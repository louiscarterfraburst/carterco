-- Multi-tenant workspaces foundation. Step 1 of the cutover: schema +
-- backfill + auto-create trigger. RLS is NOT yet tightened to filter by
-- workspace — that's the final step after every webhook insert path is
-- updated to set workspace_id. This file is idempotent and re-runnable.

create table if not exists public.workspaces (
    id          uuid primary key default gen_random_uuid(),
    name        text not null,
    owner_email text not null,
    created_at  timestamptz not null default now()
);

create table if not exists public.workspace_members (
    workspace_id uuid not null references public.workspaces(id) on delete cascade,
    user_email   text not null,
    role         text not null default 'member' check (role in ('owner','member')),
    joined_at    timestamptz not null default now(),
    primary key (workspace_id, user_email)
);

create index if not exists idx_workspace_members_email
    on public.workspace_members(user_email);

-- Helper: workspaces the current JWT user is a member of. Stable so it can
-- be used in RLS policies without recomputing per row.
create or replace function public.auth_workspace_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
    select wm.workspace_id
    from public.workspace_members wm
    where wm.user_email = (auth.jwt() ->> 'email');
$$;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;

drop policy if exists workspaces_self on public.workspaces;
create policy workspaces_self on public.workspaces
    for select to authenticated
    using (id in (select public.auth_workspace_ids()));

drop policy if exists workspace_members_self on public.workspace_members;
create policy workspace_members_self on public.workspace_members
    for select to authenticated
    using (workspace_id in (select public.auth_workspace_ids()));

-- Bootstrap workspaces for the existing humans.
insert into public.workspaces (name, owner_email)
select 'CarterCo', 'louis@carterco.dk'
where not exists (select 1 from public.workspaces where owner_email = 'louis@carterco.dk');

insert into public.workspaces (name, owner_email)
select 'Tresyv', 'rm@tresyv.dk'
where not exists (select 1 from public.workspaces where owner_email = 'rm@tresyv.dk');

insert into public.workspaces (name, owner_email)
select 'Haugefrom', 'haugefrom@haugefrom.com'
where not exists (select 1 from public.workspaces where owner_email = 'haugefrom@haugefrom.com');

insert into public.workspace_members (workspace_id, user_email, role)
select w.id, w.owner_email, 'owner'
from public.workspaces w
on conflict do nothing;

-- Add workspace_id to data tables (nullable for now).
alter table public.leads               add column if not exists workspace_id uuid references public.workspaces(id);
alter table public.outreach_leads      add column if not exists workspace_id uuid references public.workspaces(id);
alter table public.outreach_pipeline   add column if not exists workspace_id uuid references public.workspaces(id);
alter table public.outreach_replies    add column if not exists workspace_id uuid references public.workspaces(id);
alter table public.user_settings       add column if not exists workspace_id uuid references public.workspaces(id);
alter table public.user_busy_intervals add column if not exists workspace_id uuid references public.workspaces(id);

-- outreach_events.workspace_id was previously a TEXT column holding
-- SendPilot's workspaceId from the payload. Rename, then add our own UUID.
do $$ begin
    if exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'outreach_events'
          and column_name = 'workspace_id' and data_type = 'text'
    ) then
        alter table public.outreach_events rename column workspace_id to source_workspace_id;
    end if;
end $$;

alter table public.outreach_events
    add column if not exists workspace_id uuid references public.workspaces(id);

create index if not exists idx_leads_workspace             on public.leads(workspace_id);
create index if not exists idx_outreach_leads_workspace    on public.outreach_leads(workspace_id);
create index if not exists idx_outreach_pipeline_workspace on public.outreach_pipeline(workspace_id);
create index if not exists idx_outreach_events_workspace   on public.outreach_events(workspace_id);
create index if not exists idx_outreach_replies_workspace  on public.outreach_replies(workspace_id);
create index if not exists idx_user_settings_workspace     on public.user_settings(workspace_id);
create index if not exists idx_user_busy_workspace         on public.user_busy_intervals(workspace_id);

-- Backfill: everything currently belongs to Louis's CarterCo workspace.
update public.leads               set workspace_id = (select id from public.workspaces where owner_email='louis@carterco.dk') where workspace_id is null;
update public.outreach_leads      set workspace_id = (select id from public.workspaces where owner_email='louis@carterco.dk') where workspace_id is null;
update public.outreach_pipeline   set workspace_id = (select id from public.workspaces where owner_email='louis@carterco.dk') where workspace_id is null;
update public.outreach_events     set workspace_id = (select id from public.workspaces where owner_email='louis@carterco.dk') where workspace_id is null;
update public.outreach_replies    set workspace_id = (select id from public.workspaces where owner_email='louis@carterco.dk') where workspace_id is null;
update public.user_busy_intervals set workspace_id = (select id from public.workspaces where owner_email='louis@carterco.dk') where workspace_id is null;
update public.user_settings us
   set workspace_id = w.id
   from public.workspaces w
   where us.workspace_id is null
     and us.user_email = w.owner_email;

-- Auth is invite-only from the app (signInWithOtp shouldCreateUser=false).
-- Keep the helper function around for compatibility, but do not attach an
-- auth.users trigger that auto-creates workspaces for arbitrary signups.
create or replace function public.handle_new_user_workspace()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;

-- Update outreach_record_invite to chase workspace_id from outreach_leads.
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
begin
    select workspace_id into ws_id
    from public.outreach_leads
    where contact_email = coalesce(nullif(_contact_email, ''), contact_email)
       or sendpilot_lead_id = _lead_id
    limit 1;

    insert into public.outreach_pipeline
        (sendpilot_lead_id, linkedin_url, contact_email, status, invited_at, workspace_id)
    values
        (_lead_id, _linkedin_url, coalesce(_contact_email, ''), 'invited', _invited_at, ws_id)
    on conflict (sendpilot_lead_id) do update set
        invited_at    = coalesce(public.outreach_pipeline.invited_at, excluded.invited_at),
        linkedin_url  = excluded.linkedin_url,
        contact_email = case when public.outreach_pipeline.contact_email = ''
                              then excluded.contact_email
                              else public.outreach_pipeline.contact_email end,
        workspace_id  = coalesce(public.outreach_pipeline.workspace_id, excluded.workspace_id);
end $$;
