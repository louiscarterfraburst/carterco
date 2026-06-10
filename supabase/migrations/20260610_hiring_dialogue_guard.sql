-- Hiring-signal pipeline: company-level dialogue guard.
--
-- Rule (Louis, 2026-06-10): never cold-message the same person twice (the
-- linkedin_url dedupe already enforces that); a DIFFERENT person at the same
-- company is fine — unless someone at that company is in active dialogue.
-- Net-new buyers at in-dialogue companies are HELD by load_hiring_batch.py:
-- not staged, not sent to SendPilot, surfaced in the run record instead.
alter table public.hiring_pipeline_runs
  add column if not exists held_company_dialogue integer not null default 0;

comment on column public.hiring_pipeline_runs.held_company_dialogue is
  'Net-new buyers held (not staged/loaded) because someone at their company is in active dialogue: recent inbound reply, live /leads row, or open deal';
