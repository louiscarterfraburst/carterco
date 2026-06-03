-- deals: track Attio record_id so the webhook can map deletes/merges back to a slug.
--
-- When Attio fires a record.deleted or record.merged event, the payload has
-- only the Attio record_id — not our supabase_pipeline_id. Persisting the
-- mapping here lets attio-webhook-deal look up the row to delete.
--
-- Not in the outgoing trigger's relevance check, so writes to this column
-- from attio-sync-deal don't re-fire sync.

alter table public.deals
  add column if not exists attio_record_id text;

create unique index if not exists deals_attio_record_id_idx
  on public.deals(attio_record_id) where attio_record_id is not null;
