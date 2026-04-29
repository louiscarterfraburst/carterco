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
        'pending_approval', -- queued in cockpit, awaiting human approve
        'sent',             -- /inbox/send returned 200
        'rejected',         -- approver said no
        'failed',           -- terminal error
        'pre_connected'     -- accepted but already connected before this campaign — no auto-render
    );
exception when duplicate_object then null; end $$;

-- Idempotent enum extension for already-deployed databases.
alter type public.outreach_status add value if not exists 'pre_connected';

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

-- 4. RLS — UI traffic only sees rows inside the user's workspace --------------
alter table public.outreach_leads enable row level security;
alter table public.outreach_events enable row level security;
alter table public.outreach_pipeline enable row level security;

drop policy if exists outreach_leads_owner_all on public.outreach_leads;
drop policy if exists outreach_leads_workspace_all on public.outreach_leads;
create policy outreach_leads_workspace_all on public.outreach_leads
    for all to authenticated
    using (workspace_id in (select public.auth_workspace_ids()))
    with check (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists outreach_events_owner_all on public.outreach_events;
drop policy if exists outreach_events_workspace_all on public.outreach_events;
create policy outreach_events_workspace_all on public.outreach_events
    for all to authenticated
    using (workspace_id in (select public.auth_workspace_ids()))
    with check (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists outreach_pipeline_owner_all on public.outreach_pipeline;
drop policy if exists outreach_pipeline_workspace_all on public.outreach_pipeline;
create policy outreach_pipeline_workspace_all on public.outreach_pipeline
    for all to authenticated
    using (workspace_id in (select public.auth_workspace_ids()))
    with check (workspace_id in (select public.auth_workspace_ids()));

-- 5. Replies (LinkedIn replies caught from message.received webhook) -----------
do $$ begin
    create type public.reply_intent as enum
        ('interested', 'question', 'decline', 'ooo', 'other');
exception when duplicate_object then null; end $$;

create table if not exists public.outreach_replies (
    id              uuid primary key default gen_random_uuid(),
    sendpilot_lead_id text not null references public.outreach_pipeline(sendpilot_lead_id) on delete cascade,
    linkedin_url    text not null,
    message         text not null,
    intent          public.reply_intent,
    confidence      numeric(4,3),
    reasoning       text,
    classified_at   timestamptz,
    received_at     timestamptz not null default now(),
    handled         boolean not null default false,
    handled_at      timestamptz,
    handled_by      text,
    notes           text
);

create index if not exists idx_outreach_replies_lead on public.outreach_replies(sendpilot_lead_id);
create index if not exists idx_outreach_replies_received on public.outreach_replies(received_at desc);
create index if not exists idx_outreach_replies_handled on public.outreach_replies(handled) where handled = false;

alter table public.outreach_pipeline
    add column if not exists last_reply_at        timestamptz,
    add column if not exists last_reply_intent    public.reply_intent;

alter table public.outreach_replies enable row level security;
drop policy if exists outreach_replies_owner_all on public.outreach_replies;
drop policy if exists outreach_replies_workspace_all on public.outreach_replies;
create policy outreach_replies_workspace_all on public.outreach_replies
    for all to authenticated
    using (workspace_id in (select public.auth_workspace_ids()))
    with check (workspace_id in (select public.auth_workspace_ids()));

-- Workspace-scoped push subscriptions. The multi-tenant cutover also creates
-- this policy; keeping it here prevents rerunning outreach.sql from reopening
-- push fan-out to every seeded email.
drop policy if exists push_subscriptions_owner_all on public.push_subscriptions;
drop policy if exists push_subscriptions_workspace_all on public.push_subscriptions;
create policy push_subscriptions_workspace_all on public.push_subscriptions
    for all to authenticated
    using (workspace_id in (select public.auth_workspace_ids()))
    with check (workspace_id in (select public.auth_workspace_ids()));

-- 6. Pending-approval notification trigger ----------------------------------
-- Fires notify-pending-approval edge function on transitions into
-- pending_approval. Equivalent to a Supabase Database Webhook configured
-- in the dashboard, but defined as code so it ships with the migration.
create or replace function public.outreach_notify_pending()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    transitioned boolean;
begin
    transitioned := new.status = 'pending_approval'
        and (tg_op = 'INSERT' or coalesce(old.status::text, '') <> 'pending_approval');
    if not transitioned then
        return new;
    end if;
    perform net.http_post(
        url := 'https://znpaevzwlcfuzqxsbyie.supabase.co/functions/v1/notify-pending-approval',
        body := jsonb_build_object(
            'type', tg_op,
            'table', 'outreach_pipeline',
            'schema', 'public',
            'record', row_to_json(new),
            'old_record', case when tg_op = 'UPDATE' then row_to_json(old) else null end
        ),
        headers := '{"Content-Type":"application/json"}'::jsonb,
        timeout_milliseconds := 5000
    );
    return new;
end $$;

drop trigger if exists outreach_pipeline_notify_pending on public.outreach_pipeline;
create trigger outreach_pipeline_notify_pending
after insert or update on public.outreach_pipeline
for each row execute function public.outreach_notify_pending();
