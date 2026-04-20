create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  user_id uuid not null default auth.uid(),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text
);

alter table public.push_subscriptions enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

drop policy if exists "CarterCo can manage push subscriptions" on public.push_subscriptions;

create policy "CarterCo can manage push subscriptions"
  on public.push_subscriptions
  for all
  to authenticated
  using ((auth.jwt() ->> 'email') = 'louis@carterco.dk')
  with check ((auth.jwt() ->> 'email') = 'louis@carterco.dk');
