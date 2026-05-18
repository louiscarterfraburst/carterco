-- Phone-scout columns on pipeline + alt_contacts. Mirror the shape already
-- present on outreach_signals so scout-phones can share writeback logic across
-- all three target kinds.
--
-- phone_direct      preferred dial-out number (mobile when available)
-- phone_office      fallback (switchboard) — kept for context, not auto-dialled
-- phone_source      'scrape' | 'apify_parvenu' | (future: 'cvr' | 'linkedin_cookie')
-- phone_scouted_at  nullable timestamp; null means never attempted
-- phone_scout_details  full waterfall trace (jsonb) for debugging false positives

alter table public.outreach_pipeline
  add column if not exists phone_direct text,
  add column if not exists phone_office text,
  add column if not exists phone_source text,
  add column if not exists phone_scouted_at timestamptz,
  add column if not exists phone_scout_details jsonb;

alter table public.outreach_alt_contacts
  add column if not exists phone_direct text,
  add column if not exists phone_office text,
  add column if not exists phone_source text,
  add column if not exists phone_scouted_at timestamptz,
  add column if not exists phone_scout_details jsonb;
