// Approval endpoint called from the /outreach UI. Authenticated user
// (louis@carterco.dk or rm@tresyv.dk) acts on a pipeline lead:
//   approve → POST /v1/inbox/send → status='sent'
//   reject  → status='rejected'
//   render  → POST /v1/dynamics/.../prospect → kicks a SendSpark render
//             for any accepted/pre-render/failed lead.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";
import { firstNameForGreeting, normalizeCompanyName, urlOrigin } from "../_shared/text.ts";
import { checkLeadReplied } from "../_shared/sendpilot-client.ts";
import { sendsparkCredsFor } from "../_shared/sendspark-config.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ALLOWED = new Set(["louis@carterco.dk", "rm@tresyv.dk", "haugefrom@haugefrom.com"]);
const SP_API_KEY = Deno.env.get("SENDPILOT_API_KEY") ?? "";
const SS_DYNAMIC = Deno.env.get("SENDSPARK_DYNAMIC") ?? "";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Auth: rely on Supabase verify_jwt (it auto-validates Authorization Bearer
  // <jwt>) and read the user from the token.
  const authHeader = request.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "missing bearer" }, 401);

  const userClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "",
    { global: { headers: { Authorization: `Bearer ${token}` } } },
  );
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return json({ error: "invalid auth" }, 401);
  const email = (user.email ?? "").toLowerCase();
  if (!ALLOWED.has(email)) return json({ error: "forbidden" }, 403);

  // Service-role client for mutations.
  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  let body: { leadId?: string; replyId?: string; decision?: string; messageOverride?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const decision = (body.decision ?? "").toLowerCase();
  if (!["approve", "reject", "render", "reply"].includes(decision)) {
    return json({ error: "decision must be one of: approve | reject | render | reply" }, 400);
  }

  // Reply path uses replyId (the inbound row we're responding to). Look up
  // the reply, then resolve the pipeline row from its sendpilot_lead_id.
  // Approve/reject/render use leadId directly.
  let leadId = (body.leadId ?? "").trim();
  let replyRow: { id: string; sendpilot_lead_id: string; suggested_reply: string | null; handled: boolean } | null = null;
  if (decision === "reply") {
    const replyId = (body.replyId ?? "").trim();
    if (!replyId) return json({ error: "replyId required for decision=reply" }, 400);
    const { data: r, error: rErr } = await admin
      .from("outreach_replies")
      .select("id, sendpilot_lead_id, suggested_reply, handled, direction")
      .eq("id", replyId)
      .maybeSingle();
    if (rErr) return json({ error: "db fetch reply", details: rErr.message }, 500);
    if (!r) return json({ error: "reply not found" }, 404);
    if (r.direction !== "inbound") return json({ error: "can only reply to inbound messages" }, 400);
    leadId = r.sendpilot_lead_id;
    replyRow = r as typeof replyRow;
  } else if (!leadId) {
    return json({ error: "leadId required" }, 400);
  }

  // Fetch the pipeline row.
  const { data: pipe, error: fetchErr } = await admin
    .from("outreach_pipeline")
    .select("sendpilot_lead_id, contact_email, linkedin_url, status, rendered_message, video_link, accepted_at, workspace_id, sendpilot_sender_id, campaign_id")
    .eq("sendpilot_lead_id", leadId)
    .maybeSingle();
  if (fetchErr) return json({ error: "db fetch", details: fetchErr.message }, 500);
  if (!pipe) return json({ error: "lead not found" }, 404);

  const now = new Date().toISOString();

  if (decision === "reply") {
    if (!pipe.sendpilot_sender_id) {
      return json({ error: "lead has no sendpilot_sender_id" }, 400);
    }
    if (!pipe.linkedin_url) {
      return json({ error: "lead has no linkedin_url" }, 400);
    }
    const message = (body.messageOverride && body.messageOverride.trim())
      ? body.messageOverride.trim()
      : (replyRow?.suggested_reply ?? "").trim();
    if (!message) return json({ error: "no message to send (empty messageOverride and no suggested_reply)" }, 400);

    const send = await fetch("https://api.sendpilot.ai/v1/inbox/send", {
      method: "POST",
      headers: { "X-API-Key": SP_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        senderId: pipe.sendpilot_sender_id,
        recipientLinkedinUrl: pipe.linkedin_url,
        message,
      }),
    });
    let respBody: unknown = null;
    try { respBody = await send.json(); } catch { /* ignore */ }
    const success = send.status === 200 || send.status === 201;

    if (success) {
      // Insert the outbound row immediately so UI updates without waiting
      // for the next sync tick. external_id stays null; sync will patch it
      // in within ~15min when SendPilot's conversation API exposes the id.
      await admin.from("outreach_replies").insert({
        sendpilot_lead_id: leadId,
        linkedin_url: pipe.linkedin_url,
        message,
        workspace_id: pipe.workspace_id,
        direction: "outbound",
        external_id: null,
        received_at: now,
      });
      // Mark the inbound we're answering as handled.
      if (replyRow) {
        await admin.from("outreach_replies").update({
          handled: true,
          handled_at: now,
          handled_by: email,
        }).eq("id", replyRow.id);
      }
    }

    return json({
      ok: success,
      decision: "reply",
      status: send.status,
      response: respBody,
    }, success ? 200 : 502);
  }

  if (decision === "render") {
    if (!pipe.contact_email) return json({ error: "lead has no contact_email" }, 400);
    const { data: lead } = await admin
      .from("outreach_leads")
      .select("first_name, last_name, company, title, website, contact_email")
      .eq("contact_email", pipe.contact_email)
      .maybeSingle();
    if (!lead) return json({ error: "outreach_leads row missing for this contact_email" }, 404);

    const renderRes = await sendsparkRender(lead, pipe.campaign_id ?? "", pipe.workspace_id ?? null);
    await admin.from("outreach_pipeline").update({
      status: renderRes.ok ? "rendering" : "failed",
      accepted_at: pipe.accepted_at ?? now,
      decided_at: now,
      decided_by: email,
      error: renderRes.ok ? null : `manual render: HTTP ${renderRes.status} — ${renderRes.errorBody}`,
    }).eq("sendpilot_lead_id", leadId);
    return json({ ok: renderRes.ok, decision: "render", status: renderRes.status });
  }

  if (decision === "reject") {
    if (pipe.status === "sent") {
      return json({ error: "lead is already sent" }, 409);
    }
    await admin.from("outreach_pipeline").update({
      status: "rejected",
      decided_at: now,
      decided_by: email,
    }).eq("sendpilot_lead_id", leadId);
    return json({ ok: true, decision: "rejected" });
  }

  if (pipe.status !== "pending_approval") {
    return json({ error: `lead is in status '${pipe.status}', not pending_approval` }, 409);
  }

  // Approve → POST /inbox/send.
  // SendPilot's API requires senderId + recipientLinkedinUrl + message
  // (NOT leadId + message — that returned HTTP 400 "Validation failed").
  // senderId is captured from the connection.accepted webhook payload and
  // stored on the pipeline row; recipientLinkedinUrl is the prospect's URL.
  const message = (body.messageOverride && body.messageOverride.trim())
    ? body.messageOverride.trim()
    : pipe.rendered_message;
  if (!message) return json({ error: "no message to send" }, 400);
  if (!pipe.sendpilot_sender_id) {
    return json({ error: "lead has no sendpilot_sender_id (cannot send via /v1/inbox/send)" }, 400);
  }
  if (!pipe.linkedin_url) {
    return json({ error: "lead has no linkedin_url" }, 400);
  }

  // LIVE SAFETY CHECK: ask SendPilot directly whether this lead has replied
  // before sending. Stateless — doesn't depend on webhooks arriving, our DB
  // being current, or async classification succeeding. Fail-safe: if we
  // can't verify, we treat as replied and abort the send (better to miss a
  // follow-up than to fire on someone who already responded).
  // We pass recipientName because SendPilot returns LinkedIn's id-encoded
  // URL form, not the vanity URL we stored, so URL matching alone always
  // fails — name match is the practical way to find the conversation.
  const { data: leadForName } = await admin
    .from("outreach_leads")
    .select("first_name, last_name, full_name")
    .eq("contact_email", pipe.contact_email ?? "")
    .maybeSingle();
  const fullName = (leadForName?.full_name as string | undefined)?.trim()
    || [leadForName?.first_name, leadForName?.last_name].filter(Boolean).join(" ").trim()
    || undefined;
  const replyCheck = await checkLeadReplied({
    apiKey: SP_API_KEY,
    senderAccountId: pipe.sendpilot_sender_id,
    recipientLinkedinUrl: pipe.linkedin_url,
    recipientName: fullName,
  });
  if (replyCheck.replied) {
    const lastReplyAt = "lastReplyAt" in replyCheck ? replyCheck.lastReplyAt : now;
    const reason = "reason" in replyCheck ? replyCheck.reason : "live API confirmed prior reply";
    await admin.from("outreach_pipeline").update({
      status: "rejected",
      decided_at: now,
      decided_by: email,
      last_reply_at: lastReplyAt,
      error: `approve aborted: ${replyCheck.source} — ${reason}`,
    }).eq("sendpilot_lead_id", leadId);
    return json({
      ok: false,
      decision: "blocked_by_live_reply_check",
      source: replyCheck.source,
      reason,
      last_reply_at: lastReplyAt,
    }, 409);
  }

  const send = await fetch("https://api.sendpilot.ai/v1/inbox/send", {
    method: "POST",
    headers: { "X-API-Key": SP_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      senderId: pipe.sendpilot_sender_id,
      recipientLinkedinUrl: pipe.linkedin_url,
      message,
    }),
  });
  let respBody: unknown = null;
  try { respBody = await send.json(); } catch { /* ignore */ }
  const success = send.status === 200 || send.status === 201;

  await admin.from("outreach_pipeline").update({
    status: success ? "sent" : "failed",
    sent_at: success ? now : null,
    decided_at: now,
    decided_by: email,
    sendpilot_response: respBody,
    error: success ? null : `inbox/send HTTP ${send.status}`,
    rendered_message: message,
  }).eq("sendpilot_lead_id", leadId);

  return json({ ok: success, decision: "sent", status: send.status, response: respBody });
});

// Per-campaign SendSpark dynamic override. Mirrors sendpilot-webhook and
// sendpilot-poll so manual pre-render approval uses the correct dynamic.
function pickDynamic(campaignId: string): string {
  const id = (campaignId ?? "").trim();
  if (id) {
    const perCampaign = Deno.env.get(`SS_DYNAMIC_${id}`);
    if (perCampaign) return perCampaign;
  }
  return SS_DYNAMIC;
}

async function sendsparkRender(lead: Record<string, unknown>, campaignId = "", workspaceId: string | null = null) {
  const creds = sendsparkCredsFor(workspaceId);
  if (creds.source === "missing") {
    return { ok: false, status: 0, errorBody: `no SendSpark creds for workspace ${workspaceId ?? "(null)"}` };
  }
  const payload = {
    processAndAuthorizeCharge: true,
    prospect: {
      contactName: firstNameForGreeting(lead.first_name as string) || "there",
      contactEmail: lead.contact_email as string,
      company: normalizeCompanyName(lead.company as string).slice(0, 80),
      jobTitle: ((lead.title as string) ?? "").slice(0, 100),
      backgroundUrl: urlOrigin(lead.website as string),
    },
  };
  const dynamicId = pickDynamic(campaignId);
  const url =
    `https://api-gw.sendspark.com/v1/workspaces/${creds.workspace}/dynamics/${dynamicId}/prospect`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": creds.apiKey,
      "x-api-secret": creds.apiSecret,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (res.ok) return { ok: true, status: res.status, errorBody: "" };
  const errorBody = await res.text().catch(() => "");
  return { ok: false, status: res.status, errorBody: errorBody.slice(0, 400) };
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
