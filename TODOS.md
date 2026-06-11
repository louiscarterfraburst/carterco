# TODOS

## Website / Lead Flex CTA

### Align the outbound hook copy with the new site CTA
**Priority:** P2
The site now promises "jeg finder dine købere og viser dig dem live" (Lead Flex
CTA plan, ~/.gstack/.../ceo-plans/2026-06-10-leadflex-website-cta.md). The
outbound DM hook ("want me to find your buyers?", design doc 2026-06-08 open
question) should speak the same language so a prospect who sees both channels
meets one offer, not two. Draft in human-typed Danish (humanize-compliant), per
niche channel. Effort S. Depends on: CTA copy landing first.

### Iterate the flex section + promise after the first real flex
**Priority:** P2
The flex-mockup section ships with clearly-fictional example data and a
mechanism-led promise because no live flex has run yet. After the first real
flex (customoffice): replace the illustrative panel with a real-shaped
(anonymized) artifact, recalibrate whether "100" can be promised harder, and
fold call learnings into the scoping questions. Effort S-M. Trigger: first
completed live flex.

### Add rate limiting to quiz-submit only if junk appears
**Priority:** P3
Soft-capture ships honeypot-only by explicit owner choice (no over-engineering;
the booking path is cal.com's spam problem). If bot junk starts landing in
/leads or push notifications get noisy, add a simple per-IP limit then.
Effort S. Trigger: observed junk rows.

### Optional: one "scoping_completed" Plausible event
**Priority:** P3
Step-level funnel events were explicitly skipped (twice) by the owner. The
outside-voice review dissented: without a redirect-to-cal.com event, leaks
between modal and booking are invisible. If the CTA swap underperforms on raw
bookings and the cause is unclear, this one event is the cheapest diagnostic.
Effort XS. Logged as cross-model tension in the CEO plan.

## Outreach / plays

### Wire play-aware follow-up sequences
**Priority:** P1
`outreach_plays.trigger_sequence_id` is recorded but nothing consumes it —
`outreach-engagement-tick` enrols purely by trigger signal / A/B arm, so a new
play's leads fall into the global video-loop follow-up sequences ("did you see
the video about your lead-flow" copy) regardless of their play-specific opener.
Either make the engine resolve the lead's play and prefer its
`trigger_sequence_id` (or add a play-match column on `outreach_sequences`), or
drop the column and the "no code changes for new plays" claim for sequencing.
Found by red-team review on `feat/play-hardening`.

### Close the pause-gating gaps
**Priority:** P1
Play-level pause now stops the hook, lemlist auto-render and engagement-tick
sequence work, but: `recover-stuck-renders` (10-min cron) still re-POSTs
paused-play rows stuck in rendering; `sendspark-webhook` still processes a
paused play's render_ready into `pending_approval`; `enrich-buckets` never
re-checks pause after being scheduled. Decide the intended closure and gate at
minimum `recover-stuck-renders`. Found by Claude adversarial review.

### Check write errors on webhook intake upserts
**Priority:** P1
Nearly every `outreach_pipeline` upsert in `sendpilot-webhook`, `sendpilot-poll`
and `lemlist-webhook` ignores the returned `error` — if the resolve-play
trigger (or anything else) rejects the write, the webhook still answers 200
"recorded" and the sender never redelivers: unrecoverable lead loss. Check
errors and return non-2xx so SendPilot/lemlist retry. Found by adversarial
review; pre-existing pattern, now sharper because the trigger can raise.

### Verify SendSpark background-URL field semantics before trusting fallback-parking
**Priority:** P1
`_shared/background.ts` host-compares payload fields whose names are
unconfirmed against a real payload. If SendSpark serves backgrounds from its
own CDN host, EVERY render classifies `fallback` and the whole queue parks at
status='rendered' silently. Capture a real render_ready payload from
`outreach_events`, confirm the field names, and add a park-rate alarm/cap.
Owned by the background-status work stream.

### Add a play column to hiring_pipeline_runs
**Priority:** P2
The Plays tab's intake-runs panel is keyed on `play.id === "hiring_signal"`
because `hiring_pipeline_runs` has no play column. Add one and drop the last
play-id literal in `page.tsx`.

### Define workspace-specific default-play semantics before seeding one
**Priority:** P2
Introducing the first workspace-scoped `is_default` play retroactively changes
the "still-default tag" upgrade rules and the UI staged query for that
workspace's existing rows. Decide + backfill strategy first; documented in
`20260610_play_hardening.sql` §2. Found by red-team review.

### Surface phantom-play rows in the UI
**Priority:** P3
Pipeline rows whose play has no registry row count toward "Alle" but appear
under no play pill (counts don't sum). Bucket them into a visible "Ukendt
play" pill so orphaned tags are auditable.

## Testing infrastructure

### Deno test harness for edge functions
**Priority:** P2
`supabase/functions/` has no local test runner (vitest now covers `_shared/`
pure modules via direct import, but the function handlers themselves are
untested). Add `deno test` + a CI job so play stamping, pause gating and
template precedence get regression coverage.

### Component-test setup for the outreach cockpit
**Priority:** P3
`page.tsx` (5k lines) has zero component tests; the Plays tab, play pills and
deep-links were shipped verified by review only. `playUi.tsx` extraction +
jsdom infra exists — extend component coverage from there.

## Completed
