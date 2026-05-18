-- vw_action_queue v3 — adds 'call' kind for accepted leads with phones that
-- haven't been declined/closed. Existing kinds (reply, approval, referral,
-- signal) unchanged.
--
-- Call-eligibility logic:
--   - has phone_direct or phone_office
--   - accepted_at is set
--   - last_reply_intent NOT IN ('decline','ooo')  (didn't say no via reply)
--   - call_outcome NOT IN ('not_interested','booked','unqualified')  (didn't close)
--   - if callback_at is set, only show when callback_at <= now()
--   - if last_called_at within last 20h and outcome is 'no_answer',
--     hide until 20h passed (rate-limit redials)
--   - if last_called_at within last 3 days and outcome is 'left_voicemail',
--     hide until 3 days passed

drop view if exists public.vw_action_queue;
create view public.vw_action_queue with (security_invoker=on) as
with reply_with_lead as (
  select r.id, r.workspace_id, r.sendpilot_lead_id, r.received_at,
         r.message, r.intent::text as intent, r.linkedin_url, r.suggested_reply,
         r.direction, r.handled,
         l.first_name, l.last_name, l.company, l.title,
         p.phone_direct, p.phone_office
  from public.outreach_replies r
  left join public.outreach_pipeline p
    on p.sendpilot_lead_id = r.sendpilot_lead_id and p.workspace_id = r.workspace_id
  left join public.outreach_leads l
    on l.contact_email = p.contact_email and l.workspace_id = r.workspace_id
),
pipeline_with_lead as (
  select p.sendpilot_lead_id, p.workspace_id, p.status::text as status,
         p.accepted_at, p.rendered_message, p.linkedin_url,
         p.phone_direct, p.phone_office,
         p.last_reply_intent::text as last_reply_intent,
         p.call_outcome, p.last_called_at, p.callback_at,
         l.first_name, l.last_name, l.company, l.title
  from public.outreach_pipeline p
  left join public.outreach_leads l
    on l.contact_email = p.contact_email and l.workspace_id = p.workspace_id
)
select
  'reply:' || r.id::text as id,
  r.workspace_id,
  'reply'::text as kind,
  (case when length(coalesce(r.suggested_reply,'')) > 0 then 'draft_ready' else 'needs_response' end)::text as subkind,
  r.sendpilot_lead_id as ref_lead_id,
  r.id::text as ref_id,
  r.received_at as surfaced_at,
  left(r.message, 240) as snippet,
  nullif(trim(concat_ws(' ', r.first_name, r.last_name)), '') as contact_name,
  r.company, r.title, r.intent, r.linkedin_url,
  case
    when length(coalesce(r.suggested_reply,'')) > 0 and r.intent in ('question','interested') then 100
    when r.intent in ('question','interested') then 90
    when r.intent = 'referral' then 65
    when r.intent = 'other' then 40
    else 20
  end as priority_score,
  r.phone_direct, r.phone_office
from reply_with_lead r
where r.direction = 'inbound' and r.handled = false
  and r.intent is distinct from 'decline' and r.intent is distinct from 'ooo'
union all
select
  'approval:' || p.sendpilot_lead_id::text,
  p.workspace_id,
  'approval'::text,
  (case when p.status = 'pending_approval' then 'approve_send'
        when p.status = 'pending_pre_render' then 'video_rendering'
        else p.status end)::text,
  p.sendpilot_lead_id, p.sendpilot_lead_id, p.accepted_at,
  left(coalesce(p.rendered_message, ''), 240),
  nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''),
  p.company, p.title, null::text, p.linkedin_url,
  case when p.status = 'pending_approval' then 85 else 75 end,
  p.phone_direct, p.phone_office
from pipeline_with_lead p
where p.status in ('pending_approval','pending_pre_render')
union all
select
  'alt:' || ac.id::text,
  ac.workspace_id,
  'referral'::text,
  (case when ac.linkedin_url is null then 'find_linkedin' else 'invite_pending' end)::text,
  ac.pipeline_lead_id, ac.id::text, ac.surfaced_at,
  left(ac.name ||
    case when ac.title is not null then ' — ' || ac.title else '' end ||
    case when ac.company is not null then ' @ ' || ac.company else '' end, 240),
  ac.name, ac.company, ac.title, null::text, ac.linkedin_url,
  case when ac.source = 'reply_referral' then 75 else 65 end,
  ac.phone_direct, ac.phone_office
from public.outreach_alt_contacts ac
where ac.acted_on_at is null
union all
select
  'signal:' || s.id::text,
  s.workspace_id,
  'signal'::text,
  s.signal_type::text,
  null::text, s.id::text, s.identified_at,
  left(coalesce(s.company_name, s.company_domain, '?') ||
    case when s.person_name is not null then ' — ' || s.person_name else '' end ||
    case when s.person_title is not null then ' (' || s.person_title || ')' else '' end, 240),
  s.person_name, s.company_name, s.person_title, null::text, s.person_linkedin_url,
  case when s.icp_score is not null and s.icp_score >= 7 then 70
       when s.icp_score is not null and s.icp_score >= 4 then 55
       else 45 end,
  s.phone_direct, s.phone_office
from public.outreach_signals s
where s.handled = false
union all
-- NEW: call kind — accepted leads with phones that aren't closed/declined
select
  'call:' || p.sendpilot_lead_id::text as id,
  p.workspace_id,
  'call'::text as kind,
  coalesce(p.call_outcome, 'new_accept')::text as subkind,
  p.sendpilot_lead_id as ref_lead_id,
  p.sendpilot_lead_id as ref_id,
  coalesce(p.callback_at, p.last_called_at, p.accepted_at) as surfaced_at,
  case
    when p.call_outcome = 'callback' then 'Callback aftalt — ring nu'
    when p.call_outcome = 'no_answer' then 'Tidligere forsøg: ingen svar'
    when p.call_outcome = 'left_voicemail' then 'Tidligere forsøg: lagt voicemail'
    when p.call_outcome = 'answered' then 'Tidligere talt med — opfølgning'
    when p.call_outcome = 'interested' then 'Varm lead — følg op'
    else 'Accepteret — kan ringes'
  end as snippet,
  nullif(trim(concat_ws(' ', p.first_name, p.last_name)), '') as contact_name,
  p.company, p.title, p.last_reply_intent as intent, p.linkedin_url,
  case
    when p.call_outcome = 'callback' and p.callback_at <= now() then 95
    when p.call_outcome = 'interested' then 85
    when p.call_outcome = 'answered' then 70
    when p.call_outcome = 'left_voicemail' then 55
    when p.call_outcome = 'no_answer' then 50
    else 60
  end as priority_score,
  p.phone_direct, p.phone_office
from pipeline_with_lead p
where (p.phone_direct is not null or p.phone_office is not null)
  and p.accepted_at is not null
  and coalesce(p.last_reply_intent, '') not in ('decline','ooo')
  and coalesce(p.call_outcome, '') not in ('not_interested','booked','unqualified','customer')
  and (p.callback_at is null or p.callback_at <= now())
  and (
    p.call_outcome is null
    or p.call_outcome in ('answered','interested','callback')
    or (p.call_outcome = 'no_answer' and (p.last_called_at is null or p.last_called_at < now() - interval '20 hours'))
    or (p.call_outcome = 'left_voicemail' and (p.last_called_at is null or p.last_called_at < now() - interval '3 days'))
  );

grant select on public.vw_action_queue to authenticated, anon;
