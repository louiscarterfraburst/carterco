# Curated live client view (Tresyv / OdaGroup)

**Status:** design / not yet built — 2026-06-06 (office-hours)
**Origin:** Louis: "losing touch with clients' performance, they don't have proper
overview." Direction chosen: client-facing overview. Shape chosen: a **curated
live view** (live data, operator-curated framing) over a raw mirror.

## The decision

Build a live, read-only, Danish, per-client view of the client's own outbound
pipeline — scoped to their workspace — that shows the funnel and engaged contacts
but is **curated to tell the story, not expose the machinery**. The goal is a
client who feels on top of their results, not one who micromanages reply rates.

This is the risk Louis accepted knowingly: a live view can invite second-guessing.
The curation is the mitigation. If the framing is raw, this erodes the
"trust the expert" relationship that a done-for-you service runs on.

## Who it's for

The client contact (Rasmus at Tresyv; OdaGroup's contact). Read-only. They
currently get curated Danish update emails from Louis (manual). This replaces the
"is anything happening?" anxiety with a link they can check, without making Louis
the bottleneck.

## What it shows (curated)

1. **Funnel headline** — kontaktet → svar → i samtale → møde. Counts + this-week
   delta. The 10-second "is it working" answer.
2. **Wins feed** — warm replies and booked meetings, surfaced first. The proof.
3. **Næste skridt** — a short "what's happening this week" line (projected upcoming
   sends + follow-ups). Signals proactivity, the thing that reassures.
4. **Engaged contacts** — a list scoped to people who replied / are in conversation
   / have a positive outcome, each with a clean timeline (their thread, what's next).

## What it HIDES (the curation)

- Failed sends, the "Fejlet" bucket, HTTP errors, retries.
- ICP-rejected leads, scoring internals, A/B arm mechanics, bucket/hook traces.
- Raw cold-lead volume framed as "nothing happening yet."
- Anything that reads as plumbing rather than progress.

The client sees outcomes and momentum. Louis still owns the narrative; the failures
and machinery stay in `/outreach` (operator-only).

## Architecture (reuse, don't rebuild)

Grounded in what already exists in the repo:
- **Per-client route pattern** — like `/tresyv`, `/outreach-bikenor`. New route, e.g.
  `/portal/[slug]` or per-client (`/tresyv/oversigt`).
- **Client login** — reuse the Bikenor-style login (`/outreach-bikenor/login`)
  rather than a new auth system. Maps an authenticated client to one workspace_id,
  read-only.
- **Funnel + timeline components** — reuse `ContactTimeline` and the funnel/status
  pieces from `/outreach/page.tsx` and `contact-timeline.ts` (`buildThread`,
  `projectUpcoming`). The curated view is a filtered, button-less, noise-stripped
  composition of these.
- **Data** — `outreach_pipeline` + `outreach_replies`, filtered server-side to one
  workspace_id and to engaged/positive rows. No raw client DB access.

## Auth / access model

- Per-client credential (Bikenor-style login page) → server-side session that
  resolves to a single `workspace_id`.
- All reads happen server-side with that workspace_id as a hard filter (or RLS
  scoped to the client's workspace). The client never queries across workspaces.
- Read-only. No approve/decline/send actions (that's the operator's cockpit, and
  Bikenor's separate approval surface).

## Trust-protective design rules

- Lead with wins and "next," not raw activity counts.
- Never show a number the client can weaponize out of context (e.g. raw reply % on
  a thin first week). Show absolute wins + trajectory instead.
- No failure surface. A genuinely stalled client is a conversation Louis initiates,
  not a red number the client discovers.
- Danish, plain, calm. Matches Louis's existing client-update tone.

## Data sources per section

| Section | Source |
|---------|--------|
| Funnel counts | `outreach_pipeline` (invited_at / accepted_at / sent_at / last_reply_at / outcome) filtered to workspace |
| Wins feed | replies where intent is positive + `outcome` = meeting/qualified |
| Næste skridt | `projectUpcoming()` over engaged leads |
| Engaged contacts | leads with a reply or positive outcome; `buildThread()` per lead |

## Rollout

1. **Pilot with one client (Tresyv).** Validate the curation matches what calms
   Rasmus before generalizing.
2. Generalize to OdaGroup (same components, different workspace_id).
3. Fast-follow (deferred): a weekly auto-generated Danish snapshot that replaces the
   manual update emails (was Approach C). Build only if the live view proves wanted.

## Open questions / risks

- **Does the client actually want self-serve, or prefer Louis's narrated emails?**
  Validate before building (see assignment). If they prefer the email, the real
  build is the weekly snapshot, not the live view.
- Curation cutoffs ("positive" intent set, "engaged" definition) need to match how
  Louis talks about progress — confirm the labels with him at build time.
- Login/session reuse: confirm the Bikenor login pattern maps cleanly to main-project
  workspaces (Bikenor is on its own Supabase project; Tresyv/OdaGroup are main).

## The assignment

Before building: in your next update to **Rasmus**, slip in one question —
"would a live link where you can see contacted / replied / in-conversation / meetings
be useful, or do you prefer I keep sending these summaries?" His answer decides
whether this is a live view or a weekly snapshot. Don't build the dashboard until a
real client says they'd open it.
