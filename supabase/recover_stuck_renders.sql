-- Self-healing reconciler for outreach_pipeline rows stuck in `rendering`.
-- Defends against dropped webhook deliveries (auth gate failures, Svix
-- retry exhaustion, SendSpark queue glitches). See
-- supabase/functions/recover-stuck-renders/index.ts for the worker logic.
--
-- Cadence: every 10 minutes. Worker uses min_age_minutes=30 by default,
-- so healthy in-flight renders aren't disrupted.
--
-- Depends on pg_cron + pg_net (already installed via outreach_engagement.sql).

select cron.unschedule('recover-stuck-renders-10min')
  where exists (select 1 from cron.job where jobname = 'recover-stuck-renders-10min');

select cron.schedule(
    'recover-stuck-renders-10min',
    '*/10 * * * *',
    $$ select net.http_post(
        url := 'https://znpaevzwlcfuzqxsbyie.supabase.co/functions/v1/recover-stuck-renders',
        body := '{}'::jsonb,
        headers := '{"Content-Type":"application/json"}'::jsonb,
        timeout_milliseconds := 60000
    ); $$
);
