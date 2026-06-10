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

### The numbers that matter

From this branch's review and live verification on the production project
(znpaevzwlcfuzqxsbyie), 2026-06-10:

| Metric | Before | After | Δ |
|---|---|---|---|
| Intake paths stamping play explicitly | 1 of ~16 | all | complete |
| Hardcoded play-name branches in functions | 6 | 0 | -6 |
| Plays addable without a deploy | no | yes | registry-driven |
| Automated tests in the repo | 0 | 76 | +76, runs in CI |
| Mistagged pipeline rows at cutover | n/a | 0 | verified live |

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
- Test infrastructure: vitest + CI workflow, 76 tests covering flow
  classification, play resolution/stats, registry lookup policy and the
  label-sync invariant. TESTING.md documents conventions.
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
  future upserts.
- `pnpm install` exits 0 again (allowBuilds placeholder in
  pnpm-workspace.yaml was never configured).

#### For contributors
- `outreach_record_invite` exists in two synced copies (migration §5 +
  workspaces.sql) — cross-referenced comments mark the pairing.
- `20260610_play_hardening.sql` documents the rollback order, fresh-DB
  prerequisites and seed/operator-data divergence rules.
