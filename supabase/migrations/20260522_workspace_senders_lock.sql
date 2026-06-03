-- Lock the workspace ↔ SendPilot sender mapping so a message can never go
-- out from the wrong account. Two layers:
--
--   1. workspace_senders table = source of truth for which LinkedIn account
--      represents which workspace. Populated from current data; updates
--      require explicit DB writes (no implicit inference).
--
--   2. Trigger on outreach_pipeline rejects any insert/update that sets
--      sendpilot_sender_id to a value not registered for the row's
--      workspace_id. Cross-workspace stamping becomes impossible at the
--      DB level — catches bad scripts, bad imports, and code bugs.
--
-- Helper function `canonical_sender_for(workspace_id)` is what send-path
-- code calls to get the right sender regardless of what's stamped on
-- the pipeline row. Defense in depth against legacy data drift.

create table if not exists public.workspace_senders (
  workspace_id        uuid not null references public.workspaces(id) on delete cascade,
  sendpilot_sender_id text not null,
  label               text,
  is_active           boolean not null default true,
  added_at            timestamptz not null default now(),
  primary key (workspace_id, sendpilot_sender_id)
);

alter table public.workspace_senders enable row level security;
drop policy if exists workspace_senders_read on public.workspace_senders;
create policy workspace_senders_read on public.workspace_senders
  for select to authenticated
  using (workspace_id in (select public.auth_workspace_ids()));

-- Seed from current production data. Each workspace's one active sender.
insert into public.workspace_senders (workspace_id, sendpilot_sender_id, label, is_active)
values
  ('1e067f9a-d453-41a7-8bc4-9fdb5644a5fa', 'cmobiza7x09mh6501dkb31v6g', 'CarterCo / Louis', true),
  ('2740ba1f-d5d5-4008-bf43-b45367c73134', 'cmocmbiyv059s5m018frvw5qv', 'Tresyv / Rasmus',  true),
  ('cdfd80d8-33bb-4b64-b778-0a2c5ab78cc6', 'cmp6qrugl00ay1q01oexjabai', 'OdaGroup / Niels', true)
on conflict (workspace_id, sendpilot_sender_id) do nothing;

-- Helper: returns the active sender_id for a workspace, or null.
-- Send-path code calls this and uses the result as the source of truth.
create or replace function public.canonical_sender_for(p_workspace_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select sendpilot_sender_id
  from public.workspace_senders
  where workspace_id = p_workspace_id and is_active = true
  order by added_at desc
  limit 1;
$$;

grant execute on function public.canonical_sender_for(uuid) to authenticated, anon, service_role;

-- Trigger: any insert/update of outreach_pipeline that sets a
-- sendpilot_sender_id MUST match a workspace_senders row for the same
-- workspace_id. Null sender_id is allowed (lead not yet sent).
create or replace function public.assert_pipeline_sender_matches_workspace()
returns trigger
language plpgsql
as $$
begin
  if new.sendpilot_sender_id is null then
    return new;
  end if;
  if not exists (
    select 1 from public.workspace_senders ws
    where ws.workspace_id = new.workspace_id
      and ws.sendpilot_sender_id = new.sendpilot_sender_id
  ) then
    raise exception
      'sender % is not registered for workspace % (see workspace_senders table)',
      new.sendpilot_sender_id, new.workspace_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_pipeline_sender_matches_workspace on public.outreach_pipeline;
create trigger trg_pipeline_sender_matches_workspace
  before insert or update of sendpilot_sender_id, workspace_id
  on public.outreach_pipeline
  for each row
  execute function public.assert_pipeline_sender_matches_workspace();
