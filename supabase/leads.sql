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
  user_agent text
);

alter table public.leads enable row level security;

grant usage on schema public to anon, authenticated;
grant insert on public.leads to anon, authenticated;

drop policy if exists "Anyone can submit CarterCo leads" on public.leads;

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
