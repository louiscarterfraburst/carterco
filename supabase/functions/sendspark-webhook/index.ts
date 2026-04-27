// Receives SendSpark webhooks. The one we care about is `video_generated_dv`,
// fired when a personalised video has rendered. We:
//   1. Match the contactEmail back to an outreach_pipeline row in 'rendering'.
//   2. Store the videoLink + format the Danish message.
//   3. If the lead was cold (we saw connection.sent first), auto-send the
//      message via SendPilot /v1/inbox/send → status='sent'.
//   4. Otherwise (already-connected) → status='pending_approval' for the UI.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type SendSparkVideoReady = {
  eventType: string;
  campaignId?: string;
  campaignName?: string;
  contactEmail?: string;
  contactInfo?: { contactFirstName?: string; company?: string; jobTitle?: string };
  videoLink?: string;
  embedLink?: string;
  thumbnailUrl?: string;
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

const SP_API_KEY = Deno.env.get("SENDPILOT_API_KEY") ?? "";

const DEFAULT_TEMPLATE = [
  "Hej {firstName},",
  "",
  "Tak for accept! Jeg lavede en kort video til dig:",
  "",
  "{videoLink}",
  "",
  "Sig endelig til hvis det giver mening for jer hos {company}.",
  "",
  "/Louis",
].join("\n");

const MESSAGE_TEMPLATE = Deno.env.get("OUTREACH_MESSAGE_TEMPLATE") || DEFAULT_TEMPLATE;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const rawBody = await request.text();
  let evt: SendSparkVideoReady;
  try {
    evt = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  if (evt.eventType !== "video_generated_dv") {
    // Could be heartbeat / engagement events — ack and move on.
    return json({ ok: true, ignored: evt.eventType ?? "unknown" });
  }

  const email = (evt.contactEmail ?? "").toLowerCase();
  const videoLink = evt.videoLink ?? "";
  if (!email || !videoLink) {
    return json({ error: "missing contactEmail or videoLink" }, 400);
  }

  // Idempotency by videoLink (unique per render).
  const eventId = `sendspark:${videoLink}`;
  const { error: evtErr } = await supabase.from("outreach_events").insert({
    event_id: eventId,
    source: "sendspark",
    event_type: evt.eventType,
    payload: evt,
  });
  if (evtErr && !`${evtErr.message}`.includes("duplicate key")) {
    console.error("event insert error", evtErr);
    return json({ error: "DB error", details: evtErr.message }, 500);
  }
  if (evtErr) return json({ ok: true, duplicate: true });

  // Find the pipeline row by contact_email.
  const { data: pipe } = await supabase
    .from("outreach_pipeline")
    .select("sendpilot_lead_id, contact_email, is_cold, status")
    .eq("contact_email", email)
    .maybeSingle();

  if (!pipe) {
    console.warn("video_generated_dv with no matching pipeline row", { email, videoLink });
    return json({ ok: true, recorded: "render_no_pipeline" });
  }

  if (pipe.status === "sent" || pipe.status === "rejected") {
    // Already terminal — ignore (re-render after-the-fact).
    return json({ ok: true, recorded: "render_after_terminal" });
  }

  // Look up lead for personalisation.
  const { data: lead } = await supabase
    .from("outreach_leads")
    .select("first_name, last_name, company, website")
    .eq("contact_email", email)
    .maybeSingle();

  const firstName = (lead?.first_name ?? "").trim() || "there";
  const company = (lead?.company ?? "").trim();
  const message = MESSAGE_TEMPLATE
    .replaceAll("{firstName}", firstName)
    .replaceAll("{company}", company)
    .replaceAll("{videoLink}", videoLink);

  const now = new Date().toISOString();

  // If cold → auto-send via SendPilot /v1/inbox/send.
  if (pipe.is_cold === true) {
    const result = await sendpilotInboxSend(pipe.sendpilot_lead_id, message);
    const success = result.status === 200 || result.status === 201;

    await supabase.from("outreach_pipeline").update({
      video_link: videoLink,
      embed_link: evt.embedLink ?? null,
      thumbnail_url: evt.thumbnailUrl ?? null,
      rendered_message: message,
      sendpilot_response: result.body,
      rendered_at: now,
      sent_at: success ? now : null,
      status: success ? "sent" : "failed",
      error: success ? null : `inbox/send HTTP ${result.status}`,
    }).eq("sendpilot_lead_id", pipe.sendpilot_lead_id);

    return json({ ok: success, branch: "cold_autosend", status: result.status });
  }

  // Already-connected → queue for approval.
  await supabase.from("outreach_pipeline").update({
    video_link: videoLink,
    embed_link: evt.embedLink ?? null,
    thumbnail_url: evt.thumbnailUrl ?? null,
    rendered_message: message,
    rendered_at: now,
    queued_at: now,
    status: "pending_approval",
  }).eq("sendpilot_lead_id", pipe.sendpilot_lead_id);

  return json({ ok: true, branch: "already_connected_queued" });
});

async function sendpilotInboxSend(leadId: string, message: string) {
  const res = await fetch("https://api.sendpilot.ai/v1/inbox/send", {
    method: "POST",
    headers: { "X-API-Key": SP_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ leadId, message }),
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body };
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
