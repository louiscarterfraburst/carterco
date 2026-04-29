-- Multi-tenant cutover. Step 2 of 2 (step 1 = workspaces.sql).
--
-- This migration:
--   A. Fills schema gaps: adds workspace_id to push_subscriptions and
--      outreach_engagement_actions (workspaces.sql added it everywhere else).
--   B. Replaces every email-allowlist RLS policy with a workspace-membership
--      predicate using public.auth_workspace_ids().
--   C. Tightens the public leads insert policy so anonymous submissions can
--      only target the CarterCo workspace.
--
-- Idempotent / re-runnable. Run AFTER workspaces.sql so all existing rows
-- already have workspace_id populated.

-- ---------------------------------------------------------------------------
-- Helper: stable lookup of the CarterCo workspace UUID. Used by the public
-- leads insert policy. Defined as a function (rather than hardcoded) so the
-- migration is portable across environments where CarterCo's UUID differs.
-- Resolves by owner_email which is set by workspaces.sql seed/trigger.
-- ---------------------------------------------------------------------------
-- security definer so anonymous callers (the public lead form RLS check) can
-- resolve the UUID even though workspaces RLS only allows authenticated members.
create or replace function public.carterco_workspace_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
    select id from public.workspaces where owner_email = 'louis@carterco.dk' limit 1;
$$;

grant execute on function public.carterco_workspace_id() to public, anon, authenticated;

-- ===========================================================================
-- A. Schema gaps
-- ===========================================================================

-- A1. push_subscriptions
alter table public.push_subscriptions
    add column if not exists workspace_id uuid references public.workspaces(id);

create index if not exists idx_push_subscriptions_workspace
    on public.push_subscriptions(workspace_id);

-- Backfill: derive workspace_id from the user_id (auth.users) → email →
-- workspace_members membership. Anything ambiguous gets the CarterCo
-- workspace as a safe default (matches the original single-tenant behaviour).
update public.push_subscriptions ps
   set workspace_id = wm.workspace_id
  from auth.users u
  join public.workspace_members wm on wm.user_email = u.email
 where ps.user_id = u.id
   and ps.workspace_id is null;

update public.push_subscriptions
   set workspace_id = public.carterco_workspace_id()
 where workspace_id is null;

-- A2. outreach_engagement_actions
alter table public.outreach_engagement_actions
    add column if not exists workspace_id uuid references public.workspaces(id);

create index if not exists idx_outreach_engagement_actions_workspace
    on public.outreach_engagement_actions(workspace_id);

-- Backfill via outreach_pipeline (1:1 on sendpilot_lead_id).
update public.outreach_engagement_actions a
   set workspace_id = p.workspace_id
  from public.outreach_pipeline p
 where a.sendpilot_lead_id = p.sendpilot_lead_id
   and a.workspace_id is null;

-- ===========================================================================
-- B. RLS cutover — replace email allowlists with workspace membership
-- ===========================================================================

-- B1. leads -----------------------------------------------------------------
-- Authenticated read/update: collapse the two old "CarterCo can …" policies
-- into a single ALL policy gated on workspace membership. Public insert/draft
-- policies stay open but require the CarterCo workspace UUID.
drop policy if exists "CarterCo can read leads"   on public.leads;
drop policy if exists "CarterCo can update leads" on public.leads;
drop policy if exists leads_workspace_all         on public.leads;

create policy leads_workspace_all on public.leads
    for all to authenticated
    using (workspace_id in (select public.auth_workspace_ids()))
    with check (workspace_id in (select public.auth_workspace_ids()));

-- Tighten public-form policies to require CarterCo's workspace_id.
drop policy if exists "Anyone can submit CarterCo leads" on public.leads;
drop policy if exists "Anyone can save draft leads"      on public.leads;
drop policy if exists "Anyone can update draft leads"    on public.leads;
drop policy if exists "Anyone can delete draft leads"    on public.leads;

create policy "Anyone can submit CarterCo leads"
    on public.leads
    for insert
    to public
    with check (
        is_draft = false
        and source = 'carterco.dk'
        and workspace_id = public.carterco_workspace_id()
        and length(trim(name)) >= 2
        and length(trim(company)) >= 2
        and email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]{2,}$'
        and length(regexp_replace(phone, '[^0-9]', '', 'g')) between 8 and 15
        and (
            monthly_leads is null
            or monthly_leads in ('Under 50', '50–250', '250–1.000', '1.000+')
        )
        and (
            response_time is null
            or response_time in ('Under 5 min', '5–30 min', '30 min – 2 timer', 'Mere end 2 timer', 'Ved ikke')
        )
    );

create policy "Anyone can save draft leads"
    on public.leads
    for insert
    to public
    with check (
        is_draft = true
        and source = 'carterco.dk'
        and workspace_id = public.carterco_workspace_id()
        and draft_session_id is not null
        and (
            coalesce(email, '') <> ''
            or length(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g')) >= 4
        )
    );

create policy "Anyone can update draft leads"
    on public.leads
    for update
    to public
    using (is_draft = true and workspace_id = public.carterco_workspace_id())
    with check (
        is_draft = true
        and source = 'carterco.dk'
        and workspace_id = public.carterco_workspace_id()
    );

create policy "Anyone can delete draft leads"
    on public.leads
    for delete
    to public
    using (is_draft = true and workspace_id = public.carterco_workspace_id());

-- B2. outreach_leads, outreach_events, outreach_pipeline, outreach_replies --
drop policy if exists outreach_leads_owner_all    on public.outreach_leads;
drop policy if exists outreach_events_owner_all   on public.outreach_events;
drop policy if exists outreach_pipeline_owner_all on public.outreach_pipeline;
drop policy if exists outreach_replies_owner_all  on public.outreach_replies;
drop policy if exists outreach_leads_workspace_all    on public.outreach_leads;
drop policy if exists outreach_events_workspace_all   on public.outreach_events;
drop policy if exists outreach_pipeline_workspace_all on public.outreach_pipeline;
drop policy if exists outreach_replies_workspace_all  on public.outreach_replies;

create policy outreach_leads_workspace_all on public.outreach_leads
    for all to authenticated
    using (workspace_id in (select public.auth_workspace_ids()))
    with check (workspace_id in (select public.auth_workspace_ids()));

create policy outreach_events_workspace_all on public.outreach_events
    for all to authenticated
    using (workspace_id in (select public.auth_workspace_ids()))
    with check (workspace_id in (select public.auth_workspace_ids()));

create policy outreach_pipeline_workspace_all on public.outreach_pipeline
    for all to authenticated
    using (workspace_id in (select public.auth_workspace_ids()))
    with check (workspace_id in (select public.auth_workspace_ids()));

create policy outreach_replies_workspace_all on public.outreach_replies
    for all to authenticated
    using (workspace_id in (select public.auth_workspace_ids()))
    with check (workspace_id in (select public.auth_workspace_ids()));

-- B3. push_subscriptions ----------------------------------------------------
-- outreach.sql created a duplicate, more permissive policy that overrides
-- notifications.sql. Drop both and re-create one workspace-scoped policy.
drop policy if exists "CarterCo can manage push subscriptions" on public.push_subscriptions;
drop policy if exists push_subscriptions_owner_all              on public.push_subscriptions;
drop policy if exists push_subscriptions_workspace_all          on public.push_subscriptions;

create policy push_subscriptions_workspace_all on public.push_subscriptions
    for all to authenticated
    using (workspace_id in (select public.auth_workspace_ids()))
    with check (workspace_id in (select public.auth_workspace_ids()));

-- B4. outreach_engagement_actions -------------------------------------------
drop policy if exists outreach_engagement_actions_owner_all     on public.outreach_engagement_actions;
drop policy if exists outreach_engagement_actions_workspace_all on public.outreach_engagement_actions;

create policy outreach_engagement_actions_workspace_all on public.outreach_engagement_actions
    for all to authenticated
    using (workspace_id in (select public.auth_workspace_ids()))
    with check (workspace_id in (select public.auth_workspace_ids()));

-- B5. user_settings ---------------------------------------------------------
-- Keep per-user gating but drop the email allowlist clause.
drop policy if exists user_settings_self on public.user_settings;
create policy user_settings_self on public.user_settings
    for all to authenticated
    using ((auth.jwt() ->> 'email') = user_email)
    with check ((auth.jwt() ->> 'email') = user_email);
