# SendPilot API — endpoints we actually use

Base: `https://api.sendpilot.ai`
Auth: header `X-API-Key: $SENDPILOT_API_KEY` (live key in `.env.local`)
Content: `Content-Type: application/json` on every POST.

> **Read this before sending a DM by hand.** We keep re-deriving this and guessing
> wrong routes. The send endpoint is `/v1/inbox/send` — **not** `/v1/inbox/messages`
> (404) and **not** `/v1/inbox/connect` (that's invite-only). See "Gotchas" below.

## Send a DM (reply or first message) — the one you want

`POST /v1/inbox/send`

```json
{
  "senderId": "<sendpilot_sender_id>",
  "recipientLinkedinUrl": "https://www.linkedin.com/in/<vanity>/",
  "message": "<text>"
}
```

- Routes by **recipient LinkedIn URL**, not conversation id. No `conversationId` needed.
- Works for both the first DM and replies into an existing thread — same endpoint.
- Success = HTTP **200 or 201**. Response body is captured to `outreach_pipeline.sendpilot_response`.
- `senderId` is the **account** that owns the conversation. For a known lead it's
  `outreach_pipeline.sendpilot_sender_id`. Use the canonical sender for the workspace —
  never trust a stale value blindly (see `invite-alt-contact` canonical lookup).
- Used by: `outreach-approve` (manual reply + followup), `outreach-engagement-tick` (auto_send).

### After a manual send, keep the DB consistent (what `outreach-approve` does)

1. Insert the outbound into `outreach_replies`:
   `{ sendpilot_lead_id, linkedin_url, message, workspace_id, direction:'outbound', external_id:null, received_at:now }`
   (`external_id` stays null; `sync-sendpilot-messages` patches it within ~15 min.)
2. Mark the inbound you're answering `handled=true, handled_at, handled_by`.
3. For a first/followup send, set `outreach_pipeline.status='sent'`, `sent_at=now`, `rendered_message=message`.

### Copy-paste reply (one-off, by hand)

```bash
KEY=$(grep -m1 '^SENDPILOT_API_KEY=' .env.local | cut -d= -f2-)
python3 - "$KEY" <<'PY'
import sys, json, urllib.request
key = sys.argv[1]
body = {
  "senderId": "<sendpilot_sender_id>",
  "recipientLinkedinUrl": "https://www.linkedin.com/in/<vanity>/",
  "message": open('/tmp/reply.txt').read().rstrip('\n'),
}
req = urllib.request.Request("https://api.sendpilot.ai/v1/inbox/send",
    data=json.dumps(body).encode(),
    headers={"X-API-Key": key, "Content-Type": "application/json"}, method="POST")
try:
    r = urllib.request.urlopen(req); print("HTTP", r.status); print(r.read().decode()[:800])
except urllib.error.HTTPError as e:
    print("HTTP", e.code); print(e.read().decode()[:800])
PY
```

## Invite a new connection (NOT for replying)

`POST /v1/inbox/connect`

```json
{ "senderId": "<sender>", "recipientLinkedinUrl": "<url>", "message": "<optional invite note>" }
```

- Fresh invite + optional note. One-off path (no campaign). Used by `invite-alt-contact`.
- Do **not** use this to reply to an already-connected lead — wrong semantics.

## Read inbox

- List conversations: `GET /v1/inbox/conversations?accountId=<senderId>&limit=50`
  → `{ conversations: [{ id, accountId, participants:[{name, profileUrl}], lastMessage:{content,sentAt,direction}, ... }] }`
  Match a person by `participants[].name`; `lastMessage.direction` is `received` (they sent) or `sent` (we sent).
- Messages in a thread: `GET /v1/inbox/conversations/<convId>/messages?accountId=<senderId>&limit=50`
  (GET only — POST here 404s.) Used by `sync-sendpilot-messages`, `sendpilot-probe`.
- Live "did they reply?" check: `checkLeadReplied()` in `_shared/sendpilot-client.ts`.

## Leads & searches

- Leads by campaign: `GET /v1/leads?campaignId=<id>` (`sendpilot-poll`).
- Lead-database search: `POST /v1/lead-database/searches` (`poll-alt-searches`, `score-accepted-lead`, `referral-search`).

## Gotchas (why this keeps biting us)

- **`/v1/inbox/messages` does not exist** → 404 `Cannot POST /v1/inbox/messages`.
  `docs/env-tokens.md` used to say this. The real send route is `/v1/inbox/send`.
- **`/v1/inbox/conversations/{id}/messages` is GET-only** → POST 404s.
- **`/v1/inbox/connect` is invite-only** — it can send a note, but to a connected lead
  it's the wrong operation. Replies go through `/v1/inbox/send`.
- Header is `X-API-Key` (capital X-A-K), not `Authorization: Bearer`.
- `senderId` (account) ≠ `sendpilot_lead_id` (the prospect). Send needs the **sender**
  account id + the **recipient** LinkedIn URL.
- Send routes by recipient URL, so the URL must be the lead's real vanity/profile URL
  (`outreach_pipeline.linkedin_url`), not the `ACoAAA…` member-URN form.

## Source of truth (grep these if this doc drifts)

- `supabase/functions/outreach-approve/index.ts` — manual reply + followup send
- `supabase/functions/outreach-engagement-tick/index.ts` — auto_send
- `supabase/functions/invite-alt-contact/index.ts` — connect/invite
- `supabase/functions/sync-sendpilot-messages/index.ts` — list conversations + messages
- `supabase/functions/_shared/sendpilot-client.ts` — reply check + search
