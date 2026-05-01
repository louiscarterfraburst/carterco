-- Voice recording + transcript columns for test_responses.
-- Used by /api/twilio/voice-recording and /api/twilio/voice-transcript
-- to enrich phone-channel responses with the actual call audio + transcript.

ALTER TABLE public.test_responses
  ADD COLUMN IF NOT EXISTS recording_url   text,
  ADD COLUMN IF NOT EXISTS recording_sid   text,
  ADD COLUMN IF NOT EXISTS recording_secs  integer,
  ADD COLUMN IF NOT EXISTS transcript      text;

CREATE INDEX IF NOT EXISTS test_responses_recording_sid_idx
  ON public.test_responses (recording_sid)
  WHERE recording_sid IS NOT NULL;

COMMENT ON COLUMN public.test_responses.recording_url IS
  'Twilio-hosted recording URL (mp3/wav); requires Twilio auth to fetch.';
COMMENT ON COLUMN public.test_responses.transcript IS
  'Auto-generated transcript from Twilio transcription.';
