// attio-webhook-deal
//
// Inbound from Attio: receives webhook events when a Deal is updated in
// Attio's UI (you drag a card to a new stage, change the value, etc.) and
// mirrors the change back to public.deals.
//
// Loop prevention: when we write to deals from this function, we set
// last_synced_from_attio_at = now(). The outgoing trigger (deal_attio_sync)
// checks this and skips updates that came from Attio within a 10-second
// window. See supabase/deals.sql.
//
// Setup (one-time, in Attio UI):
//   Settings -> Developers -> Webhooks -> Create webhook
//     URL:    https://znpaevzwlcfuzqxsbyie.supabase.co/functions/v1/attio-webhook-deal
//     Events: record.updated, record.created (object = deals)
//     Secret: <copy into supabase secret ATTIO_WEBHOOK_SECRET>
//
// Only deals whose supabase_pipeline_id starts with "manual:" are mirrored
// here; cold-outbound deals (sync-pipeline-id like "cmowxgnk...") are
// one-way (Supabase -> Attio) and any Attio-side edits on them are ignored.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";
import { createHmac } from "node:crypto";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ATTIO_API_KEY = Deno.env.get("ATTIO_API_KEY") ?? "";
const ATTIO_WEBHOOK_SECRET = Deno.env.get("ATTIO_WEBHOOK_SECRET") ?? "";
const ATTIO_BASE = "https://api.attio.com/v2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

// Reverse of STAGE_ID in attio-sync-deal
const STAGE_FROM_ID: Record<string, string> = {
  "894b6b8d-8eac-4af3-b878-dd662a4022a1": "lead",
  "4cf8dee9-dcb3-4c67-8005-a6a7c7a0ba51": "in_progress",
  "3fc5dde1-2f5e-49d1-a21e-c5acaa85f7df": "meeting_booked",
  "3c4ddbb4-c954-4d6f-a74e-8a9ec94da936": "won",
  "7a4f6484-cb28-4bc2-b256-af577d68ee5e": "lost",
  // SENT_AWAITING from cold outbound — don't map to deals
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method === "GET") return json({ ok: true, name: "attio-webhook-deal" });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Fail closed: refuse if the webhook secret isn't configured. Anyone could
  // otherwise POST to this URL and mutate deal records.
  if (!ATTIO_WEBHOOK_SECRET) {
    return json({ error: "ATTIO_WEBHOOK_SECRET not configured" }, 500);
  }

  const rawBody = await request.text();
  const sig = request.headers.get("x-attio-signature") ?? "";
  const expected = createHmac("sha256", ATTIO_WEBHOOK_SECRET).update(rawBody).digest("hex");
  if (sig !== expected) {
    return json({ error: "invalid signature" }, 401);
  }

  let payload: WebhookPayload;
  try { payload = JSON.parse(rawBody); }
  catch { return json({ error: "invalid json" }, 400); }

  // Attio webhook payload: { events: [{ event_type, id: { record_id, object_id, ... } }] }
  const events = payload.events ?? [];
  const results: { event: string; ok: boolean; reason?: string }[] = [];

  for (const ev of events) {
    const recordId = ev.id?.record_id;
    if (!recordId) {
      results.push({ event: ev.event_type, ok: false, reason: "missing record_id" });
      continue;
    }
    if (ev.event_type === "record.updated" || ev.event_type === "record.created") {
      const r = await mirrorDealToRow(recordId);
      results.push({ event: ev.event_type, ok: r.ok, reason: r.reason });
    } else if (ev.event_type === "record.deleted" || ev.event_type === "record.merged") {
      // Attio's merge event fires on the source (deleted) side with the
      // destination linked in the payload; we treat both identically — drop
      // the row whose attio_record_id matches.
      const r = await deleteRowByAttioId(recordId);
      results.push({ event: ev.event_type, ok: r.ok, reason: r.reason });
    } else {
      results.push({ event: ev.event_type, ok: true, reason: "ignored event type" });
    }
  }

  return json({ ok: true, events: results });
});

async function deleteRowByAttioId(attioRecordId: string): Promise<{ ok: boolean; reason?: string }> {
  // Look up the deal row by Attio record_id. If found and it's a manual deal,
  // delete the row. Cold-outbound deals (no row in public.deals) are no-ops.
  const { data, error } = await supabase
    .from("deals")
    .select("slug")
    .eq("attio_record_id", attioRecordId)
    .maybeSingle();
  if (error) return { ok: false, reason: `db lookup: ${error.message}` };
  if (!data) return { ok: true, reason: "no matching deal row — likely cold outbound" };

  const { error: delErr } = await supabase
    .from("deals")
    .delete()
    .eq("attio_record_id", attioRecordId);
  if (delErr) return { ok: false, reason: `db delete: ${delErr.message}` };
  return { ok: true, reason: `deleted slug=${data.slug}` };
}

async function mirrorDealToRow(dealRecordId: string): Promise<{ ok: boolean; reason?: string }> {
  const dealRes = await fetch(`${ATTIO_BASE}/objects/deals/records/${dealRecordId}`, {
    headers: { Authorization: `Bearer ${ATTIO_API_KEY}` },
  });
  if (!dealRes.ok) return { ok: false, reason: `attio fetch ${dealRes.status}` };
  const dealData = await dealRes.json();
  const v = dealData?.data?.values ?? {};

  const spid: string = v.supabase_pipeline_id?.[0]?.value ?? "";
  if (!spid.startsWith("manual:")) {
    return { ok: true, reason: "not a manual deal — skipped" };
  }
  const slug = spid.slice("manual:".length);

  const stageId: string = v.stage?.[0]?.status?.id?.status_id ?? "";
  const newStage = STAGE_FROM_ID[stageId];
  if (!newStage) return { ok: false, reason: `unknown stage ${stageId}` };

  const valueAmount: number | null = v.value?.[0]?.currency_value ?? null;
  const dealName: string = v.name?.[0]?.value ?? "";

  const { error } = await supabase
    .from("deals")
    .update({
      stage: newStage,
      value_amount: valueAmount,
      deal_name: dealName || null,
      last_synced_from_attio_at: new Date().toISOString(),
    })
    .eq("slug", slug);

  if (error) return { ok: false, reason: `db update: ${error.message}` };
  return { ok: true, reason: `mirrored slug=${slug} stage=${newStage}` };
}

type WebhookPayload = {
  events?: { event_type: string; id?: { record_id?: string } }[];
};

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
