-- Due-action scheduler: fires pushes when next_action_at is due.
-- Depends on pg_cron + pg_net (both installed).
--
-- Live dispatcher is public.process_due_lead_actions(), run every minute by the
-- 'process-due-lead-actions' cron. (Historical note: an earlier
-- public.dispatch_due_retries() + 'leads-dispatch-retries' job was superseded
-- and dropped 2026-06-05; the function below is the source of truth.)

-- Clamp a timestamptz into Mon-Fri 09:00-17:00 Europe/Copenhagen. Input is
-- pushed forward to the earliest valid business-hours moment >= ts.
create or replace function public.clamp_business_hours(ts timestamptz)
returns timestamptz
language plpgsql
stable
as $$
declare
  local_ts timestamp;
  dow int;
  hour_of_day numeric;
  day_anchor timestamp;
  result timestamp;
begin
  local_ts := ts at time zone 'Europe/Copenhagen';
  dow := extract(isodow from local_ts);
  hour_of_day := extract(hour from local_ts) + extract(minute from local_ts) / 60.0;

  -- Weekend: jump to Monday 09:00.
  if dow = 6 then
    day_anchor := date_trunc('day', local_ts) + interval '2 days';
    result := day_anchor + interval '9 hours';
  elsif dow = 7 then
    day_anchor := date_trunc('day', local_ts) + interval '1 day';
    result := day_anchor + interval '9 hours';
  elsif hour_of_day < 9 then
    day_anchor := date_trunc('day', local_ts);
    result := day_anchor + interval '9 hours';
  elsif hour_of_day >= 17 then
    day_anchor := date_trunc('day', local_ts) + interval '1 day';
    -- If next day is Saturday, push to Monday 09:00.
    if extract(isodow from day_anchor) = 6 then
      day_anchor := day_anchor + interval '2 days';
    elsif extract(isodow from day_anchor) = 7 then
      day_anchor := day_anchor + interval '1 day';
    end if;
    result := day_anchor + interval '9 hours';
  else
    result := local_ts;
  end if;

  return result at time zone 'Europe/Copenhagen';
end;
$$;

-- Hard retry cadence for unanswered dials. Given how many retries have already
-- fired, return when the next one should fire. Null when exhausted (after 4).
create or replace function public.next_retry_due(fired int, from_ts timestamptz)
returns timestamptz
language sql
stable
as $$
  select case
    when fired <= 0 then public.clamp_business_hours(from_ts + interval '2 hours')
    when fired = 1 then public.clamp_business_hours(from_ts + interval '1 day')
    when fired = 2 then public.clamp_business_hours(from_ts + interval '3 days')
    when fired = 3 then public.clamp_business_hours(from_ts + interval '7 days')
    else null
  end;
$$;

-- Softer cadence for leads already marked "interested"/"follow_up" but not
-- booked. Two nudges, then we stop bothering the operator.
create or replace function public.next_interested_nudge(fired int, from_ts timestamptz)
returns timestamptz
language sql
stable
as $$
  select case
    when fired <= 0 then public.clamp_business_hours(from_ts + interval '2 days')
    when fired = 1 then public.clamp_business_hours(from_ts + interval '7 days')
    else null
  end;
$$;

-- Dispatcher: find due leads, fire push, advance the cadence.
--   * retry rows fire regardless of outcome. The app schedules
--     next_action_type='retry' both for unanswered dials (outcome null) and for
--     interested/follow_up nudges (outcome kept) — all must fire.
--   * push title is outcome-aware: interested/follow_up send action_type
--     'follow_up' ("Follow-up: X"); unanswered dials send 'retry' ("Prøv igen").
--   * cadence comes from the business-hours-clamped helpers: hard retries
--     2h/24h/3d/7d (max 4), soft nudges 2d/7d (max 2). Ladder end clears the
--     action so the lead settles in its outcome state.
--   * callback rows fire once, then reopen the lead and clear action state.
create or replace function public.process_due_lead_actions()
returns void
language plpgsql
security definer
set search_path = public, net
as $$
declare
  r record;
  notify_url text := 'https://znpaevzwlcfuzqxsbyie.functions.supabase.co/notify-new-lead';
  is_nudge boolean;
  push_action text;
  next_ts timestamptz;
begin
  for r in
    select *
    from public.leads
    where next_action_at is not null
      and next_action_at <= now()
      and not is_draft
      and (
        next_action_type = 'retry'
        or (next_action_type = 'callback' and outcome = 'callback')
      )
    order by next_action_at
    limit 50
  loop
    if r.next_action_type = 'retry' then
      is_nudge := r.outcome in ('interested', 'follow_up');
      push_action := case when is_nudge then 'follow_up' else 'retry' end;

      perform net.http_post(
        url := notify_url,
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object('record', to_jsonb(r), 'action_type', push_action)
      );

      next_ts := case
        when is_nudge then public.next_interested_nudge(r.retry_count + 1, now())
        else public.next_retry_due(r.retry_count + 1, now())
      end;

      if next_ts is null then
        update public.leads
        set retry_count = r.retry_count + 1,
            next_action_at = null,
            next_action_type = null,
            last_action_fired_at = now()
        where id = r.id;
      else
        update public.leads
        set retry_count = r.retry_count + 1,
            next_action_at = next_ts,
            last_action_fired_at = now()
        where id = r.id;
      end if;

    elsif r.next_action_type = 'callback' then
      perform net.http_post(
        url := notify_url,
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object('record', to_jsonb(r), 'action_type', 'callback')
      );
      -- Callback fired: reopen the lead and clear action state.
      update public.leads
      set outcome = null,
          outcome_at = null,
          next_action_at = null,
          next_action_type = null,
          callback_at = null,
          last_action_fired_at = now()
      where id = r.id;
    end if;
  end loop;
end;
$$;

revoke all on function public.process_due_lead_actions() from public, anon, authenticated;

-- Register cron job (every minute). Unschedule first so re-runs are idempotent.
select cron.unschedule('process-due-lead-actions')
  where exists (select 1 from cron.job where jobname = 'process-due-lead-actions');
select cron.schedule(
  'process-due-lead-actions',
  '* * * * *',
  $$ select public.process_due_lead_actions(); $$
);
