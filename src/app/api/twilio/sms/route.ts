// Twilio SMS webhook: fires when someone texts our +45 91 30 92 79 number.

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
  const url = getWebhookUrl(req, "/api/twilio/sms");

  if (!verifyTwilioSignature(url, params, signature, authToken)) {
    return new NextResponse("invalid signature", { status: 403 });
  }

  const from = (params["From"] || "").trim();
  const body = params["Body"] || "";
  const messageSid = params["MessageSid"] || "";

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

  // Empty TwiML response = don't auto-reply.
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response/>`;
  return new NextResponse(twiml, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
