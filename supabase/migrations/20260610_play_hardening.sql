-- Play hardening: every contacted lead is registered with a play, and play
-- behaviour lives in the outreach_plays registry instead of hardcoded string
-- checks scattered through the edge functions.
--
-- Before this migration the guarantee was fake: outreach_pipeline.play was
-- NOT NULL, but only because of a hardcoded `default 'video_loop'` — ~15
-- upsert paths in sendpilot-poll / sendpilot-webhook / lemlist-webhook never
-- set play, so hiring_signal leads were silently mistagged video_loop until
-- (and only if) outreach-approve re-derived the tag at approval time.
--
-- After this migration:
--   1. The DEFAULT play is registry data (outreach_plays.is_default), not a
--      column default. Column defaults are dropped on all three tables.
--   2. A BEFORE trigger resolves a missing play to the registry default and
--      REJECTS plays that aren't registered in outreach_plays — a typo'd play
--      fails loudly instead of minting a phantom play.
--   3. Play behaviour the functions used to branch on by name
--      (play === 'hiring_signal') becomes registry config: dm_template and
--      use_personalized_hook. New plays need a registry row, zero code.
--   4. One-time backfill repairs pipeline rows mistagged by the old default.
--
-- Applied via supabase MCP apply_migration on 2026-06-10 (plus the
-- play_hardening_review_fixes follow-up the same day, folded in here). This
-- file mirrors prod for repo traceability. NOTE on "fresh DB": this migration
-- assumes the out-of-band base schema (supabase/outreach.sql, workspaces.sql,
-- and the lead_inbox table, which has no CREATE TABLE in the repo) has been
-- applied first — migrations/ alone does not bootstrap a fresh database.
--
-- Rollback (order is load-bearing — restore defaults BEFORE dropping
-- triggers, or every play-less webhook insert violates NOT NULL):
--   1. alter table ... alter column play set default 'video_loop'  (x3 tables)
--   2. drop the three *_resolve_play triggers + outreach_resolve_play()
--   3. restore the 20260606_play_on_leads.sql outreach_record_invite body
--   4. drop function outreach_default_play(uuid)
--   5. optionally drop the registry columns added in section 1
--
-- The outreach_plays UPDATEs below are point-in-time SEEDS of operator-owned
-- data: the live rows are edited at runtime (e.g. dm_template). Replaying this
-- file overwrites live edits — re-sync the seeds before replaying.

-- 1. Behaviour config on the registry -----------------------------------------

alter table public.outreach_plays
  add column if not exists is_default boolean not null default false,
  add column if not exists dm_template text,
  add column if not exists use_personalized_hook boolean not null default true,
  add column if not exists auto_render boolean not null default false;

comment on column public.outreach_plays.auto_render is
  'Whether a cold accept fires the SendSpark render immediately instead of parking in pending_pre_render for manual operator release. Default false (manual gate).';

comment on column public.outreach_plays.is_default is
  'The play a lead falls back to when its enrichment row carries none. Resolution mirrors outreach_sequences: workspace-specific default overrides the global one. Enforced unique per scope by partial indexes.';
comment on column public.outreach_plays.dm_template is
  'First-DM template for this play (placeholders: {firstName} {company} {website} {role} {videoLink}). NULL = use the workspace/campaign default path (OUTREACH_TEMPLATE_<campaignId> env override still wins either way). Replaces the hardcoded HIRING_TEMPLATE_DEFAULT branch in sendspark-webhook.';
comment on column public.outreach_plays.use_personalized_hook is
  'Whether leads in this play get the Becc bucket-hook personalization (enrich-buckets + personalized_hook at render time). false for plays with their own opener (hiring_signal: the bucket generator bakes in the banned "testede jeres lead-flow" claim). Replaces play === ''hiring_signal'' checks in sendpilot-webhook / sendspark-webhook / lemlist-webhook.';

-- At most one default play per scope (one global, one per workspace).
create unique index if not exists outreach_plays_default_global_uniq
  on public.outreach_plays ((1)) where is_default and workspace_id is null;
create unique index if not exists outreach_plays_default_workspace_uniq
  on public.outreach_plays (workspace_id) where is_default and workspace_id is not null;

-- Seed: video_loop is the global default (that's what the old column default
-- meant); hiring_signal gets its job-posting template + no bucket hook. These
-- literals are registry DATA — the application code no longer carries them.
update public.outreach_plays
   set is_default = true
 where id = 'video_loop' and workspace_id is null;

update public.outreach_plays
   set use_personalized_hook = false,
       dm_template = E'Hej {firstName}\n\nSå, at I har slået en {role} op. Fedt at der er gang i den.\n\nJeg bygger systemerne rundt om salgsteams, så bliver altid nysgerrig på, hvor meget af arbejdet omkring rollen der stadig bliver gjort manuelt.\n\nJeg optog en kort video med et par tanker:\n{videoLink}\n\nMvh\nLouis'
 where id = 'hiring_signal' and workspace_id is null;

-- 2. Default-play resolution --------------------------------------------------

-- Workspace-specific default wins over global; among equals, lowest position.
-- security definer so the resolving trigger works regardless of the caller's
-- RLS visibility into outreach_plays. Deliberately does NOT filter on status:
-- a paused default play must still resolve for tagging — pausing stops sends,
-- it must never break intake inserts.
--
-- CAUTION (unencoded semantics): introducing the FIRST workspace-specific
-- default play retroactively changes what "still-default tag" means for that
-- workspace's existing rows (record_invite/approve upgrade rules) and what the
-- UI staged query excludes. Decide + backfill before seeding one.
create or replace function public.outreach_default_play(ws uuid)
returns text
language sql stable
security definer
set search_path = public
as $$
  select id from public.outreach_plays
  where is_default
    and (workspace_id = ws or workspace_id is null)
  order by workspace_id nulls last, position
  limit 1
$$;

comment on function public.outreach_default_play(uuid) is
  'The play a lead falls back to when none is supplied. Registry-driven replacement for the old hardcoded ''video_loop'' column default.';

-- SECURITY DEFINER + PostgREST would otherwise expose this to anon RPC.
revoke all on function public.outreach_default_play(uuid) from public, anon;
grant execute on function public.outreach_default_play(uuid) to authenticated, service_role;

-- 3. Resolve-and-validate trigger ---------------------------------------------

-- Fills a missing play from the registry default and rejects unregistered
-- plays. Runs before the NOT NULL check, so inserts that omit play still
-- succeed — but the default now comes from data, not a literal.
create or replace function public.outreach_resolve_play()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- No-op updates skip validation: upserts include play in their ON CONFLICT
  -- SET list even when the value is preserved, and a legacy row carrying an
  -- unregistered play must not poison every future update to itself.
  if tg_op = 'UPDATE' and new.play is not distinct from old.play then
    return new;
  end if;
  if new.play is null or new.play = '' then
    new.play := public.outreach_default_play(new.workspace_id);
    if new.play is null then
      raise exception 'no play supplied and no default play configured for workspace % — set outreach_plays.is_default', new.workspace_id;
    end if;
  end if;
  if not exists (
    select 1 from public.outreach_plays pl
    where pl.id = new.play
      and (pl.workspace_id is null or pl.workspace_id = new.workspace_id)
  ) then
    raise exception 'unknown play "%" — register it in outreach_plays first', new.play;
  end if;
  return new;
end $$;

drop trigger if exists outreach_pipeline_resolve_play on public.outreach_pipeline;
create trigger outreach_pipeline_resolve_play
  before insert or update of play on public.outreach_pipeline
  for each row execute function public.outreach_resolve_play();

drop trigger if exists outreach_leads_resolve_play on public.outreach_leads;
create trigger outreach_leads_resolve_play
  before insert or update of play on public.outreach_leads
  for each row execute function public.outreach_resolve_play();

drop trigger if exists lead_inbox_resolve_play on public.lead_inbox;
create trigger lead_inbox_resolve_play
  before insert or update of play on public.lead_inbox
  for each row execute function public.outreach_resolve_play();

-- 4. Drop the hardcoded column defaults ---------------------------------------

alter table public.outreach_pipeline alter column play drop default;
alter table public.outreach_leads    alter column play drop default;
alter table public.lead_inbox       alter column play drop default;

comment on column public.outreach_pipeline.play is
  'Which outbound play this lead belongs to (orthogonal to workspace_id). Stamped explicitly at intake by each webhook/script; a missing value resolves to the registry default (outreach_plays.is_default) and unregistered values are rejected — both via the outreach_resolve_play trigger. No hardcoded default.';

comment on column public.lead_inbox.play is
  'Play tag for staged leads. Carried into outreach_leads by promoteFromInbox (sendpilot-webhook) since 2026-06-10, so plays can stage via lead_inbox instead of pre-seeding outreach_leads.';

-- 5. outreach_record_invite: registry-driven default --------------------------

-- Same shape as before, but no 'video_loop' literals: the insert passes the
-- lead's play through (trigger resolves NULL to the registry default), and the
-- re-invite rule "only upgrade a still-default tag" compares against the
-- registry default for the row's workspace.
-- KEEP IN SYNC with the copy in supabase/workspaces.sql (fresh-DB bootstrap
-- mirror) — editing one without the other drifts the mirror from prod.
create or replace function public.outreach_record_invite(
    _lead_id text,
    _linkedin_url text,
    _contact_email text,
    _invited_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    ws_id uuid;
    lead_play text;
begin
    select workspace_id, play into ws_id, lead_play
    from public.outreach_leads
    where contact_email = coalesce(nullif(_contact_email, ''), contact_email)
       or sendpilot_lead_id = _lead_id
    limit 1;

    insert into public.outreach_pipeline
        (sendpilot_lead_id, linkedin_url, contact_email, status, invited_at, workspace_id, play)
    values
        (_lead_id, _linkedin_url, coalesce(_contact_email, ''), 'invited', _invited_at,
         ws_id, lead_play)
    on conflict (sendpilot_lead_id) do update set
        invited_at    = coalesce(public.outreach_pipeline.invited_at, excluded.invited_at),
        linkedin_url  = excluded.linkedin_url,
        contact_email = case when public.outreach_pipeline.contact_email = ''
                              then excluded.contact_email
                              else public.outreach_pipeline.contact_email end,
        workspace_id  = coalesce(public.outreach_pipeline.workspace_id, excluded.workspace_id),
        play          = case when public.outreach_pipeline.play
                                  = public.outreach_default_play(public.outreach_pipeline.workspace_id)
                              then excluded.play
                              else public.outreach_pipeline.play end;
end $$;

-- 6. One-time backfill of mistagged pipeline rows ------------------------------

-- Rows created by the poll/webhook upserts before this migration kept the old
-- column default even when their enrichment row carried a real play (and were
-- only repaired if the operator approved them). The 'video_loop' literal here
-- is data repair against the pre-migration default, not a code path.
-- ONE-TIME repair (ran 2026-06-10, 0 rows): on replay it cannot distinguish
-- "mistagged by the old default" from "explicitly tagged video_loop", so don't
-- re-run it against post-migration data. The exists() guard keeps a replay
-- from aborting on legacy lead rows whose play was never registered.
update public.outreach_pipeline p
   set play = l.play
  from public.outreach_leads l
 where (l.sendpilot_lead_id = p.sendpilot_lead_id
        or (p.contact_email <> '' and l.contact_email = p.contact_email))
   and p.play = 'video_loop'
   and l.play is distinct from p.play
   and exists (select 1 from public.outreach_plays pl where pl.id = l.play);
