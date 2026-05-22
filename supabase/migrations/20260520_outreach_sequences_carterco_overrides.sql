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

-- STEP 1: extend the shape validator to allow email_draft. The original
-- validator (20260516_outreach_sequences_shape_check.sql) hardcodes the
-- allowed action.type list to (auto_send, queue_approval, push_only). The
-- INSERT below would fail the CHECK constraint without this update.
-- Bundled into the same migration as the INSERT so the change is atomic —
-- you can't accidentally apply the data without the validator update.
CREATE OR REPLACE FUNCTION validate_sequence_steps(steps jsonb)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  step jsonb;
  branch jsonb;
  action jsonb;
  strategy text;
BEGIN
  IF jsonb_typeof(steps) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'steps must be a JSON array, got %', jsonb_typeof(steps);
  END IF;
  IF jsonb_array_length(steps) = 0 THEN
    RAISE EXCEPTION 'steps cannot be empty (engine would complete immediately)';
  END IF;

  FOR step IN SELECT * FROM jsonb_array_elements(steps) LOOP
    IF jsonb_typeof(step) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'each step must be a JSON object, got %', jsonb_typeof(step);
    END IF;

    IF step ? 'wait_hours' THEN
      RAISE EXCEPTION 'step has snake_case key wait_hours; the engine reads camelCase waitHours';
    END IF;
    IF step ? 'max_wait_hours' THEN
      RAISE EXCEPTION 'step has snake_case key max_wait_hours; the engine reads camelCase maxWaitHours';
    END IF;

    IF NOT (step ? 'id' AND step ? 'waitHours' AND step ? 'branches') THEN
      RAISE EXCEPTION 'step missing required fields {id, waitHours, branches}: %', step;
    END IF;
    IF jsonb_typeof(step->'id') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'step.id must be string';
    END IF;
    IF jsonb_typeof(step->'waitHours') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'step.waitHours must be number';
    END IF;
    IF (step->>'waitHours')::numeric < 0 THEN
      RAISE EXCEPTION 'step.waitHours must be non-negative';
    END IF;

    IF jsonb_typeof(step->'branches') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'step.branches must be array';
    END IF;
    IF jsonb_array_length(step->'branches') = 0 THEN
      RAISE EXCEPTION 'step.branches must be non-empty';
    END IF;

    FOR branch IN SELECT * FROM jsonb_array_elements(step->'branches') LOOP
      IF jsonb_typeof(branch) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'each branch must be a JSON object';
      END IF;
      IF NOT (branch ? 'action') THEN
        RAISE EXCEPTION 'branch missing required field {action}: %', branch;
      END IF;
      action := branch->'action';
      IF jsonb_typeof(action) IS DISTINCT FROM 'object' OR NOT (action ? 'type') THEN
        RAISE EXCEPTION 'branch.action must be object with a type field';
      END IF;
      IF action->>'type' NOT IN ('auto_send', 'queue_approval', 'push_only', 'email_draft') THEN
        RAISE EXCEPTION 'branch.action.type=% not in (auto_send, queue_approval, push_only, email_draft)', action->>'type';
      END IF;
      IF action->>'type' IN ('auto_send', 'queue_approval') THEN
        IF NOT (action ? 'template') OR jsonb_typeof(action->'template') IS DISTINCT FROM 'string' OR length(action->>'template') = 0 THEN
          RAISE EXCEPTION 'branch.action.template required and non-empty for type=%', action->>'type';
        END IF;
      END IF;
      -- email_draft: strategy is optional, but if present must be one of the
      -- five known strategies. The engine forwards it to outreach-ai as the
      -- suggestedStrategy override.
      IF action->>'type' = 'email_draft' AND action ? 'strategy' THEN
        strategy := action->>'strategy';
        IF strategy NOT IN ('reconnect_post_call', 'reply_redirect', 'warm_recap', 'referral_intro', 'first_contact') THEN
          RAISE EXCEPTION 'branch.action.strategy=% not in (reconnect_post_call, reply_redirect, warm_recap, referral_intro, first_contact)', strategy;
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  RETURN TRUE;
END $$;

-- STEP 2: insert the CarterCo overrides.
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
            "template": "Hej {firstName}\n\nHurtigt spørgsmål: er du den rigtige hos jer at tale med om dette, eller skal jeg fange en anden? Sig også til hvis det ikke er relevant."
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
