// Twilio Voice webhook: fires when someone calls our +45 91 30 92 79 number.
// Policy: never pick up. Ring out a few seconds, hang up. Inbound call is
// logged to test_responses so it shows up in the dashboard.
//
// As of 2026-05-22 (Phase 1 SMS rebuild) we no longer auto-fire a "hvem er
// det?" SMS to unknown callers — that was reckless (any wrong number got
// texted). Follow-up SMS, if any, is now operator-triggered from /leads.

import { NextResponse } from "next/server";
import {
  verifyTwilioSignature,
  parseFormParams,
  findSubmissionByCaller,
  insertResponse,
  getWebhookUrl,
} from "../_helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    return new NextResponse("TWILIO_AUTH_TOKEN not configured", { status: 500 });
  }

  const params = await parseFormParams(req);
  const signature = req.headers.get("x-twilio-signature") || "";
  const url = getWebhookUrl(req, "/api/twilio/voice");

  if (!verifyTwilioSignature(url, params, signature, authToken)) {
    return new NextResponse("invalid signature", { status: 403 });
  }

  const from = (params["From"] || "").trim();
  const to = (params["To"] || "").trim();
  const callSid = params["CallSid"] || "";

  const sub = from ? await findSubmissionByCaller(from) : null;

  await insertResponse({
    submission_id: sub?.id ?? null,
    channel: "phone",
    from_address: from || null,
    from_name: null,
    subject: `Inbound call to ${to}`,
    body_excerpt: `CallSid=${callSid} CallerId=${from}`,
    message_id: `twilio-call-${callSid}`,
    matched_via: sub ? "phone" : null,
    match_confidence: sub ? 0.95 : null,
  });

  // Don't pick up. Pause ~6s so it rings a few times then drops naturally
  // ("missed call, in a meeting"), then hang up. No greeting, no recording.
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="6"/>
  <Hangup/>
</Response>`;

  return new NextResponse(twiml, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
