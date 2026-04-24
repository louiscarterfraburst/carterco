-- Retry scheduler: fires pushes when next_action_at is due and advances cadence.
-- Depends on pg_cron + pg_net (both installed).

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

-- Given how many retries have already fired, return when the next one should
-- fire. Returns null when the cadence is exhausted.
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

-- Softer cadence for leads already marked "interested" but not booked.
-- Two nudges, then we stop bothering the operator.
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

-- Dispatcher: find due leads, fire push, advance cadence.
create or replace function public.dispatch_due_retries()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  fn_url text := 'https://znpaevzwlcfuzqxsbyie.supabase.co/functions/v1/notify-new-lead';
  due record;
  next_ts timestamptz;
  fired int := 0;
begin
  for due in
    select *
    from public.leads
    where is_draft = false
      and next_action_at is not null
      and next_action_at <= now()
      and next_action_type in ('retry', 'callback')
      and (last_action_fired_at is null or last_action_fired_at < next_action_at)
    order by next_action_at asc
    limit 50
  loop
    -- Interested-lead nudges use a distinct push title via action_type=follow_up.
    perform net.http_post(
      url := fn_url,
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object(
        'record', to_jsonb(due),
        'action_type',
        case
          when due.next_action_type = 'retry' and due.outcome = 'interested'
            then 'follow_up'
          else due.next_action_type
        end
      )
    );

    if due.next_action_type = 'retry' then
      if due.outcome = 'interested' then
        next_ts := public.next_interested_nudge(due.retry_count + 1, now());
        if next_ts is null then
          -- Two nudges fired, no booking yet. Stop pushing; let the operator decide.
          update public.leads
          set next_action_at = null,
              next_action_type = null,
              last_action_fired_at = now(),
              retry_count = due.retry_count + 1
          where id = due.id;
        else
          update public.leads
          set retry_count = due.retry_count + 1,
              next_action_at = next_ts,
              last_action_fired_at = now()
          where id = due.id;
        end if;
      else
        next_ts := public.next_retry_due(due.retry_count + 1, now());
        if next_ts is null then
          update public.leads
          set outcome = 'unqualified',
              outcome_at = now(),
              next_action_at = null,
              next_action_type = null,
              callback_at = null,
              last_action_fired_at = now(),
              retry_count = least(due.retry_count + 1, 4)
          where id = due.id;
        else
          update public.leads
          set retry_count = due.retry_count + 1,
              next_action_at = next_ts,
              last_action_fired_at = now()
          where id = due.id;
        end if;
      end if;
    else
      -- Callback fired. Give a 2h grace, then escalate into the no-answer ladder.
      update public.leads
      set last_action_fired_at = now(),
          next_action_at = now() + interval '2 hours',
          next_action_type = 'retry',
          retry_count = 0
      where id = due.id;
    end if;

    fired := fired + 1;
  end loop;

  return fired;
end;
$$;

revoke all on function public.dispatch_due_retries() from public, anon, authenticated;

-- Register cron job. Unschedule first so re-runs of this file are idempotent.
do $$
begin
  perform cron.unschedule('leads-dispatch-retries');
exception when others then null;
end$$;

select cron.schedule(
  'leads-dispatch-retries',
  '* * * * *',
  $$ select public.dispatch_due_retries(); $$
);
