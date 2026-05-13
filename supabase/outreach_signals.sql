-- outreach_signals: inbound buying signals from third-party identification
-- tools (RB2B today, Koala / Dealfront / Trigify later). Each row is one
-- identified visitor or engagement event. Mirrors the outreach_replies
-- pattern: workspace-scoped, jsonb raw payload + extracted top-level fields,
-- handled/handled_at for UI surfacing, source+external_id unique for
-- webhook idempotency.
--
-- Triage: a separate Claude pass (similar to ai-triage-reply) can score
-- against the workspace ICP, draft an outreach message, and surface in the
-- Opgaver tab. Not wired yet — this file just captures.
--
-- Idempotent: re-runnable.

create table if not exists public.outreach_signals (
    id                   uuid primary key default gen_random_uuid(),
    workspace_id         uuid not null references public.workspaces(id) on delete cascade,

    -- Provenance + idempotency
    source               text not null,
    external_id          text,
    signal_type          text,
    identified_at        timestamptz not null default now(),

    -- Person (nullable — company-only signals are common on Free tiers)
    person_name          text,
    person_title         text,
    person_linkedin_url  text,
    person_email         text,

    -- Company
    company_name         text,
    company_domain       text,
    company_linkedin_url text,
    company_industry     text,
    company_size         text,

    -- Geo + behavior
    geo                  jsonb,
    page_views           jsonb,

    -- Raw payload (audit trail; defensive against schema changes upstream)
    payload              jsonb not null,

    -- ICP scoring (populated by future triage edge function)
    icp_score            numeric(4,3),
    icp_reasoning        text,
    scored_at            timestamptz,

    -- Handling
    handled              boolean not null default false,
    handled_at           timestamptz,
    handled_by           text,
    notes                text,

    created_at           timestamptz not null default now()
);

-- Idempotency: drop duplicates from webhook retries (RB2B retries on non-2xx).
create unique index if not exists idx_outreach_signals_source_extid
    on public.outreach_signals (source, external_id)
    where external_id is not null;

create index if not exists idx_outreach_signals_workspace_identified
    on public.outreach_signals (workspace_id, identified_at desc);

create index if not exists idx_outreach_signals_unhandled
    on public.outreach_signals (identified_at desc)
    where handled = false;

create index if not exists idx_outreach_signals_company_domain
    on public.outreach_signals (company_domain)
    where company_domain is not null;

-- RLS: workspace-scoped, mirrors outreach_replies.
alter table public.outreach_signals enable row level security;
drop policy if exists outreach_signals_workspace_all on public.outreach_signals;
create policy outreach_signals_workspace_all on public.outreach_signals
    for all to authenticated
    using (workspace_id in (select public.auth_workspace_ids()))
    with check (workspace_id in (select public.auth_workspace_ids()));
