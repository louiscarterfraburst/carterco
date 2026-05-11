-- ICP scoring + alternate-contact discovery for accepted leads.
-- Idempotent. Service-role functions bypass RLS; UI traffic is workspace-scoped.

-- 1. Pipeline columns (additive; no breaking changes) --------------------------
alter table public.outreach_pipeline
    add column if not exists icp_company_score   int,
    add column if not exists icp_person_score    int,
    add column if not exists icp_rationale       text,
    add column if not exists icp_scored_at       timestamptz,
    add column if not exists alt_search_id       text,
    add column if not exists alt_search_status   text,   -- pending|completed|empty|failed
    add column if not exists alt_decided_at      timestamptz,
    add column if not exists alt_decided_by      text;

create index if not exists idx_outreach_pipeline_icp_unscored
    on public.outreach_pipeline(status, icp_scored_at)
    where icp_scored_at is null;

create index if not exists idx_outreach_pipeline_alt_pending
    on public.outreach_pipeline(alt_search_status)
    where alt_search_status = 'pending';

-- 2. Outreach status enum: add new terminal/branching states -------------------
alter type public.outreach_status add value if not exists 'rejected_by_icp';
alter type public.outreach_status add value if not exists 'pending_alt_review';

-- 3. Alternate contacts table (one row per candidate suggested by SendPilot
--    lead-database search or /team-page fallback) ------------------------------
create table if not exists public.outreach_alt_contacts (
    id                   uuid primary key default gen_random_uuid(),
    workspace_id         uuid not null references public.workspaces(id) on delete cascade,
    pipeline_lead_id     text not null references public.outreach_pipeline(sendpilot_lead_id) on delete cascade,
    name                 text not null,
    linkedin_url         text not null,
    title                text,
    seniority            text,
    employees            text,
    company              text,
    source               text not null check (source in ('sendpilot', 'team_page')),
    sendpilot_lead_db_id text,
    surfaced_at          timestamptz not null default now(),
    acted_on_at          timestamptz,
    invite_response      jsonb,
    error                text,
    unique (pipeline_lead_id, linkedin_url)
);

create index if not exists idx_outreach_alt_contacts_pipeline
    on public.outreach_alt_contacts(pipeline_lead_id);
create index if not exists idx_outreach_alt_contacts_pending
    on public.outreach_alt_contacts(pipeline_lead_id, acted_on_at)
    where acted_on_at is null;

alter table public.outreach_alt_contacts enable row level security;
drop policy if exists outreach_alt_contacts_workspace_all on public.outreach_alt_contacts;
create policy outreach_alt_contacts_workspace_all on public.outreach_alt_contacts
    for all to authenticated
    using (workspace_id in (select public.auth_workspace_ids()))
    with check (workspace_id in (select public.auth_workspace_ids()));

-- 4. Cron schedules -------------------------------------------------------------
-- Score newly-accepted leads every 5 minutes.
select cron.unschedule('score-accepted-lead-5min')
  where exists (select 1 from cron.job where jobname = 'score-accepted-lead-5min');
select cron.schedule(
    'score-accepted-lead-5min',
    '*/5 * * * *',
    $$ select net.http_post(
        url := 'https://znpaevzwlcfuzqxsbyie.supabase.co/functions/v1/score-accepted-lead',
        body := '{}'::jsonb,
        headers := '{"Content-Type":"application/json"}'::jsonb,
        timeout_milliseconds := 240000
    ); $$
);

-- Poll outstanding SendPilot alt-searches every 2 minutes.
select cron.unschedule('poll-alt-searches-2min')
  where exists (select 1 from cron.job where jobname = 'poll-alt-searches-2min');
select cron.schedule(
    'poll-alt-searches-2min',
    '*/2 * * * *',
    $$ select net.http_post(
        url := 'https://znpaevzwlcfuzqxsbyie.supabase.co/functions/v1/poll-alt-searches',
        body := '{}'::jsonb,
        headers := '{"Content-Type":"application/json"}'::jsonb,
        timeout_milliseconds := 120000
    ); $$
);
