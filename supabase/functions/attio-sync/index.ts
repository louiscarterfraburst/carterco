// attio-sync
//
// Pushes a single outreach_pipeline row to Attio. Mirrors the row's current
// state into three Attio objects: Company (by domain), Person (by email),
// Deal (by supabase_pipeline_id). Idempotent — Attio's "assert" endpoint
// (PUT with matching_attribute) upserts by the unique key.
//
// Triggers:
//   - Postgres trigger on outreach_pipeline insert/update (real-time sync)
//   - Manual backfill: POST { pipelineLeadId } per row
//   - Manual reseed: POST { backfill: true } to walk all rows (rate-limited)
//
// Stage mapping prioritises outcome over status: a row with outcome='won'
// wins regardless of status. See mapStage() for the full table.

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

// Single-tenant Attio for now: only CarterCo's workspace syncs. Other
// Supabase workspaces (Tresyv, Haugefrom) don't push to this Attio. When
// we add a second Attio workspace we'll route by workspace_id → token.
const CARTERCO_WORKSPACE_ID = "1e067f9a-d453-41a7-8bc4-9fdb5644a5fa";

// Attio status_ids for the deals.stage attribute (see Attio workspace settings).
// Resolved once via API at deploy time; hard-coded here to avoid a lookup per sync.
const STAGE = {
  LEAD: "894b6b8d-8eac-4af3-b878-dd662a4022a1",
  SENT_AWAITING: "2dce8d36-ff36-433f-a17c-f35b8c2b1d19",
  IN_PROGRESS: "4cf8dee9-dcb3-4c67-8005-a6a7c7a0ba51",
  MEETING_BOOKED: "3fc5dde1-2f5e-49d1-a21e-c5acaa85f7df",
  WON: "3c4ddbb4-c954-4d6f-a74e-8a9ec94da936",
  LOST: "7a4f6484-cb28-4bc2-b256-af577d68ee5e",
} as const;

// Deal owner — Attio requires this. Solo workspace today so hard-coded;
// when we add a second workspace member, look up by email at sync time.
const ATTIO_DEFAULT_OWNER_MEMBER_ID = "20ad018d-2d38-4bc7-8d2d-7aded17797c5"; // louis@carterco.dk

type Outcome =
  | "won" | "meeting_booked" | "interested" | "not_interested"
  | "wrong_person_confirmed" | "ghosted";

type PipelineRow = {
  sendpilot_lead_id: string;
  linkedin_url: string | null;
  contact_email: string | null;
  phone_direct: string | null;
  phone_office: string | null;
  status: string;
  outcome: Outcome | null;
  invited_at: string | null;
  sent_at: string | null;
  last_reply_at: string | null;
  workspace_id: string;
};

type LeadRow = {
  contact_email: string | null;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  title: string | null;
  website: string | null;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method === "GET") return json({ ok: true, name: "attio-sync" });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!ATTIO_API_KEY) return json({ error: "ATTIO_API_KEY not configured" }, 500);

  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  // Backfill mode: walk every pipeline row in batches. Caller is expected to
  // be a human operator running this once, not the pg trigger. Pass
  // { offset, limit } to chunk; defaults to first 50 rows. Response includes
  // next_offset so the caller can loop.
  if (body.backfill === true) {
    const offset = typeof body.offset === "number" ? body.offset : 0;
    const limit = typeof body.limit === "number" ? Math.min(body.limit, 50) : 50;
    return await runBackfill(offset, limit);
  }

  // Single-row mode. pipelineLeadId is the sendpilot_lead_id.
  // Pg trigger payload has { record: { sendpilot_lead_id, ... } }.
  const pipelineLeadId =
    (body.pipelineLeadId as string | undefined) ??
    ((body.record as Record<string, unknown> | undefined)?.sendpilot_lead_id as string | undefined);
  if (!pipelineLeadId) return json({ error: "pipelineLeadId or record.sendpilot_lead_id required" }, 400);

  const result = await syncOne(pipelineLeadId);
  return json(result, result.ok ? 200 : 502);
});

async function syncOne(pipelineLeadId: string): Promise<Record<string, unknown> & { ok: boolean }> {
  const { data: pipe, error: pipeErr } = await supabase
    .from("outreach_pipeline")
    .select("sendpilot_lead_id, linkedin_url, contact_email, phone_direct, phone_office, status, outcome, invited_at, sent_at, last_reply_at, workspace_id")
    .eq("sendpilot_lead_id", pipelineLeadId)
    .maybeSingle();
  if (pipeErr || !pipe) return { ok: false, error: "pipeline row not found", details: pipeErr?.message };

  const row = pipe as PipelineRow;

  // Workspace gate: other Supabase tenants don't sync into this Attio.
  if (row.workspace_id !== CARTERCO_WORKSPACE_ID) {
    return { ok: true, skipped: "non-carterco workspace", pipelineLeadId, workspaceId: row.workspace_id };
  }
  const rawEmail = row.contact_email?.toLowerCase().trim() ?? "";

  const { data: lead } = await supabase
    .from("outreach_leads")
    .select("contact_email, first_name, last_name, company, title, website")
    .eq("workspace_id", row.workspace_id)
    .eq("contact_email", row.contact_email)
    .maybeSingle();
  const leadRow = (lead ?? null) as LeadRow | null;

  // Distinguish a real prospect email from our SendPilot routing alias. The
  // carterco+li-<slug>@carterco.dk alias is our reply-routing infra, not the
  // prospect's identity — using it as an Attio People email creates orphan
  // Person records when the lead is later replaced by a real-email enrichment.
  // Same for the @example.invalid placeholder used for un-enriched leads.
  const isRealEmail = !!rawEmail
    && !rawEmail.endsWith("@example.invalid")
    && !(rawEmail.startsWith("carterco+") && rawEmail.endsWith("@carterco.dk"));
  const realEmail = isRealEmail ? rawEmail : "";
  const phoneValues = attioPhoneValues(row.phone_direct, row.phone_office);
  const personIdentityEmail = realEmail || (phoneValues.length > 0 ? rawEmail : "");

  const domain = normalizeDomain(leadRow?.website ?? null);
  const companyName = leadRow?.company?.trim() ?? domain ?? null;

  // Need at least a company OR a person identity. We still avoid synthetic
  // CarterCo reply aliases by default, but allow them when we have a phone:
  // older SendPilot-imported people in Attio were keyed that way, and this
  // lets us enrich those existing records with useful contact data.
  if (!domain && !personIdentityEmail) {
    return { ok: true, skipped: "no usable person identity and no company domain", pipelineLeadId };
  }

  // 1. Upsert Company by domain (only if we have one)
  let companyRecordId: string | null = null;
  if (domain) {
    const companyRes = await attioAssert("companies", "domains", {
      name: companyName ? [{ value: companyName }] : undefined,
      domains: [{ domain }],
    });
    if (!companyRes.ok) return { ok: false, stage: "company_upsert", error: companyRes.error, details: companyRes.details };
    companyRecordId = companyRes.recordId;
  }

  // 2. Upsert Person by email. Prefer the real prospect email; for phone-only
  // legacy leads, use the existing routing alias so we update the Attio record
  // that was already created from the old sync.
  let personRecordId: string | null = null;
  if (personIdentityEmail) {
    const personValues: Record<string, unknown> = {
      email_addresses: [{ email_address: personIdentityEmail }],
    };
    if (phoneValues.length > 0) personValues.phone_numbers = phoneValues;
    if (leadRow?.first_name || leadRow?.last_name) {
      personValues.name = [{
        first_name: leadRow.first_name ?? "",
        last_name: leadRow.last_name ?? "",
        full_name: [leadRow.first_name, leadRow.last_name].filter(Boolean).join(" "),
      }];
    }
    if (leadRow?.title) personValues.job_title = leadRow.title;
    if (row.linkedin_url) personValues.linkedin = row.linkedin_url;
    if (companyRecordId) {
      personValues.company = [{ target_object: "companies", target_record_id: companyRecordId }];
    }
    const personRes = await attioAssert("people", "email_addresses", personValues);
    if (!personRes.ok) return { ok: false, stage: "person_upsert", error: personRes.error, details: personRes.details };
    personRecordId = personRes.recordId;
  }

  // 3. Upsert Deal by supabase_pipeline_id (sendpilot_lead_id)
  const stageId = mapStage(row);
  const dealName = [
    [leadRow?.first_name, leadRow?.last_name].filter(Boolean).join(" ").trim() || (realEmail || rawEmail),
    companyName,
  ].filter(Boolean).join(" — ");

  const dealValues: Record<string, unknown> = {
    name: dealName,
    supabase_pipeline_id: pipelineLeadId,
    stage: [{ status: stageId }],
    owner: [{ referenced_actor_type: "workspace-member", referenced_actor_id: ATTIO_DEFAULT_OWNER_MEMBER_ID }],
  };
  if (personRecordId) {
    dealValues.associated_people = [{ target_object: "people", target_record_id: personRecordId }];
  }
  if (companyRecordId) {
    dealValues.associated_company = [{ target_object: "companies", target_record_id: companyRecordId }];
  }

  const dealRes = await attioAssert("deals", "supabase_pipeline_id", dealValues);
  if (!dealRes.ok) return { ok: false, stage: "deal_upsert", error: dealRes.error, details: dealRes.details };

  return {
    ok: true,
    pipelineLeadId,
    personRecordId,
    companyRecordId,
    dealRecordId: dealRes.recordId,
    stage: stageNameOf(stageId),
  };
}

function mapStage(row: PipelineRow): string {
  // Outcome wins over status
  if (row.outcome === "won") return STAGE.WON;
  if (row.outcome === "meeting_booked") return STAGE.MEETING_BOOKED;
  if (row.outcome === "not_interested" || row.outcome === "ghosted" || row.outcome === "wrong_person_confirmed") {
    return STAGE.LOST;
  }
  if (["rejected", "rejected_by_icp", "failed"].includes(row.status)) return STAGE.LOST;
  if (row.status === "sent" && row.last_reply_at) return STAGE.IN_PROGRESS;
  // Everything else (invited, accepted, render-in-progress, sent without reply, pre_connected) is in flight
  return STAGE.SENT_AWAITING;
}

function stageNameOf(id: string): string {
  for (const [k, v] of Object.entries(STAGE)) {
    if (v === id) return k;
  }
  return id;
}

function normalizeDomain(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./, "").toLowerCase().trim() || null;
  } catch {
    const cleaned = raw.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase().trim();
    return cleaned || null;
  }
}

function attioPhoneValues(...phones: (string | null | undefined)[]): string[] {
  const normalized = phones
    .map((phone) => normalizePhone(phone ?? null))
    .filter((phone): phone is string => !!phone);
  return [...new Set(normalized)];
}

function normalizePhone(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let digits = trimmed.replace(/[^\d+]/g, "");
  if (digits.startsWith("00")) digits = `+${digits.slice(2)}`;
  if (!digits.startsWith("+")) {
    const justDigits = digits.replace(/\D/g, "");
    if (justDigits.length === 8) digits = `+45${justDigits}`;
    else return null;
  }

  const e164 = `+${digits.replace(/\D/g, "")}`;
  const digitCount = e164.length - 1;
  if (digitCount < 10 || digitCount > 15) return null;
  // NANP area codes cannot start with 0 or 1. Attio/libphonenumber rejects
  // these even if they look E.164-ish, so filter before sending.
  if (/^\+1[01]/.test(e164)) return null;
  return e164;
}

// Attio's "assert" pattern: PUT with matching_attribute query param. Creates
// if no match found, updates if found. Returns the record_id either way.
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
    if (!res.ok) {
      return { ok: false, error: `attio http ${res.status}`, details: data ?? text };
    }
    const recordId = (data as { data?: { id?: { record_id?: string } } } | null)?.data?.id?.record_id;
    if (!recordId) return { ok: false, error: "no record_id in response", details: data };
    return { ok: true, recordId };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function runBackfill(offset = 0, limit = 50): Promise<Response> {
  const { data: rows, error } = await supabase
    .from("outreach_pipeline")
    .select("sendpilot_lead_id")
    .eq("workspace_id", CARTERCO_WORKSPACE_ID)
    .order("updated_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return json({ ok: false, error: error.message }, 500);

  const results: { id: string; ok: boolean; stage?: string; error?: string }[] = [];
  for (const r of (rows ?? []) as { sendpilot_lead_id: string }[]) {
    const res = await syncOne(r.sendpilot_lead_id);
    results.push({ id: r.sendpilot_lead_id, ok: !!res.ok, stage: res.stage as string | undefined, error: res.error as string | undefined });
    // Modest pause to stay friendly with Attio rate limits. 100 req/sec is the
    // hard cap; we do 3 PUTs per row → ~30 rows/sec ceiling. Sleep 50ms.
    await new Promise((r) => setTimeout(r, 50));
  }

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  return json({
    ok: true,
    offset,
    limit,
    total: results.length,
    succeeded,
    failed: failed.length,
    failures: failed.slice(0, 20),
    next_offset: results.length < limit ? null : offset + limit,
  });
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
