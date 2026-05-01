-- Caller-phone index: maps an inbound caller's phone number to the
-- test_submission they're calling about. Filled by the recording
-- processor once it's identified the caller's company from the audio.
--
-- A single phone can map to multiple submissions (rare — same person
-- juggling multiple companies), so this is a join table, not a 1:1.

CREATE TABLE IF NOT EXISTS public.caller_phones (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone           text        NOT NULL,                    -- E.164
  submission_id   uuid        NOT NULL REFERENCES public.test_submissions(id) ON DELETE CASCADE,

  -- Provenance: who told us this mapping
  learned_from    uuid        REFERENCES public.test_responses(id) ON DELETE SET NULL,
  source          text        NOT NULL CHECK (source IN ('voice_transcript','manual','sms_body')),
  confidence      numeric,                                  -- 0..1
  caller_name     text,                                     -- person's name from transcript
  notes           text,

  inserted_at     timestamptz DEFAULT now(),

  UNIQUE (phone, submission_id)
);

CREATE INDEX IF NOT EXISTS caller_phones_phone_idx
  ON public.caller_phones (phone);
CREATE INDEX IF NOT EXISTS caller_phones_submission_idx
  ON public.caller_phones (submission_id);

ALTER TABLE public.caller_phones ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.caller_phones IS
  'Inbound-caller phone → submission mapping. Populated when a recording transcript reveals which company called. Future calls/SMS from the same phone auto-attribute via this index.';
