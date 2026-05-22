create table if not exists public.sms_forwarded_messages (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  relay_phone text not null,
  message_body text not null,
  sender_raw text,
  sender_phone text,
  lead_id uuid references public.leads(id) on delete set null,
  status text not null default 'pending_sender'
    check (status in ('pending_sender', 'matched', 'unmatched')),
  twilio_body_sid text unique,
  twilio_sender_sid text unique
);

create index if not exists sms_forwarded_messages_pending_idx
  on public.sms_forwarded_messages (relay_phone, created_at desc)
  where status = 'pending_sender';

create index if not exists sms_forwarded_messages_sender_phone_idx
  on public.sms_forwarded_messages (sender_phone)
  where sender_phone is not null;
