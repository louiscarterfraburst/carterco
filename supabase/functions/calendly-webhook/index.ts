import { createClient } from "npm:@supabase/supabase-js@2.103.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, calendly-webhook-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type InviteePayload = {
  email?: string;
  name?: string | null;
  uri?: string;
  cancel_url?: string;
  reschedule_url?: string;
  scheduled_event?: {
    uri?: string;
    start_time?: string;
    end_time?: string;
    name?: string;
    event_memberships?: { user_email?: string; user_name?: string }[];
  };
  questions_and_answers?: { question: string; answer: string }[];
};

type CalendlyWebhook = {
  event: string;
  payload: InviteePayload;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const rawBody = await request.text();

  const signingKey = Deno.env.get("CALENDLY_WEBHOOK_SIGNING_KEY");
  if (signingKey) {
    const header = request.headers.get("calendly-webhook-signature");
    const ok = await verifyCalendlySignature(header, rawBody, signingKey);
    if (!ok) {
      return json({ error: "Invalid signature" }, 401);
    }
  }

  let body: CalendlyWebhook | null = null;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!body?.event) return json({ error: "Missing event" }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "Missing Supabase env" }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const invitee = body.payload ?? {};
  const email = (invitee.email ?? "").trim().toLowerCase();
  const name = invitee.name ?? null;
  const eventUri = invitee.scheduled_event?.uri ?? null;
  const startAt = invitee.scheduled_event?.start_time ?? null;
  const inviteeUri = invitee.uri ?? null;
  const hostEmail = (invitee.scheduled_event?.event_memberships?.[0]?.user_email ?? "")
    .trim()
    .toLowerCase();

  // Resolve which workspace this booking belongs to.
  // Priority: matched-lead's workspace → host's user_settings.workspace_id →
  // CARTERCO_DEFAULT_WORKSPACE_ID env → CarterCo (owner_email lookup).
  async function resolveDefaultWorkspaceId(): Promise<string | null> {
    if (hostEmail) {
      const { data: hostSettings } = await supabase
        .from("user_settings")
        .select("workspace_id")
        .eq("user_email", hostEmail)
        .maybeSingle();
      if (hostSettings?.workspace_id) return hostSettings.workspace_id;
    }
    const envFallback = Deno.env.get("CARTERCO_DEFAULT_WORKSPACE_ID");
    if (envFallback) return envFallback;
    const { data: ws } = await supabase
      .from("workspaces")
      .select("id")
      .eq("owner_email", "louis@carterco.dk")
      .maybeSingle();
    return ws?.id ?? null;
  }

  if (body.event === "invitee.created") {
    if (!email) return json({ error: "Invitee missing email" }, 400);

    // Find a matching real lead (not a draft) by email
    const { data: existing, error: selectErr } = await supabase
      .from("leads")
      .select("id, workspace_id")
      .eq("is_draft", false)
      .ilike("email", email)
      .limit(1);
    if (selectErr) return json({ error: selectErr.message }, 500);

    const nowIso = new Date().toISOString();

    if (existing && existing.length > 0) {
      // Preserve the lead's existing workspace (already set by /outreach,
      // /leads, or an earlier insert). Only set if NULL (legacy rows).
      const updatePayload: Record<string, unknown> = {
        outcome: "booked",
        outcome_at: nowIso,
        meeting_at: startAt,
        calendly_event_uri: eventUri,
        calendly_invitee_uri: inviteeUri,
        // Booking supersedes any pending retry / interested nudge.
        next_action_at: null,
        next_action_type: null,
        callback_at: null,
        retry_count: 0,
        last_action_fired_at: null,
      };
      if (!existing[0].workspace_id) {
        updatePayload.workspace_id = await resolveDefaultWorkspaceId();
      }
      const { error: updateErr } = await supabase
        .from("leads")
        .update(updatePayload)
        .eq("id", existing[0].id);
      if (updateErr) return json({ error: updateErr.message }, 500);
    } else {
      // No matching real lead — create one so the booking appears in /leads
      const workspaceId = await resolveDefaultWorkspaceId();
      const { error: insertErr } = await supabase.from("leads").insert({
        name,
        email,
        source: "calendly",
        is_draft: false,
        outcome: "booked",
        outcome_at: nowIso,
        meeting_at: startAt,
        calendly_event_uri: eventUri,
        calendly_invitee_uri: inviteeUri,
        workspace_id: workspaceId,
      });
      if (insertErr) return json({ error: insertErr.message }, 500);
    }

    // Clean up any drafts for this email — they've submitted for real now
    await supabase
      .from("leads")
      .delete()
      .eq("is_draft", true)
      .ilike("email", email);

    return json({ ok: true, handled: "invitee.created" });
  }

  if (body.event === "invitee.canceled") {
    if (!eventUri) return json({ error: "Missing event uri" }, 400);

    const { error: cancelErr } = await supabase
      .from("leads")
      .update({
        outcome: null,
        outcome_at: null,
        meeting_at: null,
        calendly_event_uri: null,
      })
      .eq("calendly_event_uri", eventUri);
    if (cancelErr) return json({ error: cancelErr.message }, 500);

    return json({ ok: true, handled: "invitee.canceled" });
  }

  return json({ ok: true, ignored: body.event });
});

async function verifyCalendlySignature(
  header: string | null,
  rawBody: string,
  signingKey: string,
): Promise<boolean> {
  if (!header) return false;
  // Header format: "t=<unix-seconds>,v1=<hex-hmac>"
  const parts = Object.fromEntries(
    header.split(",").map((p) => p.split("=") as [string, string]),
  );
  const timestamp = parts["t"];
  const signature = parts["v1"];
  if (!timestamp || !signature) return false;

  // Reject timestamps older than 3 minutes (replay protection)
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > 180) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(`${timestamp}.${rawBody}`),
  );
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}
