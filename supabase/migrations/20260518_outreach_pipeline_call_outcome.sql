-- Call-outcome tracking on outreach_pipeline, mirroring the model in
-- public.leads (used by /leads UI). Enables I dag to surface accepted leads
-- with phones as callable items, route them through outcome states, and
-- hide/re-surface based on outcome.
--
-- Outcome enum (text, validated client-side, matches /leads conventions):
--   'no_answer'       — tried, no pickup. Re-surfaces next business day.
--   'left_voicemail'  — tried, left voicemail. Re-surfaces in 3 business days.
--   'answered'        — spoke briefly, neutral. Stays in queue, bumped priority.
--   'callback'        — scheduled follow-up. Re-surfaces at callback_at.
--   'interested'      — warm. Promotes to top.
--   'not_interested'  — drop. Hidden from queue.
--   'booked'          — meeting scheduled. Hidden from queue, tracked as outcome.
--   'unqualified'     — not a fit. Hidden from queue.

alter table public.outreach_pipeline
  add column if not exists call_outcome text,
  add column if not exists call_outcome_at timestamptz,
  add column if not exists last_called_at timestamptz,
  add column if not exists callback_at timestamptz,
  add column if not exists call_notes text;
