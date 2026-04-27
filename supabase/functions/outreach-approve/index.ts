// Approval endpoint called from the /outreach UI. Authenticated user
// (louis@carterco.dk or rm@tresyv.dk) approves or rejects a pending message.
// On approve → POST /v1/inbox/send → status='sent'. On reject → status='rejected'.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ALLOWED = new Set(["louis@carterco.dk", "rm@tresyv.dk", "haugefrom@haugefrom.com"]);
const SP_API_KEY = Deno.env.get("SENDPILOT_API_KEY") ?? "";

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

  let body: { leadId?: string; decision?: string; messageOverride?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const leadId = (body.leadId ?? "").trim();
  const decision = (body.decision ?? "").toLowerCase();
  if (!leadId || (decision !== "approve" && decision !== "reject")) {
    return json({ error: "leadId and decision (approve|reject) required" }, 400);
  }

  // Fetch the pipeline row.
  const { data: pipe, error: fetchErr } = await admin
    .from("outreach_pipeline")
    .select("sendpilot_lead_id, status, rendered_message, video_link")
    .eq("sendpilot_lead_id", leadId)
    .maybeSingle();
  if (fetchErr) return json({ error: "db fetch", details: fetchErr.message }, 500);
  if (!pipe) return json({ error: "lead not found" }, 404);
  if (pipe.status !== "pending_approval") {
    return json({ error: `lead is in status '${pipe.status}', not pending_approval` }, 409);
  }

  const now = new Date().toISOString();

  if (decision === "reject") {
    await admin.from("outreach_pipeline").update({
      status: "rejected",
      decided_at: now,
      decided_by: email,
    }).eq("sendpilot_lead_id", leadId);
    return json({ ok: true, decision: "rejected" });
  }

  // Approve → POST /inbox/send.
  const message = (body.messageOverride && body.messageOverride.trim())
    ? body.messageOverride.trim()
    : pipe.rendered_message;
  if (!message) return json({ error: "no message to send" }, 400);

  const send = await fetch("https://api.sendpilot.ai/v1/inbox/send", {
    method: "POST",
    headers: { "X-API-Key": SP_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ leadId, message }),
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

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
