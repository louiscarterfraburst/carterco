-- Lemlist as a second invite source alongside SendPilot. When a lemlist
-- linkedinInviteAccepted webhook fires, lemlist-webhook creates an
-- outreach_pipeline row tagged invite_source='lemlist' + lemlist_lead_id.
-- The rest of the /outreach flow (enrich-buckets, sendspark-webhook,
-- approval gate) is shared with SendPilot; outreach-approve branches on
-- invite_source to either resume the lemlist lead (lemlist API) or send
-- via SendPilot.

alter table public.outreach_pipeline
  add column if not exists invite_source text not null default 'sendpilot'
    check (invite_source in ('sendpilot', 'lemlist')),
  add column if not exists lemlist_lead_id     text,
  add column if not exists lemlist_campaign_id text;

comment on column public.outreach_pipeline.invite_source is
  'Which tool sent the LinkedIn invite. sendpilot = legacy/default; lemlist = via lemlist Chrome extension. outreach-approve branches on this to decide which API to call when the human approves the rendered DM.';

comment on column public.outreach_pipeline.lemlist_lead_id is
  'Lemlist lea_XXX ID for the campaign-lead row. Set when invite_source=lemlist. Used by lemlist-webhook to look up the pipeline row on accept/reply events and by sendspark-webhook to PATCH the rendered_message + videoUrl back as custom variables.';

comment on column public.outreach_pipeline.lemlist_campaign_id is
  'Lemlist cam_XXX ID for the campaign this lead lives in. Set when invite_source=lemlist.';

create index if not exists outreach_pipeline_lemlist_lead_id_idx
  on public.outreach_pipeline (lemlist_lead_id)
  where lemlist_lead_id is not null;

create unique index if not exists outreach_pipeline_lemlist_lead_id_uniq
  on public.outreach_pipeline (workspace_id, lemlist_lead_id)
  where lemlist_lead_id is not null;
