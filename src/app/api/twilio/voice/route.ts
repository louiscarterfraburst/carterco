// Twilio Voice webhook: fires when someone calls our +45 91 30 92 79 number.
// Policy: never pick up. Let it ring out (a few seconds), hang up, then
// follow up with an SMS asking who they are. The SMS reply is what places
// them in the pipeline.

import { NextResponse } from "next/server";
import {
  verifyTwilioSignature,
  parseFormParams,
  findSubmissionByCaller,
  insertResponse,
  getWebhookUrl,
  sendTwilioSMS,
} from "../_helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Danish challenge SMS sent after every unknown inbound call.
const CHALLENGE_SMS = "Hej, hvem er det? (har fået ny telefon)";

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

  // Only challenge unknown callers — if we already matched them to a
  // submission via phone, sending the "who is it" SMS would be weird.
  // Silent on send failure (e.g. landline that can't receive SMS).
  if (from && !sub) {
    try {
      await sendTwilioSMS(from, CHALLENGE_SMS);
    } catch (e) {
      console.error("[twilio/voice] SMS challenge send failed:", e);
    }
  }

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
