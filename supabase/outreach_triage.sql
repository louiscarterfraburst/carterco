-- AI-triage layer for outreach_replies.
--
-- Adds AI-derived signals on top of the existing intent classification:
-- priority for surfacing, recommended next action, draft response,
-- extracted signals, AI reasoning, and scheduled follow-up date pulled
-- from time signals in the reply text ("tjek tilbage om en måned" etc).
--
-- Pattern mirrors the existing outreach_notify_pending trigger
-- (supabase/outreach.sql:192) — on INSERT into outreach_replies, fire
-- the ai-triage-reply edge function via net.http_post. Operators see
-- the triage signals in the Svar tab; a nightly cron resurfaces replies
-- whose scheduled_followup_at has come due.
--
-- Idempotent: re-runnable.

-- 1. Additive columns -----------------------------------------------------
alter table public.outreach_replies
    add column if not exists triage_priority       smallint check (triage_priority between 1 and 10),
    add column if not exists triage_action         text,
    add column if not exists triage_draft          text,
    add column if not exists triage_signals        jsonb,
    add column if not exists triage_reasoning      text,
    add column if not exists triage_processed_at   timestamptz,
    add column if not exists scheduled_followup_at timestamptz;

comment on column public.outreach_replies.triage_priority is
    'AI-assigned 1-10 priority for surfacing in the Svar dashboard. Higher = act sooner. Computed by ai-triage-reply edge function from intent + ICP + signal strength + time-relevance.';

comment on column public.outreach_replies.triage_action is
    'AI-recommended next action in short prose, native Danish. E.g. "Send Murph-case + spørg om Q3-budget".';

comment on column public.outreach_replies.triage_draft is
    'AI-suggested response draft in native Danish. Operator copy-edits before send.';

comment on column public.outreach_replies.triage_signals is
    'Structured AI-extracted signals: { budget, timeline, decision_authority, objections, time_signal }';

comment on column public.outreach_replies.triage_reasoning is
    'AI explanation for the priority + action choice. Visible on hover so operators understand the why.';

comment on column public.outreach_replies.triage_processed_at is
    'When ai-triage-reply last processed this row. Re-triage on intent reclassification by setting to null.';

comment on column public.outreach_replies.scheduled_followup_at is
    'When the prospect explicitly asked to be re-engaged. AI extracts from time signals in the reply ("tjek tilbage om en måned"). Nightly cron resurfaces these on the day with boosted priority.';

-- 2. Indexes --------------------------------------------------------------
-- Priority sort for the Svar tab. Only unhandled rows need to be surfaced.
create index if not exists idx_outreach_replies_triage_priority
    on public.outreach_replies (triage_priority desc nulls last)
    where handled = false;

-- Scheduled-followup index for the nightly cron sweep.
create index if not exists idx_outreach_replies_scheduled
    on public.outreach_replies (scheduled_followup_at)
    where scheduled_followup_at is not null and handled = false;

-- Index for the backfill script: find unprocessed rows efficiently.
create index if not exists idx_outreach_replies_unprocessed
    on public.outreach_replies (received_at desc)
    where triage_processed_at is null;

-- 3. Trigger: auto-fire ai-triage-reply on new reply ----------------------
-- Mirrors the outreach_notify_pending pattern: net.http_post to the edge
-- function. Idempotent — re-running the migration replaces the function.
create or replace function public.outreach_trigger_triage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    -- Only fire on INSERT, and only if not already triaged (safety against
    -- accidental re-triggering on UPDATE).
    if tg_op <> 'INSERT' then
        return new;
    end if;
    if new.triage_processed_at is not null then
        return new;
    end if;

    perform net.http_post(
        url := 'https://znpaevzwlcfuzqxsbyie.supabase.co/functions/v1/ai-triage-reply',
        body := jsonb_build_object(
            'type', tg_op,
            'table', 'outreach_replies',
            'schema', 'public',
            'record', row_to_json(new)
        ),
        headers := '{"Content-Type":"application/json"}'::jsonb,
        timeout_milliseconds := 5000
    );

    return new;
end $$;

drop trigger if exists outreach_replies_triage_trg on public.outreach_replies;
create trigger outreach_replies_triage_trg
    after insert on public.outreach_replies
    for each row execute function public.outreach_trigger_triage();

-- 4. Backfill helper ------------------------------------------------------
-- One-shot batch dispatcher: fires ai-triage-reply for unprocessed replies.
-- Run after deploying the function: `select public.outreach_triage_backfill(100);`
-- Repeat until it returns 0. Throttle: each call queues N requests to
-- the edge function via net.http_post (async — they run in parallel up to
-- Supabase's worker pool limits).
create or replace function public.outreach_triage_backfill(batch_size int default 50)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
    count_processed int := 0;
    r record;
begin
    for r in
        select id from public.outreach_replies
        where triage_processed_at is null
          and handled = false
          and direction = 'inbound'
        order by received_at desc
        limit batch_size
    loop
        perform net.http_post(
            url := 'https://znpaevzwlcfuzqxsbyie.supabase.co/functions/v1/ai-triage-reply',
            body := jsonb_build_object('replyId', r.id::text),
            headers := '{"Content-Type":"application/json"}'::jsonb,
            timeout_milliseconds := 5000
        );
        count_processed := count_processed + 1;
    end loop;
    return count_processed;
end $$;

comment on function public.outreach_triage_backfill is
    'Backfill triage signals for unprocessed inbound replies. Run repeatedly with batch_size until it returns 0. Each call enqueues parallel HTTP POSTs to ai-triage-reply.';
