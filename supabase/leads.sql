create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  company text not null,
  email text not null,
  phone text not null,
  monthly_leads text not null,
  response_time text not null,
  source text not null default 'carterco.dk',
  page_url text,
  user_agent text,
  call_status text check (call_status in ('answered', 'no_answer')),
  call_status_at timestamptz,
  outcome text check (outcome in ('booked', 'interested', 'not_interested', 'follow_up')),
  outcome_at timestamptz,
  notes text
);

alter table public.leads add column if not exists call_status text
  check (call_status in ('answered', 'no_answer'));
alter table public.leads add column if not exists call_status_at timestamptz;
alter table public.leads add column if not exists outcome text
  check (outcome in ('booked', 'interested', 'not_interested', 'follow_up'));
alter table public.leads add column if not exists outcome_at timestamptz;
alter table public.leads add column if not exists notes text;

alter table public.leads enable row level security;

grant usage on schema public to anon, authenticated;
grant insert on public.leads to anon, authenticated;
grant select, update on public.leads to authenticated;

drop policy if exists "Anyone can submit CarterCo leads" on public.leads;
drop policy if exists "CarterCo can read leads" on public.leads;
drop policy if exists "CarterCo can update leads" on public.leads;

create policy "Anyone can submit CarterCo leads"
  on public.leads
  for insert
  to public
  with check (
    source = 'carterco.dk'
    and length(trim(name)) >= 2
    and length(trim(company)) >= 2
    and email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]{2,}$'
    and length(regexp_replace(phone, '[^0-9]', '', 'g')) between 8 and 15
    and monthly_leads in ('Under 50', '50–250', '250–1.000', '1.000+')
    and response_time in ('Under 5 min', '5–30 min', '30 min – 2 timer', 'Mere end 2 timer', 'Ved ikke')
  );

create policy "CarterCo can read leads"
  on public.leads
  for select
  to authenticated
  using ((auth.jwt() ->> 'email') = 'louis@carterco.dk');

create policy "CarterCo can update leads"
  on public.leads
  for update
  to authenticated
  using ((auth.jwt() ->> 'email') = 'louis@carterco.dk')
  with check ((auth.jwt() ->> 'email') = 'louis@carterco.dk');
