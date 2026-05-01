-- Phase 2: phone tracking for test-leads.
-- Adds the company-side phone number to test_submissions so we can
-- attribute inbound Twilio calls/SMS via caller-ID.

ALTER TABLE public.test_submissions
  ADD COLUMN IF NOT EXISTS phone text;

CREATE INDEX IF NOT EXISTS test_submissions_phone_idx
  ON public.test_submissions (phone) WHERE phone IS NOT NULL;

-- Normalize an arbitrary phone string into E.164. Best-effort, used by
-- the Twilio webhooks to match caller-ID against test_submissions.phone.
-- Examples:
--   "+45 91 30 92 79"  → "+4591309279"
--   "0045 91309279"    → "+4591309279"
--   "91 30 92 79"      → "+4591309279"  (assumes DK if no country code)
--   "(415) 555-0100"   → "+14155550100" (assumes US if 10 digits)
CREATE OR REPLACE FUNCTION public.normalize_phone(input text, default_cc text DEFAULT '45')
RETURNS text AS $$
DECLARE
  digits text;
BEGIN
  IF input IS NULL OR input = '' THEN RETURN NULL; END IF;
  -- Strip everything but digits and leading '+'
  digits := regexp_replace(input, '[^\d+]', '', 'g');
  IF digits LIKE '+%' THEN
    RETURN digits;
  END IF;
  IF digits LIKE '00%' THEN
    RETURN '+' || substring(digits FROM 3);
  END IF;
  IF length(digits) = 10 AND default_cc = '1' THEN
    RETURN '+1' || digits;
  END IF;
  IF length(digits) = 8 AND default_cc = '45' THEN
    RETURN '+45' || digits;
  END IF;
  -- Generic fallback: prefix country code
  RETURN '+' || default_cc || digits;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON COLUMN public.test_submissions.phone IS
  'Company phone number in E.164 (e.g. +4591309279). Used for caller-ID match on Twilio webhooks.';
