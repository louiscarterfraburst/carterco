-- vw_action_queue v5 — replies auto-resolve from data, no manual "handled".
-- A reply surfaces only while it is the conversation's NEWEST message (no later
-- inbound OR outbound message for that lead — i.e. you haven't replied yet).
-- An outbound reply (cockpit, or synced from LinkedIn via sync-sendpilot-
-- messages) auto-resolves it. handled is kept ONLY as an optional manual
-- dismiss escape hatch for sync gaps. decline/ooo still skipped. Everything
-- else (approval/alt/signal/call/email branches) is unchanged from v4.

drop view if exists public.vw_action_queue;
create view public.vw_action_queue with (security_invoker=on) as
with reply_with_lead as (
  select r.id, r.workspace_id, r.sendpilot_lead_id, r.received_at,
         r.message, r.intent::text as intent, r.linkedin_url, r.suggested_reply,
         r.direction, r.handled,
         l.first_name, l.last_name, l.company, l.title,
         p.phone_direct, p.phone_office, p.email_direct, p.email_office
  from public.outreach_replies r
  left join public.outreach_pipeline p
    on p.sendpilot_lead_id = r.sendpilot_lead_id and p.workspace_id = r.workspace_id
  left join public.outreach_leads l
    on l.contact_email = p.contact_email and l.workspace_id = r.workspace_id
),
pipeline_with_lead as (
  select p.sendpilot_lead_id, p.workspace_id, p.status::text as status,
         p.accepted_at, p.rendered_message, p.linkedin_url,
         p.phone_direct, p.phone_office, p.email_direct, p.email_office,
         p.last_reply_intent::text as last_reply_intent,
         p.call_outcome, p.last_called_at, p.callback_at, p.last_email_at,
         l.first_name, l.last_name, l.company, l.title
  from public.outreach_pipeline p
  left join public.outreach_leads l
    on l.contact_email = p.contact_email and l.workspace_id = p.workspace_id
),
latest_email as (
  select distinct on (pipeline_lead_id)
    pipeline_lead_id, id as email_id, subject, strategy, drafted_at, sent_at
  from public.outreach_emails
  order by pipeline_lead_id, drafted_at desc
)
select
  'reply:' || r.id::text as id,
  r.workspace_id, 'reply'::text as kind,
  (case when length(coalesce(r.suggested_reply,'')) > 0 then 'draft_ready' else 'needs_response' end)::text as subkind,
  r.sendpilot_lead_id as ref_lead_id, r.id::text as ref_id,
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
  r.phone_direct, r.phone_office,
  r.email_direct, r.email_office,
  null::uuid as email_draft_id, null::text as email_subject
from reply_with_lead r
where r.direction = 'inbound'
  and coalesce(r.handled, false) = false
  and r.intent is distinct from 'decline' and r.intent is distinct from 'ooo'
  and not exists (
    select 1 from public.outreach_replies r2
    where r2.sendpilot_lead_id = r.sendpilot_lead_id
      and r2.workspace_id = r.workspace_id
      and r2.received_at > r.received_at
  )
union all
select
  'approval:' || p.sendpilot_lead_id::text, p.workspace_id, 'approval'::text,
  (case when p.status = 'pending_approval' then 'approve_send'
        when p.status = 'pending_pre_render' then 'video_rendering'
        else p.status end)::text,
  p.sendpilot_lead_id, p.sendpilot_lead_id, p.accepted_at,
  left(coalesce(p.rendered_message, ''), 240),
  nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''),
  p.company, p.title, null::text, p.linkedin_url,
  case when p.status = 'pending_approval' then 85 else 75 end,
  p.phone_direct, p.phone_office,
  p.email_direct, p.email_office,
  null::uuid, null::text
from pipeline_with_lead p
where p.status in ('pending_approval','pending_pre_render')
union all
select
  'alt:' || ac.id::text, ac.workspace_id, 'referral'::text,
  (case when ac.linkedin_url is null then 'find_linkedin' else 'invite_pending' end)::text,
  ac.pipeline_lead_id, ac.id::text, ac.surfaced_at,
  left(ac.name ||
    case when ac.title is not null then ' — ' || ac.title else '' end ||
    case when ac.company is not null then ' @ ' || ac.company else '' end, 240),
  ac.name, ac.company, ac.title, null::text, ac.linkedin_url,
  case when ac.source = 'reply_referral' then 75 else 65 end,
  ac.phone_direct, ac.phone_office,
  ac.email_direct, ac.email_office,
  null::uuid, null::text
from public.outreach_alt_contacts ac
where ac.acted_on_at is null
union all
select
  'signal:' || s.id::text, s.workspace_id, 'signal'::text,
  s.signal_type::text,
  null::text, s.id::text, s.identified_at,
  left(coalesce(s.company_name, s.company_domain, '?') ||
    case when s.person_name is not null then ' — ' || s.person_name else '' end ||
    case when s.person_title is not null then ' (' || s.person_title || ')' else '' end, 240),
  s.person_name, s.company_name, s.person_title, null::text, s.person_linkedin_url,
  case when s.icp_score is not null and s.icp_score >= 7 then 70
       when s.icp_score is not null and s.icp_score >= 4 then 55
       else 45 end,
  s.phone_direct, s.phone_office,
  null::text, null::text,
  null::uuid, null::text
from public.outreach_signals s
where s.handled = false
union all
-- call kind
select
  'call:' || p.sendpilot_lead_id::text,
  p.workspace_id, 'call'::text,
  coalesce(p.call_outcome, 'new_accept')::text,
  p.sendpilot_lead_id, p.sendpilot_lead_id,
  coalesce(p.callback_at, p.last_called_at, p.accepted_at),
  case
    when p.call_outcome = 'callback' then 'Callback aftalt — ring nu'
    when p.call_outcome = 'no_answer' then 'Tidligere forsøg: ingen svar'
    when p.call_outcome = 'left_voicemail' then 'Tidligere forsøg: lagt voicemail'
    when p.call_outcome = 'answered' then 'Tidligere talt med — opfølgning'
    when p.call_outcome = 'interested' then 'Varm lead — følg op'
    else 'Accepteret — kan ringes'
  end,
  nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''),
  p.company, p.title, p.last_reply_intent, p.linkedin_url,
  case
    when p.call_outcome = 'callback' and p.callback_at <= now() then 95
    when p.call_outcome = 'interested' then 85
    when p.call_outcome = 'answered' then 70
    when p.call_outcome = 'left_voicemail' then 55
    when p.call_outcome = 'no_answer' then 50
    else 60
  end,
  p.phone_direct, p.phone_office,
  p.email_direct, p.email_office,
  null::uuid, null::text
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
  )
union all
-- email kind
select
  'email:' || p.sendpilot_lead_id::text,
  p.workspace_id, 'email'::text,
  (case when le.email_id is null then 'needs_draft' else 'draft_ready' end)::text,
  p.sendpilot_lead_id, p.sendpilot_lead_id,
  coalesce(le.drafted_at, p.accepted_at),
  case when le.email_id is null then 'Email ikke skrevet endnu'
       else coalesce(le.subject, 'Udkast klar') end,
  nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''),
  p.company, p.title, p.last_reply_intent, p.linkedin_url,
  case
    when le.email_id is not null then 80
    when p.call_outcome = 'no_answer' then 75
    when p.call_outcome = 'left_voicemail' then 70
    when p.last_reply_intent in ('question','interested') then 65
    else 55
  end,
  p.phone_direct, p.phone_office,
  p.email_direct, p.email_office,
  le.email_id, le.subject
from pipeline_with_lead p
left join latest_email le on le.pipeline_lead_id = p.sendpilot_lead_id
where (p.email_direct is not null or p.email_office is not null)
  and p.accepted_at is not null
  and coalesce(p.last_reply_intent, '') not in ('decline','ooo')
  and coalesce(p.call_outcome, '') not in ('not_interested','booked','unqualified','customer')
  and (le.email_id is null or le.sent_at is null);

grant select on public.vw_action_queue to authenticated, anon;
