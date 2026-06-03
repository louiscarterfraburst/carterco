-- Per-arm sequence routing for Tresyv's 3-arm A/B test. Sequences can now
-- be restricted to a specific first_dm_variant — V1 follow-up only fires for
-- V1-arm leads, V2 follow-up only for V2-arm leads, etc. Null = matches any
-- variant (legacy behaviour, preserved for non-Tresyv workspaces).

alter table public.outreach_sequences
  add column if not exists match_first_dm_variant text;

alter table public.outreach_sequences
  drop constraint if exists outreach_sequences_variant_check;
alter table public.outreach_sequences
  add constraint outreach_sequences_variant_check
  check (match_first_dm_variant is null or match_first_dm_variant in ('v1_long', 'v2_short', 'v3_video'));

-- Existing Tresyv sequences: lock to the correct arm.
-- unwatched_followup_v1 uses V1 template → V1 arm only.
update public.outreach_sequences
set match_first_dm_variant = 'v1_long'
where workspace_id = '2740ba1f-d5d5-4008-bf43-b45367c73134'
  and id = 'unwatched_followup_v1';

-- watched_followup_v1 fires on played event → V3 arm only.
update public.outreach_sequences
set match_first_dm_variant = 'v3_video'
where workspace_id = '2740ba1f-d5d5-4008-bf43-b45367c73134'
  and id = 'watched_followup_v1';

-- V2 follow-up: delete + insert (partial unique index forces this shape).
delete from public.outreach_sequences
where workspace_id = '2740ba1f-d5d5-4008-bf43-b45367c73134'
  and id = 'tresyv_v2_short_followup';

insert into public.outreach_sequences (
  id, workspace_id, description, trigger_signal, excludes_global,
  steps, position, is_active, match_first_dm_variant
) values (
  'tresyv_v2_short_followup',
  '2740ba1f-d5d5-4008-bf43-b45367c73134',
  'Tresyv V2 short-arm follow-up at +72h from sent.',
  'sent',
  ARRAY['replied']::text[],
  '[{"id":"v2_followup","waitHours":72,"branches":[{"action":{"type":"auto_send","template":"Hej {firstName}\n\nJeg følger bare lige op.\n\nSkal jeg sende dig de 2-3 ting, jeg især ville kigge på for at gøre jeres website skarpere og få flere besøgende til at tage næste skridt?\n\nHvis ikke, er det helt fair.\n\nDe venligste hilsner\nRasmus"}}]}]'::jsonb,
  100,
  true,
  'v2_short'
);

-- V3 no-activity follow-up.
delete from public.outreach_sequences
where workspace_id = '2740ba1f-d5d5-4008-bf43-b45367c73134'
  and id = 'tresyv_v3_no_activity_followup';

insert into public.outreach_sequences (
  id, workspace_id, description, trigger_signal, excludes_global,
  steps, position, is_active, match_first_dm_variant
) values (
  'tresyv_v3_no_activity_followup',
  '2740ba1f-d5d5-4008-bf43-b45367c73134',
  'Tresyv V3 video-arm follow-up for leads who never played the video. +72h from sent.',
  'sent',
  ARRAY['replied','played']::text[],
  '[{"id":"v3_no_activity","waitHours":72,"branches":[{"action":{"type":"auto_send","template":"Hej {firstName}\n\nJeg følger bare lige op.\n\nJeg tror, der er nogle oplagte muligheder for at gøre jeres website tydeligere og få flere besøgende til at tage næste skridt.\n\nSkal jeg sende et par forslag til tider, hvor vi kan tage en kort snak?\n\nDe venligste hilsner\nRasmus"}}]}]'::jsonb,
  100,
  true,
  'v3_video'
);
