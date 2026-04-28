create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text,
  company text,
  email text,
  phone text,
  monthly_leads text,
  response_time text,
  source text not null default 'carterco.dk',
  page_url text,
  user_agent text,
  call_status text check (call_status in ('answered', 'no_answer')),
  call_status_at timestamptz,
  outcome text check (outcome in ('booked', 'interested', 'not_interested', 'follow_up', 'unqualified', 'callback', 'customer')),
  outcome_at timestamptz,
  notes text,
  is_draft boolean not null default false,
  draft_session_id text,
  draft_updated_at timestamptz,
  meeting_at timestamptz,
  calendly_event_uri text,
  calendly_invitee_uri text,
  linkedin_url text,
  callback_at timestamptz,
  next_action_at timestamptz,
  next_action_type text check (next_action_type in ('retry', 'callback')),
  retry_count int not null default 0 check (retry_count >= 0 and retry_count <= 4),
  last_action_fired_at timestamptz
);

alter table public.leads alter column name          drop not null;
alter table public.leads alter column company       drop not null;
alter table public.leads alter column email         drop not null;
alter table public.leads alter column phone         drop not null;
alter table public.leads alter column monthly_leads drop not null;
alter table public.leads alter column response_time drop not null;

alter table public.leads add column if not exists call_status text
  check (call_status in ('answered', 'no_answer'));
alter table public.leads add column if not exists call_status_at timestamptz;
alter table public.leads add column if not exists outcome text
  check (outcome in ('booked', 'interested', 'not_interested', 'follow_up', 'unqualified', 'callback', 'customer'));
alter table public.leads add column if not exists outcome_at timestamptz;
alter table public.leads add column if not exists notes text;
alter table public.leads add column if not exists is_draft boolean not null default false;
alter table public.leads add column if not exists draft_session_id text;
alter table public.leads add column if not exists draft_updated_at timestamptz;
alter table public.leads add column if not exists meeting_at timestamptz;
alter table public.leads add column if not exists calendly_event_uri text;
alter table public.leads add column if not exists calendly_invitee_uri text;
alter table public.leads add column if not exists linkedin_url text;
alter table public.leads add column if not exists callback_at timestamptz;
alter table public.leads add column if not exists next_action_at timestamptz;
alter table public.leads add column if not exists next_action_type text
  check (next_action_type in ('retry', 'callback'));
alter table public.leads add column if not exists retry_count int not null default 0;
alter table public.leads add column if not exists last_action_fired_at timestamptz;
alter table public.leads add column if not exists workspace_id uuid references public.workspaces(id);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'leads_retry_count_cap'
  ) then
    alter table public.leads
      add constraint leads_retry_count_cap check (retry_count >= 0 and retry_count <= 4);
  end if;
end$$;

create index if not exists leads_next_action_due_idx
  on public.leads (next_action_at)
  where next_action_at is not null and is_draft = false;

create unique index if not exists leads_draft_session_id_key
  on public.leads (draft_session_id)
  where draft_session_id is not null;

create unique index if not exists leads_calendly_event_uri_key
  on public.leads (calendly_event_uri)
  where calendly_event_uri is not null;

create unique index if not exists leads_linkedin_url_key
  on public.leads (linkedin_url)
  where linkedin_url is not null;

alter table public.leads enable row level security;

grant usage on schema public to anon, authenticated;
grant insert, update, delete on public.leads to anon, authenticated;
grant select on public.leads to authenticated;

drop policy if exists "Anyone can submit CarterCo leads" on public.leads;
drop policy if exists "Anyone can save draft leads" on public.leads;
drop policy if exists "Anyone can update draft leads" on public.leads;
drop policy if exists "Anyone can delete draft leads" on public.leads;
drop policy if exists "CarterCo can read leads" on public.leads;
drop policy if exists "CarterCo can update leads" on public.leads;
drop policy if exists leads_workspace_all on public.leads;

create policy leads_workspace_all
  on public.leads
  for all
  to authenticated
  using (workspace_id in (select public.auth_workspace_ids()))
  with check (workspace_id in (select public.auth_workspace_ids()));

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
