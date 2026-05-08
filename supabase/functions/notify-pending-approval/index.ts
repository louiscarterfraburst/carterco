// Receives a Supabase Database Webhook on outreach_pipeline INSERT/UPDATE.
// When status transitions into 'pending_pre_render' or 'pending_approval', fan out a web-push to every
// row in push_subscriptions so the approver sees it on their phone instantly.
// Mirrors the notify-new-lead pattern (same VAPID + push_subscriptions table).
import { createClient } from "npm:@supabase/supabase-js@2.103.3";
import webpush from "npm:web-push@3.6.7";

type PipelineRow = {
  sendpilot_lead_id: string;
  linkedin_url: string;
  status: string;
  contact_email: string | null;
  workspace_id: string | null;
};

type WebhookPayload = {
  type?: "INSERT" | "UPDATE" | "DELETE";
  table?: string;
  schema?: string;
  record?: PipelineRow | null;
  old_record?: PipelineRow | null;
};

type PushSubscriptionRow = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

type WebPushError = Error & { statusCode?: number };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-webhook-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const webhookSecret = Deno.env.get("PENDING_WEBHOOK_SECRET");
  if (webhookSecret) {
    const provided = request.headers.get("x-webhook-secret");
    if (provided !== webhookSecret) return json({ error: "Unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const vapidSubject = Deno.env.get("VAPID_SUBJECT") ?? "mailto:louis@carterco.dk";
  const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!supabaseUrl || !serviceRoleKey || !vapidPublicKey || !vapidPrivateKey) {
    return json({ error: "Missing notification environment variables" }, 500);
  }

  const body = (await request.json().catch(() => null)) as WebhookPayload | null;
  if (!body || !body.record) {
    return json({ error: "Missing record" }, 400);
  }

  // Only fire on transitions INTO a human-review status — skip subsequent
  // updates and the noisy non-pending statuses.
  const newStatus = body.record.status;
  const oldStatus = body.old_record?.status ?? null;
  if (newStatus !== "pending_pre_render" && newStatus !== "pending_approval") {
    return json({ ok: true, ignored: `status=${newStatus}` });
  }
  if (body.type === "UPDATE" && oldStatus === newStatus) {
    return json({ ok: true, ignored: "already pending" });
  }

  // Look up lead for a friendlier push title.
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
  const { data: lead } = await supabase
    .from("outreach_leads")
    .select("first_name, last_name, company")
    .eq("contact_email", body.record.contact_email ?? "")
    .maybeSingle();
  const workspaceId = body.record.workspace_id;
  if (!workspaceId) {
    return json({ error: "Missing outreach workspace_id" }, 400);
  }

  const firstName = (lead?.first_name ?? "").trim() || "(?)";
  const company = (lead?.company ?? "").trim();
  const title = newStatus === "pending_pre_render"
    ? `Video-review: ${firstName}`
    : `Outreach venter: ${firstName}`;
  const bodyLine = company ? `${firstName} @ ${company}` : firstName;

  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

  const { data: subscriptions, error } = await supabase
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("workspace_id", workspaceId);
  if (error) return json({ error: error.message }, 500);

  const payload = JSON.stringify({
    title,
    body: bodyLine,
    url: "/outreach",
  });

  const results = await Promise.allSettled(
    (subscriptions ?? []).map((sub: PushSubscriptionRow) =>
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      ),
    ),
  );

  const expiredEndpoints = results
    .map((result, index) => {
      if (result.status === "fulfilled") return null;
      const reason = result.reason as WebPushError;
      if (reason.statusCode === 404 || reason.statusCode === 410) {
        return subscriptions?.[index]?.endpoint ?? null;
      }
      console.error("Push notification failed", reason);
      return null;
    })
    .filter((e): e is string => Boolean(e));

  if (expiredEndpoints.length > 0) {
    await supabase.from("push_subscriptions").delete().in("endpoint", expiredEndpoints);
  }

  return json({
    sent: results.filter((r) => r.status === "fulfilled").length,
    failed: results.filter((r) => r.status === "rejected").length,
    removed: expiredEndpoints.length,
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
