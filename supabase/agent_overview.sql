-- Per-agent overview aggregation for /leads/overview (soho-leadflow.md §6).
-- SECURITY INVOKER (default): runs as the calling user, so RLS on leads +
-- lead_conversation_events scopes every read to the user's own workspaces — the
-- p_workspace_id filter is for selection, RLS is the guard. Exact counts, no row
-- limits (no silent truncation), one round trip. p_range is resolved to a since
-- timestamp in Europe/Copenhagen so "today" means the operator's business day.
--
-- Returns jsonb: { agents: [{email, calls, booked, rented, avg_speed_seconds}],
--   total_calls, total_booked, total_rented, unattributed_booked,
--   unattributed_rented, avg_speed_seconds }.
--   * calls            = outbound phone events by sender
--   * booked / rented  = outcome 'booked' / 'customer', attributed to the last
--                        person to log phone/note contact at or before outcome_at
--   * avg_speed_seconds= mean (first outbound call − created_at) for leads
--                        created in the window
--   * unattributed_*   = outcomes with no logged contact before the outcome
create or replace function public.agent_overview(p_workspace_id uuid, p_range text)
returns jsonb
language plpgsql
stable
as $$
declare
  v_since timestamptz;
  v_result jsonb;
begin
  v_since := case p_range
    when 'today' then date_trunc('day', now() at time zone 'Europe/Copenhagen')
                        at time zone 'Europe/Copenhagen'
    when '7d' then now() - interval '7 days'
    when '30d' then now() - interval '30 days'
    else now() - interval '1 day'
  end;

  with calls as (
    select sender, count(*)::int as calls
    from public.lead_conversation_events
    where workspace_id = p_workspace_id
      and channel = 'phone' and direction = 'outbound'
      and sender is not null
      and occurred_at >= v_since
    group by sender
  ),
  created as (
    select id, created_at
    from public.leads
    where workspace_id = p_workspace_id and not is_draft and created_at >= v_since
  ),
  first_call as (
    select distinct on (e.lead_id) e.lead_id, e.sender, e.occurred_at
    from public.lead_conversation_events e
    join created c on c.id = e.lead_id
    where e.channel = 'phone' and e.direction = 'outbound' and e.sender is not null
    order by e.lead_id, e.occurred_at asc
  ),
  speed as (
    select fc.sender,
           avg(extract(epoch from (fc.occurred_at - c.created_at))) as avg_speed_seconds
    from first_call fc
    join created c on c.id = fc.lead_id
    where fc.occurred_at >= c.created_at
    group by fc.sender
  ),
  outcomes as (
    select id, outcome, outcome_at
    from public.leads
    where workspace_id = p_workspace_id
      and outcome in ('booked', 'customer') and outcome_at >= v_since
  ),
  attrib as (
    select distinct on (o.id) o.id, o.outcome, e.sender
    from outcomes o
    left join public.lead_conversation_events e
      on e.lead_id = o.id
     and e.channel in ('phone', 'note')
     and e.sender is not null
     and e.occurred_at <= o.outcome_at
    order by o.id, e.occurred_at desc nulls last
  ),
  booked as (
    select sender,
           count(*) filter (where outcome = 'booked')::int as booked,
           count(*) filter (where outcome = 'customer')::int as rented
    from attrib
    where sender is not null
    group by sender
  ),
  keys as (
    select sender from calls
    union select sender from speed
    union select sender from booked
  ),
  agents as (
    select k.sender as email,
           coalesce(c.calls, 0) as calls,
           coalesce(b.booked, 0) as booked,
           coalesce(b.rented, 0) as rented,
           s.avg_speed_seconds
    from keys k
    left join calls c on c.sender = k.sender
    left join speed s on s.sender = k.sender
    left join booked b on b.sender = k.sender
    where k.sender is not null
  )
  select jsonb_build_object(
    'agents', coalesce(
      (select jsonb_agg(to_jsonb(a) order by a.calls desc, a.rented desc, a.booked desc)
       from agents a), '[]'::jsonb),
    'total_calls', coalesce((select sum(calls) from calls), 0),
    'total_booked', coalesce((select sum(booked) from booked), 0)
                    + (select count(*) from attrib where sender is null and outcome = 'booked'),
    'total_rented', coalesce((select sum(rented) from booked), 0)
                    + (select count(*) from attrib where sender is null and outcome = 'customer'),
    'unattributed_booked', (select count(*) from attrib where sender is null and outcome = 'booked'),
    'unattributed_rented', (select count(*) from attrib where sender is null and outcome = 'customer'),
    'avg_speed_seconds', (
      select avg(extract(epoch from (fc.occurred_at - c.created_at)))
      from first_call fc join created c on c.id = fc.lead_id
      where fc.occurred_at >= c.created_at)
  )
  into v_result;

  return v_result;
end;
$$;

grant execute on function public.agent_overview(uuid, text) to authenticated;
