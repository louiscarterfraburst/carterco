# lemlist

`LEMLIST_API` was added to `.env.local` 2026-06-02. This doc captures what
exists in the lemlist account, why we duplicated parts of `/outreach` into it,
and where to extend.

## Why this exists

`/outreach` is the CarterCo + client sales engine (SendPilot LinkedIn,
SendSpark video, AI-drafted DMs, ICP scoring, alt-contact discovery, signals,
sequences). Lemlist was added as a **parallel** channel for **CarterCo only**
— not a migration. The existing pipeline keeps running unchanged.

Lemlist gives us things `/outreach` doesn't have:
- Native multi-step LinkedIn invite → message sequences with conditional
  branching (lemlist's `linkedinInviteAccepted` conditional)
- Email warmup (lemwarm) — eventually replaces the manual Gmail mailto flow
- Built-in unsubscribe handling + analytics dashboards
- A/B testing inside a campaign

What stayed in `/outreach` and is **not** replicated in lemlist:
- SendSpark video render-per-lead (lemlist has no video generation hook)
- Per-workspace Claude-drafted first DM (lemlist supports campaign-level AI
  variables but not per-lead Claude calls at send time — see "Upgrade path")
- ICP scoring + Læring tuning loop
- Alt-contact discovery (Vælg-rigtig-person flow)
- Attio bi-directional deal sync
- Signal-driven inbound (RB2B → outreach_signals)

## Current account state

| Thing | Value |
|-------|-------|
| Team ID | `tea_GGnnmAFrqXLnyrjKF` ("Louis Carter's Team") |
| Plan | 200 gifted credits (free trial) |
| Senders | none connected yet |
| Campaigns | `CarterCo — ad_funnel_leak (DK)` (`cam_M8mQPzp3iYh5NHbsH`) — see below |
| Webhooks | none |

There's also a `_lemlist_api_probe_DELETE_ME` campaign left over from initial
endpoint testing. Lemlist's API doesn't expose `DELETE /campaigns/{id}` — clean
it up from the lemlist UI (Campaigns → menu → archive).

## The CarterCo campaign — what was duplicated

`cam_M8mQPzp3iYh5NHbsH` mirrors the **text-only** flavor of the existing
`unwatched_followup_v1` sequence from `outreach_sequences` (the watched/played
branch is dropped — lemlist can't observe SendSpark video events).

Sequence layout:
```
step 0  linkedinInvite          delay 0d   (cold connect, no note)
step 1  conditional             delay 0d   linkedinInviteAccepted, waitUntil
        └─ branch [Accepted invite]:
             step 0  linkedinSend  delay 0d  → first DM (ad_funnel_leak voice, DA)
             step 1  linkedinSend  delay 3d  → "qualifier" (mirrors /outreach +72h step)
             step 2  linkedinSend  delay 5d  → "graceful exit" (mirrors /outreach +120h step)
```

Templates use lemlist Liquid built-ins (`{{firstName}}`, `{{companyName}}`).
The exact copy lives in `scripts/lemlist/provision_carterco_campaign.mjs` and
follows `clients/carterco/agent-brief.md` — casual DK, 2–4 short sentences,
no marketing puffery, soft close.

## Provisioning script

`scripts/lemlist/provision_carterco_campaign.mjs` is idempotent:

```
# Create the campaign + sequence if missing; describe if present:
node scripts/lemlist/provision_carterco_campaign.mjs

# Describe-only (no writes):
node scripts/lemlist/provision_carterco_campaign.mjs --layout

# Wipe and rebuild the sequence (keep the campaign):
node scripts/lemlist/provision_carterco_campaign.mjs --reset
```

It reads `LEMLIST_API` from `.env.local`. Campaign name is the idempotency key
— don't rename it from the lemlist UI without updating `CAMPAIGN_NAME` in the
script.

## Before sending anything

The campaign is created but cannot send until you do these manually in the
lemlist UI (the API doesn't cover any of these — they're all OAuth / browser
flows):

1. **Connect Louis's LinkedIn** — install lemlist Chrome extension, log in.
2. **Connect Louis's email account** — Settings → Connect Email Account
   (Gmail OAuth or Microsoft 365). Required even for LinkedIn-only campaigns
   because lemlist wants a primary identity per sender.
3. **Start lemwarm** on the connected email if you plan to add email steps
   later. Takes ~2 weeks to ramp.
4. **Add the sender to the campaign**: open the campaign → Settings → Sending
   account → pick Louis's connected account.
5. **Decide auto-review**: currently `autoReview: false` — every new lead
   sits in "review" until you click launch. Flip to `true` in the UI once
   confident.

## Adding leads

```bash
curl -u ":$LEMLIST_API" \
  -X POST "https://api.lemlist.com/api/campaigns/cam_M8mQPzp3iYh5NHbsH/leads/" \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Anders",
    "lastName": "Sørensen",
    "email": "anders@example.dk",
    "companyName": "Valentin Regnskab",
    "linkedinUrl": "https://www.linkedin.com/in/anders-sorensen-example/"
  }'
```

Or build a feeder script (similar to `scripts/lead-enrichment/*`) that reads
from `outreach_leads` filtered to `workspace_id = $CARTERCO_WORKSPACE_ID` and
posts each to lemlist. Note: lemlist deduplicates by email per campaign, so
re-pushing the same lead is safe.

## Upgrade paths

**Per-lead AI-personalised first DM** — today's templates are static with
Liquid placeholders. To get the same per-lead AI personalisation as
`/outreach`:

1. Pre-compute the first-DM text per lead with `_shared/draft-first-message.ts`
   (CarterCo agent-brief), store it as a custom variable on the lead.
2. Push the lead with `firstDM` set in `customVariables`.
3. Edit step 0 of the accepted branch in
   `provision_carterco_campaign.mjs` to use `message: "{{firstDM}}"` and
   re-run with `--reset`.

**Reply sync back to Supabase** — lemlist webhooks (`POST /hooks`) can push
`linkedinReplied`, `emailsReplied`, `linkedinInviteAccepted`, etc. to a new
edge function. Suggested function name: `lemlist-webhook` (mirrors
`sendpilot-webhook`). Subscribe to `warmed` (covers all reply event types) and
optionally `attracted` (accept events).

**Email steps** — when lemwarm is ready, swap or extend the accepted branch
with `type: "email"` steps. Requires `subject` field. The
`/outreach` Gmail mailto flow can stay in parallel or get retired.

## API quick reference

Auth: HTTP Basic, empty username, key as password.

```bash
# Probe team identity (sanity check):
curl -u ":$LEMLIST_API" https://api.lemlist.com/api/team

# Remaining credits:
curl -u ":$LEMLIST_API" https://api.lemlist.com/api/team/credits

# List campaigns (must pass version=v2):
curl -u ":$LEMLIST_API" "https://api.lemlist.com/api/campaigns?version=v2"

# Get one campaign's sequence tree:
curl -u ":$LEMLIST_API" \
  "https://api.lemlist.com/api/campaigns/$CAMPAIGN_ID/sequences"

# Add a step:
curl -u ":$LEMLIST_API" -X POST \
  "https://api.lemlist.com/api/sequences/$SEQUENCE_ID/steps" \
  -H "Content-Type: application/json" \
  -d '{"type":"linkedinSend","delay":3,"message":"…"}'

# Add a webhook (all events):
curl -u ":$LEMLIST_API" -X POST \
  "https://api.lemlist.com/api/hooks" \
  -H "Content-Type: application/json" \
  -d '{"targetUrl":"https://znpaevzwlcfuzqxsbyie.supabase.co/functions/v1/lemlist-webhook","type":"warmed","secret":"<rotate-me>"}'
```

Full docs: `https://developer.lemlist.com/llms-full.txt` (markdown index of all
endpoints; cache it locally to avoid round-trips).
