-- The "play" axis: a second scoping dimension on /outreach, orthogonal to
-- workspace. A workspace (e.g. CarterCo) runs SEVERAL distinct outbound plays
-- concurrently — the SendPilot→SendSpark video loop, the hiring-signal
-- foot-in-the-door play, mystery-shop, ad-leak — each with its own intake and
-- sequence, but all monitored in one cockpit. Until now every intake dumped
-- into the same outreach_pipeline with no way to tell them apart.
--
-- This mirrors the per-workspace pattern that already runs through the engine
-- (outreach_sequences, the tick engine, the UI workspace dropdown): `play` is
-- the same move on a new axis. Model is "single current play per lead"
-- (concurrent plays, not yet contact-flows-between-plays); a future
-- contact_plays history table can layer sequential hand-off on top without
-- changing this column.
--
-- Applied via supabase MCP apply_migration on 2026-06-06. This file mirrors the
-- change for repo traceability — running it on a fresh DB reproduces prod.

-- 1. The play tag on each worked lead. Default 'video_loop' so every existing
--    row keeps its current behaviour (nothing reads `play` until Phase 2, so
--    this is a pure no-op tag at apply time). No CHECK constraint — valid plays
--    live in the registry below so they can be added without a migration.
alter table public.outreach_pipeline
  add column if not exists play text not null default 'video_loop';

comment on column public.outreach_pipeline.play is
  'Which outbound play this lead belongs to (orthogonal to workspace_id). Valid values come from outreach_plays.id, not a CHECK, so plays are addable without a migration. Default video_loop = the legacy SendPilot→SendSpark motion. Stamped at intake by each webhook/script.';

create index if not exists outreach_pipeline_play_idx
  on public.outreach_pipeline (workspace_id, play);

-- 2. The play registry. NULL workspace_id = global play available to all;
--    a row with a real workspace_id is a workspace-specific play. Mirrors
--    outreach_sequences resolution exactly.
create table if not exists public.outreach_plays (
  id                   text not null,
  workspace_id         uuid references workspaces(id) on delete cascade,
  label                text not null,
  description          text not null default '',
  intake               text not null default '',
  trigger_sequence_id  text,
  status               text not null default 'active'
                         check (status in ('active', 'paused')),
  position             int not null default 100,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on table public.outreach_plays is
  'Outbound play registry — the distinct motions a workspace runs concurrently. workspace_id NULL = global. trigger_sequence_id names the sequence (in outreach_sequences) a lead in this play enrols into. Resolution mirrors outreach_sequences: workspace-specific overrides global by matching id.';
comment on column public.outreach_plays.intake is
  'Human-readable note on where leads in this play come from (e.g. "Apify job-search → enrich → sample"). Documentation, not wiring.';
comment on column public.outreach_plays.trigger_sequence_id is
  'Default outreach_sequences.id a lead in this play enrols into. NULL = uses the existing signal-triggered globals (video_loop relies on watched/unwatched_followup_v1).';

create unique index if not exists outreach_plays_global_uniq
  on public.outreach_plays (id) where workspace_id is null;
create unique index if not exists outreach_plays_workspace_uniq
  on public.outreach_plays (workspace_id, id) where workspace_id is not null;
create index if not exists outreach_plays_active_idx
  on public.outreach_plays (workspace_id, position) where status = 'active';

create or replace function set_outreach_plays_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger outreach_plays_set_updated_at
  before update on public.outreach_plays
  for each row execute function set_outreach_plays_updated_at();

alter table public.outreach_plays enable row level security;

create policy "read global + own workspace plays"
  on public.outreach_plays
  for select
  to authenticated
  using (
    workspace_id is null
    or exists (
      select 1 from workspace_members wm
      where wm.workspace_id = outreach_plays.workspace_id
        and wm.user_email = auth.jwt() ->> 'email'
    )
  );

-- 3. Seed the two live plays as globals. video_loop carries every existing
--    lead (matches the column default); hiring_signal is the new motion, whose
--    sequence (hiring_signal_v1) gets created in Phase 2.
insert into public.outreach_plays (id, workspace_id, label, description, intake, trigger_sequence_id, status, position) values
  ('video_loop', null, 'Video-loop',
   'LinkedIn invite → on accept render a personalised SendSpark video → DM it, then engagement-driven follow-ups.',
   'SendPilot / lemlist LinkedIn invite', null, 'active', 100),
  ('hiring_signal', null, 'Hiring-signal',
   'Detect a company that just posted a sales/SDR role, pull a sample of their buyers, open with "5 of your buyers + the DMs I''d send."',
   'Apify linkedin-job-search → apify_enrich_brands → sample', 'hiring_signal_v1', 'active', 200)
on conflict do nothing;
