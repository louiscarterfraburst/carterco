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

drop policy if exists "Anyone can submit CarterCo leads" on public.leads;

create policy "Anyone can submit CarterCo leads"
  on public.leads
  for insert
  to anon
  with check (
    source = 'carterco.dk'
    and length(trim(name)) > 0
    and length(trim(company)) > 0
    and email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    and length(trim(phone)) > 0
  );
