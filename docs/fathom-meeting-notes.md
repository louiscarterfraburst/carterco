# Fathom → meeting notes on the lead

Every recorded sales call ends up as a Danish meeting note on the lead's
timeline in `/leads`. Fathom records/transcribes the call (works on Google
Meet, Zoom, and Teams — chosen over native Meet transcription because the
Workspace plan is Business Starter, which has no transcripts).

## How it works

1. Fathom auto-joins calls from Louis' calendar and transcribes them.
2. A few minutes after the call, Fathom fires its "new meeting content
   ready" webhook at the `fathom-webhook` edge function — payload includes
   the transcript, calendar invitees (with emails), and action items.
   Event-driven; no cron, no polling.
3. The function matches the meeting to a lead: external invitee email ↔
   `leads.email` first (the same key the booking webhooks write), then the
   invitee's corporate domain (free-mail excluded, and only when exactly one
   lead has that domain — a colleague joining instead of the booked contact
   still lands on the right timeline), finally `leads.meeting_at` ±30 min.
   Internal meetings and unmatched recordings are dropped.
4. Claude summarizes the transcript (Resultat / Situation / Indvendinger /
   Næste skridt) and the note is inserted into `lead_conversation_events`
   with `channel='note'`, `source='fathom'`, `source_id=recording_id`. The
   partial unique index on `(source, source_id)` makes Fathom's webhook
   retries a no-op. Full transcript, action items, and the Fathom share link
   live in `metadata`.

## One-time setup

### 1. Fathom account

Sign up at [fathom.video](https://fathom.video) with louis@carterco.dk
(free tier: unlimited recording + transcription). Grant calendar access so
it auto-joins meetings; in Fathom settings, set it to record meetings with
external attendees. First call: let the bot in and confirm recording works.

### 2. API key

fathom.video → Settings → **API Access** → generate a key →
add to `.env.local` as `FATHOM_API_KEY`.

### 3. Deploy the function

```bash
supabase functions deploy fathom-webhook --no-verify-jwt
```

`config.toml` already carries `[functions.fathom-webhook] verify_jwt = false`.

### 4. Register the webhook

```bash
node scripts/fathom/register-webhook.mjs
```

Creates the webhook (transcript + summary + action items, my_recordings)
pointed at the edge function and prints the `whsec_…` secret — shown only
once. Run the `supabase secrets set FATHOM_WEBHOOK_SECRET=…` command it
prints, and add the secret to `.env.local`. Until the secret is set, the
function accepts unsigned posts (same convention as cal-webhook).

### 5. Verify

Record a short test meeting (Fathom posts the webhook a few minutes after
it ends), then check the lead in `/leads`. Function logs show the outcome:
`ok` + `lead_id`, or `ignored: only_internal | no_lead_match | no_content`.

## Limits

- The Fathom notetaker is visible in the call and announces recording —
  that's the consent notice for DK/EU calls.
- A meeting with no matching lead (no booking, unknown email) produces no
  note — add one manually in `/leads` if it mattered.
- Telavox phone calls are out of scope; a later ingest could reuse the same
  summarize-and-insert path with `channel='phone'`.
