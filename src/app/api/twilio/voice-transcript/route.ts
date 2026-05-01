// Twilio fires this when transcription of a recorded call completes.
// We append the text to the matching test_responses row.

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
  const url = getWebhookUrl(req, "/api/twilio/voice-transcript");
  if (!verifyTwilioSignature(url, params, signature, authToken)) {
    return new NextResponse("invalid signature", { status: 403 });
  }

  const callSid = params["CallSid"] || "";
  const text = params["TranscriptionText"] || "";
  const status = params["TranscriptionStatus"] || "";

  if (!callSid) {
    return new NextResponse("", { status: 200 });
  }

  const sb = createAdminClient();
  const { error } = await sb
    .from("test_responses")
    .update({
      transcript: status === "completed" ? text : `(${status})`,
      // Also stuff the transcript into body_excerpt so the existing UI shows it
      body_excerpt: status === "completed"
        ? `[Voice] ${text.slice(0, 1900)}`
        : `[Voice — transcription ${status}]`,
    })
    .eq("message_id", `twilio-call-${callSid}`);

  if (error) {
    console.error("voice-transcript update failed:", error.message);
  }

  return new NextResponse("", { status: 200 });
}
