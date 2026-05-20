-- CarterCo-specific overrides of the two global outreach sequences.
-- Adds email follow-up steps and tightens LI cadence. Other workspaces
-- (Tresyv, Haugefrom, OdaGroup) continue to resolve to the unchanged
-- global rows — workspace isolation is automatic via the partial unique
-- indexes + resolveSequencesForWorkspace() preferring workspace-specific
-- rows over globals when ids collide.
--
-- DEPLOY-ORDER WARNING: this migration requires engine support for
-- action.type = "email_draft" added in the same release. The engine code
-- lives in:
--   - supabase/functions/_shared/engagement-rules.ts (Action union)
--   - supabase/functions/outreach-engagement-tick/index.ts (dispatch arm)
--   - supabase/functions/outreach-ai/index.ts (strategy parameter)
-- DEPLOY those functions BEFORE applying this migration, otherwise the
-- engine will crash at step 2 of the new watched sequence (renderTemplate
-- on an undefined action.template).
--
-- IN-FLIGHT MIGRATION NOTE: 6 CarterCo leads were in unwatched_followup_v1
-- at the time this was authored (2 at step=0, 4 at step=1). The 4 at
-- step=1 were waiting for the old graceful_exit (LI). With this override
-- their next fire becomes mail_anden_kanal (email_draft, first_contact).
-- They will continue through the full new sequence afterwards — graceful_exit
-- now lives at step=3. End-to-end this means the lead gets MORE touches
-- than originally scheduled, not fewer.

INSERT INTO outreach_sequences (id, workspace_id, description, trigger_signal, excludes_global, steps, position) VALUES
(
  'watched_followup_v1',
  '1e067f9a-d453-41a7-8bc4-9fdb5644a5fa',
  'CarterCo override: tighter LI cadence (1d vs 3d) + 3 email_draft steps over 12 days. Watched flow = high intent (lead played the video).',
  'played',
  ARRAY['replied'],
  $JSON$[
    {
      "id": "nysgerrig",
      "waitHours": 0.3333333333333333,
      "branches": [
        {
          "action": {
            "type": "auto_send",
            "template": "Hej {firstName}\n\nEr nysgerrig på din vurdering. Er det noget, der lyder interessant?\n\nJeg kan sende et par forslag til tider, hvis det giver mening at tage den videre."
          }
        }
      ]
    },
    {
      "id": "kalender",
      "waitHours": 24,
      "branches": [
        {
          "action": {
            "type": "auto_send",
            "template": "Hej {firstName}, vender tilbage på denne. Er det noget vi skal sætte i kalenderen?"
          }
        }
      ]
    },
    {
      "id": "mail_opsummering",
      "waitHours": 24,
      "branches": [
        {
          "action": { "type": "email_draft", "strategy": "warm_recap" }
        }
      ]
    },
    {
      "id": "mail_ny_vinkel",
      "waitHours": 72,
      "branches": [
        {
          "action": { "type": "email_draft", "strategy": "warm_recap" }
        }
      ]
    },
    {
      "id": "mail_sidste",
      "waitHours": 168,
      "branches": [
        {
          "action": { "type": "email_draft", "strategy": "warm_recap" }
        }
      ]
    }
  ]$JSON$::jsonb,
  100
),
(
  'unwatched_followup_v1',
  '1e067f9a-d453-41a7-8bc4-9fdb5644a5fa',
  'CarterCo override: tighter LI cadence (2d vs 3d) + 3 email_draft steps with graceful_exit at +10d, final mail at +21d. Unwatched flow = lower intent (got video, did not play).',
  'sent',
  ARRAY['replied', 'played'],
  $JSON$[
    {
      "id": "qualifier",
      "waitHours": 48,
      "branches": [
        {
          "action": {
            "type": "auto_send",
            "template": "Hej {firstName}\n\nHurtigt spørgsmål: er du den rigtige hos {company} at tale med om dette, eller skal jeg fange en anden? Sig også til hvis det ikke er relevant."
          }
        }
      ]
    },
    {
      "id": "mail_anden_kanal",
      "waitHours": 24,
      "branches": [
        {
          "action": { "type": "email_draft", "strategy": "first_contact" }
        }
      ]
    },
    {
      "id": "mail_opfoelg",
      "waitHours": 72,
      "branches": [
        {
          "action": { "type": "email_draft", "strategy": "first_contact" }
        }
      ]
    },
    {
      "id": "graceful_exit",
      "waitHours": 96,
      "branches": [
        {
          "action": {
            "type": "auto_send",
            "template": "Hej {firstName}\n\nJeg lukker den herfra for nu.\n\nHvis det bliver relevant senere, er du meget velkommen til at skrive, så tager vi den derfra.\n\nGod dag."
          }
        }
      ]
    },
    {
      "id": "mail_sidste",
      "waitHours": 264,
      "branches": [
        {
          "action": { "type": "email_draft", "strategy": "first_contact" }
        }
      ]
    }
  ]$JSON$::jsonb,
  200
)
ON CONFLICT DO NOTHING;
