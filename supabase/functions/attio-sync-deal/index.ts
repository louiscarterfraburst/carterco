// attio-sync-deal
//
// One-way push from public.deals -> Attio. Fires from a Postgres trigger
// (deals.sql) and from manual calls during seed/backfill.
//
// Sibling to attio-sync (cold-outbound from outreach_pipeline). Both write
// to the same Attio Deal object, distinguished by supabase_pipeline_id:
//   - cold outbound:   "cmowxgnk..." (SendPilot lead id)
//   - deal (manual):   "manual:<slug>"
//
// Triggers:
//   - Postgres trigger on deals insert/update
//   - Manual: POST { slug } (single row) or { backfill: true } (all rows)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ATTIO_API_KEY = Deno.env.get("ATTIO_API_KEY") ?? "";
const ATTIO_BASE = "https://api.attio.com/v2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

// Attio stage status_ids — same workspace as attio-sync.
const STAGE_ID: Record<string, string> = {
  lead:           "894b6b8d-8eac-4af3-b878-dd662a4022a1",
  sent_awaiting:  "2dce8d36-ff36-433f-a17c-f35b8c2b1d19",
  in_progress:    "4cf8dee9-dcb3-4c67-8005-a6a7c7a0ba51",
  meeting_booked: "3fc5dde1-2f5e-49d1-a21e-c5acaa85f7df",
  won:            "3c4ddbb4-c954-4d6f-a74e-8a9ec94da936",
  lost:           "7a4f6484-cb28-4bc2-b256-af577d68ee5e",
};

const ATTIO_DEFAULT_OWNER_MEMBER_ID = "20ad018d-2d38-4bc7-8d2d-7aded17797c5";

type DealRow = {
  slug: string;
  company_name: string;
  company_domain: string;
  person_email: string;
  person_name: string | null;
  person_title: string | null;
  person_linkedin_url: string | null;
  stage: string;
  value_amount: number | null;
  value_currency: string | null;
  deal_name: string | null;
  notes: string | null;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method === "GET") return json({ ok: true, name: "attio-sync-deal" });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!ATTIO_API_KEY) return json({ error: "ATTIO_API_KEY not configured" }, 500);

  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  if (body.backfill === true) return await runBackfill();

  const slug =
    (body.slug as string | undefined) ??
    ((body.record as Record<string, unknown> | undefined)?.slug as string | undefined);
  if (!slug) return json({ error: "slug or record.slug required" }, 400);

  const res = await syncOne(slug);
  return json(res, res.ok ? 200 : 502);
});

async function syncOne(slug: string): Promise<Record<string, unknown> & { ok: boolean }> {
  const { data, error } = await supabase
    .from("deals")
    .select("slug, company_name, company_domain, person_email, person_name, person_title, person_linkedin_url, stage, value_amount, value_currency, deal_name, notes")
    .eq("slug", slug)
    .maybeSingle();
  if (error || !data) return { ok: false, error: "deal not found", details: error?.message };

  const row = data as DealRow;
  const domain = normalizeDomain(row.company_domain);
  if (!domain) return { ok: false, error: "deal.company_domain missing/invalid" };

  // 1. Upsert Company by domain
  const companyRes = await attioAssert("companies", "domains", {
    name: row.company_name ? [{ value: row.company_name }] : undefined,
    domains: [{ domain }],
  });
  if (!companyRes.ok) return { ok: false, stage: "company", error: companyRes.error, details: companyRes.details };
  const companyRecordId = companyRes.recordId;

  // 2. Upsert Person by email
  const email = row.person_email.toLowerCase().trim();
  const [firstName, ...lastParts] = (row.person_name ?? "").trim().split(/\s+/);
  const lastName = lastParts.join(" ");
  const personValues: Record<string, unknown> = {
    email_addresses: [{ email_address: email }],
    company: [{ target_object: "companies", target_record_id: companyRecordId }],
  };
  if (row.person_name) {
    personValues.name = [{
      first_name: firstName ?? "",
      last_name: lastName ?? "",
      full_name: row.person_name,
    }];
  }
  if (row.person_title) personValues.job_title = row.person_title;
  if (row.person_linkedin_url) personValues.linkedin = row.person_linkedin_url;

  const personRes = await attioAssert("people", "email_addresses", personValues);
  if (!personRes.ok) return { ok: false, stage: "person", error: personRes.error, details: personRes.details };
  const personRecordId = personRes.recordId;

  // 3. Upsert Deal by supabase_pipeline_id = "manual:<slug>"
  const stageId = STAGE_ID[row.stage];
  if (!stageId) return { ok: false, error: `unknown stage: ${row.stage}` };

  const dealName = row.deal_name ?? defaultDealName(row);
  const dealValues: Record<string, unknown> = {
    name: dealName,
    supabase_pipeline_id: `manual:${row.slug}`,
    stage: [{ status: stageId }],
    owner: [{ referenced_actor_type: "workspace-member", referenced_actor_id: ATTIO_DEFAULT_OWNER_MEMBER_ID }],
    associated_company: [{ target_object: "companies", target_record_id: companyRecordId }],
    associated_people: [{ target_object: "people", target_record_id: personRecordId }],
  };
  if (row.value_amount != null) {
    // Attio currency attribute takes a bare number; currency_code is set on
    // the attribute config in Attio's workspace settings, not per-record.
    dealValues.value = row.value_amount;
  }

  const dealRes = await attioAssert("deals", "supabase_pipeline_id", dealValues);
  if (!dealRes.ok) return { ok: false, stage: "deal", error: dealRes.error, details: dealRes.details };

  return {
    ok: true,
    slug,
    companyRecordId,
    personRecordId,
    dealRecordId: dealRes.recordId,
    stage: row.stage,
  };
}

function defaultDealName(row: DealRow): string {
  const personPart = row.person_name?.trim() || row.person_email;
  return `${row.company_name} — ${personPart}`;
}

function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./, "").toLowerCase().trim() || null;
  } catch {
    const cleaned = raw.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase().trim();
    return cleaned || null;
  }
}

async function attioAssert(
  objectSlug: string,
  matchingAttribute: string,
  values: Record<string, unknown>,
): Promise<{ ok: true; recordId: string } | { ok: false; error: string; details?: unknown }> {
  const url = `${ATTIO_BASE}/objects/${objectSlug}/records?matching_attribute=${matchingAttribute}`;
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${ATTIO_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data: { values } }),
    });
    const text = await res.text();
    let data: unknown = null;
    try { data = JSON.parse(text); } catch { /* keep text */ }
    if (!res.ok) return { ok: false, error: `attio http ${res.status}`, details: data ?? text };
    const recordId = (data as { data?: { id?: { record_id?: string } } } | null)?.data?.id?.record_id;
    if (!recordId) return { ok: false, error: "no record_id in response", details: data };
    return { ok: true, recordId };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function runBackfill(): Promise<Response> {
  const { data: rows, error } = await supabase
    .from("deals")
    .select("slug")
    .order("created_at", { ascending: true });
  if (error) return json({ ok: false, error: error.message }, 500);

  const results: { slug: string; ok: boolean; error?: string }[] = [];
  for (const r of (rows ?? []) as { slug: string }[]) {
    const res = await syncOne(r.slug);
    results.push({ slug: r.slug, ok: !!res.ok, error: res.error as string | undefined });
    await new Promise((r) => setTimeout(r, 50));
  }
  return json({
    ok: true,
    total: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok),
  });
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
