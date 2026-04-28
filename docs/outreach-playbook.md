# Outreach engagement playbook

## 1. Intent

The outreach pipeline runs a SendPilot ↔ SendSpark loop:

1. SendPilot sends a LinkedIn invite.
2. On `connection.accepted`, we POST to SendSpark to render a personalised video.
3. On `Video Ready to Download`, we send the LinkedIn message containing the video link (auto-send for cold leads, queue for approval for warm).
4. SendSpark fires engagement webhooks as the lead interacts with the video page (Viewed → Played → Watched-to-End → CTA Clicked → Liked).
5. The **engagement system** (this doc) reacts to those signals with rule-driven follow-ups.

**What this system does:** apply a set of declarative rules to the engagement state of every open lead. When a rule matches, fire one of three actions: `auto_send`, `queue_approval`, or `push_only`.

**What it deliberately does not do:**
- It does not send a follow-up *while a real conversation is live*. The auto-flow halts the moment a LinkedIn reply arrives (`last_reply_at` set). After that, every message is human-composed in the cockpit. Nuance matters once a human has engaged — the system stays out of the way.
- It does not ladder beyond the rules array. If no rule matches, nothing happens.
- It does not fire more than `maxFiresPerLead` (default 1) of the same rule against the same lead.

## 2. Signal vocabulary

The eight SendSpark webhook event types and how they map to `outreach_pipeline` columns:

| SendSpark event           | Internal Signal | Pipeline column        | Notes                                           |
|---------------------------|-----------------|------------------------|-------------------------------------------------|
| Video Created             | —               | (audit only)           | Logged in `outreach_events`, no pipeline write  |
| Video Ready to Download   | —               | `rendered_at`, `sent_at` | Existing render→send/queue path                |
| Video Viewed              | `viewed`        | `viewed_at`            | Visited the video page                          |
| Video Played              | `played`        | `played_at`            | Hit play                                        |
| Video Watched to the End  | `watched_end`   | `watched_end_at`       | Strongest passive signal                        |
| Video CTA Clicked         | `cta_clicked`   | `cta_clicked_at`       | **Instant trigger** — fires worker immediately  |
| Video Liked               | `liked`         | `liked_at`             | Light positive signal                           |
| Video Failed to Generate  | `render_failed` | `render_failed_at`     | **Instant trigger**, also sets `status='failed'`|

Two additional signals derived from elsewhere in the pipeline:

| Signal     | Derived from                                | Used as |
|------------|---------------------------------------------|---------|
| `sent`     | `outreach_pipeline.sent_at`                 | required (rules typically need the message to have gone out) |
| `replied`  | `outreach_pipeline.last_reply_at`           | exclude (auto-flow halts on any reply) |

Engagement column writes are idempotent: a second `Video Played` event won't overwrite the first `played_at` timestamp.

## 3. Sequence contract

A **sequence** is an ordered list of steps a lead walks through after a trigger signal lands. One sequence per lead at a time. Defined in `supabase/functions/_shared/sequences.ts`:

```ts
type Sequence = {
  id: string;                    // stable; audit log writes "<seq>::<step>"
  description: string;
  trigger: { signal: Signal };   // sequence starts when this signal first appears on a lead
  excludesGlobal?: Signal[];     // checked at every step. Default: ["replied"]
  steps: SequenceStep[];
};

type SequenceStep = {
  id: string;                    // stable; written to audit log as "<seq>::<step>"
  waitHours: number;             // hours after step entry before evaluating branches
  excludes?: Signal[];           // step-local exit (added to sequence.excludesGlobal)
  branches: Array<{
    requires?: Signal[];         // all must be present; omit/empty = always match (fallback)
    action:
      | { type: "auto_send";      template: string }
      | { type: "queue_approval"; template: string }
      | { type: "push_only" };
  }>;
  maxWaitHours?: number;         // skip-and-advance after this many hours if no branch matched. Default: waitHours
};
```

**Field semantics:**

- `Sequence.trigger.signal` — when this signal first becomes true on a lead with no `sequence_id`, the engine enrols the lead at step 0. Typical: `"sent"` (post-message follow-ups). One sequence per lead total — the first matching sequence in `SEQUENCES` wins.
- `Sequence.excludesGlobal` — defaults to `["replied"]`. Once any signal in this set is present, the sequence exits immediately (no further steps fire). The auto-flow halts the moment a real conversation starts.
- `SequenceStep.waitHours` — measured from `sequence_step_entered_at` (set when the lead arrived at this step). For step 0 that's the enrolment time.
- `SequenceStep.branches` — evaluated **in order**, first match wins. Use a final entry with no `requires` as a fallback. If you want the step to do nothing for cases that don't match anything, omit the fallback and rely on `maxWaitHours` to advance.
- `SequenceStep.maxWaitHours` — when the step's signals haven't lined up by then, the engine advances silently (no audit row). Without this the step could park forever waiting for a signal that never lands.
- `id` (sequence and step) — must be stable across deploys; the audit log uses `"<sequence_id>::<step_id>"` as `rule_id` to enforce idempotency. Renaming a step makes the engine treat it as new.

**Precedence:** within a single tick, exactly one step is evaluated per lead. If a branch fires, the lead advances to the next step (which is parked until its own `waitHours` elapses). If no branch fires and `maxWaitHours` hasn't elapsed, the lead is re-parked. If `maxWaitHours` has elapsed, the lead advances silently.

**Per-lead state** lives on `outreach_pipeline`:
- `sequence_id`, `sequence_step` — current position.
- `sequence_step_entered_at` — when the lead arrived at the current step.
- `sequence_parked_until` — earliest tick we should re-evaluate. Indexed for cheap scans.
- `sequence_started_at`, `sequence_completed_at` — bookkeeping.

## 4. Current sequences

| ID | Trigger | Description | Steps |
|----|---------|-------------|-------|
| `post_send_followup_v1` | `sent` | Follow up 48h after we sent the video. Branches on watch state. | `followup_48h` (queue_approval if watched_end → played → fallback push_only) |

## 5. How to add a sequence

1. **Append to `SEQUENCES`** in `supabase/functions/_shared/sequences.ts`. Keep `id` stable and descriptive (e.g. `cta_clicked_v1`). Same for each step's `id`.
2. **Write templates** inline as the `template` string on each branch. Use `{firstName}` / `{company}` / `{videoLink}` placeholders. Danish, line breaks as `\n`, no trailing whitespace.
3. **Update the "Current sequences" table** in this doc (section 4). One row per live sequence; summarise step structure compactly.
4. **Deploy `outreach-engagement-tick`**:
   ```
   supabase functions deploy outreach-engagement-tick --no-verify-jwt
   ```
   No schema migration is needed for a new sequence — the schema is already general.
5. **Verify** within one cron cycle (≤5 min). Trigger a real or synthetic engagement event against a test lead, then:
   - check `outreach_pipeline.sequence_id` got set on enrolment,
   - check `outreach_engagement_actions` got a row with `rule_id = "<sequence_id>::<step_id>"`,
   - check `outreach_pipeline.status` / `rendered_message` reflect the action,
   - if `auto_send`: confirm the SendPilot send succeeded (`status='sent'`, `sendpilot_response` populated),
   - check `sequence_completed_at` is set after the last step (or after a global-exclude exit).

## 6. Architecture (reference)

```
SendSpark webhook
        │
        ▼
sendspark-webhook  ──(insert raw)──►  outreach_events
        │
        ├──(stamp timestamp col)──►  outreach_pipeline
        │
        └─(if cta_clicked / render_failed)
                │
                ▼  AFTER trigger fires net.http_post
        outreach-engagement-tick  ◄──(every 5 min)── pg_cron
                │
                ▼
        per-lead state machine:
          enrol (if no sequence_id, trigger signal present)
            → wait gate (sequence_step_entered_at + waitHours)
            → evaluate branches (first match fires action)
            → advance step (or complete)
            → exit on excludesGlobal / step.excludes
                │
                ▼
        outreach_engagement_actions  (audit row per fire,
                                      rule_id = "<seq>::<step>")
```

Source-of-truth split:

- **Code** — `sequences.ts` is authoritative for *behavior*. The runtime reads it; what's there is what fires. `engagement-rules.ts` still owns the `Signal` / `Action` types and the pure helpers (`signalsForLead`, `renderTemplate`); its `RULES = []` is vestigial and will be removed once sequences are proven in production.
- **This doc** — authoritative for *intent*. If the doc and code disagree, fix whichever one is wrong; don't let them drift.
