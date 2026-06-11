// Pure helpers for fathom-webhook. Deno-free so vitest can run them
// (same convention as send-queue.ts / business-time.ts).

export type FathomInvitee = {
  name?: string | null;
  email?: string | null;
  is_external?: boolean;
};

export type FathomTranscriptItem = {
  speaker?: {
    display_name?: string | null;
    matched_calendar_invitee_email?: string | null;
  };
  text?: string | null;
};

export type LeadCandidate = {
  id: string;
  meeting_at: string | null;
  workspace_id?: string | null;
  name?: string | null;
  company?: string | null;
  email?: string | null;
};

// Fallback when no invitee email matches a lead: the booking stamps
// leads.meeting_at at the slot start; ±30 min absorbs late starts and
// meetings run from an adjacent slot.
export const MEETING_MATCH_TOLERANCE_MS = 30 * 60_000;

// External invitee emails, lowercased, deduped — the lead is matched on
// these (Louis and anyone on the host domain are is_external=false).
export function externalInviteeEmails(invitees: FathomInvitee[]): string[] {
  const out: string[] = [];
  for (const invitee of invitees) {
    if (!invitee.is_external) continue;
    const email = (invitee.email ?? "").trim().toLowerCase();
    if (email && !out.includes(email)) out.push(email);
  }
  return out;
}

// Fathom returns one transcript item per spoken segment; merge consecutive
// segments from the same speaker so the text reads as dialogue, not captions.
export function buildTranscriptText(items: FathomTranscriptItem[]): string {
  const lines: string[] = [];
  let prevSpeaker: string | null = null;
  for (const item of items) {
    const text = (item.text ?? "").trim();
    if (!text) continue;
    const speaker = item.speaker?.display_name?.trim() || "Ukendt deltager";
    if (speaker === prevSpeaker && lines.length > 0) {
      lines[lines.length - 1] += ` ${text}`;
    } else {
      lines.push(`${speaker}: ${text}`);
      prevSpeaker = speaker;
    }
  }
  return lines.join("\n");
}

// Closest lead whose meeting_at falls within the tolerance window. A tie at
// the same distance (double-booked slot) is ambiguous → null, never a guess.
export function matchLeadByMeetingTime<T extends LeadCandidate>(
  leads: T[],
  meetingStartIso: string,
  toleranceMs = MEETING_MATCH_TOLERANCE_MS,
): T | null {
  const started = Date.parse(meetingStartIso);
  if (!Number.isFinite(started)) return null;
  let best: T | null = null;
  let bestDist = Infinity;
  let tied = false;
  for (const lead of leads) {
    if (!lead.meeting_at) continue;
    const at = Date.parse(lead.meeting_at);
    if (!Number.isFinite(at)) continue;
    const dist = Math.abs(at - started);
    if (dist > toleranceMs) continue;
    if (dist < bestDist) {
      best = lead;
      bestDist = dist;
      tied = false;
    } else if (dist === bestDist && best && lead.id !== best.id) {
      tied = true;
    }
  }
  return tied ? null : best;
}

export function durationMinutes(
  startIso?: string | null,
  endIso?: string | null,
): number | null {
  if (!startIso || !endIso) return null;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  return Math.round((end - start) / 60_000);
}

export function noteSubject(
  meetingTitle: string | null | undefined,
  durationMin: number | null,
): string {
  const parts = ["Møde"];
  const title = (meetingTitle ?? "").trim();
  if (title) parts.push(title);
  if (durationMin != null) parts.push(`${durationMin} min`);
  return parts.join(" · ");
}

// Cap what we feed Claude / store in metadata. 80k chars ≈ a multi-hour
// meeting; anything longer keeps the head, which holds the agenda + pitch.
export const TRANSCRIPT_MAX_CHARS = 80_000;

export function truncateTranscript(
  text: string,
  maxChars = TRANSCRIPT_MAX_CHARS,
): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… [transkript afkortet]`;
}

// Fathom signs webhooks Svix-style: headers webhook-id / webhook-timestamp /
// webhook-signature, signed content `${id}.${timestamp}.${rawBody}`,
// HMAC-SHA256 keyed with the base64-decoded secret (after the whsec_
// prefix), base64 output. The signature header holds space-delimited
// `v1,<base64>` entries; any match passes. Timestamps older than 5 min are
// rejected (replay protection).
export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export async function verifyFathomSignature(
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  rawBody: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;

  const age = Math.abs(nowSeconds - Number(timestamp));
  if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) return false;

  let keyBytes: Uint8Array;
  try {
    const raw = atob(secret.startsWith("whsec_") ? secret.slice(6) : secret);
    keyBytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  } catch {
    return false;
  }

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(`${id}.${timestamp}.${rawBody}`),
  );
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));

  for (const entry of signature.split(" ")) {
    const [version, sig] = entry.split(",", 2);
    if (version === "v1" && sig && timingSafeEqual(expected, sig)) return true;
  }
  return false;
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
