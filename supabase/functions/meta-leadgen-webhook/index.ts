// meta-leadgen-webhook
//
// Receives Meta (Facebook) Lead Ads webhooks for the Louis fra Carter & Co
// page (1138136299380303). Inserts into public.leads with source='meta_leadgen'
// — the leads_notify_new_lead DB trigger fires push notifications automatically.
//
// Required env:
//   META_VERIFY_TOKEN          — token used in Meta webhook subscription handshake
//   META_APP_SECRET            — app secret, used to verify X-Hub-Signature-256
//   META_PAGE_ACCESS_TOKEN     — long-lived page token to read /{leadgen_id}
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Subscribe via Graph API once after deploy:
//   POST /v21.0/{page-id}/subscribed_apps
//     ?subscribed_fields=leadgen
//     &access_token={page-access-token}
//
// And in the Meta App dashboard → Webhooks → Page → leadgen field → callback:
//   https://<project>.supabase.co/functions/v1/meta-leadgen-webhook
//   verify token: META_VERIFY_TOKEN
//
// Single-workspace for now: defaults to public.carterco_workspace_id().

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const VERIFY_TOKEN = Deno.env.get("META_VERIFY_TOKEN") ?? "";
const APP_SECRET = Deno.env.get("META_APP_SECRET") ?? "";
const PAGE_ACCESS_TOKEN = Deno.env.get("META_PAGE_ACCESS_TOKEN") ?? "";
const GRAPH_VERSION = Deno.env.get("META_GRAPH_VERSION") ?? "v21.0";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false } },
);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Meta verification handshake
  if (request.method === "GET") {
    const url = new URL(request.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
      return new Response(challenge ?? "", { headers: { ...corsHeaders, "Content-Type": "text/plain" } });
    }
    if (mode) return json({ error: "Verification failed" }, 403);
    return json({ ok: true, name: "meta-leadgen-webhook" });
  }

  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const rawBody = await request.text();

  if (APP_SECRET) {
    const header = request.headers.get("x-hub-signature-256") ?? "";
    const ok = await verifyMetaSignature(header, rawBody, APP_SECRET);
    if (!ok) return json({ error: "Invalid signature" }, 401);
  }

  let body: MetaWebhookBody;
  try { body = JSON.parse(rawBody); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  if (body.object !== "page" || !Array.isArray(body.entry)) {
    return json({ ok: true, ignored: "not a page event" });
  }

  const { data: ws } = await supabase.rpc("carterco_workspace_id");
  const workspaceId = ws as string | null;
  if (!workspaceId) return json({ error: "workspace not resolvable" }, 500);

  const results: Array<{ leadgen_id: string; status: string; lead_id?: string; error?: string }> = [];

  for (const entry of body.entry) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "leadgen") continue;
      const v = change.value ?? {};
      const leadgenId = String(v.leadgen_id ?? "");
      if (!leadgenId) {
        results.push({ leadgen_id: "", status: "skipped:missing_id" });
        continue;
      }

      try {
        const lead = await fetchLead(leadgenId);
        const fields = parseFieldData(lead.field_data);
        const inserted = await insertLead({
          workspaceId,
          leadgenId,
          formId: String(v.form_id ?? lead.form_id ?? ""),
          adId: v.ad_id ? String(v.ad_id) : null,
          createdAt: lead.created_time ?? new Date().toISOString(),
          fields,
          raw: { webhook: v, lead },
        });
        results.push({ leadgen_id: leadgenId, status: inserted.duplicate ? "duplicate" : "ok", lead_id: inserted.id });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("meta-leadgen handler error", leadgenId, msg);
        results.push({ leadgen_id: leadgenId, status: "error", error: msg });
      }
    }
  }

  return json({ ok: true, results });
});

type MetaWebhookBody = {
  object: string;
  entry: Array<{
    id: string;
    time: number;
    changes?: Array<{
      field: string;
      value: {
        leadgen_id?: string;
        page_id?: string;
        form_id?: string;
        ad_id?: string;
        adgroup_id?: string;
        created_time?: number;
      };
    }>;
  }>;
};

type LeadFieldData = { name: string; values: string[] };
type MetaLead = {
  id: string;
  created_time?: string;
  ad_id?: string;
  form_id?: string;
  field_data?: LeadFieldData[];
};

async function fetchLead(leadgenId: string): Promise<MetaLead> {
  if (!PAGE_ACCESS_TOKEN) throw new Error("META_PAGE_ACCESS_TOKEN not set");
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${leadgenId}` +
    `?fields=id,created_time,ad_id,form_id,field_data` +
    `&access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph fetch ${res.status}: ${text.slice(0, 300)}`);
  }
  return await res.json() as MetaLead;
}

// Field names from Meta lead forms come back as machine-readable slugs. The
// standard prefilled fields are stable; custom questions use the slug of the
// question label. We map known slugs and keep the rest in raw for later use.
function parseFieldData(fields: LeadFieldData[] | undefined): {
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  qualifier: string | null;
  extra: Record<string, string>;
} {
  const out = { name: null as string | null, email: null as string | null, phone: null as string | null, company: null as string | null, qualifier: null as string | null, extra: {} as Record<string, string> };
  if (!Array.isArray(fields)) return out;
  for (const f of fields) {
    const slug = (f.name ?? "").toLowerCase();
    const val = (f.values?.[0] ?? "").trim();
    if (!val) continue;
    if (!out.name && (slug === "full_name" || slug === "name")) { out.name = val; continue; }
    if (!out.name && (slug === "first_name" || slug === "last_name")) {
      out.extra[slug] = val;
      // Combine on second occurrence
      if (out.extra.first_name && out.extra.last_name) out.name = `${out.extra.first_name} ${out.extra.last_name}`.trim();
      continue;
    }
    if (!out.email && slug === "email") { out.email = val.toLowerCase(); continue; }
    if (!out.phone && (slug === "phone_number" || slug === "phone")) { out.phone = val; continue; }
    if (!out.company && (slug === "company_name" || slug === "company")) { out.company = val; continue; }
    // Anything else (qualifier slug varies with the question label) lands in extra
    out.extra[slug] = val;
  }
  // Use first non-standard field as the qualifier if we have one
  if (!out.qualifier) {
    for (const [k, v] of Object.entries(out.extra)) {
      if (["first_name", "last_name"].includes(k)) continue;
      out.qualifier = v;
      break;
    }
  }
  return out;
}

async function insertLead(args: {
  workspaceId: string;
  leadgenId: string;
  formId: string;
  adId: string | null;
  createdAt: string;
  fields: ReturnType<typeof parseFieldData>;
  raw: Record<string, unknown>;
}): Promise<{ id: string; duplicate: boolean }> {
  // Idempotency: if we've already stored this leadgen_id, return the existing row.
  const { data: existing } = await supabase
    .from("leads")
    .select("id")
    .eq("source", "meta_leadgen")
    .eq("notes", metaLeadNote(args.leadgenId))
    .maybeSingle();
  if (existing?.id) return { id: existing.id, duplicate: true };

  const row = {
    workspace_id: args.workspaceId,
    name: args.fields.name,
    company: args.fields.company,
    email: args.fields.email,
    phone: args.fields.phone,
    monthly_leads: args.fields.qualifier,
    source: "meta_leadgen",
    is_draft: false,
    notes: metaLeadNote(args.leadgenId, args.formId, args.adId),
  };

  const { data, error } = await supabase
    .from("leads")
    .insert(row)
    .select("id")
    .single();
  if (error) throw new Error(`leads insert: ${error.message}`);
  return { id: data.id, duplicate: false };
}

function metaLeadNote(leadgenId: string, formId?: string, adId?: string | null) {
  const parts = [`meta_leadgen_id=${leadgenId}`];
  if (formId) parts.push(`form_id=${formId}`);
  if (adId) parts.push(`ad_id=${adId}`);
  return parts.join(" · ");
}

async function verifyMetaSignature(header: string, rawBody: string, appSecret: string): Promise<boolean> {
  if (!header.startsWith("sha256=")) return false;
  const provided = header.slice("sha256=".length);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return timingSafeEqual(expected, provided);
}

function timingSafeEqual(a: string, b: string) {
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
