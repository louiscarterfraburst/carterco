// Twilio fires this when the <Record> verb finishes. We update the
// existing test_responses row (matched via the parent CallSid) with the
// recording URL + duration.

import { NextResponse } from "next/server";
import {
  verifyTwilioSignature,
  parseFormParams,
  getWebhookUrl,
  sendTwilioSMS,
} from "../_helpers";
import { createAdminClient } from "@/utils/supabase/admin";

const MIN_REC_SECS_FOR_KEEP = 3;
const FOLLOWUP_SMS_BODY = "Hej, hvem er det?";

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
  const { data: row, error } = await sb
    .from("test_responses")
    .update({
      recording_url: recordingUrl || null,
      recording_sid: recordingSid || null,
      recording_secs: duration,
    })
    .eq("message_id", `twilio-call-${callSid}`)
    .select("from_address")
    .maybeSingle();

  if (error) {
    console.error("voice-recording update failed:", error.message);
  }

  // If they hung up before saying anything (or barely said anything),
  // follow up with an SMS asking who they are. We dedupe on caller +
  // recent SMS so we don't pester repeat callers.
  const callerNumber = row?.from_address || null;
  const recordingTooShort = (duration || 0) < MIN_REC_SECS_FOR_KEEP;
  if (callerNumber && recordingTooShort) {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recent } = await sb
      .from("test_responses")
      .select("id")
      .eq("from_address", callerNumber)
      .eq("channel", "sms")
      .gte("received_at", oneHourAgo)
      .limit(1);
    const alreadyMessaged = (recent || []).length > 0;
    if (!alreadyMessaged) {
      try {
        await sendTwilioSMS(callerNumber, FOLLOWUP_SMS_BODY);
      } catch (e) {
        console.error("hangup follow-up SMS failed:", e);
      }
    }
  }

  // Twilio expects 200 OK; no TwiML needed for status callbacks
  return new NextResponse("", { status: 200 });
}
