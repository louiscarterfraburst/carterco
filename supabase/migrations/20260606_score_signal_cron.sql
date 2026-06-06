-- Score inbound signals (RB2B site visits etc.) against each workspace's active
-- ICP every 10 min. Nothing scored signals before — outreach_signals.icp_score
-- was always null, so the Besøg view read "ukendt fit" for everyone. The
-- score-signal edge function (deployed separately, verify_jwt off) scores
-- company fit 1-10 against icp_versions.company_fit. Cloned from icp.sql's
-- score-accepted-lead-5min schedule.

select cron.unschedule('score-signal-10min')
  where exists (select 1 from cron.job where jobname = 'score-signal-10min');

select cron.schedule(
  'score-signal-10min',
  '*/10 * * * *',
  $$ select net.http_post(
    url := 'https://znpaevzwlcfuzqxsbyie.supabase.co/functions/v1/score-signal',
    body := '{}'::jsonb,
    headers := '{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 240000
  ); $$
);
