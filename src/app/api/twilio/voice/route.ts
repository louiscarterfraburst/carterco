// Twilio Voice webhook: fires when someone calls our +45 91 30 92 79 number.
// We log the call into test_responses and send a short voicemail prompt.

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

  // Friendly TwiML response: brief greeting then hang up.
  // (We don't want to actually take a voicemail; the call event itself
  //  is the signal we care about — we know they tried to reach us, fast.)
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Mads" language="da-DK">Hej. Du har ringet til en testlinje. Tak.</Say>
  <Hangup/>
</Response>`;

  return new NextResponse(twiml, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
