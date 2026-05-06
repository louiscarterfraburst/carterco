-- Lead quiz submissions from /lead-loss quiz on carterco.dk.
-- Captured at the contact-gate step before results are shown. Phone is
-- optional; if present we fire an SMS via Twilio so the prospect gets a
-- callback offer within minutes.
CREATE TABLE IF NOT EXISTS public.quiz_submissions (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz   NOT NULL DEFAULT now(),
  name            text          NOT NULL,
  email           text          NOT NULL,
  phone           text,
  -- Raw quiz inputs so we can re-derive the loss number later if logic changes.
  url             text,
  monthly_leads   numeric,
  deal_value      numeric,
  close_rate      numeric,
  response_time   text,
  channels        text[],
  -- Snapshot of the loss math at submit time (what the prospect actually saw).
  total_loss      numeric,
  speed_loss      numeric,
  close_rate_loss numeric,
  channel_loss    numeric,
  -- Outbound SMS bookkeeping.
  sms_sid         text,
  sms_sent_at     timestamptz,
  sms_error       text,
  user_agent      text,
  referrer        text
);

CREATE INDEX IF NOT EXISTS quiz_submissions_email_idx
  ON public.quiz_submissions (lower(email));
CREATE INDEX IF NOT EXISTS quiz_submissions_phone_idx
  ON public.quiz_submissions (phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS quiz_submissions_created_idx
  ON public.quiz_submissions (created_at DESC);

COMMENT ON TABLE public.quiz_submissions IS
  'Lead-quiz submissions from carterco.dk. Each row = one contact-gate fill, written before results render. Phone optional; SMS auto-fires when provided.';
