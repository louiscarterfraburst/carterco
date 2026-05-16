-- Per-workspace follow-up sequence definitions. NULL workspace_id = global
-- default; a row with a real workspace_id overrides the global default for
-- that workspace by matching sequence id. The engine resolves per-lead via
-- (workspace_id = lead.workspace_id OR workspace_id IS NULL), preferring
-- workspace-specific over global when ids collide.
--
-- Applied via supabase MCP apply_migration on 2026-05-16. This file mirrors
-- the change for repo traceability — running it again on a fresh DB
-- reproduces production state.

CREATE TABLE outreach_sequences (
  id              text NOT NULL,
  workspace_id    uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  description     text NOT NULL DEFAULT '',
  trigger_signal  text NOT NULL,
  excludes_global text[] NOT NULL DEFAULT ARRAY['replied'],
  steps           jsonb NOT NULL,
  position        int NOT NULL DEFAULT 100,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE outreach_sequences IS
  'Follow-up sequence definitions. workspace_id NULL = global default. Engine: outreach-engagement-tick reads via _shared/sequences.ts loader.';
COMMENT ON COLUMN outreach_sequences.steps IS
  'Array of SequenceStep objects: {id, waitHours, branches[{action:{type,template}}], excludes?, maxWaitHours?}. Shape mirrors the TS type in _shared/sequences.ts.';

CREATE UNIQUE INDEX outreach_sequences_global_uniq
  ON outreach_sequences (id) WHERE workspace_id IS NULL;
CREATE UNIQUE INDEX outreach_sequences_workspace_uniq
  ON outreach_sequences (workspace_id, id) WHERE workspace_id IS NOT NULL;

CREATE INDEX outreach_sequences_active_idx
  ON outreach_sequences (workspace_id, position) WHERE is_active = true;

CREATE OR REPLACE FUNCTION set_outreach_sequences_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER outreach_sequences_set_updated_at
  BEFORE UPDATE ON outreach_sequences
  FOR EACH ROW EXECUTE FUNCTION set_outreach_sequences_updated_at();

ALTER TABLE outreach_sequences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "read global + own workspace sequences"
  ON outreach_sequences
  FOR SELECT
  TO authenticated
  USING (
    workspace_id IS NULL
    OR EXISTS (
      SELECT 1 FROM workspace_members wm
      WHERE wm.workspace_id = outreach_sequences.workspace_id
        AND wm.user_email = auth.jwt() ->> 'email'
    )
  );

-- Seed: the two current sequences, copied byte-for-byte from the pre-DB
-- SEQUENCES const in _shared/sequences.ts (now removed). After this seed,
-- every workspace resolves to the same 2 sequences as before — no behavior
-- change.
INSERT INTO outreach_sequences (id, workspace_id, description, trigger_signal, excludes_global, steps, position) VALUES
(
  'watched_followup_v1',
  NULL,
  'Lead played the video. React fast (20 min), then bump 3 days later if no reply.',
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
      "waitHours": 72,
      "branches": [
        {
          "action": {
            "type": "auto_send",
            "template": "Hej {firstName}, vender tilbage på denne. Er det noget vi skal sætte i kalenderen?"
          }
        }
      ]
    }
  ]$JSON$::jsonb,
  100
),
(
  'unwatched_followup_v1',
  NULL,
  'Lead got the video but hasn''t played it. Qualify at +3d, then a final graceful exit at +5d. Slower than the watched flow because no engagement yet, gives them room for vacations / busy weeks before pushing.',
  'sent',
  ARRAY['replied', 'played'],
  $JSON$[
    {
      "id": "qualifier",
      "waitHours": 72,
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
      "id": "graceful_exit",
      "waitHours": 120,
      "branches": [
        {
          "action": {
            "type": "auto_send",
            "template": "Hej {firstName}\n\nJeg lukker den herfra for nu.\n\nHvis det bliver relevant senere, er du meget velkommen til at skrive, så tager vi den derfra.\n\nGod dag."
          }
        }
      ]
    }
  ]$JSON$::jsonb,
  200
)
ON CONFLICT DO NOTHING;
