# Outreach Flow Map — read-only automation tree

An ActiveCampaign-style automation map inside `/outreach`: a branching decision
tree of the outbound flow with a live count of how many contacts sit at each
node right now, plus an A/B-test scoreboard for the first-DM arms. Read-only —
no editing the flow, no moving contacts.

## v2 update (current) — branching tree + A/B scoreboard

Feedback after v1: the column+arrow layout read as a linear pipeline, and the
Tresyv 3-arm A/B test was invisible. v2 reworks it:

- **Render:** React Flow (`@xyflow/react`) — a real branching tree with drawn
  edges, fit-to-view, pan/zoom. Custom `flowCard` node themed to the house
  style. Replaces the v1 custom-SVG columns.
- **A/B arms:** the first DM forks into the arms (`v1_long` / `v2_short` /
  `v3_video`, from `outreach_pipeline.first_dm_variant`). Each arm routes to its
  matched follow-up sequence via `outreach_sequences.match_first_dm_variant`.
  A scoreboard above the tree shows per-arm assigned / sent / replied /
  reply-rate (from the `vw_first_dm_ab` view), with the leading arm flagged.
- **Outcomes strip:** replies (by intent) and terminal states are cross-cutting
  outcomes — a lead can reply or fail from any branch — so they render as a
  strip below the tree, not as tree nodes. Keeps the tree clean.

## Decisions (locked)

- **Scope:** visual flow/decision-tree map with live per-node counts, plus
  click-a-node to list the contacts in it. No flow editing.
- **Render:** React Flow (`@xyflow/react`), themed to the existing
  sand/cream/forest + Fraunces/Manrope house style. (v1 was custom SVG; the
  genuine-tree + A/B-branch requirement justified the dependency.)
- **Counts:** client-side JS bucketing. Pull a lean projection of
  `outreach_pipeline` rows (same pattern `page.tsx` already uses), classify
  each row into one node in TS. No new table, no migration, no RPC.
- **Branch:** built straight on `main` (operator's call) so it deploys live to
  the cockpit immediately. It's a separate surface from the marketing-site
  restructure on `site/three-machines`.
- **Graph shape:** authored once as a TS constant. The top-level status
  transitions live in edge-function code (`sendpilot-webhook`), not in data,
  so the node/edge structure is hand-defined. Only sequence step *labels* are
  read live from `outreach_sequences`.

## Data source

`outreach_pipeline` is one row per contact and already carries the full
position: `status`, `sequence_id`, `sequence_step`, `sequence_completed_at`,
engagement timestamps (`played_at`, `watched_end_at`, `cta_clicked_at`),
`last_reply_intent`, `seq_decision`. No schema work needed.

Sequence step labels (`nysgerrig`, `kalender`, `qualifier`, `graceful_exit`,
...) come from `outreach_sequences.steps` (jsonb) so they stay correct if the
sequence is re-authored. The page already fetches sequences via
`/api/outreach/client-config`.

## Node graph

Each contact is assigned to exactly ONE node — its current position — by an
ordered `classifyNode(row)` function (first match wins, most-advanced first).
Edges are static structure (the known transitions), drawn as SVG connectors,
not derived from data.

Columns, left to right:

1. **Entry** — `invited` (status='invited')
2. **Accept branch** — `pending_pre_render` (cold video / CarterCo) ·
   `pending_ai_draft` (OdaGroup text) · `pre_connected` (already connected)
3. **Render & approve** — `rendering` · `rendered` · `pending_approval`
4. **Sent** — `sent` (sent, not yet enrolled / baseline)
5. **Sequence** (engagement fork, labels live from `outreach_sequences`):
   - watched → `watched_followup_v1` step 0 (nysgerrig) → step 1 (kalender)
   - unwatched → `unwatched_followup_v1` step 0 (qualifier) → step 1 (graceful_exit)
6. **Reply** (intent fork) — interested · question · decline · ooo · referral
7. **Terminal** — `sequence_completed` · `rejected` · `rejected_by_icp` · `failed`

### classifyNode precedence (current position, most-advanced first)

1. Terminal status (`rejected`, `rejected_by_icp`, `failed`)
2. `sequence_completed_at` not null → `sequence_completed`
3. `last_reply_at` not null → reply node by `last_reply_intent`
4. `sequence_id` not null and not completed → sequence step node
5. `status` in (sent) → `sent`
6. `status` in render/approve set → that status node
7. `status` in accept-branch set → that status node
8. else → `invited`

This guarantees the counts sum to the workspace's live contact total, so the
map reads as "everyone is somewhere."

## UI

- New 10th tab in the `Tabs` bar (line ~1483 of `page.tsx`). Danish label:
  **"Flow"**.
- `FlowTab` component: renders the column layout. Each node is a card showing
  label + live count, sized/tinted by count (forest accent for active,
  clay for terminal-negative). SVG `<path>` connectors between columns,
  same approach as the existing `Sparkline`.
- Click a node → expands a lean contact list below the canvas (name, company,
  last event, time-in-node), reusing the row styling already in `AllTab`.
- **Message text is first-class.** Two layers:
  - **Node blueprint:** clicking a sequence-step node shows its copy from
    `outreach_sequences.steps[].branches[].action.template` with the
    `{firstName}` / `{company}` / `{videoLink}` tokens shown literally. The
    first-DM node has no fixed template (it's AI-generated per contact), so it
    renders a **"AI-personaliseret"** badge instead of a static string.
  - **Per-contact rendered text:** clicking a contact in the list shows the
    actual message for that person:
    - `outreach_pipeline.rendered_message` — the real text that shipped.
    - `outreach_pipeline.personalized_hook` — the AI-generated first-DM hook
      (the "AI placeholder custom message"), with `hook_context` (why this
      angle) and `hook_bucket` shown as provenance.
    - `outreach_replies.message` — inbound reply text (already loaded).
    - `outreach_emails.subject` / `body` for email steps (lazy-load on click,
      or fold into the projection if cheap).
- Counts recompute from the rows already loaded in `load()` — add the few
  missing columns to the existing pipeline projection, no new query.
- Workspace-scoped like every other tab.

## Build steps

1. Add `classifyNode(row)` + the `FLOW_NODES` / `FLOW_EDGES` constants
   (new file `src/app/outreach/flow.ts`).
2. Extend the `load()` pipeline projection with any missing columns
   (`last_reply_at`, `seq_decision`, `rendered_message`, `personalized_hook`,
   `hook_context`, `hook_bucket` — several already in `PipelineRow`).
3. Build `FlowTab` (canvas + connectors + node cards).
4. Wire the node click → contact list (filter the in-memory rows by node).
5. Add the message-text panel: node blueprint (template from
   `outreach_sequences`) + per-contact rendered text (`rendered_message` /
   `personalized_hook` + `hook_context` / reply `message` / email body).
6. Register the tab in `Tabs` and the tab switch.

## Explicitly out of scope for v1

- Editing/reordering the flow (drag-and-drop node editor).
- Moving a contact between nodes / firing operator actions from the map.
- Per-node conversion rates and time-in-stage analytics.
- A real `campaigns` table (campaign scoping stays implicit via
  `invite_source` / `lemlist_campaign_id`).

These are natural v2 once the read-only map proves useful.
