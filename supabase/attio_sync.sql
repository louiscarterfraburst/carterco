-- attio-sync: pushes outreach_pipeline rows to Attio Deals (one-way).
--
-- Fires attio-sync edge function on every outreach_pipeline change for the
-- CarterCo workspace so the Attio Deals view stays in sync without manual
-- backfill runs. Pattern mirrors outreach_notify_pending (supabase/outreach.sql)
-- and outreach_replies_triage_trg (supabase/outreach_triage.sql).
--
-- Single-tenant for now: only CarterCo's workspace syncs. Other Supabase
-- tenants (Tresyv, Haugefrom) don't push to this Attio. When we add a second
-- Attio workspace we'll route by workspace_id → token.
--
-- Idempotent: re-runnable.

create or replace function public.attio_sync_pipeline()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    carterco_id constant uuid := '1e067f9a-d453-41a7-8bc4-9fdb5644a5fa';
    relevant_change boolean;
begin
    if new.workspace_id is distinct from carterco_id then
        return new;
    end if;

    -- Skip noise: only fire when a field Attio cares about actually changed.
    -- INSERTs always fire; UPDATEs only fire if status, outcome, last_reply_at,
    -- contact_email, or linkedin_url changed. Cron-tick updates that don't
    -- touch these fields shouldn't burn Attio API quota.
    relevant_change := tg_op = 'INSERT' or (
        coalesce(old.status::text, '')         is distinct from coalesce(new.status::text, '')
        or coalesce(old.outcome::text, '')      is distinct from coalesce(new.outcome::text, '')
        or coalesce(old.last_reply_at, 'epoch'::timestamptz) is distinct from coalesce(new.last_reply_at, 'epoch'::timestamptz)
        or coalesce(old.contact_email, '')      is distinct from coalesce(new.contact_email, '')
        or coalesce(old.linkedin_url, '')       is distinct from coalesce(new.linkedin_url, '')
    );
    if not relevant_change then
        return new;
    end if;

    perform net.http_post(
        url := 'https://znpaevzwlcfuzqxsbyie.supabase.co/functions/v1/attio-sync',
        body := jsonb_build_object(
            'type', tg_op,
            'table', 'outreach_pipeline',
            'schema', 'public',
            'record', row_to_json(new),
            'old_record', case when tg_op = 'UPDATE' then row_to_json(old) else null end
        ),
        headers := '{"Content-Type":"application/json"}'::jsonb,
        timeout_milliseconds := 8000
    );
    return new;
end $$;

drop trigger if exists outreach_pipeline_attio_sync on public.outreach_pipeline;
create trigger outreach_pipeline_attio_sync
after insert or update on public.outreach_pipeline
for each row execute function public.attio_sync_pipeline();
