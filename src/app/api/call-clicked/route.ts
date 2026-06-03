// Operator-clicked dial log. Called from /leads when a receptionist clicks
// the "Ring" button on a lead. The click opens the phone (tel:/Telavox) and
// the same click POSTs here so the backend records WHO attempted the call,
// WHICH lead, and WHEN — the foundation for per-receptionist call attribution
// and the agent overview.
//
// This logs the click (intent to call), not a connected call. Once the
// Telavox CAPI dial feature is enabled, the actual call records will be
// reconciled in via polling /v1/extensions/users/me/calls/history.
//
// Honor-system trade (same as sms-sent): if the operator backs out before the
// call connects, the log still shows an attempt. Acceptable for v1 — the
// signal we want is "who is working which leads, and how fast".

import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  leadId?: string;
};

export async function POST(req: Request) {
  let payload: Body;
  try {
    payload = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const leadId = payload.leadId?.trim();
  if (!leadId) {
    return NextResponse.json({ error: "leadId required" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data: lead, error: leadErr } = await supabase
    .from("leads")
    .select("id, workspace_id, phone")
    .eq("id", leadId)
    .maybeSingle();
  if (leadErr) {
    return NextResponse.json({ error: leadErr.message }, { status: 500 });
  }
  if (!lead) {
    return NextResponse.json({ error: "lead not found" }, { status: 404 });
  }

  const occurredAt = new Date().toISOString();
  const { data: event, error: insertErr } = await supabase
    .from("lead_conversation_events")
    .insert({
      workspace_id: lead.workspace_id,
      lead_id: lead.id,
      channel: "phone",
      direction: "outbound",
      occurred_at: occurredAt,
      // sender = the receptionist who clicked. This is what powers the
      // "who called whom" agent overview.
      sender: user.email ?? null,
      recipient: lead.phone ?? null,
      body: "Ringede op",
      source: "dial_click",
      metadata: { logged_by: user.id, via: "tel_click" },
    })
    .select(
      "id, lead_id, channel, direction, occurred_at, sender, recipient, subject, body, source",
    )
    .single();

  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  return NextResponse.json({ event });
}
