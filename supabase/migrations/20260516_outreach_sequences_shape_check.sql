-- Floor-level validation on outreach_sequences.steps. The CLI
-- (scripts/sequences/manage.py) already validates the shape before write;
-- this CHECK is defense-in-depth for the case where someone bypasses the
-- CLI (raw SQL, supabase dashboard, future tooling). Keeps the engine
-- from ever loading a row that would silently freeze leads.
--
-- Mirrors the SequenceStep type in supabase/functions/_shared/sequences.ts.
-- Validation depth: type / required-keys / non-empty. Doesn't check Signal
-- enum membership inside step.excludes or branch.requires (that's the CLI's
-- job — cheap to add later if needed).
--
-- Applied via supabase MCP apply_migration on 2026-05-16.

CREATE OR REPLACE FUNCTION validate_sequence_steps(steps jsonb)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  step jsonb;
  branch jsonb;
  action jsonb;
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
      IF action->>'type' NOT IN ('auto_send', 'queue_approval', 'push_only') THEN
        RAISE EXCEPTION 'branch.action.type=% not in (auto_send, queue_approval, push_only)', action->>'type';
      END IF;
      IF action->>'type' IN ('auto_send', 'queue_approval') THEN
        IF NOT (action ? 'template') OR jsonb_typeof(action->'template') IS DISTINCT FROM 'string' OR length(action->>'template') = 0 THEN
          RAISE EXCEPTION 'branch.action.template required and non-empty for type=%', action->>'type';
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  RETURN TRUE;
END $$;

COMMENT ON FUNCTION validate_sequence_steps(jsonb) IS
  'Validates outreach_sequences.steps shape (mirrors SequenceStep in TS). RAISES on invalid; returns TRUE on valid. Used by the CHECK constraint and callable directly.';

ALTER TABLE outreach_sequences
  ADD CONSTRAINT outreach_sequences_steps_shape
  CHECK (validate_sequence_steps(steps));

ALTER TABLE outreach_sequences
  ADD CONSTRAINT outreach_sequences_trigger_valid
  CHECK (trigger_signal IN (
    'sent', 'viewed', 'played', 'watched_end',
    'cta_clicked', 'liked', 'replied', 'render_failed'
  ));
