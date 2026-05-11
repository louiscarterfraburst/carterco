// Engagement rule contract + pure evaluation helpers. Imported by
// outreach-engagement-tick. Adding a new rule = appending to RULES.
//
// See docs/outreach-playbook.md for intent, signal vocabulary, and the
// step-by-step "how to add a rule" checklist.

import { firstNameForGreeting, normalizeCompanyName } from "./text.ts";

export type Signal =
    | "sent"          // we sent the post-render LinkedIn message
    | "viewed"        // SendSpark "Video Viewed"
    | "played"        // SendSpark "Video Played"
    | "watched_end"   // SendSpark "Video Watched to the End"
    | "cta_clicked"   // SendSpark "Video CTA Clicked"
    | "liked"         // SendSpark "Video Liked"
    | "replied"       // any LinkedIn reply received from this lead
    | "render_failed";// SendSpark "Video Failed to Generate"

export type Action =
    | { type: "auto_send";      template: string }
    | { type: "queue_approval"; template: string }
    | { type: "push_only" };

export type EngagementRule = {
    id: string;                  // stable id, used in audit log
    description: string;         // human-readable intent
    when: {
        requires: Signal[];      // all must be present
        excludes?: Signal[];     // any present → rule does not match (e.g. "replied")
        delayHours: number;      // hours since the most recent required signal; 0 = instant
    };
    action: Action;
    maxFiresPerLead?: number;    // default 1
};

// No rules wired yet. Each new rule = one entry here + an updated
// "Current rules" table in docs/outreach-playbook.md.
export const RULES: EngagementRule[] = [];

// --- Pure helpers (no DB access; safe to unit-test) ---------------------------

export type LeadSignals = Partial<Record<Signal, Date>>;

// Build the Signal → timestamp map from an outreach_pipeline row.
//
// IMPORTANT: engagement signals (viewed/played/watched_end/cta_clicked/liked)
// only count if they happen STRICTLY AFTER the initial DM was sent AND a
// short post-send buffer has elapsed. SendSpark webhook payloads contain
// no viewer-identifying data (no user-agent, no IP, no viewerEmail), so
// when Louis or Rasmus previews a video in /outreach, the event is
// indistinguishable from a real prospect play. Two heuristic guards
// protect against treating internal previews as engagement:
//
//   1. played_at <= sent_at  → preview (impossible for prospect to engage
//      before DM was delivered). Confirmed: Erik Mygind Nielsen got
//      nysgerrig 109ms after his initial DM because the video had been
//      previewed 30 min EARLIER, and the engine treated that 30-min-old
//      "play" as 30-min-old engagement → fired immediately.
//
//   2. sent_at < played_at < sent_at + INTERNAL_PREVIEW_BUFFER_MS → likely
//      preview (real B2B prospects rarely open a LinkedIn DM and watch a
//      personalised video within minutes of receipt). Trade-off: we'll
//      miss the occasional truly-instant prospect engagement, but block
//      the much-more-common false positive of post-approval review.
//
// `replied` and `render_failed` are NOT gated — they're terminal/branch
// signals where false positives are safe (they only ever STOP further
// sends, never trigger them).
const INTERNAL_PREVIEW_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

export function signalsForLead(row: {
    sent_at?: string | null;
    viewed_at?: string | null;
    played_at?: string | null;
    watched_end_at?: string | null;
    cta_clicked_at?: string | null;
    liked_at?: string | null;
    last_reply_at?: string | null;
    render_failed_at?: string | null;
}): LeadSignals {
    const out: LeadSignals = {};
    const sentAt = row.sent_at ? new Date(row.sent_at) : null;

    function postSendOnly(ts: string | null | undefined): Date | null {
        if (!ts) return null;
        if (!sentAt) return null; // no DM dispatched yet → any engagement is noise
        const d = new Date(ts);
        // Require: (a) strictly after sent, and (b) outside the
        // internal-preview window after sent. Prevents both pre-send
        // previews AND fast post-approval reviews from arming sequences.
        if (d.getTime() <= sentAt.getTime() + INTERNAL_PREVIEW_BUFFER_MS) return null;
        return d;
    }

    if (row.sent_at)          out.sent          = new Date(row.sent_at);
    const viewed     = postSendOnly(row.viewed_at);     if (viewed)     out.viewed       = viewed;
    const played     = postSendOnly(row.played_at);     if (played)     out.played       = played;
    const watchedEnd = postSendOnly(row.watched_end_at); if (watchedEnd) out.watched_end  = watchedEnd;
    const cta        = postSendOnly(row.cta_clicked_at); if (cta)        out.cta_clicked  = cta;
    const liked      = postSendOnly(row.liked_at);       if (liked)      out.liked        = liked;
    if (row.last_reply_at)    out.replied       = new Date(row.last_reply_at);
    if (row.render_failed_at) out.render_failed = new Date(row.render_failed_at);
    return out;
}

// Returns true iff all required signals are present, no excluded signal is
// present, and the most recent required signal happened ≥ delayHours ago.
export function ruleMatches(
    rule: EngagementRule,
    signals: LeadSignals,
    now: Date,
): boolean {
    for (const ex of rule.when.excludes ?? []) {
        if (signals[ex]) return false;
    }
    let mostRecent: Date | null = null;
    for (const req of rule.when.requires) {
        const ts = signals[req];
        if (!ts) return false;
        if (!mostRecent || ts > mostRecent) mostRecent = ts;
    }
    if (!mostRecent) return false;
    const ageMs = now.getTime() - mostRecent.getTime();
    return ageMs >= rule.when.delayHours * 3600_000;
}

// Substitute {firstName}, {company}, {videoLink} in a template string.
// Missing fields fall back to sensible defaults.
export function renderTemplate(
    tpl: string,
    lead: { first_name?: string | null; company?: string | null; video_link?: string | null },
): string {
    return tpl
        .replaceAll("{firstName}", firstNameForGreeting(lead.first_name) || "der")
        .replaceAll("{company}",   normalizeCompanyName(lead.company))
        .replaceAll("{videoLink}", (lead.video_link ?? "").trim());
}
