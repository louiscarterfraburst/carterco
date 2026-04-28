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

## 3. Rule contract

Defined in `supabase/functions/_shared/engagement-rules.ts`:

```ts
type EngagementRule = {
  id: string;            // stable identifier — written to the audit log
  description: string;   // human-readable intent

  when: {
    requires: Signal[];     // ALL must be present on the lead
    excludes?: Signal[];    // if ANY is present, rule does NOT match
    delayHours: number;     // hours since the most recent required signal; 0 = instant
  };

  action:
    | { type: "auto_send";       template: string }
    | { type: "queue_approval";  template: string }
    | { type: "push_only" };

  maxFiresPerLead?: number;   // default 1
};
```

**Field semantics:**

- `id` — must be stable across deploys; the audit log uses it to enforce `maxFiresPerLead`. Renaming a rule means losing its history.
- `when.requires` — *all* signals must be present. The rule's "trigger time" is the most recent of these timestamps; `delayHours` is measured from there.
- `when.excludes` — typical use: `["replied"]` so the rule stops firing once a real conversation starts. Optional but almost always wanted.
- `when.delayHours` — `0` for "fire immediately", `24` for "fire 24h after the most recent required signal", etc. Time-gated rules are evaluated by the 5-min cron scan; `0` rules also fire instantly via DB triggers on `cta_clicked_at` / `render_failed_at`.
- `action.template` — Danish text supporting `{firstName}`, `{company}`, `{videoLink}` substitutions.
- `maxFiresPerLead` — counted via rows in `outreach_engagement_actions` for that `(sendpilot_lead_id, rule_id)`.

**Precedence:** rules are evaluated in array order. The first match per lead per tick wins; subsequent rules are skipped for that lead until the next tick. This keeps a single engagement event from fanning out into multiple actions in one pass.

## 4. Current rules

| ID | Description | Action |
|----|-------------|--------|
| _(none yet)_ | Infrastructure ships first; rules added one at a time | — |

## 5. How to add a rule

1. **Append to `RULES`** in `supabase/functions/_shared/engagement-rules.ts`. Keep `id` stable and descriptive (e.g. `viewed_no_reply_24h`).
2. **Write the template** inline as the `template` string. Use `{firstName}` / `{company}` / `{videoLink}` placeholders. Danish, line breaks as `\n`, no trailing whitespace.
3. **Update the "Current rules" table** in this doc (section 4). One row per live rule.
4. **Deploy `outreach-engagement-tick`**:
   ```
   supabase functions deploy outreach-engagement-tick --no-verify-jwt
   ```
   No schema migration is needed for a new rule — the schema is already general.
5. **Verify** within one cron cycle (≤5 min). Trigger a real or synthetic engagement event against a test lead, then:
   - check `outreach_engagement_actions` got a row with the new `rule_id`,
   - check `outreach_pipeline.status` / `rendered_message` reflect the action,
   - if `auto_send`: confirm the SendPilot send succeeded (`status='sent'`, `sendpilot_response` populated).

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
        iterate RULES → evaluate signals → execute action
                │
                ▼
        outreach_engagement_actions  (audit row per fire)
```

Source-of-truth split:

- **Code** — `engagement-rules.ts` is authoritative for *behavior*. The runtime reads it; what's there is what fires.
- **This doc** — authoritative for *intent*. If the doc and code disagree, fix whichever one is wrong; don't let them drift.
