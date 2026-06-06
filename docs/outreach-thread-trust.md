# Outreach — trustworthy reply data (thread completeness)

**Status:** design / not yet built — 2026-06-06
**Owner:** Louis
**Origin:** the "Michel replied" scare turned out to be a misattribution — the warm
reply was Dennis Hansen's. Chasing it surfaced the real defect: **the threads we
store are incomplete, so contacts can't be read at a glance and two leads get crossed.**

## The defect

When you open a contact, you see only part of the conversation. Concretely, Dennis
Hansen's thread:

| Source | Messages | Your side (outbound) | Their side (inbound) |
|--------|---------:|---------------------:|---------------------:|
| SendPilot (truth) | 9 | 5 | 4 |
| Our DB            | 6 | **2** | 4 |

Three of **your own** manual replies (sent from SendPilot's UI on 06-04/06-05) never
reached the database:
- "Giver mening 👍 Og fair nok, med 5-10 leads om ugen…"
- "Jeg tænker bare på, om I har bygget noget ovenpå til at…"
- "Haha, fair nok 😄 Ja, jeg skrev noget for at komme igen…"

Inbound is complete; outbound is not. That asymmetry is the whole problem.

## Root cause

Two capture paths, each with a hole:

1. **Webhook (`sendpilot-webhook`)** fires on *inbound* messages only. That's why all
   4 of Dennis's replies are present. It never sees your manual outbound.
2. **Backfill sync (`sync-sendpilot-messages`, cron every 15 min, active)** is the
   *only* path that captures manual outbound. It does not reliably do so:
   - It matches a SendPilot conversation to our lead by **participant id / vanity
     LinkedIn URL / display name**. SendPilot returns participants as encoded
     LinkedIn **URNs** (`ACoAA…`) and display names — so the URL match and id match
     never hit; only the name match can, and only when our stored name is exactly
     SendPilot's (often it isn't: middle names, diacritics).
   - Even where the name matches (Dennis: "Dennis Schjødt Hansen" on both sides),
     the thread is still only partially captured — of 6 reply rows only **1** carries
     the sync's `external_id` fingerprint. So the sync reaches threads partially
     (batch `limit` per run across a large qualifying set, and/or match flakiness),
     not completely.

Net: outbound depends entirely on a sync whose lead↔conversation linkage is fragile,
so manual replies are dropped silently and threads render half-complete.

## What is NOT wrong (corrected during investigation)

- Direction labels are **correct** — the "nørder" message is genuinely your outbound
  (`sent` in SendPilot). The earlier "mislabel" call was wrong.
- No duplicate rows. The earlier "duplicate" call was wrong.
- The 12 "Fejlet" leads are **genuine** failures (real 500, no SendPilot conversation,
  no reply). Nobody warm is hiding there. Michel was never contacted.

## Approaches

### A — Minimal: harden the matcher (S, low risk)
Match conversations by LinkedIn **URN** too; on first match, store the URN on the
lead; loosen name normalization (diacritics, middle-name tolerance). Raises hit rate.
- Pros: small diff, no schema change, improves coverage immediately.
- Cons: still fuzzy; "partial reach per run" not addressed; no guarantee of completeness.

### B — Ideal: stable conversation-id linkage (M, med risk) — RECOMMENDED
Capture SendPilot's `conversationId` (and participant URN) onto the lead at send time;
one-time backfill of existing leads by URN. Sync then matches by stored
`conversationId` → deterministic, complete thread capture. Drop the `limit` batching
in favor of "process leads whose thread changed since last sync" (use
`lastActivityAt`).
- Pros: every thread becomes complete and correct; kills the misattribution class of
  bug at the source; makes the UI honest.
- Cons: schema column + send-path change + a backfill pass; needs a CLI deploy of the
  edge function.

### C — Confidence layer on top: per-thread reconciliation flag (S, additive)
Compare SendPilot message count vs DB count per active thread; if they differ, show a
"thread out of sync" flag on the contact so a half-thread is never trusted silently.
- Pros: turns silent data gaps into visible ones; cheap safety net.
- Cons: needs A or B underneath to actually close the gaps, not just flag them.

## Recommendation

**B, then add C's flag.** B is the real fix for "trustworthy reply data" — deterministic
linkage so every thread is whole. C is the small insurance that you never again reason
off a partial record without knowing it. A alone is a patch that leaves the door open.

## Rollout sketch (for the build, not this doc)

1. Add `sendpilot_conversation_id` (+ optional `participant_urn`) to `outreach_pipeline`.
2. Send path: persist `conversationId`/URN on first DM send.
3. Backfill existing active leads by URN (one-time script, read-only against SendPilot).
4. Rewrite sync match to key on `conversation_id`; switch selection to changed-since.
5. Add reconciliation count check → `thread_out_of_sync` flag surfaced in the UI.
6. Deploy edge function via Supabase CLI (MCP bundling of the 440-line + _shared tree
   is too fragile to do blind).

## Risks

- Backfill hits the SendPilot API per lead — rate-limit / page it.
- A wrong `conversationId` would attach messages to the wrong lead — validate URN match
  before writing, and let C's reconciliation catch drift.
