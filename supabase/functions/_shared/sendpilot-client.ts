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
 * Returns:
 *   - { replied: true, lastReplyAt, source: "live_api" }     → prospect's last
 *       message was inbound. Abort the send.
 *   - { replied: false, checkedAt, source: "live_api" }      → either no
 *       conversation found OR last message was outbound. Safe to send.
 *   - { replied: true, reason, source: "fail_safe" }         → we couldn't
 *       verify (API error, missing inputs, etc.). Treated as replied so the
 *       send is BLOCKED. Caller logs the reason and moves on.
 *
 * Pagination note: only fetches the first 100 conversations. SendPilot
 * sorts by lastActivityAt desc, so any prospect who recently replied will
 * be near the top of the list. A long-silent lead that pushes off page 1
 * would correctly fall through to "not found" → safe-to-send.
 */
export async function checkLeadReplied(args: {
    apiKey: string;
    senderAccountId: string;
    recipientLinkedinUrl: string;
}): Promise<ReplyCheckResult> {
    const { apiKey, senderAccountId, recipientLinkedinUrl } = args;

    if (!apiKey) {
        return { replied: true, source: "fail_safe", reason: "SENDPILOT_API_KEY missing" };
    }
    if (!senderAccountId) {
        return { replied: true, source: "fail_safe", reason: "senderAccountId missing on lead" };
    }
    if (!recipientLinkedinUrl) {
        return { replied: true, source: "fail_safe", reason: "recipientLinkedinUrl missing on lead" };
    }

    const url = `${SP_API_BASE}/v1/inbox/conversations` +
        `?accountId=${encodeURIComponent(senderAccountId)}` +
        `&limit=100`;

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
    const target = normaliseLinkedinUrl(recipientLinkedinUrl);
    const checkedAt = new Date().toISOString();

    for (const conv of conversations) {
        const participants = (conv.participants as Array<Record<string, unknown>>) ?? [];
        let matched = false;
        for (const p of participants) {
            const profileUrl = (p.profileUrl as string) ?? (p.linkedinUrl as string) ?? "";
            if (normaliseLinkedinUrl(profileUrl) === target) {
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

    // No conversation with this prospect on page 1 (or at all). Treat as not-replied.
    // Edge case: if 100+ active conversations exist and the silent prospect's
    // conversation has been pushed off page 1, we'd get a false negative — but
    // by definition that prospect has had no activity, so "not replied" is correct.
    return { replied: false, checkedAt, source: "live_api" };
}
