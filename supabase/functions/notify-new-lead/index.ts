import { createClient } from "npm:@supabase/supabase-js@2.103.3";
import webpush from "npm:web-push@3.6.7";

type Lead = {
  id?: string;
  name?: string | null;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  monthly_leads?: string | null;
  response_time?: string | null;
  source?: string | null;
};

function sourceLabelFor(source: string | null | undefined) {
  switch (source) {
    case "calendly":
      return "Booket møde";
    default:
      return "Nyt lead";
  }
}

type PushSubscriptionRow = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

type WebPushError = Error & {
  statusCode?: number;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-webhook-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const webhookSecret = Deno.env.get("LEAD_WEBHOOK_SECRET");
  if (webhookSecret) {
    const providedSecret = request.headers.get("x-webhook-secret");
    if (providedSecret !== webhookSecret) {
      return json({ error: "Unauthorized" }, 401);
    }
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const vapidSubject = Deno.env.get("VAPID_SUBJECT") ?? "mailto:louis@carterco.dk";
  const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");

  if (!supabaseUrl || !serviceRoleKey || !vapidPublicKey || !vapidPrivateKey) {
    return json({ error: "Missing notification environment variables" }, 500);
  }

  const body = await request.json().catch(() => null);
  const lead = (body?.record ?? body) as Lead | null;
  const actionType = body?.action_type as
    | "retry"
    | "callback"
    | "follow_up"
    | undefined;

  // Need at least one identifiable field. Drafts and empty rows get skipped.
  if (!lead || (!lead.name && !lead.email && !lead.phone)) {
    return json({ error: "Missing lead payload" }, 400);
  }

  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
    },
  });

  const { data: subscriptions, error } = await supabase
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth");

  if (error) {
    return json({ error: error.message }, 500);
  }

  const displayName = lead.name ?? lead.email ?? lead.phone ?? "lead";
  let title: string;
  if (actionType === "retry") {
    title = `Prøv igen: ${displayName}`;
  } else if (actionType === "callback") {
    title = `Ring tilbage nu: ${displayName}`;
  } else if (actionType === "follow_up") {
    title = `Follow-up: ${displayName}`;
  } else {
    title = `${sourceLabelFor(lead.source)}: ${displayName}`;
  }
  const bodyLine = [lead.company, lead.phone ?? lead.email]
    .filter(Boolean)
    .join(" — ");
  const payload = JSON.stringify({
    title,
    body: bodyLine || "Åbn CarterCo for at se leadet.",
    phone: lead.phone ?? "",
    url: "/leads",
  });

  const results = await Promise.allSettled(
    (subscriptions ?? []).map((subscription: PushSubscriptionRow) =>
      webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: subscription.p256dh,
            auth: subscription.auth,
          },
        },
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
    .filter((endpoint): endpoint is string => Boolean(endpoint));

  if (expiredEndpoints.length > 0) {
    await supabase
      .from("push_subscriptions")
      .delete()
      .in("endpoint", expiredEndpoints);
  }

  return json({
    sent: results.filter((result) => result.status === "fulfilled").length,
    failed: results.filter((result) => result.status === "rejected").length,
    removed: expiredEndpoints.length,
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}
