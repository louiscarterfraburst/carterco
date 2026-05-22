// Twilio SMS webhook: fires when someone texts our +45 91 30 92 79 number.

import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { clampToBusinessHours } from "@/utils/businessHours";
import {
  verifyTwilioSignature,
  parseFormParams,
  findSubmissionByCaller,
  insertResponse,
  getWebhookUrl,
} from "../_helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LeadMatch = {
  id: string;
  name: string | null;
  company: string | null;
  phone: string | null;
  notes: string | null;
  workspace_id: string | null;
};

type PendingForward = {
  id: string;
  message_body: string;
  created_at: string;
};

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 8) return `45${digits}`;
  if (digits.startsWith("00") && digits.length > 8) return digits.slice(2);
  if (digits.length >= 10) return digits;
  return null;
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

function relayPhones() {
  return (process.env.SMS_RELAY_PHONES ?? "+4593966390")
    .split(",")
    .map((phone) => normalizePhone(phone.trim()))
    .filter((phone): phone is string => Boolean(phone));
}

function smsNote(from: string, body: string) {
  return [
    "",
    "",
    `[${new Date().toISOString().slice(0, 10)} SMS reply]`,
    `From: ${from}`,
    body,
  ].join("\n");
}

function appendNote(existing: string | null, note: string) {
  const current = existing ?? "";
  if (current.includes(note.trim())) return current;
  return `${current}${note}`;
}

async function findLeadByPhone(normalizedSender: string) {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("leads")
    .select("id, name, company, phone, notes, workspace_id")
    .not("phone", "is", null)
    .order("created_at", { ascending: false })
    .limit(250);
  if (error) throw error;
  return (
    ((data ?? []).find((row) =>
      phoneMatches(row.phone, normalizedSender),
    ) as LeadMatch | undefined) ?? null
  );
}

async function handleRelayForward(params: Record<string, string>) {
  const from = (params["From"] || "").trim();
  const body = (params["Body"] || "").trim();
  const messageSid = params["MessageSid"] || "";
  const fromNormalized = normalizePhone(from);

  if (!fromNormalized || !relayPhones().includes(fromNormalized)) {
    return false;
  }

  const supabase = createAdminClient();
  const pendingCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: pending } = await supabase
    .from("sms_forwarded_messages")
    .select("id, message_body, created_at")
    .eq("relay_phone", from)
    .eq("status", "pending_sender")
    .gte("created_at", pendingCutoff)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!pending) {
    await supabase.from("sms_forwarded_messages").insert({
      relay_phone: from,
      message_body: body,
      status: "pending_sender",
      twilio_body_sid: messageSid || null,
    });
    return true;
  }

  const pendingForward = pending as PendingForward;
  const pendingAsPhone = normalizePhone(pendingForward.message_body);
  const incomingAsPhone = normalizePhone(body);
  const shortcutSentSenderFirst = Boolean(pendingAsPhone && !incomingAsPhone);
  const senderRaw = shortcutSentSenderFirst ? pendingForward.message_body : body;
  const messageBody = shortcutSentSenderFirst ? body : pendingForward.message_body;
  const normalizedSender = normalizePhone(senderRaw);
  const lead = normalizedSender ? await findLeadByPhone(normalizedSender) : null;
  const status = lead ? "matched" : "unmatched";

  await supabase
    .from("sms_forwarded_messages")
    .update({
      updated_at: new Date().toISOString(),
      message_body: messageBody,
      sender_raw: senderRaw,
      sender_phone: normalizedSender ? `+${normalizedSender}` : null,
      lead_id: lead?.id ?? null,
      status,
      twilio_sender_sid: messageSid || null,
    })
    .eq("id", pendingForward.id);

  if (lead && normalizedSender) {
    const followUpAt = clampToBusinessHours(
      new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    );
    const note = smsNote(`+${normalizedSender}`, messageBody);
    await supabase
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
    await supabase
      .from("lead_conversation_events")
      .insert({
        workspace_id: lead.workspace_id,
        lead_id: lead.id,
        channel: "sms",
        direction: "inbound",
        occurred_at: new Date().toISOString(),
        sender: `+${normalizedSender}`,
        recipient: process.env.TWILIO_NUMBER ?? null,
        body: messageBody,
        source: "twilio_relay",
        source_id: params["MessageSid"] || null,
        metadata: {
          relay_phone: params["From"] || null,
          forwarded_message_id: pendingForward.id,
        },
      });
  }

  return true;
}

export async function POST(req: Request) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    return new NextResponse("TWILIO_AUTH_TOKEN not configured", { status: 500 });
  }

  const params = await parseFormParams(req);
  const signature = req.headers.get("x-twilio-signature") || "";
  const url = getWebhookUrl(req, "/api/twilio/sms");

  if (!verifyTwilioSignature(url, params, signature, authToken)) {
    return new NextResponse("invalid signature", { status: 403 });
  }

  const from = (params["From"] || "").trim();
  const body = params["Body"] || "";
  const messageSid = params["MessageSid"] || "";

  const handledRelayForward = await handleRelayForward(params);

  const sub = from ? await findSubmissionByCaller(from) : null;

  await insertResponse({
    submission_id: sub?.id ?? null,
    channel: "sms",
    from_address: from || null,
    from_name: null,
    subject: null,
    body_excerpt: body.slice(0, 2000),
    message_id: `twilio-sms-${messageSid}`,
    matched_via: sub ? "phone" : null,
    match_confidence: sub ? 0.95 : null,
  });

  if (handledRelayForward) {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response/>`;
    return new NextResponse(twiml, {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  }

  // Empty TwiML response = don't auto-reply.
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response/>`;
  return new NextResponse(twiml, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
