// meta-leadgen-relay
//
// Receives Meta Lead Ads leads forwarded via Make (or any HTTP client) and
// inserts them into public.leads. Same pattern as rb2b-webhook — shared secret
// in URL token; idempotent on (source='meta_leadgen', meta_lead_id=leadgen_id).
//
// This is the LIVE Meta lead-ads ingestion path (the meta-leadgen-webhook
// Graph variant is dormant — its app/page secrets are unset). Multi-tenant:
// the Make scenario includes the page_id, and pages route to workspaces via
// META_PAGE_WORKSPACE_MAP. The CarterCo page is the built-in default, so the
// existing CarterCo scenario keeps working unchanged (no page_id needed). A new
// tenant (Soho) = add its page→workspace to the env map + a Make scenario on
// its page; no redeploy.
//
// Expected POST body (Make module fields, all optional except leadgen_id):
//   {
//     "leadgen_id": "1234567890",         // Meta lead ID — idempotency key
//     "page_id": "146975948684005",       // routes to the workspace (Soho here)
//     "form_id": "...", "ad_id": "...", "campaign_id": "...",
//     "created_time": "2026-05-25T...",
//     "full_name" | "name": "...",
//     "email": "...",
//     "phone_number" | "phone": "...",
//     "company_name" | "company": "...",
//     "moeder_per_uge" | "qualifier": "...",
//     "utm_source"|"utm_medium"|"utm_campaign"|"utm_content"|"utm_term": "...",
//     "raw": { ... }                       // optional — full Make payload
//   }
//
// Auth: ?token=<META_LEADGEN_RELAY_TOKEN>  OR  X-Meta-Relay-Token header.
//
// Configure in Make (one scenario per page):
//   1. Trigger: Facebook Lead Ads — Watch Leads on the page
//   2. Action: HTTP POST
//      URL:  https://<project>.supabase.co/functions/v1/meta-leadgen-relay?token=<TOKEN>
//      Body: JSON with the fields above — INCLUDE page_id so it routes right.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
};

const RELAY_TOKEN = Deno.env.get("META_LEADGEN_RELAY_TOKEN") ?? "";

// page_id → workspace uuid. CarterCo page is the built-in default; more pages
// (Soho's 146975948684005) come from META_PAGE_WORKSPACE_MAP — env, not deploy.
const CARTERCO_PAGE_ID = "1138136299380303";
const PAGE_WORKSPACE_MAP: Record<string, string> = parseJsonEnv("META_PAGE_WORKSPACE_MAP");

// Optional per-page form allowlist. When a page has one, only leads from those
// form_ids are ingested — the rest are skipped at the door. Soho's page hosts
// both a Mødelokaler form (in scope) and a Kontor form (different sales motion,
// out of scope), so we accept only the meeting-room form. JSON:
//   {"146975948684005":["1539910014404003"]}
const PAGE_FORM_ALLOWLIST: Record<string, string[]> = parseJsonArrayEnv("META_PAGE_FORM_ALLOWLIST");

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

  // Route to the workspace by page. No page_id → CarterCo default (back-compat).
  // page_id present but unmapped → skip, so a stray page never lands in a tenant.
  const pageId = strField(body, "page_id", "pageId") ?? "";
  const workspaceId = await resolveWorkspace(pageId);
  if (!workspaceId) {
    if (pageId) return json({ ok: true, status: `skipped:unmapped_page:${pageId}` });
    return json({ error: "workspace not resolvable" }, 500);
  }

  // Form scope: if this page has an allowlist, only its forms are in scope.
  // (Soho: accept Mødelokaler, skip Kontor.)
  const formId = strField(body, "form_id");
  const allow = PAGE_FORM_ALLOWLIST[pageId];
  if (allow && allow.length && (!formId || !allow.includes(formId))) {
    return json({ ok: true, status: `skipped:form_out_of_scope:${formId ?? "none"}` });
  }

  // Idempotency: structured column first, legacy note as fallback for old rows.
  const noteTag = `meta_leadgen_id=${leadgenId}`;
  const existingId = await findExisting(leadgenId, noteTag);
  if (existingId) return json({ ok: true, duplicate: true, lead_id: existingId });

  const name = strField(body, "full_name", "name");
  const email = (strField(body, "email") ?? "").toLowerCase() || null;
  const phone = strField(body, "phone_number", "phone");
  const company = strField(body, "company_name", "company");
  const qualifier = strField(body, "moeder_per_uge", "qualifier", "monthly_leads");

  const adId = strField(body, "ad_id");
  const campaignId = strField(body, "campaign_id");
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
    // First-touch attribution — written once, the CAPI match key + ROAS join.
    meta_lead_id: leadgenId,
    meta_form_id: formId,
    meta_ad_id: adId,
    meta_campaign_id: campaignId,
    utm_source: strField(body, "utm_source"),
    utm_medium: strField(body, "utm_medium"),
    utm_campaign: strField(body, "utm_campaign"),
    utm_content: strField(body, "utm_content"),
    utm_term: strField(body, "utm_term"),
    // Human-readable note kept for the panel; columns are the source of truth.
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
  return json({ ok: true, lead_id: data.id, workspace_id: workspaceId });
});

async function resolveWorkspace(pageId: string): Promise<string | null> {
  if (pageId && PAGE_WORKSPACE_MAP[pageId]) return PAGE_WORKSPACE_MAP[pageId];
  if (!pageId || pageId === CARTERCO_PAGE_ID) {
    const { data } = await supabase.rpc("carterco_workspace_id");
    return (data as string | null) ?? null;
  }
  return null; // page present but unmapped → caller skips (no cross-tenant)
}

async function findExisting(leadgenId: string, noteTag: string): Promise<string | null> {
  const { data: byCol } = await supabase
    .from("leads").select("id")
    .eq("source", "meta_leadgen").eq("meta_lead_id", leadgenId)
    .maybeSingle();
  if (byCol?.id) return byCol.id;
  const { data: byNote } = await supabase
    .from("leads").select("id")
    .eq("source", "meta_leadgen").ilike("notes", `%${noteTag}%`)
    .maybeSingle();
  return byNote?.id ?? null;
}

function parseJsonEnv(name: string): Record<string, string> {
  const raw = Deno.env.get(name);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
  } catch {
    console.error(`${name}: invalid JSON, ignoring`);
    return {};
  }
}

function parseJsonArrayEnv(name: string): Record<string, string[]> {
  const raw = Deno.env.get(name);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (Array.isArray(v)) out[k] = v.map(String);
    }
    return out;
  } catch {
    console.error(`${name}: invalid JSON, ignoring`);
    return {};
  }
}

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
