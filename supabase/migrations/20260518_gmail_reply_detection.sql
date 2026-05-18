-- Gmail reply detection (Level 2 of email integration)
--
-- gmail_tokens: stores the user's Gmail OAuth refresh token so an edge
-- function can poll their inbox without re-prompting for consent.

create table if not exists public.gmail_tokens (
  user_email     text primary key,
  refresh_token  text not null,
  access_token   text,
  expires_at     timestamptz,
  granted_scopes text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.gmail_tokens enable row level security;

create policy "Users see only their own gmail token"
  on public.gmail_tokens for select to authenticated
  using (user_email = (select auth.jwt()->>'email'));

create policy "Users write only their own gmail token"
  on public.gmail_tokens for insert to authenticated
  with check (user_email = (select auth.jwt()->>'email'));

create policy "Users update only their own gmail token"
  on public.gmail_tokens for update to authenticated
  using (user_email = (select auth.jwt()->>'email'));

alter table public.outreach_emails
  add column if not exists gmail_thread_id text,
  add column if not exists reply_received_at timestamptz,
  add column if not exists reply_message_id text,
  add column if not exists reply_snippet text;

create index if not exists outreach_emails_sent_unhandled_idx
  on public.outreach_emails (sent_at)
  where sent_at is not null and reply_received_at is null;
