-- Tresyv 3-arm A/B test (per Rasmus's May 21 email):
--   v1_long  : long text, no video — Rasmus's "den voksne og forklarende"
--   v2_short : short text, no video — "krog: skal jeg sende 2-3 ting?"
--   v3_video : existing SendSpark video flow, unchanged
-- 33/33/33 random assignment at connection.accepted time, locked at insert.

alter table public.outreach_pipeline
  add column if not exists first_dm_variant text;

alter table public.outreach_pipeline
  drop constraint if exists outreach_pipeline_first_dm_variant_check;
alter table public.outreach_pipeline
  add constraint outreach_pipeline_first_dm_variant_check
  check (first_dm_variant is null or first_dm_variant in ('v1_long', 'v2_short', 'v3_video'));

-- Once stamped, never change — the variant is the experiment's independent
-- variable. The trigger below enforces it.
create or replace function public.assert_first_dm_variant_immutable()
returns trigger
language plpgsql
as $$
begin
  if old.first_dm_variant is not null
     and new.first_dm_variant is distinct from old.first_dm_variant then
    raise exception
      'first_dm_variant is locked once assigned (old=%, new=%)',
      old.first_dm_variant, new.first_dm_variant
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_first_dm_variant_immutable on public.outreach_pipeline;
create trigger trg_first_dm_variant_immutable
  before update of first_dm_variant on public.outreach_pipeline
  for each row
  execute function public.assert_first_dm_variant_immutable();

-- Analytics view: accept-to-reply rate by variant. Counts unique pipeline
-- rows so re-renders/follow-ups don't double-count.
drop view if exists public.vw_first_dm_ab;
create view public.vw_first_dm_ab with (security_invoker=on) as
select
  workspace_id,
  first_dm_variant,
  count(*) as assigned,
  count(*) filter (where sent_at is not null) as sent,
  count(*) filter (where last_reply_at is not null) as replied,
  round(
    100.0 * count(*) filter (where last_reply_at is not null)
    / nullif(count(*) filter (where sent_at is not null), 0),
    1
  ) as reply_pct
from public.outreach_pipeline
where first_dm_variant is not null
group by workspace_id, first_dm_variant
order by workspace_id, first_dm_variant;

grant select on public.vw_first_dm_ab to authenticated, anon;
