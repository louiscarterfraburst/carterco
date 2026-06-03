create table if not exists public.lead_conversation_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  channel text not null check (channel in ('sms', 'email', 'linkedin', 'phone', 'note')),
  direction text not null check (direction in ('inbound', 'outbound', 'internal')),
  occurred_at timestamptz not null default now(),
  sender text,
  recipient text,
  subject text,
  body text not null,
  source text not null default 'manual',
  source_id text,
  metadata jsonb not null default '{}'::jsonb
);

create unique index if not exists lead_conversation_events_source_key
  on public.lead_conversation_events (source, source_id)
  where source_id is not null;

create index if not exists lead_conversation_events_lead_time_idx
  on public.lead_conversation_events (lead_id, occurred_at desc);

create index if not exists lead_conversation_events_workspace_time_idx
  on public.lead_conversation_events (workspace_id, occurred_at desc);

alter table public.lead_conversation_events enable row level security;

drop policy if exists lead_conversation_events_workspace_all
  on public.lead_conversation_events;

create policy lead_conversation_events_workspace_all
  on public.lead_conversation_events
  for all
  to authenticated
  using (workspace_id in (select public.auth_workspace_ids()))
  with check (workspace_id in (select public.auth_workspace_ids()));
