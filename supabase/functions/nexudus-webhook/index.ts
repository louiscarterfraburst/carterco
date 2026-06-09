// nexudus-webhook
//
// Receives Nexudus booking webhooks for Soho and closes the loop: when a lead
// books a room, auto-mark the matching lead as booked (no receptionist action)
// + set meeting_at — the conversion + attribution signal (docs/soho-leadflow.md
// §11). Booking cancel/delete reopens the lead. Mirrors meta-leadgen-webhook:
// service-role client, HMAC verify, and it ALWAYS returns 200 on a no-op so
// Nexudus never auto-disables the hook (it disables after 10 consecutive fails).
//
// Nexudus setup (Settings -> Integrations -> Webhooks):
//   URL:    https://znpaevzwlcfuzqxsbyie.supabase.co/functions/v1/nexudus-webhook
//   Events: Booking Create (6), Booking Update (7), Booking Delete (8)
//   Secret: shared secret -> NEXUDUS_WEBHOOK_SECRET
//           (HMAC-SHA256 over the raw body, header X-Nexudus-Hook-Signature)
//
// Required env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   NEXUDUS_WEBHOOK_SECRET   — optional; when set, signatures are verified
//   SOHO_WORKSPACE_ID        — defaults to the Soho rooms workspace
//
// NOTE: the exact Nexudus payload shape (field casing, event wrapper) is
// confirmed against the first real event via the raw-body log below, then the
// extractors are tightened. Until then this parses defensively and no-ops
// safely on anything it can't map. The booking -> CAPI fire is a follow-up
// (the Soho CAPI sender) — this function only sets the outcome.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SECRET = Deno.env.get("NEXUDUS_WEBHOOK_SECRET") ?? "";
const SOHO_WORKSPACE_ID =
  Deno.env.get("SOHO_WORKSPACE_ID") ?? "7f13f551-9514-4a5a-b1bf-98eb95c1a469";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false } },
);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method === "GET") return json({ ok: true, name: "nexudus-webhook" });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const rawBody = await request.text();

  // Signature — optional until we've exchanged the secret with Nexudus.
  if (SECRET) {
    const header =
      request.headers.get("x-nexudus-hook-signature") ??
      request.headers.get("x-nexudus-signature") ??
      "";
    if (!(await verifyHmac(header, rawBody, SECRET))) {
      return json({ error: "Invalid signature" }, 401);
    }
  } else {
    console.warn("nexudus-webhook: NEXUDUS_WEBHOOK_SECRET not set — skipping signature verification");
  }

  // Log the raw shape so the first real bookings confirm field mapping.
  console.log("nexudus-webhook raw:", rawBody.slice(0, 2000));

  let body: unknown;
  try { body = JSON.parse(rawBody); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  // Nexudus may send a single object, a batch array, or a { Records: [...] }
  // wrapper. Normalize to a flat list of event objects.
  const events = toEventList(body);

  const results: Array<Record<string, unknown>> = [];
  for (const ev of events) {
    try { results.push(await handleEvent(ev)); }
    catch (e) {
      console.error("nexudus handler error", e instanceof Error ? e.message : String(e));
      results.push({ status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }
  return json({ ok: true, results });
});

// ── event handling ──────────────────────────────────────────────────────────

async function handleEvent(ev: Record<string, unknown>): Promise<Record<string, unknown>> {
  // The booking record may be the event itself or nested under Record/Data/Entity.
  const rec = (pick(ev, "Record", "record", "Data", "data", "Entity", "entity") as
    Record<string, unknown> | undefined) ?? ev;

  const bookingId = str(pick(rec, "Id", "id", "BookingId", "UniqueId"));
  const fromTime = str(pick(rec, "FromTime", "fromTime", "FromTimeUtc", "fromTimeUtc"));
  const resource = str(pick(rec, "ResourceName", "resourceName", "ResourceId", "resourceId"));

  // Cancel/delete signal: numeric event 8, an IsCancelled flag, or a delete key.
  const eventCode = Number(pick(ev, "Event", "EventType", "Type", "event", "type"));
  const isCancelled =
    pick(rec, "IsCancelled", "isCancelled", "Cancelled", "cancelled") === true ||
    eventCode === 8 ||
    pick(ev, "Deleted", "deleted") === true;

  // Booker email: nested Coworker, or a flat field.
  const coworker = pick(rec, "Coworker", "coworker") as Record<string, unknown> | undefined;
  const email = (
    str(coworker && pick(coworker, "Email", "email")) ??
    str(pick(rec, "CoworkerEmail", "coworkerEmail", "Email", "email"))
  )?.toLowerCase() ?? null;

  if (!email) {
    // Existing member or a booking with no resolvable email — ignore (per §11).
    return { status: "skipped:no-email", bookingId };
  }

  // Match to a Soho lead by email (first-class key). Most recent non-draft row.
  const { data: lead, error } = await supabase
    .from("leads")
    .select("id, outcome")
    .eq("workspace_id", SOHO_WORKSPACE_ID)
    .eq("is_draft", false)
    .eq("email", email)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`lead lookup: ${error.message}`);
  if (!lead?.id) return { status: "unmatched", email, bookingId };

  if (isCancelled) {
    // Reopen — booking gone. Drop the terminal outcome + clear the meeting.
    const { error: upErr } = await supabase
      .from("leads")
      .update({ outcome: null, outcome_at: null, meeting_at: null })
      .eq("id", lead.id);
    if (upErr) throw new Error(`reopen: ${upErr.message}`);
    return { status: "reopened", lead_id: lead.id, email, bookingId };
  }

  // Booked — mark it (idempotent: re-setting the same values is harmless).
  const update: Record<string, unknown> = {
    outcome: "booked", // TODO: -> 'booket' once §8 Soho outcome model lands
    outcome_at: new Date().toISOString(),
  };
  if (fromTime) update.meeting_at = fromTime;

  const { error: upErr } = await supabase.from("leads").update(update).eq("id", lead.id);
  if (upErr) throw new Error(`mark booked: ${upErr.message}`);
  return { status: "booked", lead_id: lead.id, email, room: resource, meeting_at: fromTime, bookingId };
}

// ── helpers ───────────────────────────────────────────────────────────────-

function toEventList(body: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(body)) return body as Array<Record<string, unknown>>;
  if (body && typeof body === "object") {
    const wrapped = (body as Record<string, unknown>).Records ??
      (body as Record<string, unknown>).records;
    if (Array.isArray(wrapped)) return wrapped as Array<Record<string, unknown>>;
    return [body as Record<string, unknown>];
  }
  return [];
}

// First non-null value across the given keys (and their case-insensitive match).
function pick(obj: unknown, ...keys: string[]): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  }
  const lowerKeys = keys.map((k) => k.toLowerCase());
  for (const [k, v] of Object.entries(o)) {
    if (lowerKeys.includes(k.toLowerCase()) && v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

// Nexudus signs the raw body with HMAC-SHA256 + shared secret. The header
// encoding isn't documented consistently, so accept hex or base64, with or
// without a "sha256=" prefix.
async function verifyHmac(header: string, rawBody: string, secret: string): Promise<boolean> {
  if (!header) return false;
  const provided = header.replace(/^sha256=/i, "").trim();
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const bytes = new Uint8Array(mac);
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  const b64 = btoa(String.fromCharCode(...bytes));
  return timingSafeEqual(provided, hex) || timingSafeEqual(provided, b64);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
