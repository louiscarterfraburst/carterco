-- Phase 2a of multi-play /outreach: make `play` flow from the enrichment row
-- into the pipeline at invite time, exactly the way `workspace_id` already does.
--
-- outreach_record_invite derives workspace_id from outreach_leads; we add `play`
-- right beside it. A play's leads are pre-seeded into outreach_leads stamped
-- play='hiring_signal' (CarterCo already pre-seeds outreach_leads, vs OdaGroup's
-- lead_inbox staging), so on invite the new row inherits the tag automatically.
--
-- lead_inbox also gets `play` for completeness, BUT the lead_inbox→outreach_leads
-- promotion path (sendpilot-webhook promoteFromInbox) does NOT yet carry play —
-- so until that's wired, plays must pre-seed outreach_leads, not stage via
-- lead_inbox. video_loop default everywhere = zero behaviour change on apply.
--
-- Applied via supabase MCP apply_migration on 2026-06-06; file mirrors for repo.

alter table public.outreach_leads
  add column if not exists play text not null default 'video_loop';
comment on column public.outreach_leads.play is
  'Which outbound play this lead belongs to. Pre-seeded by the play''s intake (e.g. the hiring bridge stamps hiring_signal). outreach_record_invite reads this onto outreach_pipeline.play, mirroring workspace_id.';

alter table public.lead_inbox
  add column if not exists play text not null default 'video_loop';
comment on column public.lead_inbox.play is
  'Play tag for staged leads. NOTE: promoteFromInbox does not yet carry this into outreach_leads — pre-seed outreach_leads for plays until that is wired.';

-- Derive play alongside workspace_id. New rows inherit the enrichment row''s
-- play; on re-invite, only upgrade a still-default video_loop tag (so a row
-- created on connection.sent before its lead row existed gets corrected later).
create or replace function public.outreach_record_invite(
    _lead_id text,
    _linkedin_url text,
    _contact_email text,
    _invited_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    ws_id uuid;
    lead_play text;
begin
    select workspace_id, play into ws_id, lead_play
    from public.outreach_leads
    where contact_email = coalesce(nullif(_contact_email, ''), contact_email)
       or sendpilot_lead_id = _lead_id
    limit 1;

    insert into public.outreach_pipeline
        (sendpilot_lead_id, linkedin_url, contact_email, status, invited_at, workspace_id, play)
    values
        (_lead_id, _linkedin_url, coalesce(_contact_email, ''), 'invited', _invited_at,
         ws_id, coalesce(lead_play, 'video_loop'))
    on conflict (sendpilot_lead_id) do update set
        invited_at    = coalesce(public.outreach_pipeline.invited_at, excluded.invited_at),
        linkedin_url  = excluded.linkedin_url,
        contact_email = case when public.outreach_pipeline.contact_email = ''
                              then excluded.contact_email
                              else public.outreach_pipeline.contact_email end,
        workspace_id  = coalesce(public.outreach_pipeline.workspace_id, excluded.workspace_id),
        play          = case when public.outreach_pipeline.play = 'video_loop'
                              then excluded.play
                              else public.outreach_pipeline.play end;
end $$;
