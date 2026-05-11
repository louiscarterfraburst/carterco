-- Hiring signals: track curated companies + push-notify when they post a new role.
-- Idempotent: re-runnable. Edge function uses service role and bypasses RLS;
-- UI traffic is workspace-scoped via auth_workspace_ids().

-- 1. Tracked companies ----------------------------------------------------------
create table if not exists public.tracked_companies (
    id                          uuid primary key default gen_random_uuid(),
    workspace_id                uuid not null references public.workspaces(id) on delete cascade,
    name                        text not null,
    domain                      text,
    careers_url                 text not null,
    -- the "ping someone" target for outreach when a posting fires
    contact_person_name         text,
    contact_person_linkedin_url text,
    contact_person_email        text,
    added_by                    text,
    added_at                    timestamptz not null default now(),
    last_polled_at              timestamptz,
    last_poll_status            text,
    last_poll_error             text,
    unique (workspace_id, careers_url)
);

create index if not exists idx_tracked_companies_workspace
    on public.tracked_companies(workspace_id);
create index if not exists idx_tracked_companies_poll_due
    on public.tracked_companies(last_polled_at nulls first);

-- 2. Job postings ---------------------------------------------------------------
create table if not exists public.job_postings (
    id                  uuid primary key default gen_random_uuid(),
    workspace_id        uuid not null references public.workspaces(id) on delete cascade,
    tracked_company_id  uuid not null references public.tracked_companies(id) on delete cascade,
    posting_key         text not null,           -- normalised title; per-company dedup
    title               text not null,
    snippet             text,
    source_url          text,
    first_seen_at       timestamptz not null default now(),
    last_seen_at        timestamptz not null default now(),
    closed_at           timestamptz,
    unique (tracked_company_id, posting_key)
);

create index if not exists idx_job_postings_workspace_recent
    on public.job_postings(workspace_id, first_seen_at desc);
create index if not exists idx_job_postings_company_open
    on public.job_postings(tracked_company_id) where closed_at is null;

-- 3. RLS — UI traffic only sees rows in the user's workspace --------------------
alter table public.tracked_companies enable row level security;
alter table public.job_postings      enable row level security;

drop policy if exists tracked_companies_workspace_all on public.tracked_companies;
create policy tracked_companies_workspace_all on public.tracked_companies
    for all to authenticated
    using (workspace_id in (select public.auth_workspace_ids()))
    with check (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists job_postings_workspace_all on public.job_postings;
create policy job_postings_workspace_all on public.job_postings
    for all to authenticated
    using (workspace_id in (select public.auth_workspace_ids()))
    with check (workspace_id in (select public.auth_workspace_ids()));

-- 4. Cron: poll daily at 07:00 UTC (= 09:00 CEST / 08:00 CET, weekdays) --------
select cron.unschedule('track-job-postings-daily')
  where exists (select 1 from cron.job where jobname = 'track-job-postings-daily');

select cron.schedule(
    'track-job-postings-daily',
    '0 7 * * 1-5',
    $$ select net.http_post(
        url := 'https://znpaevzwlcfuzqxsbyie.supabase.co/functions/v1/track-job-postings',
        body := '{}'::jsonb,
        headers := '{"Content-Type":"application/json"}'::jsonb,
        timeout_milliseconds := 300000
    ); $$
);
