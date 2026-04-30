-- Hourly poll of Sendpilot's API to backfill leads where the
-- connection.accepted webhook never landed. See
-- supabase/functions/sendpilot-poll/index.ts for the worker.
--
-- Depends on pg_cron + pg_net (both already installed via outreach_engagement.sql).

select cron.unschedule('sendpilot-poll-hourly')
  where exists (select 1 from cron.job where jobname = 'sendpilot-poll-hourly');

select cron.schedule(
    'sendpilot-poll-hourly',
    '0 * * * *',
    $$ select net.http_post(
        url := 'https://znpaevzwlcfuzqxsbyie.supabase.co/functions/v1/sendpilot-poll',
        body := '{}'::jsonb,
        headers := '{"Content-Type":"application/json"}'::jsonb,
        timeout_milliseconds := 60000
    ); $$
);
