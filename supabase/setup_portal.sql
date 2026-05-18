-- Client-onboarding portal. Per-engagement /setup/<slug> page where a new
-- client (e.g. Bikenor / Nikolaj) fills in the access bits I need before I
-- can start building. Replaces the back-and-forth email checklist.
--
-- Two tables. setup_engagements is the per-client header (one row per
-- engagement). setup_items is the long list of fields the client fills in,
-- grouped by section. Kinds drive the input renderer in /setup/[slug].
--
-- Slugs are the bearer — long, unguessable, sent directly to the client.
-- No public listing endpoint; the row is fetched by slug match only.
-- Sensitive tokens are NEVER stored in setup_items.value as raw text — the
-- "secure_share" kind asks the client for a Bitwarden Send / 1Password
-- share URL instead, which expires server-side after first retrieval.

CREATE TABLE setup_engagements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,
  client_name     text NOT NULL,
  contact_name    text,
  contact_email   text,
  intro_md        text,
  status          text NOT NULL DEFAULT 'open',
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  notified_at     timestamptz
);

COMMENT ON TABLE setup_engagements IS
  'Per-client onboarding header for /setup/<slug> portal. Slug is bearer auth.';
COMMENT ON COLUMN setup_engagements.status IS
  'open | completed | archived';

CREATE INDEX setup_engagements_slug_idx ON setup_engagements (slug);

CREATE TABLE setup_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id   uuid NOT NULL REFERENCES setup_engagements(id) ON DELETE CASCADE,
  section_key     text NOT NULL,
  section_title   text NOT NULL,
  item_key        text NOT NULL,
  label           text NOT NULL,
  help_md         text,
  placeholder     text,
  kind            text NOT NULL,
  required        boolean NOT NULL DEFAULT false,
  value           text,
  completed       boolean NOT NULL DEFAULT false,
  completed_at    timestamptz,
  sort_section    int NOT NULL DEFAULT 100,
  sort_item       int NOT NULL DEFAULT 100,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE setup_items IS
  'Per-item field on a setup engagement. Grouped by section_key.';
COMMENT ON COLUMN setup_items.kind IS
  'text | textarea | secure_share | checkbox | radio';
COMMENT ON COLUMN setup_items.value IS
  'Plaintext value. For kind=secure_share this is a Bitwarden/1P share URL — NEVER a raw token.';

CREATE UNIQUE INDEX setup_items_engagement_key_idx
  ON setup_items (engagement_id, item_key);
CREATE INDEX setup_items_engagement_section_idx
  ON setup_items (engagement_id, sort_section, sort_item);

CREATE OR REPLACE FUNCTION set_setup_items_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER setup_items_updated_at
  BEFORE UPDATE ON setup_items
  FOR EACH ROW EXECUTE FUNCTION set_setup_items_updated_at();

-- RLS: the portal page reads/writes via the service-role admin client in
-- Next.js server actions (slug validated server-side), so anon access is
-- closed entirely.
ALTER TABLE setup_engagements ENABLE ROW LEVEL SECURITY;
ALTER TABLE setup_items       ENABLE ROW LEVEL SECURITY;
-- No policies = no anon access. Service role bypasses RLS.
