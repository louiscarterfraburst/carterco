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

// Per-workspace copy. A workspace absent here never sends — only workspaces
// whose team actually dials via Telavox belong here (the SMS goes out from a
// Soho Telavox seat, so the sender must make sense to the lead). Klosterstræde
// is deliberately NOT enabled: Lee doesn't use Telavox.
export const SMS_ACK_COPY: Record<string, (firstName: string | null) => string> = {
  // Soho (mødelokaler + kontorer) — reception calls from 88 27 64 01.
  "7f13f551-9514-4a5a-b1bf-98eb95c1a469": (first) =>
    `${first ? `Hej ${first}` : "Hej"}, tak for din henvendelse til SOHO. Vi ringer til dig snarest fra 88 27 64 01.`,
  // Soho Events (Sahra) — Telavox-dialled, no fixed outbound number promised.
  "9d2a8cd2-ea01-4ab0-92c5-84e4256ccca7": (first) =>
    `${first ? `Hej ${first}` : "Hej"}, tak for din henvendelse om events hos SOHO. Vi ringer til dig snarest.`,
};

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
  const copy = lead.workspace_id ? SMS_ACK_COPY[lead.workspace_id] : undefined;
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
