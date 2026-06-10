-- Approved-DM drip queue + auto-render on accept.
--
-- Design: /office-hours 2026-06-10 (louiscarter-feat-play-hardening-design-
-- 20260610-163518.md). Approving a DM never fires the send anymore:
-- outreach-approve stamps status='approved_queued' + scheduled_send_at
-- (6–10 min jitter, weekdays 08–18 Europe/Copenhagen, max 25/sender/day) and
-- the outreach-send-queue cron drains due rows one per sender per tick, with
-- the live reply check re-run at SEND time. Plays with auto_render=true fire
-- the SendSpark render at accept instead of parking in pending_pre_render.

-- 0. Status enum ----------------------------------------------------------------
-- Applied as its own migration (send_queue_status_enum) in prod: ALTER TYPE
-- ADD VALUE cannot be used in the same transaction that references the value.
alter type public.outreach_status add value if not exists 'approved_queued' after 'pending_approval';
-- 'sending' = atomically claimed by the drainer, external send in flight.
-- Exists so a crash between claim and finalize is detectable (stuck-recovery
-- flips >15-min-old 'sending' rows to failed) and overlapping drainer
-- invocations can never both send the same row.
alter type public.outreach_status add value if not exists 'sending' after 'approved_queued';

-- 1. Play registry: auto-render opt-in -----------------------------------------
alter table public.outreach_plays
  add column if not exists auto_render boolean not null default false;

comment on column public.outreach_plays.auto_render is
  'Cold accept fires the SendSpark render immediately (skips the manual pending_pre_render gate)';

update public.outreach_plays
  set auto_render = true
  where id = 'hiring_signal';

-- 2. Pipeline: queue slot --------------------------------------------------------
alter table public.outreach_pipeline
  add column if not exists scheduled_send_at timestamptz;

comment on column public.outreach_pipeline.scheduled_send_at is
  'Drip-queue slot for status=approved_queued rows; outreach-send-queue sends the row once now() passes it. Restamped to claim time while status=sending (stuck-recovery clock).';

-- The canonical sender the DM is queued under — persisted at enqueue
-- (outreach-approve, canonicalSenderFor) so the daily-cap query, the
-- drainer's one-per-sender-per-tick throttle, and the actual send all key on
-- the SAME identity. The per-lead sendpilot_sender_id is often null or a
-- different connection id and must not be used for cap math.
alter table public.outreach_pipeline
  add column if not exists queue_sender_id text;

create index if not exists outreach_pipeline_send_queue_idx
  on public.outreach_pipeline (scheduled_send_at)
  where status = 'approved_queued';

create index if not exists outreach_pipeline_queue_sender_idx
  on public.outreach_pipeline (queue_sender_id, sent_at);

-- 3. Drainer cron ----------------------------------------------------------------
-- NB deploy order: config.toml needs [functions.outreach-send-queue]
-- verify_jwt=false or every tick 401s before the function runs. The endpoint
-- itself is safe to expose: sends are gated by atomic claims + a send-time
-- spacing floor, and OUTREACH_CRON_TOKEN (function env) can additionally
-- require an X-Cron-Token header. To use the token from cron, add it to the
-- headers jsonb below via vault — never hardcode it in this file (public repo).
select cron.unschedule('outreach-send-queue-5min')
  where exists (select 1 from cron.job where jobname = 'outreach-send-queue-5min');

select cron.schedule(
  'outreach-send-queue-5min',
  '*/5 * * * *',
  $$ select net.http_post(
    url := 'https://znpaevzwlcfuzqxsbyie.supabase.co/functions/v1/outreach-send-queue',
    body := '{}'::jsonb,
    headers := '{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 120000
  ); $$
);
