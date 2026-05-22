-- Tresyv-specific overrides of outreach_sequences.
-- Replaces global CarterCo-voiced follow-ups with Rasmus's approved copy
-- from the 2026-05-21 thread (Re: Fwd: 3 versioner vi kører):
--   unwatched (text-track + video never-played) → V1 "blød exit"
--   watched   (video played)                    → V3 "pull-the-meeting"
-- Drops the breakup step entirely per Rasmus's explicit ask
-- ("Kan vi droppe 'Sidste hilsen (breakup) — fælles' …").
--
-- Lane-keyed routing (V1 vs V2 vs V3 first-messages with lane-specific
-- followups) is NOT yet implemented — pending the lane-storage decision
-- after the 2026-05-22 meeting. For now ALL Tresyv text-only leads share
-- the V1 followup and ALL video-played share V3 pull-the-meeting.
--
-- In-flight handling: 4 Tresyv leads are parked at unwatched_followup_v1
-- step=1 for the now-removed graceful_exit, due Sun 2026-05-24 ~14:45
-- UTC. The same-transaction UPDATE rewinds them to step=0 so the engine
-- fires the new V1 copy at the already-scheduled time instead of the
-- breakup. Watched leads in the Tresyv workspace are all already
-- sequence_completed_at, so nothing to rewind on the watched side.

INSERT INTO outreach_sequences (id, workspace_id, description, trigger_signal, excludes_global, steps, position) VALUES
(
  'unwatched_followup_v1',
  '2740ba1f-d5d5-4008-bf43-b45367c73134',
  'Tresyv override: V1 blød-exit followup at +72h from sent. Single step, no breakup. Covers text-track (V1+V2) and video-never-played until lane-keyed routing ships.',
  'sent',
  ARRAY['replied', 'played'],
  $JSON$[
    {
      "id": "v1_soft_exit",
      "waitHours": 72,
      "branches": [
        {
          "action": {
            "type": "auto_send",
            "template": "Hej {firstName}\n\nJeg følger bare lige op.\n\nJeg tror, der er et par oplagte steder, hvor jeres website kan blive tydeligere og konvertere bedre.\n\nSkal jeg sende et par konkrete bud?\n\nHvis ikke, er det helt fair – så lukker jeg den bare herfra.\n\nDe venligste hilsner\nRasmus"
          }
        }
      ]
    }
  ]$JSON$::jsonb,
  100
),
(
  'watched_followup_v1',
  '2740ba1f-d5d5-4008-bf43-b45367c73134',
  'Tresyv override: V3 pull-the-meeting at +8h from played. Single step. Sub-variants (watched_end / opened-not-finished / no-activity) require finer engagement signals; deferred until lane-keyed routing.',
  'played',
  ARRAY['replied'],
  $JSON$[
    {
      "id": "v3_pull_the_meeting",
      "waitHours": 8,
      "branches": [
        {
          "action": {
            "type": "auto_send",
            "template": "Hej {firstName}\n\nJeg håber, videoen gav mening.\n\nSkal vi tage en kort snak om, hvor vi ser de største muligheder for at gøre jeres website tydeligere og få flere besøgende til at tage næste skridt?\n\nJeg sender gerne et par forslag til tider.\n\nDe venligste hilsner\nRasmus"
          }
        }
      ]
    }
  ]$JSON$::jsonb,
  100
);

-- Rewind in-flight unwatched leads to step=0 of the new override so the
-- already-scheduled fire on Sun 2026-05-24 ~14:45 UTC delivers V1 copy
-- instead of the now-removed graceful_exit.
UPDATE outreach_pipeline
SET sequence_step = 0
WHERE workspace_id = '2740ba1f-d5d5-4008-bf43-b45367c73134'
  AND sequence_id = 'unwatched_followup_v1'
  AND sequence_step = 1
  AND sequence_completed_at IS NULL;
