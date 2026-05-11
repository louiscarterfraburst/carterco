// Cron-triggered every 5 min. For each pending_pre_render row with
// icp_scored_at IS NULL:
//   1. Load enrichment from outreach_leads.
//   2. Haiku scores (company 1-5, person 1-5) against ICP.
//   3. Branch:
//        company_score < min            → status='rejected_by_icp'
//        person_score  < min            → fire SendPilot lead-database search
//                                          → status='pending_alt_review'
//        otherwise                      → leave status='pending_pre_render'
//                                          (existing render flow proceeds)
//
// All branches stamp icp_scored_at + scores + rationale.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";
import { ICP, type IcpScores } from "../_shared/icp.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const SP_API_KEY = Deno.env.get("SENDPILOT_API_KEY") ?? "";
const SP_SEARCH_BASE = "https://api.sendpilot.ai/v1/lead-database/searches";
const BATCH_LIMIT = Number(Deno.env.get("ICP_SCORE_BATCH") ?? "20");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

type PipelineRow = {
  sendpilot_lead_id: string;
  contact_email: string;
  workspace_id: string;
};

type LeadEnrich = {
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  title: string | null;
  website: string | null;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method === "GET") return json({ ok: true, name: "score-accepted-lead" });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const { data: rows, error } = await supabase
    .from("outreach_pipeline")
    .select("sendpilot_lead_id, contact_email, workspace_id")
    .eq("status", "pending_pre_render")
    .is("icp_scored_at", null)
    .order("accepted_at", { ascending: true })
    .limit(BATCH_LIMIT);
  if (error) return json({ error: error.message }, 500);
  if (!rows || rows.length === 0) return json({ ok: true, scored: 0 });

  const summary: Array<Record<string, unknown>> = [];
  for (const row of rows as PipelineRow[]) {
    summary.push(await scoreOne(row));
  }
  return json({ ok: true, scored: summary.length, summary });
});

async function scoreOne(row: PipelineRow): Promise<Record<string, unknown>> {
  const { data: lead } = await supabase
    .from("outreach_leads")
    .select("first_name, last_name, company, title, website")
    .eq("contact_email", row.contact_email)
    .maybeSingle();
  const enrich = (lead ?? {}) as LeadEnrich;

  const now = new Date().toISOString();

  let scores: IcpScores;
  try {
    scores = await haikuScore(enrich);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase.from("outreach_pipeline").update({
      icp_scored_at: now,
      icp_rationale: `score error: ${msg.slice(0, 400)}`,
    }).eq("sendpilot_lead_id", row.sendpilot_lead_id);
    return { lead: row.sendpilot_lead_id, error: msg.slice(0, 200) };
  }

  const { minCompanyScore, minPersonScore } = ICP.thresholds;

  // Branch 1: company is not a fit at all.
  if (scores.companyScore < minCompanyScore) {
    await supabase.from("outreach_pipeline").update({
      status: "rejected_by_icp",
      icp_scored_at: now,
      icp_company_score: scores.companyScore,
      icp_person_score: scores.personScore,
      icp_rationale: scores.rationale,
    }).eq("sendpilot_lead_id", row.sendpilot_lead_id);
    return {
      lead: row.sendpilot_lead_id,
      decision: "rejected_by_icp",
      company: enrich.company,
      scores,
    };
  }

  // Branch 2: company OK but the accepted person isn't a buyer at this company.
  if (scores.personScore < minPersonScore) {
    const searchOut = await fireAltSearch(enrich.company ?? "");
    await supabase.from("outreach_pipeline").update({
      status: "pending_alt_review",
      icp_scored_at: now,
      icp_company_score: scores.companyScore,
      icp_person_score: scores.personScore,
      icp_rationale: scores.rationale,
      alt_search_id: searchOut.id,
      alt_search_status: searchOut.id ? "pending" : "failed",
    }).eq("sendpilot_lead_id", row.sendpilot_lead_id);
    return {
      lead: row.sendpilot_lead_id,
      decision: "alt_search_started",
      company: enrich.company,
      scores,
      alt_search: searchOut,
    };
  }

  // Branch 3: both pass — render flow proceeds untouched.
  await supabase.from("outreach_pipeline").update({
    icp_scored_at: now,
    icp_company_score: scores.companyScore,
    icp_person_score: scores.personScore,
    icp_rationale: scores.rationale,
  }).eq("sendpilot_lead_id", row.sendpilot_lead_id);
  return {
    lead: row.sendpilot_lead_id,
    decision: "icp_passed",
    company: enrich.company,
    scores,
  };
}

const HAIKU_SYSTEM = `You score a B2B outreach lead against an ICP for Carter & Co.

${ICP.companyFit}

${ICP.personFit}

Return ONLY a JSON object, no markdown fences, no commentary:
{"company_score": int 1-5, "person_score": int 1-5, "rationale": "one short sentence covering both"}

company_score = how well the company fits the ICP (5 = perfect, 1 = obvious no).
person_score  = how likely this person is the buyer/influencer at that company (5 = clearly a buyer, 1 = clearly wrong person).
rationale     = explain the lower of the two scores in one terse sentence (no preamble).`;

async function haikuScore(lead: LeadEnrich): Promise<IcpScores> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const userBlock = [
    `Name: ${(lead.first_name ?? "") + " " + (lead.last_name ?? "")}`.trim(),
    `Title / headline: ${lead.title ?? "(unknown)"}`,
    `Company: ${lead.company ?? "(unknown)"}`,
    `Website: ${lead.website ?? "(unknown)"}`,
  ].join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: HAIKU_SYSTEM,
      messages: [{ role: "user", content: userBlock }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`haiku ${res.status}: ${body.slice(0, 200)}`);
  }
  const body = await res.json();
  const blocks = (body.content ?? []) as Array<{ type: string; text?: string }>;
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  const slice = start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped;
  const parsed = JSON.parse(slice) as {
    company_score?: number;
    person_score?: number;
    rationale?: string;
  };
  const clamp = (n: number) => Math.max(1, Math.min(5, Math.round(n)));
  return {
    companyScore: clamp(parsed.company_score ?? 3),
    personScore: clamp(parsed.person_score ?? 3),
    rationale: (parsed.rationale ?? "").slice(0, 500),
  };
}

async function fireAltSearch(companyName: string): Promise<{ id: string | null; error?: string }> {
  if (!SP_API_KEY) return { id: null, error: "SENDPILOT_API_KEY not set" };
  const name = companyName.trim();
  if (!name) return { id: null, error: "no company name" };

  const res = await fetch(SP_SEARCH_BASE, {
    method: "POST",
    headers: { "X-API-Key": SP_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `carterco-alt-${Date.now()}`,
      limit: 5,
      filters: {
        companies: [name],
        jobTitles: ICP.alternateSearchTitles,
        locations: ICP.alternateSearchLocations,
      },
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return { id: null, error: `sendpilot ${res.status}: ${txt.slice(0, 200)}` };
  }
  const body = await res.json().catch(() => null) as { id?: string } | null;
  return { id: body?.id ?? null };
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
