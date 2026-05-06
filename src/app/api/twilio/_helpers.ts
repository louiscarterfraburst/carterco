// Shared helpers for Twilio inbound webhooks.

import crypto from "node:crypto";
import { createAdminClient } from "@/utils/supabase/admin";

/**
 * Verify a Twilio webhook signature.
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string,
  authToken: string,
): boolean {
  // Twilio signs: full URL + params sorted by key, concatenated as key+value
  const sorted = Object.keys(params).sort();
  let data = url;
  for (const k of sorted) {
    data += k + (params[k] ?? "");
  }
  const expected = crypto
    .createHmac("sha1", authToken)
    .update(data)
    .digest("base64");
  // Constant-time compare
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected),
    );
  } catch {
    return false;
  }
}

export async function parseFormParams(req: Request): Promise<Record<string, string>> {
  const text = await req.text();
  const out: Record<string, string> = {};
  for (const pair of text.split("&")) {
    if (!pair) continue;
    const [k, v = ""] = pair.split("=");
    out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, " "));
  }
  return out;
}

/**
 * Look up a test_submission by inbound caller-ID (E.164). Checks two
 * indexes in order:
 *   1. caller_phones — populated when a prior voice/SMS interaction
 *      identified this number's company. Most reliable.
 *   2. test_submissions.phone — the company's listed contact number,
 *      scraped at submission time. Less reliable (some companies share
 *      switchboards) but fine as fallback.
 */
export async function findSubmissionByCaller(
  fromE164: string,
): Promise<{ id: string; company: string | null } | null> {
  if (!fromE164) return null;
  const sb = createAdminClient();

  const { data: known } = await sb
    .from("caller_phones")
    .select("submission_id, test_submissions(id, company)")
    .eq("phone", fromE164)
    .order("inserted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (known?.test_submissions) {
    const t = known.test_submissions as unknown as { id: string; company: string | null };
    return { id: t.id, company: t.company };
  }

  const { data } = await sb
    .from("test_submissions")
    .select("id, company")
    .eq("phone", fromE164)
    .order("submitted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

export async function insertResponse(row: {
  submission_id: string | null;
  channel: "phone" | "sms";
  from_address: string | null;
  from_name: string | null;
  subject: string | null;
  body_excerpt: string | null;
  message_id: string;
  matched_via: "phone" | null;
  match_confidence: number | null;
}) {
  const sb = createAdminClient();
  await sb.from("test_responses").insert({
    submission_id: row.submission_id,
    channel: row.channel,
    received_at: new Date().toISOString(),
    from_address: row.from_address,
    from_name: row.from_name,
    subject: row.subject,
    body_excerpt: row.body_excerpt,
    message_id: row.message_id,
    matched_via: row.matched_via,
    match_confidence: row.match_confidence,
  });
}

/**
 * Build the public webhook URL we registered with Twilio. Used for
 * signature validation. Twilio computes the signature against the URL
 * THEY hit, including any query string we registered.
 */
export function getWebhookUrl(req: Request, defaultPath: string): string {
  // Twilio is hitting the public URL. Use the host + protocol from the
  // forwarded headers (Vercel sets x-forwarded-proto + host).
  const fwdProto = req.headers.get("x-forwarded-proto") || "https";
  const host =
    req.headers.get("x-forwarded-host") ||
    req.headers.get("host") ||
    "";
  return `${fwdProto}://${host}${defaultPath}`;
}

/**
 * Send an outbound SMS via Twilio. Returns the Twilio message SID on success.
 * Throws on failure.
 */
export async function sendTwilioSMS(to: string, body: string): Promise<string> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_NUMBER;
  if (!sid || !tok || !from) {
    throw new Error("TWILIO_ACCOUNT_SID/AUTH_TOKEN/NUMBER not configured");
  }
  const auth = Buffer.from(`${sid}:${tok}`).toString("base64");
  const form = new URLSearchParams({ From: from, To: to, Body: body });
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    },
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Twilio SMS send failed: ${res.status} ${errText.slice(0, 300)}`);
  }
  const json = (await res.json()) as { sid: string };
  return json.sid;
}
