-- engagements: source-of-truth for warm/active deals (not cold outbound).
--
-- Cold-outbound prospects live in outreach_pipeline and sync to Attio via
-- attio_sync.sql. Real client engagements (Cleanstep, BikeNor, OdaGroup,
-- Tresyv, intros from calls/network) don't fit that funnel — they're warm
-- from day one. This table is their durable home.
--
-- Sync direction (today): engagements -> Attio Deals (one-way push).
-- Keyed on slug; Attio Deal supabase_pipeline_id = 'manual:<slug>'.
-- For the planned bidirectional sync (Attio -> engagements), see
-- supabase/functions/attio-webhook-engagement.
--
-- Idempotent: re-runnable.

create table if not exists public.engagements (
    id uuid primary key default gen_random_uuid(),
    workspace_id uuid not null default '1e067f9a-d453-41a7-8bc4-9fdb5644a5fa',
    slug text not null unique,

    -- Company side
    company_name text not null,
    company_domain text not null,

    -- Primary contact
    person_email text not null,
    person_name text,
    person_title text,
    person_linkedin_url text,

    -- Deal state
    stage text not null
        check (stage in ('lead','meeting_booked','in_progress','won','lost')),
    value_amount numeric,
    value_currency text default 'DKK',
    deal_name text,

    -- Activity
    last_contact_at timestamptz,
    notes text,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    -- Bidirectional-sync guard: when Attio's webhook writes to this row, we
    -- set this to now() and the outgoing trigger checks it to avoid a loop.
    last_synced_from_attio_at timestamptz
);

create index if not exists engagements_workspace_idx on public.engagements(workspace_id);
create index if not exists engagements_stage_idx on public.engagements(stage);

-- Auto-update updated_at on row change
create or replace function public.engagements_set_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end $$;

drop trigger if exists engagements_set_updated_at_trg on public.engagements;
create trigger engagements_set_updated_at_trg
before update on public.engagements
for each row execute function public.engagements_set_updated_at();

-- Outgoing sync: engagements -> Attio
create or replace function public.engagement_attio_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    loop_window constant interval := interval '10 seconds';
    relevant_change boolean;
begin
    -- Skip if this update just came from Attio's webhook (avoid loop).
    if tg_op = 'UPDATE'
       and new.last_synced_from_attio_at is not null
       and now() - new.last_synced_from_attio_at < loop_window then
        return new;
    end if;

    -- INSERTs always fire; UPDATEs only when Attio-visible fields changed.
    relevant_change := tg_op = 'INSERT' or (
        coalesce(old.stage,'')          is distinct from coalesce(new.stage,'')
        or coalesce(old.value_amount, -1)  is distinct from coalesce(new.value_amount, -1)
        or coalesce(old.value_currency,'') is distinct from coalesce(new.value_currency,'')
        or coalesce(old.deal_name,'')      is distinct from coalesce(new.deal_name,'')
        or coalesce(old.person_email,'')   is distinct from coalesce(new.person_email,'')
        or coalesce(old.person_name,'')    is distinct from coalesce(new.person_name,'')
        or coalesce(old.company_name,'')   is distinct from coalesce(new.company_name,'')
        or coalesce(old.company_domain,'') is distinct from coalesce(new.company_domain,'')
    );
    if not relevant_change then
        return new;
    end if;

    perform net.http_post(
        url := 'https://znpaevzwlcfuzqxsbyie.supabase.co/functions/v1/attio-sync-engagement',
        body := jsonb_build_object(
            'type', tg_op,
            'record', row_to_json(new)
        ),
        headers := '{"Content-Type":"application/json"}'::jsonb,
        timeout_milliseconds := 8000
    );
    return new;
end $$;

drop trigger if exists engagement_attio_sync_trg on public.engagements;
create trigger engagement_attio_sync_trg
after insert or update on public.engagements
for each row execute function public.engagement_attio_sync();
