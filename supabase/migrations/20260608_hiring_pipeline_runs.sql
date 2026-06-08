-- Run log for the hiring-signal daily pipeline. Each row = one execution of
-- run_hiring_pipeline.sh (cron or manual). Surfaced in /outreach so Louis can
-- follow what the automation did without reading CI logs.
-- Applied via supabase MCP apply_migration on 2026-06-08; file mirrors for repo.
create table if not exists public.hiring_pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  ran_at timestamptz not null default now(),
  trigger text not null default 'manual',          -- 'cron' | 'manual'
  companies_found int default 0,                    -- unique companies after tier filter
  decision_makers int default 0,                    -- enriched DMs found
  leads_staged int default 0,                       -- new rows into outreach_leads
  leads_added_sendpilot int default 0,              -- net-new added to the campaign
  skipped_existing int default 0,                   -- already in CarterCo (dedup)
  skipped_cross_workspace int default 0,            -- owned by another workspace (not clobbered)
  unresolved int default 0,                         -- encoded URLs that didn't resolve (held back)
  status text not null default 'ok',                -- 'ok' | 'error'
  error text,
  detail jsonb,                                     -- per-company picks for the UI
  created_at timestamptz not null default now()
);
comment on table public.hiring_pipeline_runs is
  'One row per run of the hiring-signal pipeline (run_hiring_pipeline.sh). Read by /outreach Hiring-signal tab to show daily run history + what was added.';
create index if not exists hiring_pipeline_runs_ran_at_idx on public.hiring_pipeline_runs (ran_at desc);
