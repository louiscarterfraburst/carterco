// Approval endpoint called from the /outreach UI. Authenticated user
// (louis@carterco.dk or rm@tresyv.dk) acts on a pipeline lead:
//   approve → POST /v1/inbox/send → status='sent'
//   reject  → status='rejected'
//   render  → POST /v1/dynamics/.../prospect → kicks a fresh SendSpark render
//             for any accepted lead (used by the Accepteret tab to recover
//             leads that never got a video).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";
import { normalizeCompanyName, urlOrigin } from "../_shared/text.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ALLOWED = new Set(["louis@carterco.dk", "rm@tresyv.dk", "haugefrom@haugefrom.com"]);
const SP_API_KEY = Deno.env.get("SENDPILOT_API_KEY") ?? "";
const SS_API_KEY = Deno.env.get("SENDSPARK_API_KEY") ?? "";
const SS_API_SECRET = Deno.env.get("SENDSPARK_API_SECRET") ?? "";
const SS_WORKSPACE = Deno.env.get("SENDSPARK_WORKSPACE") ?? "";
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

  let body: { leadId?: string; decision?: string; messageOverride?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const leadId = (body.leadId ?? "").trim();
  const decision = (body.decision ?? "").toLowerCase();
  if (!leadId || !["approve", "reject", "render"].includes(decision)) {
    return json({ error: "leadId and decision (approve|reject|render) required" }, 400);
  }

  // Fetch the pipeline row.
  const { data: pipe, error: fetchErr } = await admin
    .from("outreach_pipeline")
    .select("sendpilot_lead_id, contact_email, linkedin_url, status, rendered_message, video_link, accepted_at, workspace_id")
    .eq("sendpilot_lead_id", leadId)
    .maybeSingle();
  if (fetchErr) return json({ error: "db fetch", details: fetchErr.message }, 500);
  if (!pipe) return json({ error: "lead not found" }, 404);

  const now = new Date().toISOString();

  if (decision === "render") {
    if (!pipe.contact_email) return json({ error: "lead has no contact_email" }, 400);
    const { data: lead } = await admin
      .from("outreach_leads")
      .select("first_name, last_name, company, title, website, contact_email")
      .eq("contact_email", pipe.contact_email)
      .maybeSingle();
    if (!lead) return json({ error: "outreach_leads row missing for this contact_email" }, 404);

    const renderRes = await sendsparkRender(lead);
    await admin.from("outreach_pipeline").update({
      status: renderRes.ok ? "rendering" : "failed",
      accepted_at: pipe.accepted_at ?? now,
      decided_at: now,
      decided_by: email,
      error: renderRes.ok ? null : `manual render: HTTP ${renderRes.status} — ${renderRes.errorBody}`,
    }).eq("sendpilot_lead_id", leadId);
    return json({ ok: renderRes.ok, decision: "render", status: renderRes.status });
  }

  if (pipe.status !== "pending_approval") {
    return json({ error: `lead is in status '${pipe.status}', not pending_approval` }, 409);
  }

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

async function sendsparkRender(lead: Record<string, unknown>) {
  const payload = {
    processAndAuthorizeCharge: true,
    prospect: {
      contactName: ((lead.first_name as string) ?? "").trim() || "there",
      contactEmail: lead.contact_email as string,
      company: normalizeCompanyName(lead.company as string).slice(0, 80),
      jobTitle: ((lead.title as string) ?? "").slice(0, 100),
      backgroundUrl: urlOrigin(lead.website as string),
    },
  };
  const url =
    `https://api-gw.sendspark.com/v1/workspaces/${SS_WORKSPACE}/dynamics/${SS_DYNAMIC}/prospect`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": SS_API_KEY,
      "x-api-secret": SS_API_SECRET,
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
