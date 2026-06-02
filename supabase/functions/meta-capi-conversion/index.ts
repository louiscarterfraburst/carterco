// meta-capi-conversion
//
// Sends Meta Conversion-Leads CRM events via the Conversions API when a deal in
// public.deals changes stage, so Meta can optimize lead-ad delivery toward leads
// that progress down the funnel (and their kroner value). Fired by the
// deal_meta_capi trigger (net.http_post), same pattern as deal_attio_sync.
//
// Conforms to Meta's CRM integration spec (dataset 2174079616765417 "Carter & Co"):
//   action_source            = "system_generated"   (required)
//   custom_data.event_source = "crm"                 (required)
//   custom_data.lead_event_source = <CRM name>       (required)
//   event_name               = the CRM stage the lead changed to
//   user_data                = hashed em/fn/ln (+ lead_id when we have it)
//
// Stage -> event_name (sent verbatim so they map 1:1 to the funnel + show in the
// ad-set "Conversion event" dropdown):
//   in_progress    -> "in_progress"
//   meeting_booked -> "meeting_booked"
//   won            -> "won"  (+ custom_data.value / currency)
//
// Match: hashed person_email (+ first/last name). Meta attributes to whoever
// clicked the lead ad with that email; non-Meta deals don't match and are
// ignored. lead_id (user_data) is the best match for lead ads — included when a
// deal carries one (future: lead->deal linkage). Dedup via event_id.
//
// Required env:
//   META_CAPI_ACCESS_TOKEN     — Conversions API token for the dataset (EAA...)
//   META_CAPI_DATASET_ID       — defaults to 2174079616765417
//   META_CAPI_LEAD_SOURCE      — CRM name for lead_event_source (default "CarterCo")
//   META_GRAPH_VERSION         — defaults to v25.0
//   META_CAPI_TEST_EVENT_CODE  — optional; routes to Events Manager -> Test Events
//
// Deployed --no-verify-jwt (called by a Postgres trigger via pg_net; no JWT).
// No-ops gracefully until META_CAPI_ACCESS_TOKEN is set.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ACCESS_TOKEN = Deno.env.get("META_CAPI_ACCESS_TOKEN") ?? "";
const DATASET_ID = Deno.env.get("META_CAPI_DATASET_ID") ?? "2174079616765417";
const LEAD_SOURCE = Deno.env.get("META_CAPI_LEAD_SOURCE") ?? "CarterCo";
const GRAPH_VERSION = Deno.env.get("META_GRAPH_VERSION") ?? "v25.0";
const TEST_EVENT_CODE = Deno.env.get("META_CAPI_TEST_EVENT_CODE") ?? "";

// Stages we report. event_name is sent verbatim. Only `won` carries value.
const STAGES = new Set(["in_progress", "meeting_booked", "won"]);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let payload: { type?: string; record?: Record<string, unknown> };
  try { payload = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const rec = payload.record ?? {};
  const stage = String(rec.stage ?? "");
  if (!STAGES.has(stage)) return json({ ok: true, skipped: `unmapped stage: ${stage || "(none)"}` });

  const email = String(rec.person_email ?? "").trim().toLowerCase();
  const leadIdRaw = rec.meta_lead_id ?? rec.lead_id ?? null;
  if (!email && !leadIdRaw) return json({ ok: true, skipped: "no email or lead_id to match on" });

  // Graceful no-op until the CAPI token is configured.
  if (!ACCESS_TOKEN) {
    console.warn("meta-capi-conversion: META_CAPI_ACCESS_TOKEN not set — not sending", { dealId: rec.id, stage });
    return json({ ok: true, skipped: "no access token configured" });
  }

  const userData: Record<string, unknown> = {};
  if (email) userData.em = [await sha256(email)];
  const { fn, ln } = splitName(String(rec.person_name ?? ""));
  if (fn) userData.fn = [await sha256(fn)];
  if (ln) userData.ln = [await sha256(ln)];
  if (leadIdRaw) {
    const n = Number(leadIdRaw);
    userData.lead_id = Number.isFinite(n) && String(n) === String(leadIdRaw) ? n : String(leadIdRaw);
  }

  const customData: Record<string, unknown> = {
    event_source: "crm",
    lead_event_source: LEAD_SOURCE,
  };
  if (stage === "won") {
    const value = Number(rec.value_amount ?? 0);
    if (value > 0) {
      customData.value = value;
      customData.currency = (String(rec.value_currency ?? "").trim() || "DKK").toUpperCase();
    }
  }

  const event = {
    event_name: stage,
    event_time: Math.floor(Date.now() / 1000),
    action_source: "system_generated",
    event_id: `deal:${rec.id}:${stage}`,
    user_data: userData,
    custom_data: customData,
  };

  const reqBody: Record<string, unknown> = { data: [event] };
  if (TEST_EVENT_CODE) reqBody.test_event_code = TEST_EVENT_CODE;

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${DATASET_ID}/events?access_token=${encodeURIComponent(ACCESS_TOKEN)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reqBody),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("meta-capi-conversion: CAPI send failed", res.status, body);
    return json({ error: "CAPI send failed", status: res.status, body }, 502);
  }
  return json({ ok: true, sent: stage, dealId: rec.id, test: !!TEST_EVENT_CODE, fb: body });
});

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function splitName(full: string): { fn: string; ln: string } {
  const parts = full.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { fn: "", ln: "" };
  if (parts.length === 1) return { fn: parts[0], ln: "" };
  return { fn: parts[0], ln: parts[parts.length - 1] };
}

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
