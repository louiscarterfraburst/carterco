-- Workspace-scoping pass on the Plays/Flow vertical (code-review 2026-06-11).
-- The hiring-signal stack (run log table, registry row, UI panel) was built
-- single-tenant and then surfaced in the multi-tenant /outreach cockpit:
--   1. hiring_pipeline_runs had no workspace_id and RLS `using (true)`, so any
--      authenticated member of ANY workspace could read CarterCo's run log
--      (including per-company picks in `detail`) straight off the REST API.
--   2. The hiring_signal play was seeded GLOBAL (workspace_id null), so it
--      resolved into every workspace's Plays tab — and pausing it for one
--      tenant would pause queued hiring_signal sends for all of them.
--   3. Which-runs-panel-to-show was a hardcoded `play.id === 'hiring_signal'`
--      literal in page.tsx, the exact pattern the registry exists to remove.
--   4. Per-workspace outreach style (video_render vs ai_drafted_dm) lived as
--      duplicate hardcoded UUID maps in client-config/route.ts and id-equality
--      branches in sendpilot-webhook ("update both files" — and prod has 7
--      workspaces, the maps knew 4).
--
-- Pre-checked on prod 2026-06-11: every outreach_pipeline (42) and
-- outreach_leads (61) row tagged hiring_signal belongs to CarterCo, so
-- scoping the registry row breaks no existing rows.

-- 1. hiring_pipeline_runs → workspace-scoped -----------------------------------

-- Default CarterCo: the only writer (run_hiring_pipeline.sh via service role)
-- is the CarterCo pipeline and predates the column. Existing rows are filled
-- by the default at ADD COLUMN time. A second tenant's intake must stamp its
-- own workspace_id explicitly.
alter table public.hiring_pipeline_runs
  add column if not exists workspace_id uuid
    references workspaces(id) on delete cascade
    not null
    default '1e067f9a-d453-41a7-8bc4-9fdb5644a5fa';

comment on column public.hiring_pipeline_runs.workspace_id is
  'Tenant that ran this intake pipeline. Defaults to CarterCo because the original writer (run_hiring_pipeline.sh) predates the column; new intake writers must stamp explicitly.';

create index if not exists hiring_pipeline_runs_ws_ran_at_idx
  on public.hiring_pipeline_runs (workspace_id, ran_at desc);

-- Replace the authenticated-can-read-everything policy with membership scoping
-- (same pattern as outreach_plays). The pipeline writes via service role,
-- which bypasses RLS, so the writer needs no policy.
drop policy if exists hiring_pipeline_runs_auth_read on public.hiring_pipeline_runs;
create policy hiring_pipeline_runs_member_read
  on public.hiring_pipeline_runs for select to authenticated
  using (
    exists (
      select 1 from workspace_members wm
      where wm.workspace_id = hiring_pipeline_runs.workspace_id
        and wm.user_email = auth.jwt() ->> 'email'
    )
  );

-- 2. Intake-runs linkage as registry data --------------------------------------

-- Replaces the hardcoded `play.id === 'hiring_signal'` panel gate in
-- src/app/outreach/page.tsx. A play whose intake writes hiring_pipeline_runs
-- rows opts in here; the UI renders the runs panel for any play with the flag.
alter table public.outreach_plays
  add column if not exists has_intake_runs boolean not null default false;

comment on column public.outreach_plays.has_intake_runs is
  'Whether this play''s intake automation logs to hiring_pipeline_runs. The /outreach Plays tab shows the daily-runs panel for plays with this flag — no play-name literals in the UI.';

update public.outreach_plays
   set has_intake_runs = true
 where id = 'hiring_signal';

-- 3. hiring_signal is a CarterCo play, not a global ----------------------------

-- The motion's intake scripts (load_hiring_batch.py etc.) stage exclusively
-- into CarterCo, and its dm_template signs off as Louis. As a global it
-- surfaced as an "Aktiv" play in every tenant's cockpit and made its pause
-- state shared across tenants.
update public.outreach_plays
   set workspace_id = '1e067f9a-d453-41a7-8bc4-9fdb5644a5fa'
 where id = 'hiring_signal' and workspace_id is null;

-- 4. Outreach style is workspace data ------------------------------------------

-- Single source of truth for "how does this client's first message work",
-- read by client-config/route.ts AND sendpilot-webhook — replaces the
-- duplicated UUID maps / id-equality branches.
alter table public.workspaces
  add column if not exists outreach_style text not null default 'video_render'
    check (outreach_style in ('video_render', 'ai_drafted_dm')),
  add column if not exists brief_slug text;

comment on column public.workspaces.outreach_style is
  'First-message mechanism for this tenant: video_render = SendSpark video then DM; ai_drafted_dm = Claude drafts the DM from the agent brief. Read by sendpilot-webhook (routing) and /api/outreach/client-config (display).';
comment on column public.workspaces.brief_slug is
  'Slug under clients/<slug>/agent-brief.md for ai_drafted_dm tenants. NULL = no agent brief.';

update public.workspaces
   set outreach_style = 'ai_drafted_dm',
       brief_slug = 'odagroup'
 where id = 'cdfd80d8-33bb-4b64-b778-0a2c5ab78cc6';

-- 5. Per-workspace sender identity for operator handoffs ------------------------

-- The Signaler SMS/mailto templates in /outreach introduced the sender as the
-- logged-in OPERATOR's user_settings identity ("det er Louis fra Carter & Co"
-- + Louis's cal.com link) regardless of which client workspace was active.
-- The voice playbook is the per-workspace identity store (owner_first_name,
-- booking_link already live there); the outbound brand name joins it, since
-- workspaces.name is an internal label ("CarterCo"), not outbound copy.
alter table public.outreach_voice_playbooks
  add column if not exists company_display_name text;

comment on column public.outreach_voice_playbooks.company_display_name is
  'How the company is written in outbound copy ("Carter & Co"), where workspaces.name is the internal label ("CarterCo"). NULL = use workspaces.name.';

update public.outreach_voice_playbooks
   set company_display_name = 'Carter & Co',
       booking_link = coalesce(booking_link, 'https://cal.com/louis-carter-3twilu/20min')
 where workspace_id = '1e067f9a-d453-41a7-8bc4-9fdb5644a5fa';

update public.outreach_voice_playbooks
   set company_display_name = 'Oda Group'
 where workspace_id = 'cdfd80d8-33bb-4b64-b778-0a2c5ab78cc6';
