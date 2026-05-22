import { NextRequest, NextResponse } from "next/server";
import {
  BIKENOR_N8N_BASE_URL,
  createBikenorAdminClient,
  isBikenorConfigured,
} from "@/utils/supabase/bikenor";

type Action = "approve" | "save" | "discard";

type Body = {
  action: Action;
  body?: string;
  subject?: string | null;
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isBikenorConfigured()) {
    return NextResponse.json(
      { error: "bikenor_not_configured" },
      { status: 503 },
    );
  }
  const { id } = await params;
  const payload = (await req.json()) as Body;
  const supa = createBikenorAdminClient();

  if (payload.action === "save") {
    const { error } = await supa
      .from("outreach_drafts")
      .update({ body: payload.body, subject: payload.subject ?? null })
      .eq("id", id)
      .eq("status", "pending_approval");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (payload.action === "discard") {
    const { error } = await supa
      .from("outreach_drafts")
      .update({ status: "discarded" })
      .eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (payload.action === "approve") {
    // 1. Persist any pending edits.
    const updates: Record<string, unknown> = {
      status: "approved",
      approved_at: new Date().toISOString(),
      approved_by: process.env.BIKENOR_APPROVER_EMAIL ?? "louis@carterco.dk",
    };
    if (typeof payload.body === "string") updates.body = payload.body;
    if (payload.subject !== undefined) updates.subject = payload.subject;

    const { error: upErr } = await supa
      .from("outreach_drafts")
      .update(updates)
      .eq("id", id)
      .eq("status", "pending_approval");
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

    // 2. Fire OUT.9 to do the actual vendor send.
    const sendUrl = `${BIKENOR_N8N_BASE_URL}/webhook/bikenor/out9-send`;
    const sendRes = await fetch(sendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft_id: id }),
    });
    const sendBody = await sendRes.json().catch(() => ({}));
    if (!sendRes.ok || sendBody?.ok === false) {
      return NextResponse.json(
        { error: "out9_send_failed", details: sendBody },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
}
