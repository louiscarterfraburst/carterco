// Did SendSpark render the prospect's own website as the video background, or
// silently fall back to the workspace default? SendSpark falls back when it
// can't scrape the prospect's site (Cloudflare bot-block, timeout) — the
// Victor Lisberg case: his video rendered with a CarterCo-branded landing
// instead of revatacarbon.com, and nothing flagged it before approval.
//
// IMPORTANT: SendSpark's payload field names for background URLs are still
// unconfirmed against a real payload (same caveat as eventType slugs — see
// sendspark-webhook header). Until a real render_ready payload in
// outreach_events confirms them, most events will classify as 'unknown',
// which intentionally changes nothing about the approval flow.

export type BackgroundStatus = "ok" | "fallback" | "unknown";

// Host-level comparison: SendSpark may rewrite the path/query of the URL it
// was given (screenshot params, proxy prefixes), so exact-string equality
// would false-positive. A fallback swaps the *site*, so the host is the
// signal.
function host(url: string): string | null {
    const trimmed = url.trim();
    if (!trimmed) return null;
    try {
        const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
        return u.hostname.replace(/^www\./, "").toLowerCase() || null;
    } catch {
        return null;
    }
}

export function classifyBackground(evt: {
    backgroundUrl?: string;
    originalBackgroundUrl?: string;
}): BackgroundStatus {
    const requested = host(evt.originalBackgroundUrl ?? "");
    const rendered = host(evt.backgroundUrl ?? "");
    if (!requested || !rendered) return "unknown";
    return requested === rendered ? "ok" : "fallback";
}
