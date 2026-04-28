-- Per-user calendar availability + suggest_slots RPC.
-- iCal URL is polled every 15 min by the cal-poll edge function (cron schedule
-- below). suggest_slots returns the next N free 30-min windows in the user's
-- timezone, used by /leads (email/SMS templates) and /outreach.

create table if not exists public.user_settings (
    user_email                  text primary key,
    ical_url                    text,
    business_hours_start        time not null default '09:00',
    business_hours_end          time not null default '17:00',
    business_days               int[] not null default '{1,2,3,4,5}',  -- 1=Mon ... 7=Sun
    tz                          text not null default 'Europe/Copenhagen',
    slot_duration_minutes       int not null default 30,
    suggest_count               int not null default 3,
    suggest_lookahead_days      int not null default 7,
    suggest_min_lead_hours      int not null default 2,
    last_synced_at              timestamptz,
    last_sync_error             text,
    updated_at                  timestamptz not null default now()
);

create table if not exists public.user_busy_intervals (
    id              uuid primary key default gen_random_uuid(),
    user_email      text not null,
    source          text not null default 'gcal',
    external_id     text,
    start_at        timestamptz not null,
    end_at          timestamptz not null,
    summary         text,
    fetched_at      timestamptz not null default now()
);

create unique index if not exists ux_busy_user_external_start
    on public.user_busy_intervals(user_email, source, coalesce(external_id, ''), start_at);
create index if not exists idx_busy_user_window
    on public.user_busy_intervals(user_email, start_at);

alter table public.user_settings enable row level security;
alter table public.user_busy_intervals enable row level security;

drop policy if exists user_settings_self on public.user_settings;
create policy user_settings_self on public.user_settings
    for all to authenticated
    using ((auth.jwt() ->> 'email') = user_email
        and (auth.jwt() ->> 'email') in ('louis@carterco.dk','rm@tresyv.dk','haugefrom@haugefrom.com'))
    with check ((auth.jwt() ->> 'email') = user_email
        and (auth.jwt() ->> 'email') in ('louis@carterco.dk','rm@tresyv.dk','haugefrom@haugefrom.com'));

drop policy if exists user_busy_self on public.user_busy_intervals;
create policy user_busy_self on public.user_busy_intervals
    for select to authenticated
    using ((auth.jwt() ->> 'email') = user_email);

create or replace function public.suggest_slots(
    _user_email text,
    _from timestamptz default now(),
    _days int default null,
    _duration_minutes int default null,
    _count int default null
)
returns table (slot timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
    s public.user_settings%rowtype;
    cursor_ts timestamptz;
    end_ts timestamptz;
    duration interval;
    days int;
    cnt int;
    n_found int := 0;
    is_busy boolean;
    local_t timestamptz;
    dow int;
    local_time time;
    has_settings boolean;
begin
    select * into s from public.user_settings where user_email = _user_email;
    has_settings := FOUND;
    if not has_settings then
        s.tz := 'Europe/Copenhagen';
        s.business_hours_start := '09:00';
        s.business_hours_end := '17:00';
        s.business_days := '{1,2,3,4,5}'::int[];
        s.slot_duration_minutes := 30;
        s.suggest_count := 3;
        s.suggest_lookahead_days := 7;
        s.suggest_min_lead_hours := 2;
    end if;

    days := coalesce(_days, s.suggest_lookahead_days);
    duration := make_interval(mins => coalesce(_duration_minutes, s.slot_duration_minutes));
    cnt := coalesce(_count, s.suggest_count);

    cursor_ts := greatest(_from, now() + make_interval(hours => s.suggest_min_lead_hours));
    cursor_ts := date_trunc('hour', cursor_ts)
        + make_interval(mins => 30 * ceil(extract(minute from cursor_ts) / 30.0)::int);
    end_ts := _from + make_interval(days => days);

    while cursor_ts < end_ts and n_found < cnt loop
        local_t := cursor_ts at time zone s.tz;
        dow := extract(isodow from local_t)::int;
        local_time := local_t::time;

        if dow = any(s.business_days)
           and local_time >= s.business_hours_start
           and (local_time + duration) <= s.business_hours_end
        then
            select exists (
                select 1 from public.user_busy_intervals b
                where b.user_email = _user_email
                  and b.start_at < cursor_ts + duration
                  and b.end_at   > cursor_ts
            ) into is_busy;
            if not is_busy then
                slot := cursor_ts;
                return next;
                n_found := n_found + 1;
            end if;
        end if;

        cursor_ts := cursor_ts + interval '30 minutes';
    end loop;
    return;
end $$;

revoke all on function public.suggest_slots(text, timestamptz, int, int, int) from public;
grant execute on function public.suggest_slots(text, timestamptz, int, int, int) to authenticated, service_role;

-- Schedule cal-poll every 15 minutes.
select cron.unschedule(jobname) from cron.job where jobname = 'cal-poll-15min';
select cron.schedule(
    'cal-poll-15min',
    '7,22,37,52 * * * *',
    $$select net.http_post(
        url := 'https://znpaevzwlcfuzqxsbyie.supabase.co/functions/v1/cal-poll',
        headers := '{"Content-Type":"application/json"}'::jsonb,
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
    )$$
);
