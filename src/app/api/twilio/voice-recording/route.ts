// Twilio fires this when the <Record> verb finishes. We update the
// existing test_responses row (matched via the parent CallSid) with the
// recording URL + duration.

import { NextResponse } from "next/server";
import {
  verifyTwilioSignature,
  parseFormParams,
  getWebhookUrl,
} from "../_helpers";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    return new NextResponse("TWILIO_AUTH_TOKEN not configured", { status: 500 });
  }

  const params = await parseFormParams(req);
  const signature = req.headers.get("x-twilio-signature") || "";
  const url = getWebhookUrl(req, "/api/twilio/voice-recording");
  if (!verifyTwilioSignature(url, params, signature, authToken)) {
    return new NextResponse("invalid signature", { status: 403 });
  }

  const callSid = params["CallSid"] || "";
  const recordingUrl = params["RecordingUrl"] || "";
  const recordingSid = params["RecordingSid"] || "";
  const duration = parseInt(params["RecordingDuration"] || "0", 10) || null;

  if (!callSid) {
    return new NextResponse("", { status: 200 });
  }

  // Find the test_responses row inserted by the /voice route on this call
  const sb = createAdminClient();
  const { error } = await sb
    .from("test_responses")
    .update({
      recording_url: recordingUrl || null,
      recording_sid: recordingSid || null,
      recording_secs: duration,
    })
    .eq("message_id", `twilio-call-${callSid}`);

  if (error) {
    console.error("voice-recording update failed:", error.message);
  }

  // Twilio expects 200 OK; no TwiML needed for status callbacks
  return new NextResponse("", { status: 200 });
}
