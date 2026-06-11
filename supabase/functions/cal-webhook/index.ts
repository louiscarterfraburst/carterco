// cal-webhook
//
// Receives cal.com webhooks (BOOKING_CREATED / CANCELLED / RESCHEDULED) and
// mirrors the booking into public.leads so it shows in /leads and /meetings.
// Direct port of calendly-webhook, adapted for cal.com's payload + signature.
//
// The cal.com booking `uid` is stored in the existing `calendly_event_uri`
// column (repurposed — no schema change), which /meetings already reads and
// which has a unique index for idempotency.
//
// Required env:
//   CAL_WEBHOOK_SECRET            — webhook signing secret (set the SAME value
//                                   on the cal.com webhook). HMAC-SHA256 of the
//                                   raw body, sent as X-Cal-Signature-256.
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   CARTERCO_DEFAULT_WORKSPACE_ID — optional workspace fallback
//
// Deployed --no-verify-jwt (cal.com sends no Supabase JWT).

import { createClient } from "npm:@supabase/supabase-js@2.103.3";
import { extractScopingId, formatFlexNote } from "../_shared/flex-scoping.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cal-signature-256",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type CalAttendee = { email?: string; name?: string | null; timeZone?: string };
type CalPayload = {
  uid?: string;
  bookingId?: number;
  title?: string;
  startTime?: string;
  endTime?: string;
  attendees?: CalAttendee[];
  organizer?: { email?: string; name?: string };
};
type CalWebhook = { triggerEvent?: string; payload?: CalPayload };

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method === "GET") return json({ ok: true, name: "cal-webhook" });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const rawBody = await request.text();

  const secret = Deno.env.get("CAL_WEBHOOK_SECRET");
  if (secret) {
    const header = request.headers.get("x-cal-signature-256");
    const ok = await verifyCalSignature(header, rawBody, secret);
    if (!ok) return json({ error: "Invalid signature" }, 401);
  }

  let body: CalWebhook | null = null;
  try { body = JSON.parse(rawBody); }
  catch { return json({ error: "Invalid JSON" }, 400); }
  const trigger = body?.triggerEvent;
  if (!trigger) return json({ error: "Missing triggerEvent" }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Missing Supabase env" }, 500);
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const p = body?.payload ?? {};
  const attendee = (p.attendees ?? [])[0] ?? {};
  const email = (attendee.email ?? "").trim().toLowerCase();
  const name = attendee.name ?? null;
  const startAt = p.startTime ?? null;
  const uid = p.uid ?? (p.bookingId != null ? String(p.bookingId) : null);
  const hostEmail = (p.organizer?.email ?? "").trim().toLowerCase();

  async function resolveDefaultWorkspaceId(): Promise<string | null> {
    if (hostEmail) {
      const { data: hostSettings } = await supabase
        .from("user_settings").select("workspace_id").eq("user_email", hostEmail).maybeSingle();
      if (hostSettings?.workspace_id) return hostSettings.workspace_id;
    }
    const envFallback = Deno.env.get("CARTERCO_DEFAULT_WORKSPACE_ID");
    if (envFallback) return envFallback;
    const { data: ws } = await supabase
      .from("workspaces").select("id").eq("owner_email", "louis@carterco.dk").maybeSingle();
    return ws?.id ?? null;
  }

  if (trigger === "BOOKING_CREATED" || trigger === "BOOKING_RESCHEDULED") {
    if (!email) return json({ error: "Booking missing attendee email" }, 400);
    const nowIso = new Date().toISOString();

    let leadId: string | null = null;
    const { data: existing, error: selectErr } = await supabase
      .from("leads").select("id, workspace_id, notes").eq("is_draft", false).ilike("email", email).limit(1);
    if (selectErr) return json({ error: selectErr.message }, 500);

    if (existing && existing.length > 0) {
      const updatePayload: Record<string, unknown> = {
        outcome: "booked",
        outcome_at: nowIso,
        meeting_at: startAt,
        calendly_event_uri: uid,
        next_action_at: null,
        next_action_type: null,
        callback_at: null,
        retry_count: 0,
        last_action_fired_at: null,
      };
      if (!existing[0].workspace_id) updatePayload.workspace_id = await resolveDefaultWorkspaceId();
      const { error: updateErr } = await supabase.from("leads").update(updatePayload).eq("id", existing[0].id);
      if (updateErr) return json({ error: updateErr.message }, 500);
      leadId = existing[0].id;
    } else {
      const workspaceId = await resolveDefaultWorkspaceId();
      const { data: inserted, error: insertErr } = await supabase.from("leads").insert({
        name, email, source: "calcom", is_draft: false,
        outcome: "booked", outcome_at: nowIso, meeting_at: startAt,
        calendly_event_uri: uid, workspace_id: workspaceId,
      }).select("id").single();
      if (insertErr) return json({ error: insertErr.message }, 500);
      leadId = inserted?.id ?? null;
    }

    // Lead Flex join (persist-then-book): the scoping modal saved the
    // visitor's answers before the redirect and put a `scoping:<id>` token
    // in the booking notes. Join soft-fails by design — the lead is already
    // created above; on any failure the answers still live in
    // scoping_submissions and the token in the calendar booking.
    try {
      const scopingId = extractScopingId(rawBody);
      if (scopingId && leadId) {
        const { data: scoping } = await supabase
          .from("scoping_submissions")
          .select("id, icp, tried")
          .eq("id", scopingId)
          .maybeSingle();
        if (scoping) {
          const note = formatFlexNote(scoping.icp, scoping.tried ?? []);
          const existingNotes = existing && existing.length > 0 ? existing[0].notes : null;
          const merged = [existingNotes, note].filter(Boolean).join("\n---\n");
          const { error: noteErr } = await supabase
            .from("leads").update({ notes: merged }).eq("id", leadId);
          if (noteErr) console.warn("cal-webhook: flex note update failed", { scopingId, leadId, error: noteErr.message });
          const { error: joinErr } = await supabase
            .from("scoping_submissions")
            .update({ lead_id: leadId, booking_uid: uid })
            .eq("id", scopingId);
          if (joinErr) console.warn("cal-webhook: scoping join failed", { scopingId, leadId, error: joinErr.message });
        } else {
          console.warn("cal-webhook: scoping token had no matching row", { scopingId, uid });
        }
      }
    } catch (e) {
      console.warn("cal-webhook: flex join threw", { uid, error: e instanceof Error ? e.message : String(e) });
    }

    await supabase.from("leads").delete().eq("is_draft", true).ilike("email", email);
    return json({ ok: true, handled: trigger });
  }

  if (trigger === "BOOKING_CANCELLED") {
    if (!uid) return json({ error: "Missing booking uid" }, 400);
    const { error: cancelErr } = await supabase
      .from("leads")
      .update({ outcome: null, outcome_at: null, meeting_at: null, calendly_event_uri: null })
      .eq("calendly_event_uri", uid);
    if (cancelErr) return json({ error: cancelErr.message }, 500);
    return json({ ok: true, handled: "BOOKING_CANCELLED" });
  }

  return json({ ok: true, ignored: trigger });
});

async function verifyCalSignature(header: string | null, rawBody: string, secret: string): Promise<boolean> {
  if (!header) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const expected = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(expected, header.trim().toLowerCase());
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
