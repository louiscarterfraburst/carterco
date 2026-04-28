-- SendSpark engagement infrastructure: timestamp columns, audit table, instant
-- trigger, and cron scan. No rules wired yet — the worker walks an empty
-- RULES array. Adding the first rule is a code-only change.
--
-- Idempotent: re-runnable. Mirrors patterns in outreach.sql + retry_scheduler.sql.

-- 1. Engagement timestamp columns on outreach_pipeline -------------------------
alter table public.outreach_pipeline
    add column if not exists viewed_at          timestamptz,
    add column if not exists played_at          timestamptz,
    add column if not exists watched_end_at     timestamptz,
    add column if not exists cta_clicked_at     timestamptz,
    add column if not exists liked_at           timestamptz,
    add column if not exists render_failed_at   timestamptz,
    add column if not exists last_engagement_at timestamptz;

-- Denormalised max() of the 5 user-engagement timestamps so the cockpit can
-- query/sort by "freshness of engagement" without a CASE expression. Kept
-- in sync via BEFORE-trigger.
create or replace function public.outreach_pipeline_set_last_engagement()
returns trigger language plpgsql as $$
declare
    candidate timestamptz;
begin
    candidate := greatest(
        coalesce(new.viewed_at,      'epoch'::timestamptz),
        coalesce(new.played_at,      'epoch'::timestamptz),
        coalesce(new.watched_end_at, 'epoch'::timestamptz),
        coalesce(new.cta_clicked_at, 'epoch'::timestamptz),
        coalesce(new.liked_at,       'epoch'::timestamptz)
    );
    if candidate = 'epoch'::timestamptz then
        new.last_engagement_at := null;
    else
        new.last_engagement_at := candidate;
    end if;
    return new;
end $$;

drop trigger if exists outreach_pipeline_last_engagement_trg on public.outreach_pipeline;
create trigger outreach_pipeline_last_engagement_trg
before insert or update on public.outreach_pipeline
for each row execute function public.outreach_pipeline_set_last_engagement();

create index if not exists idx_outreach_pipeline_last_engagement
    on public.outreach_pipeline(last_engagement_at);

-- 2. Audit table: every rule fire writes a row -------------------------------
create table if not exists public.outreach_engagement_actions (
    id                uuid primary key default gen_random_uuid(),
    sendpilot_lead_id text not null references public.outreach_pipeline(sendpilot_lead_id) on delete cascade,
    rule_id           text not null,
    action_type       text not null check (action_type in ('auto_send', 'queue_approval', 'push_only')),
    template_id       text,
    fired_at          timestamptz not null default now(),
    result            jsonb
);

create index if not exists idx_outreach_engagement_actions_lead
    on public.outreach_engagement_actions(sendpilot_lead_id);
create index if not exists idx_outreach_engagement_actions_rule
    on public.outreach_engagement_actions(rule_id);
create index if not exists idx_outreach_engagement_actions_fired
    on public.outreach_engagement_actions(fired_at desc);

alter table public.outreach_engagement_actions enable row level security;

drop policy if exists outreach_engagement_actions_owner_all on public.outreach_engagement_actions;
create policy outreach_engagement_actions_owner_all on public.outreach_engagement_actions
    for all to authenticated
    using ((auth.jwt() ->> 'email') in ('louis@carterco.dk','rm@tresyv.dk','haugefrom@haugefrom.com'))
    with check ((auth.jwt() ->> 'email') in ('louis@carterco.dk','rm@tresyv.dk','haugefrom@haugefrom.com'));

-- 3. Instant trigger: fire worker on cta_clicked / render_failed transitions --
create or replace function public.outreach_engagement_instant_tick()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    cta_changed  boolean;
    fail_changed boolean;
begin
    cta_changed := new.cta_clicked_at is not null
        and (tg_op = 'INSERT' or old.cta_clicked_at is null);
    fail_changed := new.render_failed_at is not null
        and (tg_op = 'INSERT' or old.render_failed_at is null);
    if not cta_changed and not fail_changed then
        return new;
    end if;
    perform net.http_post(
        url := 'https://znpaevzwlcfuzqxsbyie.supabase.co/functions/v1/outreach-engagement-tick',
        body := jsonb_build_object(
            'mode', 'lead',
            'sendpilot_lead_id', new.sendpilot_lead_id
        ),
        headers := '{"Content-Type":"application/json"}'::jsonb,
        timeout_milliseconds := 5000
    );
    return new;
end $$;

drop trigger if exists outreach_pipeline_engagement_instant_trg on public.outreach_pipeline;
create trigger outreach_pipeline_engagement_instant_trg
after insert or update on public.outreach_pipeline
for each row execute function public.outreach_engagement_instant_tick();

-- 4. Cron: scan all open leads every 5 minutes -------------------------------
do $$
begin
    perform cron.unschedule('outreach-engagement-scan');
exception when others then null;
end$$;

select cron.schedule(
    'outreach-engagement-scan',
    '*/5 * * * *',
    $$ select net.http_post(
        url := 'https://znpaevzwlcfuzqxsbyie.supabase.co/functions/v1/outreach-engagement-tick',
        body := '{"mode":"scan"}'::jsonb,
        headers := '{"Content-Type":"application/json"}'::jsonb,
        timeout_milliseconds := 30000
    ); $$
);
