-- Lead attribution columns (true-ROAS foundation).
--
-- The CAPI loop (Soho meeting-room flow, docs/soho-leadflow.md §3/§12) needs a
-- match key banked on the lead at creation so a booking weeks later — on a
-- different device — can be credited back to the originating ad. For lead ads
-- (Meta instant forms) the gold key is meta_lead_id; fbclid is the fragile
-- cookie fallback. These are first-touch: written once at ingestion, never
-- overwritten (the lead-intake / meta-leadgen functions own that contract).
--
-- Additive + nullable, so this is safe across every workspace already in
-- public.leads (CarterCo, Soho, Soho Events, …).

alter table public.leads
  add column if not exists utm_source       text,
  add column if not exists utm_medium       text,
  add column if not exists utm_campaign      text,
  add column if not exists utm_content       text,
  add column if not exists utm_term          text,
  add column if not exists fbclid            text,
  add column if not exists gclid             text,
  add column if not exists meta_lead_id      text,  -- leadgen_id from the instant form; primary CAPI match
  add column if not exists meta_campaign_id  text,
  add column if not exists meta_ad_id        text,
  add column if not exists meta_form_id      text,
  add column if not exists landing_page_url  text;

-- Cost-side reporting joins Meta spend by campaign; group/filter by these.
create index if not exists leads_meta_campaign_id_idx on public.leads (meta_campaign_id);
create index if not exists leads_meta_lead_id_idx     on public.leads (meta_lead_id);
