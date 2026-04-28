-- Outreach sequences: per-lead ordered automation state. Layered on top of
-- outreach_engagement (which gives us signal columns + audit table + cron).
--
-- A sequence is code-defined in supabase/functions/_shared/sequences.ts. This
-- migration only stores per-lead position: which sequence, which step, when
-- to wake. One sequence per lead at a time.
--
-- Idempotent: re-runnable.

alter table public.outreach_pipeline
    add column if not exists sequence_id              text,
    add column if not exists sequence_step            int,
    add column if not exists sequence_parked_until    timestamptz,
    add column if not exists sequence_started_at      timestamptz,
    add column if not exists sequence_completed_at    timestamptz,
    add column if not exists sequence_step_entered_at timestamptz;

-- Lets the scan-mode query find due leads cheaply: only rows that are in a
-- sequence and not yet completed need checking.
create index if not exists idx_outreach_pipeline_sequence_parked
    on public.outreach_pipeline (sequence_parked_until)
    where sequence_id is not null and sequence_completed_at is null;

-- One-time backfill: leads whose initial message we already sent before this
-- feature went live should NOT auto-enrol into post-send sequences. Mark them
-- as completed against a sentinel sequence id so the engine ignores them.
-- Idempotent — new rows on every subsequent re-run won't be touched because
-- they'll already have sequence_id set (or no sent_at yet).
update public.outreach_pipeline
set sequence_id           = 'pre_feature_backfill',
    sequence_started_at   = now(),
    sequence_completed_at = now()
where sent_at is not null
  and sequence_id is null;
