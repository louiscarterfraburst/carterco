-- Outreach pipeline: SendPilot ↔ SendSpark integration tables.
-- Idempotent: re-runnable. Edge functions use service role and bypass RLS.
-- UI access gated to louis@carterco.dk (matches existing notifications.sql pattern).

-- 1. Leads (1:1 with master_sendable_no_marketing_agencies.csv) -----------------
create table if not exists public.outreach_leads (
    linkedin_url       text primary key,
    sendpilot_lead_id  text,
    first_name         text,
    last_name          text,
    full_name          text,
    company            text,
    title              text,
    website            text,
    contact_email      text,
    slug               text,
    inserted_at        timestamptz not null default now(),
    updated_at         timestamptz not null default now()
);

-- Slug = lowercased final path segment of linkedin_url (used to match
-- normalization differences across SendPilot vs source-CSV URL forms).
create or replace function public.outreach_leads_set_slug()
returns trigger language plpgsql as $$
begin
    new.slug := lower(regexp_replace(
        coalesce(split_part(rtrim(new.linkedin_url, '/'), '/', -1), ''),
        '[^a-z0-9-]+', '-', 'g'
    ));
    new.updated_at := now();
    return new;
end $$;

drop trigger if exists outreach_leads_set_slug_trg on public.outreach_leads;
create trigger outreach_leads_set_slug_trg
before insert or update on public.outreach_leads
for each row execute function public.outreach_leads_set_slug();

create index if not exists idx_outreach_leads_slug on public.outreach_leads(slug);
create index if not exists idx_outreach_leads_sendpilot_lead_id on public.outreach_leads(sendpilot_lead_id);
create index if not exists idx_outreach_leads_contact_email on public.outreach_leads(contact_email);

-- 2. Events (raw webhook audit + idempotency) -----------------------------------
create table if not exists public.outreach_events (
    event_id     text primary key,
    source       text not null check (source in ('sendpilot', 'sendspark')),
    event_type   text not null,
    workspace_id text,
    payload      jsonb not null,
    received_at  timestamptz not null default now()
);

create index if not exists idx_outreach_events_type on public.outreach_events(event_type);
create index if not exists idx_outreach_events_received_at on public.outreach_events(received_at desc);

-- 3. Pipeline (per-lead state machine) ------------------------------------------
do $$ begin
    create type public.outreach_status as enum (
        'invited',          -- connection.sent observed
        'accepted',         -- connection.accepted observed
        'rendering',        -- POSTed to SendSpark, awaiting callback
        'rendered',         -- video ready, ready to send
        'pending_approval', -- already-connected → awaiting human
        'sent',             -- /inbox/send returned 200
        'rejected',         -- approver said no
        'failed'            -- terminal error
    );
exception when duplicate_object then null; end $$;

create table if not exists public.outreach_pipeline (
    sendpilot_lead_id   text primary key,
    linkedin_url        text not null,
    contact_email       text not null,
    is_cold             boolean,
    status              public.outreach_status not null default 'invited',
    video_link          text,
    embed_link          text,
    thumbnail_url       text,
    rendered_message    text,
    sendpilot_response  jsonb,
    invited_at          timestamptz,
    accepted_at         timestamptz,
    rendered_at         timestamptz,
    sent_at             timestamptz,
    queued_at           timestamptz,
    decided_at          timestamptz,
    decided_by          text,
    error               text,
    updated_at          timestamptz not null default now()
);

create index if not exists idx_outreach_pipeline_status on public.outreach_pipeline(status);
create index if not exists idx_outreach_pipeline_linkedin_url on public.outreach_pipeline(linkedin_url);
create index if not exists idx_outreach_pipeline_contact_email on public.outreach_pipeline(contact_email);

create or replace function public.outreach_pipeline_touch()
returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end $$;

drop trigger if exists outreach_pipeline_touch_trg on public.outreach_pipeline;
create trigger outreach_pipeline_touch_trg
before update on public.outreach_pipeline
for each row execute function public.outreach_pipeline_touch();

-- 4. RLS — UI traffic only sees rows when JWT is the workspace owner ------------
alter table public.outreach_leads enable row level security;
alter table public.outreach_events enable row level security;
alter table public.outreach_pipeline enable row level security;

drop policy if exists outreach_leads_owner_all on public.outreach_leads;
create policy outreach_leads_owner_all on public.outreach_leads
    for all to authenticated
    using ((auth.jwt() ->> 'email') = 'louis@carterco.dk')
    with check ((auth.jwt() ->> 'email') = 'louis@carterco.dk');

drop policy if exists outreach_events_owner_all on public.outreach_events;
create policy outreach_events_owner_all on public.outreach_events
    for all to authenticated
    using ((auth.jwt() ->> 'email') = 'louis@carterco.dk')
    with check ((auth.jwt() ->> 'email') = 'louis@carterco.dk');

drop policy if exists outreach_pipeline_owner_all on public.outreach_pipeline;
create policy outreach_pipeline_owner_all on public.outreach_pipeline
    for all to authenticated
    using ((auth.jwt() ->> 'email') = 'louis@carterco.dk')
    with check ((auth.jwt() ->> 'email') = 'louis@carterco.dk');
