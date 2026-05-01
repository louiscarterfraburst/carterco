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

  // Casual "I'm in a meeting" greeting + record what they say, so we capture
  // who's calling and why. Audio URL + auto-transcription land via the
  // recording-status and transcribe callbacks on the same domain.
  //
  // Pacing notes: short pause between sentences ("...") makes Polly read
  // less robotically. Polly.Mads is Twilio's Danish male voice.
  // Gatekeeper persona: a virtual assistant / answering service for Louis,
  // not Louis himself. Naturally elicits "who's calling + why".
  const recCallback = `https://${req.headers.get("host")}/api/twilio/voice-recording`;
  const transcribeCallback = `https://${req.headers.get("host")}/api/twilio/voice-transcript`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  <Say voice="Polly.Naja" language="da-DK">Hej, du har ringet til Louis.</Say>
  <Pause length="1"/>
  <Say voice="Polly.Naja" language="da-DK">Vil du venligst sige dit navn og hvad opkaldet drejer sig om, så ser jeg om Louis er ledig — ellers ringer han tilbage.</Say>
  <Record
    maxLength="60"
    timeout="3"
    finishOnKey="#"
    playBeep="true"
    transcribe="true"
    transcribeCallback="${transcribeCallback}"
    recordingStatusCallback="${recCallback}"
    recordingStatusCallbackMethod="POST"/>
  <Say voice="Polly.Naja" language="da-DK">Tak. Jeg giver Louis besked.</Say>
  <Hangup/>
</Response>`;

  return new NextResponse(twiml, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
