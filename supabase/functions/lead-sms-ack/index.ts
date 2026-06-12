// lead-sms-ack
//
// Cron-driven safety net for inbound Meta leads: if reception hasn't touched a
// lead 5 minutes after it landed (no dial click, no call status, no outcome),
// send ONE acknowledgement SMS from Soho's Telavox seat — "vi ringer snarest"
// — so the lead recognises the number when the call comes. Call-first stays
// the play; this only fires when the 5-minute head start has passed.
//
// Eligibility, copy and the business-hours window live in
// _shared/lead-sms-ack.ts (tested). One attempt per lead, ever — attempts
// (including failures) are recorded as a lead_conversation_events row keyed
// source='lead_sms_ack', which doubles as the receptionist-visible timeline
// entry and the idempotency guard.
//
// Required env:
//   TELAVOX_SMS_TOKEN — token from a Telavox seat with the SMS feature
//                       (Reception1; Louis's USER_FREE seat is feature-gated).
//                       Missing token → the function no-ops (dormant deploy).
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";
import {
  SMS_ACK_COPY,
  SMS_ACK_GATE_MS,
  SMS_ACK_MAX_AGE_MS,
  smsAckDecision,
  type SmsAckLead,
} from "../_shared/lead-sms-ack.ts";

const TELAVOX_SMS_TOKEN = Deno.env.get("TELAVOX_SMS_TOKEN") ?? "";
const TELAVOX_BASE = Deno.env.get("TELAVOX_BASE") ?? "https://home.telavox.se/api/capi";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false } },
);

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!TELAVOX_SMS_TOKEN) {
    return json({ ok: true, dormant: "TELAVOX_SMS_TOKEN not set" });
  }

  const now = new Date();
  const enabledWorkspaces = Object.keys(SMS_ACK_COPY);

  // Candidates: untouched meta leads past the gate but not stale.
  const { data: leads, error } = await supabase
    .from("leads")
    .select("id, workspace_id, name, phone, source, is_draft, call_status, outcome, created_at, meta_form_id")
    .in("workspace_id", enabledWorkspaces)
    .eq("source", "meta_leadgen")
    .eq("is_draft", false)
    .is("call_status", null)
    .is("outcome", null)
    .gte("created_at", new Date(now.getTime() - SMS_ACK_MAX_AGE_MS).toISOString())
    .lte("created_at", new Date(now.getTime() - SMS_ACK_GATE_MS).toISOString())
    .limit(20);
  if (error) return json({ error: error.message }, 500);
  if (!leads?.length) return json({ ok: true, results: [] });

  // Contact + prior-attempt lookup in one query.
  const ids = leads.map((l) => l.id);
  const { data: events, error: evErr } = await supabase
    .from("lead_conversation_events")
    .select("lead_id, channel, source")
    .in("lead_id", ids);
  if (evErr) return json({ error: evErr.message }, 500);

  const contacted = new Set<string>();
  const attempted = new Set<string>();
  for (const ev of events ?? []) {
    if (ev.source === "lead_sms_ack") attempted.add(ev.lead_id);
    else if (ev.channel === "phone" || ev.channel === "sms" || ev.channel === "email") {
      contacted.add(ev.lead_id);
    }
  }

  const results: Array<Record<string, unknown>> = [];
  for (const lead of leads as SmsAckLead[]) {
    const decision = smsAckDecision(lead, {
      now,
      hasContact: contacted.has(lead.id),
      hasAckAttempt: attempted.has(lead.id),
    });
    if (decision.action === "skip") {
      results.push({ lead_id: lead.id, status: `skipped:${decision.reason}` });
      continue;
    }

    let sendOk = false;
    let sendError: string | null = null;
    try {
      const res = await fetch(`${TELAVOX_BASE}/v1/extensions/users/me/sms`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TELAVOX_SMS_TOKEN}`,
          "Content-Type": "application/json",
          "User-Agent": "carterco-leads/1.0 (louis@carterco.dk)",
        },
        body: JSON.stringify({ phoneNumber: decision.to, message: decision.message }),
      });
      sendOk = res.ok;
      if (!res.ok) sendError = `telavox ${res.status}: ${(await res.text()).slice(0, 200)}`;
    } catch (e) {
      sendError = e instanceof Error ? e.message : String(e);
    }

    // Record the attempt either way — the row is both the timeline entry the
    // receptionist sees and the guard that caps us at one attempt per lead.
    const { error: insErr } = await supabase.from("lead_conversation_events").insert({
      workspace_id: lead.workspace_id,
      lead_id: lead.id,
      channel: "sms",
      direction: "outbound",
      sender: "auto",
      recipient: decision.to,
      body: decision.message,
      source: "lead_sms_ack",
      metadata: sendOk ? { status: "sent" } : { status: "failed", error: sendError },
    });
    if (insErr) console.error("lead-sms-ack: event insert failed", lead.id, insErr.message);
    if (sendError) console.warn("lead-sms-ack: send failed", lead.id, sendError);

    results.push({ lead_id: lead.id, status: sendOk ? "sent" : "failed", error: sendError ?? undefined });
  }

  return json({ ok: true, results });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
