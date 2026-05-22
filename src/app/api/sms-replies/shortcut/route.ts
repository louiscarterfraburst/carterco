import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { clampToBusinessHours } from "@/utils/businessHours";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ShortcutPayload = Record<string, unknown>;

type LeadMatch = {
  id: string;
  name: string | null;
  company: string | null;
  phone: string | null;
  notes: string | null;
  workspace_id: string | null;
};

function asString(value: unknown): string | null {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

function firstString(payload: ShortcutPayload, keys: string[]) {
  for (const key of keys) {
    const value = asString(payload[key]);
    if (value) return value;
  }
  return null;
}

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 8) return `45${digits}`;
  if (digits.startsWith("00") && digits.length > 8) return digits.slice(2);
  if (digits.length >= 10) return digits;
  return null;
}

function phoneVariants(normalized: string) {
  const variants = new Set<string>([normalized]);
  if (normalized.startsWith("45") && normalized.length === 10) {
    variants.add(normalized.slice(2));
    variants.add(`+${normalized}`);
    variants.add(`+45${normalized.slice(2)}`);
  } else {
    variants.add(`+${normalized}`);
  }
  return [...variants];
}

function compactPhone(raw: string | null) {
  return raw ? raw.replace(/\D/g, "") : "";
}

function phoneMatches(leadPhone: string | null, normalized: string) {
  const compact = compactPhone(leadPhone);
  if (!compact) return false;
  const local = normalized.startsWith("45") ? normalized.slice(2) : normalized;
  return (
    compact === normalized ||
    compact === local ||
    compact.endsWith(normalized) ||
    compact.endsWith(local)
  );
}

function smsNote(receivedAt: Date, from: string, body: string) {
  return [
    "",
    "",
    `[${receivedAt.toISOString().slice(0, 10)} SMS reply]`,
    `From: ${from}`,
    body,
  ].join("\n");
}

function appendNote(existing: string | null, note: string) {
  const current = existing ?? "";
  if (current.includes(note.trim())) return current;
  return `${current}${note}`;
}

export async function POST(req: Request) {
  const expectedToken = process.env.SMS_SHORTCUT_WEBHOOK_TOKEN;
  const providedToken =
    req.headers.get("x-shortcut-token") ??
    new URL(req.url).searchParams.get("token");
  if (expectedToken && providedToken !== expectedToken) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: ShortcutPayload;
  try {
    payload = (await req.json()) as ShortcutPayload;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const from =
    firstString(payload, ["from", "sender", "phone", "number", "contact"]) ??
    "";
  const body =
    firstString(payload, ["body", "message", "text", "content", "Message"]) ??
    "";
  const receivedRaw =
    firstString(payload, ["received_at", "date", "timestamp", "time"]) ?? "";
  const receivedAt = receivedRaw ? new Date(receivedRaw) : new Date();
  const safeReceivedAt = Number.isNaN(receivedAt.getTime())
    ? new Date()
    : receivedAt;

  if (!from) return NextResponse.json({ error: "from required" }, { status: 400 });
  if (!body) return NextResponse.json({ error: "body required" }, { status: 400 });

  const normalized = normalizePhone(from);
  if (!normalized) {
    return NextResponse.json({ error: "phone format invalid" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: leads, error } = await supabase
    .from("leads")
    .select("id, name, company, phone, notes, workspace_id")
    .not("phone", "is", null)
    .order("created_at", { ascending: false })
    .limit(250);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const lead =
    ((leads ?? []).find((row) => phoneMatches(row.phone, normalized)) ??
      null) as LeadMatch | null;
  if (!lead) {
    return NextResponse.json({
      ok: true,
      matched: false,
      normalized_phone: normalized,
    });
  }

  const note = smsNote(safeReceivedAt, from, body);
  const followUpAt = clampToBusinessHours(
    new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  );
  const { error: updateError } = await supabase
    .from("leads")
    .update({
      notes: appendNote(lead.notes, note),
      outcome: "follow_up",
      outcome_at: new Date().toISOString(),
      next_action_at: followUpAt,
      next_action_type: "retry",
      retry_count: 0,
      last_action_fired_at: null,
    })
    .eq("id", lead.id);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  await supabase
    .from("lead_conversation_events")
    .insert({
      workspace_id: lead.workspace_id,
      lead_id: lead.id,
      channel: "sms",
      direction: "inbound",
      occurred_at: safeReceivedAt.toISOString(),
      sender: from,
      recipient: "iphone-shortcut",
      body,
      source: "iphone_shortcut",
      source_id: `${normalized}:${safeReceivedAt.toISOString()}:${body.slice(0, 80)}`,
      metadata: payload,
    });

  return NextResponse.json({
    ok: true,
    matched: true,
    lead_id: lead.id,
    company: lead.company,
    name: lead.name,
    next_action_at: followUpAt,
  });
}
