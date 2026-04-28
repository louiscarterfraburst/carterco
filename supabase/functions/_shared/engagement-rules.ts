// Engagement rule contract + pure evaluation helpers. Imported by
// outreach-engagement-tick. Adding a new rule = appending to RULES.
//
// See docs/outreach-playbook.md for intent, signal vocabulary, and the
// step-by-step "how to add a rule" checklist.

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
    if (row.sent_at)          out.sent          = new Date(row.sent_at);
    if (row.viewed_at)        out.viewed        = new Date(row.viewed_at);
    if (row.played_at)        out.played        = new Date(row.played_at);
    if (row.watched_end_at)   out.watched_end   = new Date(row.watched_end_at);
    if (row.cta_clicked_at)   out.cta_clicked   = new Date(row.cta_clicked_at);
    if (row.liked_at)         out.liked         = new Date(row.liked_at);
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
        .replaceAll("{firstName}", (lead.first_name ?? "").trim() || "der")
        .replaceAll("{company}",   (lead.company ?? "").trim())
        .replaceAll("{videoLink}", (lead.video_link ?? "").trim());
}
