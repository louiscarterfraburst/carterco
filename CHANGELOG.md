# Changelog

All notable changes to carterco are documented here. Versions follow the
4-digit `MAJOR.MINOR.PATCH.MICRO` scheme; entries lead with a release summary,
itemized changes below.

## [0.2.0.0] - 2026-06-10

**Every contact now belongs to exactly one play, and the cockpit finally
shows you which.**

The play axis stopped being a column nobody enforced and became the system's
backbone. Every lead entering the pipeline gets stamped with its play at first
contact, the database rejects plays that aren't registered, and play behavior
(DM template, personalization hook, pause) lives in the `outreach_plays`
registry instead of hardcoded string checks scattered through six functions.
Adding a play is now a database row, not a deploy. The /outreach cockpit grew
a real Plays tab, and pausing a play actually stops its automation.

Approving a DM no longer fires the send. Approvals land in a drip queue
(6-10 min jitter, weekdays 08-18 Copenhagen, 25/sender/day cap) and a cron
drains one DM per sender per tick — a batch approval can never burst from a
personal LinkedIn account. The drainer claims each row atomically before the
send, re-runs the live reply check at send time, honors pause immediately
(no cache), and a SendPilot outage delays sends instead of destroying them.

### The numbers that matter

From this branch's review and live verification on the production project
(znpaevzwlcfuzqxsbyie), 2026-06-10:

| Metric | Before | After | Δ |
|---|---|---|---|
| Intake paths stamping play explicitly | 1 of ~16 | all | complete |
| Hardcoded play-name branches in functions | 6 | 0 | -6 |
| Plays addable without a deploy | no | yes | registry-driven |
| Automated tests in the repo | 0 | 94 | +94, runs in CI |
| Mistagged pipeline rows at cutover | n/a | 0 | verified live |
| Max burst from one approval batch | unbounded | 1 DM / sender / 5 min | drip queue |
| Double-send window (crash or overlapping cron) | open | closed | atomic claim |

The 0 mistagged rows means the cutover was clean: the approval-time repair had
kept prod consistent, and from now on tags are right at insert time instead.

### What this means for the operator

You can answer "which contacts are in which flow" without reading SQL: the
Plays tab lists every play with live aktive/sendt/svar counts, click-through
to a play-filtered Flow tree, and contact rosters with each person's current
step. Pausing a play in the registry now actually halts its renders, hooks
and follow-up sends. Next: per-play follow-up sequences (see TODOS.md).

### Itemized changes

#### Added
- Plays tab on /outreach: one row per registered play with status pill, live
  counts and reply rate, expandable detail (funnel, intake runs, contact
  roster), and deep-links into a play-filtered Flow tree and contact list.
- Play filter pills on the Flow and Kontakter tabs — node counts and the
  contact list are two views of the same play-scoped query.
- Flow tree nodes show how long the oldest contact has been waiting (clay
  highlight after 5 days); contact rows show their current sequence step with
  the tree's exact wording.
- Play behavior config in the `outreach_plays` registry: `dm_template`,
  `use_personalized_hook`, `is_default`, `auto_render`, plus pause that
  genuinely stops hooks, auto-renders and follow-up sequence work.
- Database guardrails: missing play resolves to the registry default, unknown
  plays are rejected at insert, the hiring-signal DM template lives in the
  registry (editable without deploy).
- Approved-DM drip queue: approve stamps `approved_queued` + a jittered
  Copenhagen-business-hours slot; the `outreach-send-queue` cron drains one
  DM per sender per tick with an atomic claim (`sending` status) so crashes
  and overlapping ticks can never double-send. Fortryd pulls a queued DM back
  before its slot — and refuses, loudly, if the drainer already claimed it.
- Send-time safety net: the live reply check re-runs when the DM actually
  goes out; an unverifiable check (SendPilot down) leaves the row queued for
  the next tick instead of rejecting it. Pause is checked uncached at send
  time, so pausing a play stops its queue immediately.
- SendSpark background guard: renders that fell back to the workspace-default
  backdrop (instead of the prospect's own site) park for manual review and
  never enter the approval queue; approving a parked row is the explicit
  operator override.
- Auto-render claims the row before calling SendSpark, so a webhook/poll race
  or redelivered accept can't double-charge a render.
- Lead quality gate: company fields carrying multi-role prose ("Volunteer
  Work for… Freelance for…") or >60 chars route to manual review instead of
  the sendable batch.
- Hiring-cron dialogue guard fails CLOSED: read errors or implausibly-empty
  sources abort the run before staging, and its reads paginate past
  PostgREST's 1000-row cap so growth can't silently blind it.
- Test infrastructure: vitest + CI workflow, 94 tests covering flow
  classification, play resolution/stats, registry lookup policy, queue slot
  math (Copenhagen window/cap), background classification, stage helpers and
  the label-sync invariant. TESTING.md documents conventions.
- Form allowlist on the Meta lead webhook with fail-closed semantics for
  allowlisted pages (Soho: Mødelokaler in, Kontor out).

#### Changed
- Every pipeline write in sendpilot-webhook (8), sendpilot-poll (6),
  lemlist-webhook and invite-alt-contact stamps the lead's play explicitly;
  staged plays carry through lead_inbox promotion without ever downgrading a
  pre-staged tag.
- sendspark-webhook picks the first-DM template from the play registry; the
  hook decision fails CLOSED on registry errors (a banned hook can never be
  re-enabled by a database blip).
- Registry lookups are cached (60s, with brief negative caching) and validate
  id shape against PostgREST filter injection.
- Hiring-signal DM copy updated to the "Jeg bygger systemerne rundt om
  salgsteams" opener.

#### Fixed
- Pausing the default play no longer has the latent ability to break all lead
  intake; the default-play SQL helper is locked down from anonymous API access.
- No-op play updates skip trigger validation, so legacy rows can't poison
  future upserts — including upsert INSERTs that conflict-update a legacy row
  (the trigger's escape matches on the row's conflict keys, so a net-new row
  can't borrow another row's unregistered play).
- A late SendSpark render can no longer rewrite an already-approved DM or
  yank it out of the send queue; the render-ready pipeline write checks its
  error and returns 500 so failures retry instead of stranding leads at
  'rendering'.
- Pausing a play now also stops alt-contact connection requests under it.
- LinkedIn URL normalization strips query params before trailing slashes, so
  scraper URL variants collide to one key in every view.
- `pnpm install` exits 0 again (allowBuilds placeholder in
  pnpm-workspace.yaml was never configured).

#### For contributors
- `outreach_record_invite` exists in two synced copies (migration §5 +
  workspaces.sql) — cross-referenced comments mark the pairing.
- `20260610_play_hardening.sql` documents the rollback order, fresh-DB
  prerequisites and seed/operator-data divergence rules.
