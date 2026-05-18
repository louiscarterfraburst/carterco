-- Email enrichment + outbound-email tracking
--
-- A. Email columns on outreach_pipeline + outreach_alt_contacts (mirrors phone shape)
-- B. New outreach_emails table — one row per draft/sent email per lead, with
--    AI-chosen strategy + rationale so we can later A/B which strategies convert

alter table public.outreach_pipeline
  add column if not exists email_direct text,
  add column if not exists email_office text,
  add column if not exists email_source text,
  add column if not exists email_scouted_at timestamptz,
  add column if not exists email_scout_details jsonb,
  add column if not exists last_email_at timestamptz,
  add column if not exists last_email_outcome text;

alter table public.outreach_alt_contacts
  add column if not exists email_direct text,
  add column if not exists email_office text,
  add column if not exists email_source text,
  add column if not exists email_scouted_at timestamptz,
  add column if not exists email_scout_details jsonb;

create table if not exists public.outreach_emails (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id),
  pipeline_lead_id text not null,
  to_email      text not null,
  subject       text not null,
  body          text not null,
  strategy      text,
  rationale     text,
  language      text,
  drafted_at    timestamptz not null default now(),
  sent_at       timestamptz,
  outcome       text,
  outcome_at    timestamptz,
  drafted_by    text,
  created_by    text
);

create index if not exists outreach_emails_pipeline_idx on public.outreach_emails(pipeline_lead_id);
create index if not exists outreach_emails_workspace_idx on public.outreach_emails(workspace_id);
create index if not exists outreach_emails_drafted_at_idx on public.outreach_emails(drafted_at desc);

alter table public.outreach_emails enable row level security;

create policy "Email reads scoped to workspace member"
  on public.outreach_emails for select to authenticated
  using (
    exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = outreach_emails.workspace_id
        and wm.user_email = (select auth.jwt()->>'email')
    )
  );

create policy "Email writes scoped to workspace member"
  on public.outreach_emails for insert to authenticated
  with check (
    exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = outreach_emails.workspace_id
        and wm.user_email = (select auth.jwt()->>'email')
    )
  );

create policy "Email updates scoped to workspace member"
  on public.outreach_emails for update to authenticated
  using (
    exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = outreach_emails.workspace_id
        and wm.user_email = (select auth.jwt()->>'email')
    )
  );
