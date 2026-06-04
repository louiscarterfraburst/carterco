// meta-leadgen-relay
//
// Receives Meta Lead Ads leads forwarded via Make (or any HTTP client) and
// inserts them into public.leads. Same pattern as rb2b-webhook — shared secret
// in URL token; idempotent on (source='meta_leadgen', external_id=leadgen_id).
//
// Expected POST body (Make module fields, all optional except leadgen_id):
//   {
//     "leadgen_id": "1234567890",         // Meta lead ID — used for idempotency
//     "form_id": "...",                   // optional
//     "ad_id": "...",                     // optional
//     "campaign_id": "...",               // optional
//     "created_time": "2026-05-25T...",   // optional
//     "full_name" | "name": "...",
//     "email": "...",
//     "phone_number" | "phone": "...",
//     "company_name" | "company": "...",
//     "moeder_per_uge" | "qualifier": "...",
//     "raw": { ... }                       // optional — full Make payload
//   }
//
// Auth: ?token=<META_LEADGEN_RELAY_TOKEN>  OR  X-Meta-Relay-Token header.
//
// Configure in Make:
//   1. Trigger: Facebook Lead Ads — Watch Leads on page 1138136299380303
//   2. Action: HTTP - Make a request
//      URL:    https://<project>.supabase.co/functions/v1/meta-leadgen-relay?token=<TOKEN>
//      Method: POST
//      Body:   JSON with the fields above (map from the trigger output)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
};

const RELAY_TOKEN = Deno.env.get("META_LEADGEN_RELAY_TOKEN") ?? "";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false } },
);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method === "GET") return json({ ok: true, name: "meta-leadgen-relay" });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (RELAY_TOKEN) {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") ?? request.headers.get("x-meta-relay-token") ?? "";
    if (token !== RELAY_TOKEN) return json({ error: "Invalid token" }, 401);
  }

  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const leadgenId = strField(body, "leadgen_id", "lead_id", "id") ?? "";
  if (!leadgenId) return json({ error: "Missing leadgen_id" }, 400);

  const { data: ws } = await supabase.rpc("carterco_workspace_id");
  const workspaceId = ws as string | null;
  if (!workspaceId) return json({ error: "workspace not resolvable" }, 500);

  // Idempotency: encode leadgen_id in notes; check before insert.
  const noteTag = `meta_leadgen_id=${leadgenId}`;
  const { data: existing } = await supabase
    .from("leads")
    .select("id")
    .eq("source", "meta_leadgen")
    .ilike("notes", `%${noteTag}%`)
    .maybeSingle();
  if (existing?.id) return json({ ok: true, duplicate: true, lead_id: existing.id });

  const name = strField(body, "full_name", "name");
  const email = (strField(body, "email") ?? "").toLowerCase() || null;
  const phone = strField(body, "phone_number", "phone");
  const company = strField(body, "company_name", "company");
  const qualifier = strField(body, "moeder_per_uge", "qualifier", "monthly_leads");

  const formId = strField(body, "form_id");
  const adId = strField(body, "ad_id");
  const noteParts = [noteTag];
  if (formId) noteParts.push(`form_id=${formId}`);
  if (adId) noteParts.push(`ad_id=${adId}`);

  const row = {
    workspace_id: workspaceId,
    name,
    company,
    email,
    phone,
    monthly_leads: qualifier,
    source: "meta_leadgen",
    is_draft: false,
    notes: noteParts.join(" · "),
  };

  const { data, error } = await supabase
    .from("leads")
    .insert(row)
    .select("id")
    .single();
  if (error) {
    console.error("leads insert error", error);
    return json({ error: "DB error", details: error.message }, 500);
  }
  return json({ ok: true, lead_id: data.id });
});

function strField(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
