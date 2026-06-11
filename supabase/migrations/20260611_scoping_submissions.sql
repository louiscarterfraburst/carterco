-- Lead Flex scoping submissions (CEO plan 2026-06-10-leadflex-website-cta).
-- Two kinds: 'booking' rows are anonymous (persist-then-book: answers are
-- saved BEFORE the cal.com redirect; identity arrives later via cal-webhook
-- join on the id token), 'soft_capture' rows carry email + explicit consent.
-- Service-role writes only (admin client / edge functions); RLS on, no
-- public policies.
create table public.scoping_submissions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('booking', 'soft_capture')),
  icp text not null,
  tried text[] not null default '{}',
  email text,
  name text,
  consent boolean not null default false,
  locale text,
  user_agent text,
  referrer text,
  lead_id uuid references public.leads(id) on delete set null,
  booking_uid text
);

alter table public.scoping_submissions enable row level security;

create index scoping_submissions_booking_uid_idx
  on public.scoping_submissions (booking_uid);
