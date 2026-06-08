-- The posted job role on the lead, for the hiring-signal play's {role} merge.
-- Set by hiring_to_outreach_leads.py from the intake's trigger_role; read by
-- sendspark-webhook (first DM) and engagement-rules renderTemplate (follow-ups).
-- Applied via supabase MCP apply_migration on 2026-06-08; file mirrors for repo.
alter table public.outreach_leads add column if not exists role text;
comment on column public.outreach_leads.role is
  'Posted job role (e.g. SDR, salgskonsulent) for the hiring-signal play {role} merge. Null for other plays.';
