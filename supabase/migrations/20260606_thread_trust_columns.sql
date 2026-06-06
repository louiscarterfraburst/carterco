-- Thread-trust: stable conversation linkage + reconciliation flag.
-- Origin: docs/outreach-thread-trust.md — manual outbound was silently dropped
-- because the sync matched conversations by fragile vanity-URL/name keys. Store
-- SendPilot's conversation id + participant URN so capture is deterministic, and
-- track per-thread message counts so a half-synced thread surfaces instead of
-- silently misleading.

alter table public.outreach_pipeline
  add column if not exists sendpilot_conversation_id text,
  add column if not exists participant_urn text,
  add column if not exists thread_out_of_sync boolean not null default false,
  add column if not exists thread_checked_at timestamptz,
  add column if not exists thread_sp_count integer,
  add column if not exists thread_db_count integer;

-- Match lookups in the sync go by conversation id; index it.
create index if not exists outreach_pipeline_sp_conversation_idx
  on public.outreach_pipeline (sendpilot_conversation_id)
  where sendpilot_conversation_id is not null;
