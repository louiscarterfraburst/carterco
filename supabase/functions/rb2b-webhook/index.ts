// rb2b-webhook
//
// Receives identified-visitor webhooks from RB2B and writes them to
// outreach_signals. RB2B doesn't ship Svix-style HMAC signatures — auth is
// a shared secret in the URL path or query string. Set RB2B_WEBHOOK_TOKEN in
// env, then configure the webhook URL in RB2B as:
//   https://<project>.supabase.co/functions/v1/rb2b-webhook?token=<RB2B_WEBHOOK_TOKEN>
//
// Idempotent on (source='rb2b', external_id) — webhook retries collapse.
//
// Single-workspace for now: defaults to public.carterco_workspace_id().
// When we add a second workspace pixel, drive workspace_id from a separate
// query param or path segment.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const RB2B_WEBHOOK_TOKEN = Deno.env.get("RB2B_WEBHOOK_TOKEN") ?? "";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method === "GET") return json({ ok: true, name: "rb2b-webhook" });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (RB2B_WEBHOOK_TOKEN) {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") ?? request.headers.get("x-rb2b-token") ?? "";
    if (token !== RB2B_WEBHOOK_TOKEN) return json({ error: "Invalid token" }, 401);
  }

  let payload: Record<string, unknown>;
  try { payload = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  // RB2B's payload shape varies (and may change). Pull defensively — keep the
  // raw payload in jsonb so we can re-extract later without re-receiving.
  const extracted = extractRb2b(payload);

  const { data: ws } = await supabase.rpc("carterco_workspace_id");
  const workspaceId = ws as string | null;
  if (!workspaceId) return json({ error: "workspace not resolvable" }, 500);

  const row = {
    workspace_id: workspaceId,
    source: "rb2b",
    external_id: extracted.externalId,
    signal_type: extracted.signalType,
    identified_at: extracted.identifiedAt ?? new Date().toISOString(),
    person_name: extracted.personName,
    person_title: extracted.personTitle,
    person_linkedin_url: extracted.personLinkedinUrl,
    person_email: extracted.personEmail,
    company_name: extracted.companyName,
    company_domain: extracted.companyDomain,
    company_linkedin_url: extracted.companyLinkedinUrl,
    company_industry: extracted.companyIndustry,
    company_size: extracted.companySize,
    geo: extracted.geo,
    page_views: extracted.pageViews,
    payload,
  };

  const { data, error } = await supabase
    .from("outreach_signals")
    .insert(row)
    .select("id")
    .single();

  if (error) {
    if (`${error.message}`.includes("duplicate key")) {
      return json({ ok: true, duplicate: true });
    }
    console.error("signal insert error", error);
    return json({ error: "DB error", details: error.message }, 500);
  }

  return json({ ok: true, id: data.id });
});

type Extracted = {
  externalId: string | null;
  signalType: string | null;
  identifiedAt: string | null;
  personName: string | null;
  personTitle: string | null;
  personLinkedinUrl: string | null;
  personEmail: string | null;
  companyName: string | null;
  companyDomain: string | null;
  companyLinkedinUrl: string | null;
  companyIndustry: string | null;
  companySize: string | null;
  geo: Record<string, unknown> | null;
  pageViews: unknown;
};

// Defensive extractor: tries flat and nested shapes RB2B is known to send.
// Anything we miss still lives in payload jsonb and can be backfilled.
function extractRb2b(p: Record<string, unknown>): Extracted {
  const visitor = (p.visitor ?? p) as Record<string, unknown>;
  const company = (visitor.company ?? {}) as Record<string, unknown>;
  const geo = (visitor.geo ?? {
    ip: visitor.ip,
    city: visitor.city,
    state: visitor.state,
    country: visitor.country,
  }) as Record<string, unknown>;

  const first = pick(visitor, "first_name", "firstName");
  const last  = pick(visitor, "last_name", "lastName");
  const personName = pick(visitor, "name", "full_name") ??
    ([first, last].filter(Boolean).join(" ").trim() || null);

  return {
    externalId: pick(p, "event_id", "id") ?? pick(visitor, "id", "visitor_id"),
    signalType: pick(p, "event_type", "type") ?? "visitor.identified",
    identifiedAt: pick(p, "timestamp") ??
      pick(visitor, "last_seen", "lastSeen", "last_visit", "identified_at"),
    personName,
    personTitle: pick(visitor, "title", "job_title"),
    personLinkedinUrl: pick(visitor, "linkedin_url", "linkedinUrl", "li_url"),
    personEmail: pick(visitor, "business_email", "email"),
    companyName: pick(company, "name") ?? pick(visitor, "company_name"),
    companyDomain: pick(company, "domain", "website") ?? pick(visitor, "company_domain"),
    companyLinkedinUrl: pick(company, "linkedin_url") ?? pick(visitor, "company_linkedin_url"),
    companyIndustry: pick(company, "industry") ?? pick(visitor, "company_industry"),
    companySize: pick(company, "size", "employee_count") ?? pick(visitor, "company_size"),
    geo: Object.values(geo).some((v) => v !== undefined && v !== null) ? geo : null,
    pageViews: visitor.page_views ?? visitor.pageViews ?? visitor.page_visits ?? null,
  };
}

function pick(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
