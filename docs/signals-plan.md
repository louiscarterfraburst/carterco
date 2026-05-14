# Buying signals + omnichannel outreach plan

Single source of truth for the signal-capture-to-outreach pipeline.
Written 2026-05-13. Update inline as we ship and learn.

## Goal

Convert RB2B-identified website visitors into booked meetings by
running the same cold-prospect flow across email, LinkedIn, SMS,
and calls — tracking which strategy classifications win so the
loop self-improves.

---

## Shipped (today, commit `52942f5` + `976778c`)

| Piece | Where | Notes |
| --- | --- | --- |
| RB2B pixel | `src/app/layout.tsx` | Live in production after next deploy. 7-day full-access trial started 2026-05-13. |
| `outreach_signals` table | `supabase/outreach_signals.sql` | Workspace-scoped, RLS on, jsonb payload + extracted fields, idempotent on `(source, external_id)`. |
| `rb2b-webhook` edge function | `supabase/functions/rb2b-webhook/` | Direct RB2B → Supabase path. Token auth via `RB2B_WEBHOOK_TOKEN`. Unused while trial active; needed if we ever switch off the Slack relay. |
| `slack-mailhook` edge function | `supabase/functions/slack-mailhook/` | Receives JSON from Make.com (Slack channel watcher → HTTP POST). Defensive regex extracts visitor data from Slack message bodies. Currently the active ingestion path. |
| `outreach_signal_phones` migration | `supabase/outreach_signal_phones.sql` | Adds `phone_direct`, `phone_office`, `phone_source`, `phone_scouted_at`, `phone_scout_details`. |
| `signal-scout-phones` edge function | `supabase/functions/signal-scout-phones/` | Waterfall: website scrape (free) → Prospeo Mobile Finder API (free 75 cr/mo, then $39/mo) → office fallback. Logs full trace to jsonb for hit-rate debugging. |
| Signaler tab | `src/app/outreach/page.tsx` | Lists unhandled signals, expand → details + scout button. Phone numbers render as click-to-call. |
| Click-to-handoff buttons | `src/app/outreach/page.tsx` | After scout: Ring (tel:), SMS (sms: w/ Danish cold body), Mail (mailto: w/ subject+body). Mirrors `/leads` pattern. |
| AI reply triage | `supabase/functions/ai-triage-reply/` + `supabase/outreach_triage.sql` | Was already partially built; shipped end-to-end this session. Scores priority + drafts Danish response. Surfaces in Opgaver tab. |
| Make.com Slack→HTTP scenario | external | Polls `#rb2b-leads` every 30 min, POSTs JSON body to `slack-mailhook`. ~1,440 polls/mo — will exceed free Make tier ~day 17. |

External services configured:
- Prospeo: free tier, 75 mobile credits/mo, API key in Supabase secret `PROSPEO_API_KEY`
- Make.com: free tier, 1,000 ops/mo
- RB2B: 7-day full-access trial → Free after 2026-05-20 (Free has no webhook, only Slack integration)

---

## Phase 1 — Cold email drafts on signals (next build)

### Scope

When a new `outreach_signals` row lands with `person_email`, Claude
drafts a personalized cold email and stores it as a draft. User reads
+ approves in Signaler tab, then sends. No auto-send for now.

### Schema

New table `outreach_messages` — unified touchpoint log across all
channels (designed to support LinkedIn / SMS / SendSpark video later).

```sql
create table outreach_messages (
  id                    uuid primary key,
  workspace_id          uuid references workspaces,
  -- Identity (at least one required)
  prospect_email        text,
  prospect_linkedin_url text,
  -- Lineage (source of touch)
  signal_id             uuid references outreach_signals,
  pipeline_lead_id      text references outreach_pipeline,
  -- Message
  channel               text,   -- 'email' | 'linkedin_invite' | 'linkedin_message'
                                -- 'sendspark_video' | 'sms' | 'call_voicemail'
  direction             text,   -- 'out' | 'in'
  subject               text,
  body                  text,
  -- Strategy classification (Claude self-tags)
  strategy              jsonb,  -- see taxonomy below
  -- Tracking
  status                text,   -- 'draft' | 'draft_held' | 'sent' | 'delivered'
                                -- 'opened' | 'replied' | 'bounced' | 'unsubscribed'
  sent_at               timestamptz,
  delivered_at          timestamptz,
  opened_at             timestamptz,
  replied_at            timestamptz,
  bounced_at            timestamptz,
  external_id           text,   -- Resend/Gmail msg id, SendPilot invite id, etc
  created_at            timestamptz default now(),
  -- RLS: workspace-scoped, same as outreach_signals
);
```

### Strategy taxonomy (jsonb shape)

```ts
type Strategy = {
  hook: "pattern_interrupt" | "specific_observation" | "contrarian"
      | "social_proof" | "mutual_connection" | "trigger_event";
  angle: "pain" | "roi" | "fomo" | "curiosity" | "compliment";
  cta: "book_call" | "reply_question" | "soft_yes" | "video_watch";
  length: "short" | "medium" | "long";  // <60 / 60-120 / 120+ words
  tone: "formal" | "casual" | "playful";
  personalization_anchors: string[];  // ["visited /pricing", "Series A Apr 2026", ...]
  predicted_response_rate: number;    // Claude's own guess 0-1
};
```

Querying this later answers "what's the reply rate for
`hook=specific_observation + cta=reply_question`?" — that's the gold.

### Edge function: `signal-draft-email`

Triggered by Postgres trigger on `outreach_signals` INSERT when
`person_email` is present.

Steps:
1. Look up existing `outreach_pipeline` row for this email. If found
   AND a SendSpark video was sent in last 7 days → status='draft_held',
   flag "ALREADY IN PIPELINE — video sent {n} days ago". User decides
   whether to add the email touch.
2. Call Claude (Sonnet via outreach-ai pattern) with:
   - Signal context (pages visited, geo, company, role, ICP score)
   - Workspace voice samples
   - Last 10 strategies tried for this ICP segment (so model varies)
3. Claude returns `{ subject, body, strategy }` — the strategy is the
   taxonomy object Claude self-classifies.
4. Insert into `outreach_messages` with `status='draft'`,
   `channel='email'`.

### Email sending: Gmail API (chosen over Resend)

Why Gmail API over Resend for v1:
- Free vs $20/mo
- Best deliverability initially (Gmail trusts itself; Resend domain needs 3-6 weeks warmup)
- Native reply threading in user's existing inbox
- Workspace allows it (~ 2,000/day limit is plenty)

Risks accepted at this volume:
- Reputation contagion (cold complaints could affect customer comms)
- Single inbox, no rotation
- Workspace ToS technically discourages bulk cold — at 30/week we're safe

Migration path: schema is provider-agnostic, swap to Resend or
Smartlead when volume justifies (~50+/day).

### UI in Signaler tab

For each signal with a draft:
- Show subject + body inline (editable textarea)
- Show strategy badges (hook, angle, cta) so user sees Claude's choice
- "Send" button → POSTs to a `send-message` edge function that uses
  Gmail API → updates `outreach_messages.status='sent'` + stores
  `external_id`
- "Skip" → status='skipped'

### Operational requirements before build

1. Enable Gmail API in Google Workspace admin console
2. OAuth setup — store refresh token in Supabase secret `GMAIL_REFRESH_TOKEN`
3. Sending alias decision: send from `louis@carterco.dk` (main) or
   `outreach@hi.carterco.dk` (subdomain to isolate reputation)
4. Unsubscribe link infra — required by EU. Either:
   - Static text: "Svar 'UNSUBSCRIBE' for at stoppe disse mails"
   - Dynamic link: `/unsubscribe?token=...` route + table
5. Cron job: poll Gmail for replies → match by thread → update
   `outreach_messages.replied_at`

---

## Phase 2 — LinkedIn message variation

### Why it matters

Currently SendPilot drives all LinkedIn outreach with static campaign
templates. Same connection note + first DM for every prospect = leaving
data + response rate on the table. AI-generated per-prospect variation
gets us:
1. Higher reply rate (estimated +30-50% from internet anecdote, will
   measure for real)
2. Strategy classifications on LinkedIn touches too — same taxonomy as
   email, so we can compare cross-channel

### What it'll involve

- Generate connection note (140 char limit) + first DM per prospect
- Pass into SendPilot's API at invite-creation time (need to verify
  what their API allows — campaign-level vs per-invite override)
- Log each as `outreach_messages` row with
  `channel='linkedin_invite'` / `'linkedin_message'`
- Reuse strategy taxonomy from email so cross-channel data joins

Likely 0.5-1 day of work depending on SendPilot API capabilities.

---

## Phase 3 — Cross-channel timeline + automation (later)

After Phase 1 + 2 are running and we have data:

1. **Reply attribution**: Gmail push notification → match inbound to
   outbound signal email → mark `replied_at` + classify intent (reuse
   outreach-ai classify_reply).
2. **Strategy effectiveness dashboard**: reply rate by hook/angle/cta
   across channels. Drives the "vary strategies" loop.
3. **Auto-follow-up sequences**: day 3, 7, 14 follow-ups, AI-generated
   variants. Halts on reply.
4. **Auto-send flag**: per-workspace flag, when on, drafts get sent
   automatically. Only enable after 50+ manual approvals show <5%
   "edit-before-send" rate.
5. **Twilio call flow**: "dial-me-first-then-connect" pattern. Click
   Ring in UI → Twilio rings user's phone → connects to prospect on
   answer. Voicemail drop optional. Logs to `outreach_messages`.
6. **Cross-channel dedup**: when scout finds a person already in
   SendPilot pipeline, show full timeline ("3 LinkedIn touches + 1
   SendSpark video, last activity 4d ago") and prevent accidental
   double-touch.

---

## Open decisions

- [ ] **Sending domain**: main (`louis@carterco.dk`) or subdomain (`hi.carterco.dk`)?
- [ ] **Cross-channel dedup default** when person is already in pipeline:
      (a) hold draft for manual decision (recommended), (b) skip silently,
      (c) draft anyway + warn
- [ ] **Strategy taxonomy refinements** — accept above or shape differently
      before first email?
- [ ] **Drop cold SMS entirely** (GDPR-risky for cold), or keep as warm
      follow-up channel only?

---

## Operational TODOs / things to watch

- [ ] **RB2B trial ends 2026-05-20** → Free tier removes webhook
      access. Slack relay still works since RB2B → Slack is one of
      Free's two remaining integrations. Decide $149/mo Pro vs Free.
- [ ] **Make.com free tier caps day 17** at 1,000 ops. Decide $9/mo Pro
      vs drop polling to hourly.
- [ ] **Prospeo free tier** = 75 credits/mo = ~7 phone hits. Decide
      $39/mo Starter when we exceed.
- [ ] **First real RB2B signal hasn't landed yet** — verify Slack
      message format matches the regex in `slack-mailhook`.
- [ ] **Cold email unsubscribe infra** needed before first send.
- [ ] **Gmail API OAuth** setup before Phase 1 send.

---

## Reference

### Edge function endpoints

```
POST https://znpaevzwlcfuzqxsbyie.supabase.co/functions/v1/rb2b-webhook?token=$RB2B_WEBHOOK_TOKEN
POST https://znpaevzwlcfuzqxsbyie.supabase.co/functions/v1/slack-mailhook
POST https://znpaevzwlcfuzqxsbyie.supabase.co/functions/v1/signal-scout-phones  (JWT required)
```

### Supabase secrets

| Secret | Purpose |
| --- | --- |
| `PROSPEO_API_KEY` | Layer 2 phone enrichment |
| `RB2B_WEBHOOK_TOKEN` | Optional, only used if direct RB2B webhook is enabled (currently not — Slack relay active) |
| `SLACK_MAILHOOK_TOKEN` | Optional auth on slack-mailhook endpoint (not currently set) |
| `ANTHROPIC_API_KEY` | Claude for AI triage / draft generation |
| (future) `GMAIL_REFRESH_TOKEN` | OAuth refresh for Gmail API send |
| (future) `RESEND_API_KEY` | Fallback transactional provider |

### Useful queries

```sql
-- Today's unhandled signals
select id, person_name, company_name, phone_direct
from outreach_signals
where handled = false
order by identified_at desc;

-- Hit rate by phone source
select phone_source, count(*) from outreach_signals
where phone_scouted_at is not null
group by phone_source;

-- (Phase 1) Reply rate by strategy hook
select strategy->>'hook' as hook,
       count(*) filter (where replied_at is not null)::float / count(*) as reply_rate,
       count(*) as sample
from outreach_messages
where channel = 'email' and sent_at is not null
group by 1
order by reply_rate desc;
```
