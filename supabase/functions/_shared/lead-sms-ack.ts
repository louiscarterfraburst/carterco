// Auto-SMS safety net for inbound Meta leads (call-first with a 5-minute gate).
//
// Reception always gets first right of way: the SMS only fires when a lead has
// sat untouched (no dial click, no call_status, no outcome) for the gate
// period. It acknowledges the enquiry and primes the upcoming call ("vi ringer
// fra …"), which is why the sender seat must be the same number reception
// dials out from. One attempt per lead, ever — Telavox has no inbound SMS, so
// the copy never invites a reply.

import { clampToWindow } from "./business-time.ts";

// Reception window (CPH): the SMS promises an imminent call, so it only sends
// while someone can actually make that call.
export const SMS_ACK_WINDOW = { startHour: 8, endHour: 17 };

export const SMS_ACK_GATE_MS = 5 * 60 * 1000; // reception's head start
export const SMS_ACK_MAX_AGE_MS = 24 * 60 * 60 * 1000; // never SMS stale leads

// Copy resolves per lead TYPE (form), falling back to the workspace default.
// A workspace absent from SMS_ACK_COPY never sends. Each message carries the
// self-serve link for that lead type (cadence §7: lead with the link), and the
// Soho variants reference the main number 70 13 60 00 — the number reception's
// outbound shows. Klosterstræde promises no number (Lee calls from her own).
const SOHO_WS = "7f13f551-9514-4a5a-b1bf-98eb95c1a469";
const SOHO_EVENTS_WS = "9d2a8cd2-ea01-4ab0-92c5-84e4256ccca7";
const KLOSTERSTRAEDE_WS = "c61aaffb-518b-4995-ac31-5a2e7300b1f2";

type CopyFn = (firstName: string | null) => string;
const greet = (first: string | null) => (first ? `Hej ${first}` : "Hej");

// Soho-page form ids (same ids as the webhook routing/allowlist).
const FORM_COPY: Record<string, CopyFn> = {
  // CR New-copy → mødelokaler: Nexudus self-serve booking.
  "1539910014404003": (f) =>
    `${greet(f)}, tak for din henvendelse til SOHO. Book dit mødelokale direkte her: https://sohonetwork.spaces.nexudus.com/bookings. Vi ringer til dig snarest fra 70 13 60 00.`,
  // Office-carter → kontorer i Kødbyen.
  "997952706463015": (f) =>
    `${greet(f)}, tak for din henvendelse om kontor hos SOHO. Se mere her: https://soho.dk/da-dk/kontorer/kodbyen. Vi ringer til dig snarest fra 70 13 60 00.`,
  // K9 → fast plads i Klosterstræde.
  "2837412979963112": (f) =>
    `${greet(f)}, tak for din interesse i en fast plads i Klosterstræde. Se mere her: https://soho.dk/da-dk/kontorer/klosterstraede. Vi ringer til dig snarest.`,
};

export const SMS_ACK_COPY: Record<string, CopyFn> = {
  [SOHO_WS]: (f) =>
    `${greet(f)}, tak for din henvendelse til SOHO. Vi ringer til dig snarest fra 70 13 60 00.`,
  [SOHO_EVENTS_WS]: (f) =>
    `${greet(f)}, tak for din henvendelse om events hos SOHO. Vi ringer til dig snarest.`,
  [KLOSTERSTRAEDE_WS]: (f) =>
    `${greet(f)}, tak for din interesse i en fast plads i Klosterstræde. Se mere her: https://soho.dk/da-dk/kontorer/klosterstraede. Vi ringer til dig snarest.`,
};

export function smsAckCopy(workspaceId: string | null, metaFormId: string | null | undefined): CopyFn | undefined {
  // Workspace gate first — a known form id never enables a disabled workspace.
  const wsCopy = workspaceId ? SMS_ACK_COPY[workspaceId] : undefined;
  if (!wsCopy) return undefined;
  return (metaFormId && FORM_COPY[metaFormId]) || wsCopy;
}

export type SmsAckLead = {
  id: string;
  workspace_id: string | null;
  name: string | null;
  phone: string | null;
  source: string;
  is_draft: boolean;
  call_status: string | null;
  outcome: string | null;
  created_at: string;
  meta_form_id: string | null;
};

export type SmsAckDecision =
  | { action: "send"; to: string; message: string }
  | { action: "skip"; reason: string };

// Danish numbers only, normalized to Telavox's 00-international format.
export function toTelavoxNumber(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, "");
  if (/^\+45\d{8}$/.test(digits)) return `0045${digits.slice(3)}`;
  if (/^0045\d{8}$/.test(digits)) return digits;
  if (/^45\d{8}$/.test(digits)) return `00${digits}`;
  if (/^\d{8}$/.test(digits)) return `0045${digits}`;
  return null;
}

export function firstNameOf(name: string | null): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  // Meta test leads and junk values ("<test lead: …>") must not be greeted.
  if (!first || !/^[\p{L}'-]+$/u.test(first)) return null;
  return first;
}

export function smsAckDecision(
  lead: SmsAckLead,
  opts: { now: Date; hasContact: boolean; hasAckAttempt: boolean },
): SmsAckDecision {
  const copy = smsAckCopy(lead.workspace_id, lead.meta_form_id);
  if (!copy) return { action: "skip", reason: "workspace_not_enabled" };
  if (lead.source !== "meta_leadgen") return { action: "skip", reason: "not_meta_lead" };
  if (lead.is_draft) return { action: "skip", reason: "draft" };
  if (lead.call_status || lead.outcome || opts.hasContact) {
    return { action: "skip", reason: "reception_acted" };
  }
  if (opts.hasAckAttempt) return { action: "skip", reason: "already_attempted" };

  const age = opts.now.getTime() - new Date(lead.created_at).getTime();
  if (age < SMS_ACK_GATE_MS) return { action: "skip", reason: "inside_gate" };
  if (age > SMS_ACK_MAX_AGE_MS) return { action: "skip", reason: "too_old" };

  const inWindow =
    clampToWindow(opts.now, SMS_ACK_WINDOW.startHour, SMS_ACK_WINDOW.endHour).getTime() ===
      opts.now.getTime();
  if (!inWindow) return { action: "skip", reason: "outside_hours" };

  const to = toTelavoxNumber(lead.phone);
  if (!to) return { action: "skip", reason: "no_danish_number" };

  return { action: "send", to, message: copy(firstNameOf(lead.name)) };
}
