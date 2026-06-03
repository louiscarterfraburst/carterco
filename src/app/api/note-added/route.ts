// Operator note on a lead. Called from /leads when a receptionist writes a note.
// Stores an attributed note event (sender = the authenticated user's email) in
// lead_conversation_events so notes are per-person, timestamped, and live in the
// same activity timeline as calls. Realtime broadcasts the insert to every other
// open panel. Mirrors /api/call-clicked and /api/sms-sent.

import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  leadId?: string;
  body?: string;
};

export async function POST(req: Request) {
  let payload: Body;
  try {
    payload = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const leadId = payload.leadId?.trim();
  const noteBody = payload.body?.trim();
  if (!leadId) {
    return NextResponse.json({ error: "leadId required" }, { status: 400 });
  }
  if (!noteBody) {
    return NextResponse.json({ error: "body required" }, { status: 400 });
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
    .select("id, workspace_id")
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
      channel: "note",
      direction: "internal",
      occurred_at: occurredAt,
      sender: user.email ?? null,
      recipient: null,
      body: noteBody,
      source: "note",
      metadata: { logged_by: user.id },
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
