-- vw_action_queue: unified "I dag" surface across the four action sources.
--
-- Replaces having to scan Opgaver + Indbakke + Svar + Signaler + alt_contacts
-- separately to know what to do today. Each row is one action item with a
-- kind, snippet, contact context, and a priority_score that ranks the queue.
--
-- security_invoker=on: the view respects RLS on the underlying tables, so
-- callers only see rows in workspaces they have access to. The /outreach UI
-- additionally filters by workspace_id on the client side, same as for the
-- raw tables.

create or replace view public.vw_action_queue with (security_invoker=on) as
with reply_with_lead as (
  select r.id, r.workspace_id, r.sendpilot_lead_id, r.received_at,
         r.message, r.intent, r.linkedin_url, r.suggested_reply,
         r.direction, r.handled,
         l.first_name, l.last_name, l.company, l.title
  from public.outreach_replies r
  left join public.outreach_pipeline p
    on p.sendpilot_lead_id = r.sendpilot_lead_id
    and p.workspace_id = r.workspace_id
  left join public.outreach_leads l
    on l.contact_email = p.contact_email
    and l.workspace_id = r.workspace_id
),
pipeline_with_lead as (
  select p.sendpilot_lead_id, p.workspace_id, p.status, p.accepted_at,
         p.rendered_message, p.linkedin_url,
         l.first_name, l.last_name, l.company, l.title
  from public.outreach_pipeline p
  left join public.outreach_leads l
    on l.contact_email = p.contact_email
    and l.workspace_id = p.workspace_id
)

-- Inbound replies needing action (excludes declines/OOO — those clutter without informing)
select
  'reply:' || r.id::text                                              as id,
  r.workspace_id                                                       as workspace_id,
  'reply'::text                                                        as kind,
  case
    when length(coalesce(r.suggested_reply,'')) > 0 then 'draft_ready'
    else 'needs_response'
  end                                                                  as subkind,
  r.sendpilot_lead_id                                                  as ref_lead_id,
  r.id::text                                                           as ref_id,
  r.received_at                                                        as surfaced_at,
  left(r.message, 240)                                                 as snippet,
  nullif(trim(concat_ws(' ', r.first_name, r.last_name)), '')         as contact_name,
  r.company                                                            as company,
  r.title                                                              as title,
  r.intent                                                             as intent,
  r.linkedin_url                                                       as linkedin_url,
  case
    when length(coalesce(r.suggested_reply,'')) > 0
         and r.intent in ('question','interested')                     then 100
    when r.intent in ('question','interested')                         then 90
    when r.intent = 'referral'                                         then 65
    when r.intent = 'other'                                            then 40
    else 20
  end                                                                  as priority_score
from reply_with_lead r
where r.direction = 'inbound'
  and r.handled = false
  and r.intent is distinct from 'decline'
  and r.intent is distinct from 'ooo'

union all

-- Pending approvals: video pre-render queue and AI-drafted DMs awaiting approval
select
  'approval:' || p.sendpilot_lead_id::text                             as id,
  p.workspace_id                                                       as workspace_id,
  'approval'::text                                                     as kind,
  case
    when p.status = 'pending_approval'      then 'approve_send'
    when p.status = 'pending_pre_render'    then 'video_rendering'
    else p.status
  end                                                                  as subkind,
  p.sendpilot_lead_id                                                  as ref_lead_id,
  p.sendpilot_lead_id                                                  as ref_id,
  p.accepted_at                                                        as surfaced_at,
  left(coalesce(p.rendered_message, ''), 240)                          as snippet,
  nullif(trim(concat_ws(' ', p.first_name, p.last_name)), '')         as contact_name,
  p.company                                                            as company,
  p.title                                                              as title,
  null::text                                                           as intent,
  p.linkedin_url                                                       as linkedin_url,
  case when p.status = 'pending_approval' then 85 else 75 end          as priority_score
from pipeline_with_lead p
where p.status in ('pending_approval','pending_pre_render')

union all

-- Referral alt-contacts awaiting action (LinkedIn URL lookup or invite click)
select
  'alt:' || ac.id::text                                                as id,
  ac.workspace_id                                                      as workspace_id,
  'referral'::text                                                     as kind,
  case when ac.linkedin_url is null then 'find_linkedin' else 'invite_pending' end as subkind,
  ac.pipeline_lead_id                                                  as ref_lead_id,
  ac.id::text                                                          as ref_id,
  ac.surfaced_at                                                       as surfaced_at,
  left(
    ac.name ||
    case when ac.title   is not null then ' — ' || ac.title   else '' end ||
    case when ac.company is not null then ' @ ' || ac.company else '' end,
    240
  )                                                                    as snippet,
  ac.name                                                              as contact_name,
  ac.company                                                           as company,
  ac.title                                                             as title,
  null::text                                                           as intent,
  ac.linkedin_url                                                      as linkedin_url,
  case when ac.source = 'reply_referral' then 75 else 65 end           as priority_score
from public.outreach_alt_contacts ac
where ac.acted_on_at is null

union all

-- Unhandled signals (ICP score drives priority within the bucket)
select
  'signal:' || s.id::text                                              as id,
  s.workspace_id                                                       as workspace_id,
  'signal'::text                                                       as kind,
  s.signal_type                                                        as subkind,
  null::text                                                           as ref_lead_id,
  s.id::text                                                           as ref_id,
  s.identified_at                                                      as surfaced_at,
  left(
    coalesce(s.company_name, s.company_domain, '?') ||
    case when s.person_name  is not null then ' — ' || s.person_name  else '' end ||
    case when s.person_title is not null then ' (' || s.person_title || ')' else '' end,
    240
  )                                                                    as snippet,
  s.person_name                                                        as contact_name,
  s.company_name                                                       as company,
  s.person_title                                                       as title,
  null::text                                                           as intent,
  s.person_linkedin_url                                                as linkedin_url,
  case
    when s.icp_score is not null and s.icp_score >= 7 then 70
    when s.icp_score is not null and s.icp_score >= 4 then 55
    else 45
  end                                                                  as priority_score
from public.outreach_signals s
where s.handled = false;

-- Grant read access via the existing authenticated role (matches other tables)
grant select on public.vw_action_queue to authenticated, anon;
