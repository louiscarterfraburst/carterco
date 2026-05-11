// SendPilot REST client helpers, focused on the "live safety check"
// that backs every auto_send + manual approve.
//
// Design note: every function fail-safes to "treat as replied" on error.
// If we can't verify whether the prospect has responded — because the API
// is down, rate-limited, returns malformed JSON, whatever — we MUST NOT
// send. The cost of an extra delayed follow-up is trivial; the cost of
// firing a follow-up at someone who already said "På ingen måde" is the
// kind of incident we just lived through.

const SP_API_BASE = "https://api.sendpilot.ai";
const SP_SEARCH_BASE = `${SP_API_BASE}/v1/lead-database/searches`;

export type ReplyCheckResult =
    | { replied: true;  lastReplyAt: string;  source: "live_api" }
    | { replied: false; checkedAt: string;   source: "live_api" }
    | { replied: true;  reason: string;       source: "fail_safe" }; // can't verify → block

function normaliseLinkedinUrl(url: string): string {
    return (url || "").toLowerCase().trim().replace(/\/+$/, "");
}

/**
 * Live check: has the prospect at `recipientLinkedinUrl` replied to the
 * conversation owned by `senderAccountId` in SendPilot? Calls SendPilot's
 * /v1/inbox/conversations endpoint and inspects lastMessage.direction.
 *
 * Match strategy (in order of reliability):
 *   1. Exact match on participant.profileUrl (vanity → vanity).
 *   2. Match on participant.name vs `recipientName` (case/whitespace
 *      normalised). REQUIRED in practice because SendPilot returns
 *      LinkedIn's INTERNAL id-encoded URL form
 *      (https://www.linkedin.com/in/ACoAAA...) NOT the vanity URL we
 *      stored, so #1 almost never matches.
 *
 * Pagination: fetches limit=20 (SendPilot's API 500s on limit≥50 — bug
 * confirmed in production). Conversations sorted by lastActivityAt desc,
 * so any prospect who recently replied is near the top.
 */
const SAFE_PAGE_LIMIT = 20;

function normaliseName(s: string): string {
    return (s || "").toLowerCase().normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")  // strip diacritics
        .replace(/[^a-z0-9 ]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export async function checkLeadReplied(args: {
    apiKey: string;
    senderAccountId: string;
    recipientLinkedinUrl: string;
    recipientName?: string;
}): Promise<ReplyCheckResult> {
    const { apiKey, senderAccountId, recipientLinkedinUrl, recipientName } = args;

    if (!apiKey) {
        return { replied: true, source: "fail_safe", reason: "SENDPILOT_API_KEY missing" };
    }
    if (!senderAccountId) {
        return { replied: true, source: "fail_safe", reason: "senderAccountId missing on lead" };
    }
    if (!recipientLinkedinUrl && !recipientName) {
        return { replied: true, source: "fail_safe", reason: "neither linkedinUrl nor name provided" };
    }

    const url = `${SP_API_BASE}/v1/inbox/conversations` +
        `?accountId=${encodeURIComponent(senderAccountId)}` +
        `&limit=${SAFE_PAGE_LIMIT}`;

    let res: Response;
    try {
        res = await fetch(url, {
            method: "GET",
            headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
        });
    } catch (e) {
        return {
            replied: true,
            source: "fail_safe",
            reason: `network: ${(e as Error).message}`,
        };
    }
    if (!res.ok) {
        return {
            replied: true,
            source: "fail_safe",
            reason: `sendpilot HTTP ${res.status}`,
        };
    }

    let payload: unknown;
    try {
        payload = await res.json();
    } catch {
        return { replied: true, source: "fail_safe", reason: "bad json from sendpilot" };
    }

    const conversations =
        ((payload as Record<string, unknown>)?.conversations as Array<Record<string, unknown>>) ?? [];
    const targetUrl = normaliseLinkedinUrl(recipientLinkedinUrl);
    const targetName = normaliseName(recipientName ?? "");
    const checkedAt = new Date().toISOString();

    for (const conv of conversations) {
        const participants = (conv.participants as Array<Record<string, unknown>>) ?? [];
        let matched = false;
        for (const p of participants) {
            const profileUrl = (p.profileUrl as string) ?? (p.linkedinUrl as string) ?? "";
            if (targetUrl && normaliseLinkedinUrl(profileUrl) === targetUrl) {
                matched = true;
                break;
            }
            const pname = normaliseName((p.name as string) ?? "");
            if (targetName && pname && pname === targetName) {
                matched = true;
                break;
            }
        }
        if (!matched) continue;

        const lastMessage = (conv.lastMessage as Record<string, unknown>) ?? {};
        const direction = (lastMessage.direction as string) ?? "";
        if (direction === "received") {
            const lastReplyAt =
                (lastMessage.sentAt as string) ||
                (conv.lastActivityAt as string) ||
                checkedAt;
            return { replied: true, lastReplyAt, source: "live_api" };
        }
        // Conversation found, last message was outbound (we sent last) → not replied yet.
        return { replied: false, checkedAt, source: "live_api" };
    }

    // No conversation with this prospect in the top 20. Treat as not-replied.
    // Edge case: a long-silent lead (>20 active conversations ahead of theirs)
    // is by definition someone with no recent activity → "not replied" is
    // correct for our purposes.
    return { replied: false, checkedAt, source: "live_api" };
}

// Fires a SendPilot lead-database search and returns the search ID for later
// polling. Used to find alternate contacts at a company when:
//   - the originally-accepted person isn't a buyer (score-accepted-lead), or
//   - the prospect replies with a referral to someone else at the same firm
//     (sendpilot-webhook).
//
// Returns { id } on success or { id: null, error } on failure. Callers persist
// the ID on outreach_pipeline.alt_search_id and let poll-alt-searches pick it
// up on the next 2-min cron tick.
export async function fireSendpilotLeadSearch(args: {
    apiKey: string;
    companyName: string;
    titles: string[];
    locations: string[];
    limit?: number;
}): Promise<{ id: string | null; error?: string }> {
    const { apiKey, companyName, titles, locations, limit } = args;
    if (!apiKey) return { id: null, error: "SENDPILOT_API_KEY not set" };
    const name = (companyName ?? "").trim();
    if (!name) return { id: null, error: "no company name" };

    const res = await fetch(SP_SEARCH_BASE, {
        method: "POST",
        headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
            name: `carterco-alt-${Date.now()}`,
            limit: limit ?? 5,
            filters: { companies: [name], jobTitles: titles, locations },
        }),
    });
    if (!res.ok) {
        const txt = await res.text().catch(() => "");
        return { id: null, error: `sendpilot ${res.status}: ${txt.slice(0, 200)}` };
    }
    const body = await res.json().catch(() => null) as { id?: string } | null;
    return { id: body?.id ?? null };
}
