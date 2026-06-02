-- meta_capi: fire a Meta Conversions API event when a deal reaches a
-- value-bearing stage, so Meta can optimize lead ads toward leads that convert
-- (and their value). Mirrors deal_attio_sync (net.http_post to an edge function).
--
-- Only fires on a transition INTO meeting_booked or won, so routine deal edits
-- don't spam Meta. The edge function (meta-capi-conversion) maps the stage to a
-- Meta event, hashes person_email/name, and sends value for won deals.
--
-- NOT YET APPLIED. Apply only after META_CAPI_ACCESS_TOKEN is set on the project
-- and Louis has confirmed he wants real deal outcomes sent to Meta.

create or replace function public.deal_meta_capi()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if (tg_op = 'INSERT' or coalesce(old.stage, '') is distinct from coalesce(new.stage, ''))
       and new.stage in ('in_progress', 'meeting_booked', 'won') then
        perform net.http_post(
            url := 'https://znpaevzwlcfuzqxsbyie.supabase.co/functions/v1/meta-capi-conversion',
            body := jsonb_build_object('type', tg_op, 'record', row_to_json(new)),
            headers := '{"Content-Type":"application/json"}'::jsonb,
            timeout_milliseconds := 8000
        );
    end if;
    return new;
end $$;

drop trigger if exists deal_meta_capi_trg on public.deals;
create trigger deal_meta_capi_trg
after insert or update on public.deals
for each row execute function public.deal_meta_capi();
