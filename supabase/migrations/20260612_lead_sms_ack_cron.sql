-- lead-sms-ack cron: every 2 minutes, drain the auto-SMS safety net for
-- inbound Meta leads (5-minute reception gate lives in the function — see
-- supabase/functions/lead-sms-ack). The function no-ops while
-- TELAVOX_SMS_TOKEN is unset, so scheduling this before the Reception1 token
-- exists is harmless.
--
-- NB deploy order: deploy the lead-sms-ack function (verify_jwt=false) before
-- applying this, or every tick 401s. The endpoint is safe to expose: sends are
-- capped at one attempt per lead via lead_conversation_events
-- (source='lead_sms_ack'), and a missing token makes it a no-op.

select cron.unschedule('lead-sms-ack-2min')
  where exists (select 1 from cron.job where jobname = 'lead-sms-ack-2min');

select cron.schedule(
  'lead-sms-ack-2min',
  '*/2 * * * *',
  $$ select net.http_post(
    url := 'https://znpaevzwlcfuzqxsbyie.supabase.co/functions/v1/lead-sms-ack',
    body := '{}'::jsonb,
    headers := '{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 60000
  ); $$
);
