// Per-contact timeline — the contact-first cockpit primitive.
//
// Two halves:
//   buildThread()      → the PAST: every message sent + received, merged in
//                        chronological order (first DM, follow-up fires, emails,
//                        inbound replies).
//   projectUpcoming()  → the FUTURE: the next sends this contact will receive,
//                        with projected dates, walked forward from their current
//                        sequence step using each step's waitHours. Best-effort
//                        (branches/replies can change it) — label as projected.
//
// A contact that's `sent` with no upcoming and no terminal outcome is the
// "forgotten" case Louis is afraid of — see isPossiblyForgotten().

import type { SeqLite } from "./flow";

export type TimelineContact = {
  sendpilot_lead_id: string;
  status: string;
  sent_at: string | null;
  rendered_message: string | null;
  hook_bucket: string | null;
  first_dm_variant: string | null;
  sequence_id: string | null;
  sequence_step: number | null;
  sequence_parked_until: string | null;
  sequence_completed_at: string | null;
  last_reply_at: string | null;
};

export type ThreadReply = { message: string; intent: string | null; received_at: string };
export type ThreadEmail = { subject: string; body: string; sent_at: string | null };
export type ThreadAction = { rule_id: string; action_type: string; fired_at: string; result: unknown };

export type ThreadItem = {
  at: string;            // ISO timestamp
  direction: "out" | "in";
  channel: "DM" | "Email";
  label: string;         // e.g. "1. DM · bucket 2", "Opfølgning · kalender", "Svar · interested"
  subject?: string;
  text: string | null;   // null = sent but text not stored
};

export type UpcomingItem = {
  stepId: string;
  at: string;            // projected ISO timestamp
  template: string;      // message template (tokens unfilled)
  conditional: boolean;  // step only fires if a branch condition holds
};

const HOUR = 3600_000;

function pickText(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  for (const k of ["message", "text", "body", "rendered", "rendered_message"]) {
    const v = r[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

export function buildThread(
  contact: TimelineContact,
  replies: ThreadReply[],
  emails: ThreadEmail[],
  actions: ThreadAction[],
): ThreadItem[] {
  const items: ThreadItem[] = [];

  if (contact.sent_at && contact.rendered_message) {
    const arm = contact.first_dm_variant ? ` · ${contact.first_dm_variant}` : "";
    const bucket = contact.hook_bucket ? ` · bucket ${contact.hook_bucket}` : "";
    items.push({
      at: contact.sent_at,
      direction: "out",
      channel: "DM",
      label: `1. DM${arm}${bucket}`,
      text: contact.rendered_message,
    });
  }

  for (const a of actions) {
    if (a.action_type !== "auto_send") continue;
    items.push({
      at: a.fired_at,
      direction: "out",
      channel: "DM",
      label: `Opfølgning · ${a.rule_id}`,
      text: pickText(a.result),
    });
  }

  for (const e of emails) {
    if (!e.sent_at) continue;
    items.push({ at: e.sent_at, direction: "out", channel: "Email", label: "Email", subject: e.subject, text: e.body });
  }

  for (const r of replies) {
    items.push({
      at: r.received_at,
      direction: "in",
      channel: "DM",
      label: `Svar${r.intent ? ` · ${r.intent}` : ""}`,
      text: r.message,
    });
  }

  return items.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

export function projectUpcoming(contact: TimelineContact, sequences: SeqLite[]): UpcomingItem[] {
  if (!contact.sequence_id || contact.sequence_completed_at) return [];
  const seq = sequences.find((s) => s.id === contact.sequence_id);
  if (!seq?.steps?.length) return [];
  const startIdx = contact.sequence_step ?? 0;
  if (startIdx >= seq.steps.length) return [];

  const base = contact.sequence_parked_until
    ? new Date(contact.sequence_parked_until).getTime()
    : Date.now();

  const out: UpcomingItem[] = [];
  let t = base;
  for (let i = startIdx; i < seq.steps.length; i++) {
    const step = seq.steps[i];
    if (i > startIdx) t += (step.waitHours ?? 0) * HOUR;
    const branch = step.branches?.[0];
    out.push({
      stepId: step.id || `trin ${i}`,
      at: new Date(t).toISOString(),
      template: branch?.action?.template ?? "",
      conditional: !!branch?.requires?.length,
    });
  }
  return out;
}

// The fear case: a contact who got the first DM but has nothing scheduled and
// hasn't replied or terminated — i.e. could be silently forgotten.
export function isPossiblyForgotten(contact: TimelineContact, upcoming: UpcomingItem[]): boolean {
  const terminal = ["rejected", "rejected_by_icp", "failed"].includes(contact.status);
  if (terminal || contact.sequence_completed_at) return false;
  if (contact.last_reply_at) return false; // a reply is a human decision point, not "forgotten"
  if (upcoming.length) return false;
  return contact.status === "sent";
}
