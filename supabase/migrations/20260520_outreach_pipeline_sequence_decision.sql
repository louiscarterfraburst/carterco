-- Adds sequence_decision columns to outreach_pipeline. Populated by
-- ai-triage-reply when an inbound reply lands; consumed by
-- outreach-engagement-tick to decide what to do with the sequence next.
--
-- Today the engine treats any reply as "kill the sequence" via the
-- excludesGlobal=['replied'] default. That's wasteful — an OOO auto-reply
-- or a "tjek tilbage om en måned" shouldn't have the same blast radius as
-- "not interested." With these columns, Haiku 4.5 makes a sequence-level
-- decision (stop / pause / reroute / continue) and the engine acts on it.
--
-- Values:
--   stop          — hard exit (not interested, decline, wrong person, customer)
--   pause_until   — temporary hold (OOO with end date, "ring i Q3")
--   reroute_email — they said "send det på mail" → skip to next email_draft step
--   reroute_call  — they offered phone / asked to be called → bump callback_at
--   continue      — generic ack that doesn't change the plan; ignore replied-exclude
--   (NULL)        — no decision yet; engine falls back to existing replied-exclude behavior
--
-- Decision is denormalized from outreach_replies onto outreach_pipeline so
-- the engine reads a single row per lead instead of joining the latest
-- reply on every tick.

ALTER TABLE outreach_pipeline
  ADD COLUMN IF NOT EXISTS seq_decision           text,
  ADD COLUMN IF NOT EXISTS seq_decision_at        timestamptz,
  ADD COLUMN IF NOT EXISTS seq_decision_resume_at timestamptz,
  ADD COLUMN IF NOT EXISTS seq_decision_reason    text,
  ADD COLUMN IF NOT EXISTS seq_decision_confidence numeric(3,2);

-- Check the decision value is one of the known buckets when set.
ALTER TABLE outreach_pipeline
  ADD CONSTRAINT outreach_pipeline_seq_decision_check
  CHECK (seq_decision IS NULL OR seq_decision IN ('stop','pause_until','reroute_email','reroute_call','continue'));

COMMENT ON COLUMN outreach_pipeline.seq_decision IS
  'AI-decided sequence reaction to the latest inbound reply. Set by ai-triage-reply, read by outreach-engagement-tick. NULL = no decision yet (engine falls back to default replied-exclude behavior).';

COMMENT ON COLUMN outreach_pipeline.seq_decision_resume_at IS
  'When seq_decision=pause_until, the timestamp to resume the sequence at.';

COMMENT ON COLUMN outreach_pipeline.seq_decision_confidence IS
  'Haiku confidence in the decision (0.0-1.0). Engine may apply a threshold below which the decision degrades to safe-stop.';

-- Index for the engine: leads with an active decision that need to be
-- evaluated separately from the normal scan path.
CREATE INDEX IF NOT EXISTS outreach_pipeline_seq_decision_idx
  ON outreach_pipeline (seq_decision)
  WHERE seq_decision IS NOT NULL;
