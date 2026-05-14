-- Signal-driven SendPilot lead-database searches. Phase 2 of the
-- signal→outreach bridge: when an RB2B-identified company has no matching
-- person in outreach_leads, we fire a SendPilot search to find decision-
-- makers at that company, then surface candidates in the Signaler tab.
--
-- Reuses the existing alt_search machinery (poll-alt-searches polls and
-- writes to outreach_alt_contacts). The contact row gets signal_id set
-- instead of (or in addition to) pipeline_lead_id.
--
-- Idempotent: re-runnable.

alter table public.outreach_signals
    add column if not exists alt_search_id     text,
    add column if not exists alt_search_status text; -- pending|completed|empty|failed

create index if not exists idx_outreach_signals_alt_search
    on public.outreach_signals (alt_search_status)
    where alt_search_status = 'pending';

comment on column public.outreach_signals.alt_search_id is
    'SendPilot lead-database search ID kicked off via signal-search-people. Polled by poll-alt-searches to fetch candidates into outreach_alt_contacts.';

alter table public.outreach_alt_contacts
    alter column pipeline_lead_id drop not null;

alter table public.outreach_alt_contacts
    add column if not exists signal_id uuid references public.outreach_signals(id) on delete cascade;

create index if not exists idx_outreach_alt_contacts_signal
    on public.outreach_alt_contacts (signal_id)
    where signal_id is not null;

alter table public.outreach_alt_contacts
    drop constraint if exists outreach_alt_contacts_source_check;
alter table public.outreach_alt_contacts
    add constraint outreach_alt_contacts_source_check
    check (source in ('sendpilot', 'team_page', 'reply_referral', 'signal'));

alter table public.outreach_alt_contacts
    drop constraint if exists outreach_alt_contacts_origin_check;
alter table public.outreach_alt_contacts
    add constraint outreach_alt_contacts_origin_check
    check (pipeline_lead_id is not null or signal_id is not null);
