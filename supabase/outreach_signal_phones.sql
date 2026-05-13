-- Phone discovery results for outreach_signals. Populated by signal-scout-phones
-- edge function which runs a waterfall: website scrape → Datagma API → office
-- fallback. phone_source records which layer produced the number; phone_scout_details
-- holds the raw waterfall trace for debugging hit-rate by layer.
--
-- Idempotent: re-runnable.

alter table public.outreach_signals
  add column if not exists phone_direct        text,
  add column if not exists phone_office        text,
  add column if not exists phone_source        text,
  add column if not exists phone_scouted_at    timestamptz,
  add column if not exists phone_scout_details jsonb;

comment on column public.outreach_signals.phone_direct is
  'Direct/mobile phone for the identified visitor. Populated by signal-scout-phones waterfall: scrape first, Datagma second, null if neither found one.';
comment on column public.outreach_signals.phone_office is
  'Office switchboard for the visitor''s company. Last-resort fallback when no direct found. Scraped from website footer or Datagma company endpoint.';
comment on column public.outreach_signals.phone_source is
  'Which layer produced phone_direct: scrape | datagma | manual. Office source is in phone_scout_details.office_source.';
