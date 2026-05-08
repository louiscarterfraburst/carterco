-- Lead-response testing system.
--
-- One persona email submits real form leads to companies we want to outreach to.
-- Their replies (or silence) get tracked here, then surface as personalized
-- Sendspark hooks ("We submitted on X, you responded in Y hours, here's what
-- a real-time response system would do.").
--
-- Apply via the Supabase SQL Editor (one-shot).

-- ─── test_submissions ──────────────────────────────────────────────────
-- One row per company we test. Created from leads_to_enrich; ref_code is
-- the body-match anchor (we put it in the form message field, it survives
-- in quoted replies).

CREATE TABLE IF NOT EXISTS public.test_submissions (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_code            text        NOT NULL UNIQUE,

  -- Source / company
  linkedin_url        text,
  company             text,
  website             text,
  domain              text,
  contact_url         text,
  industry            text,
  city                text,

  -- Submission state
  status              text        NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','submitted','skipped','failed')),
  submitted_at        timestamptz,
  submitted_by        text,
  notes               text,

  -- Denormalized first-response (kept fresh by trigger below)
  first_response_at   timestamptz,
  first_response_id   uuid,

  inserted_at         timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS test_submissions_status_idx
  ON public.test_submissions (status);
CREATE INDEX IF NOT EXISTS test_submissions_domain_idx
  ON public.test_submissions (domain) WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS test_submissions_submitted_at_idx
  ON public.test_submissions (submitted_at) WHERE submitted_at IS NOT NULL;

-- ─── test_responses ────────────────────────────────────────────────────
-- One row per inbound message (email v1, phone/sms later). submission_id
-- is nullable — unmatched replies surface in the admin UI for manual assign.

CREATE TABLE IF NOT EXISTS public.test_responses (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id   uuid        REFERENCES public.test_submissions(id) ON DELETE SET NULL,

  channel         text        NOT NULL CHECK (channel IN ('email','phone','sms','manual')),
  received_at     timestamptz NOT NULL DEFAULT now(),

  -- Email payload
  from_address    text,
  from_name       text,
  from_domain     text,
  subject         text,
  body_excerpt    text,
  message_id      text        UNIQUE,    -- IMAP Message-ID; dedup on re-poll

  -- Attribution provenance
  matched_via     text        CHECK (matched_via IS NULL
                              OR matched_via IN ('email_tag','domain','ref_code','manual')),
  match_confidence numeric,

  inserted_at     timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS test_responses_submission_idx
  ON public.test_responses (submission_id);
CREATE INDEX IF NOT EXISTS test_responses_unassigned_idx
  ON public.test_responses (received_at) WHERE submission_id IS NULL;
CREATE INDEX IF NOT EXISTS test_responses_received_idx
  ON public.test_responses (received_at);

ALTER TABLE public.test_responses
  DROP CONSTRAINT IF EXISTS test_responses_matched_via_check;

ALTER TABLE public.test_responses
  ADD CONSTRAINT test_responses_matched_via_check
  CHECK (matched_via IS NULL
         OR matched_via IN ('email_tag','domain','ref_code','manual'));

-- ─── First-response trigger ────────────────────────────────────────────
-- When a response lands and is attributed, update the parent submission's
-- first_response_at if this is the earliest. Cheap pre-aggregation so the
-- warmth query never has to scan responses.

CREATE OR REPLACE FUNCTION public.test_responses_update_first()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.submission_id IS NOT NULL THEN
    UPDATE public.test_submissions
    SET first_response_at = NEW.received_at,
        first_response_id = NEW.id,
        updated_at = now()
    WHERE id = NEW.submission_id
      AND (first_response_at IS NULL OR NEW.received_at < first_response_at);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS test_responses_first_aiu ON public.test_responses;
CREATE TRIGGER test_responses_first_aiu
  AFTER INSERT OR UPDATE OF submission_id, received_at ON public.test_responses
  FOR EACH ROW
  EXECUTE FUNCTION public.test_responses_update_first();

-- ─── RLS — service-role only for now ───────────────────────────────────
ALTER TABLE public.test_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_responses   ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.test_submissions IS
  'Lead-response testing: one row per company we submitted a test lead for.';
COMMENT ON TABLE public.test_responses IS
  'Lead-response testing: one row per inbound reply, attributed to a submission.';
