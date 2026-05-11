// Manually triggered. Reads outcomes vs ICP scores for CarterCo, finds
// contradictions (high-scored ghosts, low-scored wins), asks Claude
// Sonnet for proposed prompt edits, writes a row to icp_tuning_proposals.
//
// Output is informational: the proposal sits in 'open' status until a human
// applies it via apply-icp-tuning-proposal. No autonomous changes.
//
// Min contradictions to generate a proposal: 5. Below that, signal is
// noise — return without spending a Sonnet call.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";
import { CARTERCO_WORKSPACE_ID } from "../_shared/icp.ts";
import { loadActiveIcp, type ResolvedIcp } from "../_shared/icp-loader.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const ALLOWED = new Set(["louis@carterco.dk", "rm@tresyv.dk", "haugefrom@haugefrom.com"]);
const MIN_CONTRADICTIONS = 5;

type Outcome =
  | "won" | "meeting_booked" | "interested"
  | "not_interested" | "wrong_person_confirmed" | "ghosted";

const POSITIVE_OUTCOMES: Outcome[] = ["won", "meeting_booked", "interested"];
const NEGATIVE_OUTCOMES: Outcome[] = ["not_interested", "wrong_person_confirmed", "ghosted"];

type PipelineWithLead = {
  sendpilot_lead_id: string;
  icp_company_score: number | null;
  icp_person_score: number | null;
  icp_rationale: string | null;
  outcome: Outcome | null;
  outcome_note: string | null;
  outcome_at: string | null;
  contact_email: string | null;
};

type LeadInfo = {
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  title: string | null;
  website: string | null;
};

type Contradiction = {
  kind: "high_score_negative" | "low_score_positive";
  lead_id: string;
  name: string;
  company: string | null;
  title: string | null;
  website: string | null;
  comp_score: number;
  pers_score: number;
  rationale: string | null;
  outcome: Outcome;
  outcome_note: string | null;
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Auth: same allowed-emails set as outreach-approve / invite-alt-contact.
  const authHeader = request.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "missing bearer" }, 401);
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "",
    { global: { headers: { Authorization: `Bearer ${token}` } } },
  );
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return json({ error: "invalid auth" }, 401);
  const email = (user.email ?? "").toLowerCase();
  if (!ALLOWED.has(email)) return json({ error: "forbidden" }, 403);

  // Load active ICP version + outcomes for CarterCo.
  const icp = await loadActiveIcp(supabase, CARTERCO_WORKSPACE_ID);

  const { data: pipeRows, error: pErr } = await supabase
    .from("outreach_pipeline")
    .select("sendpilot_lead_id, icp_company_score, icp_person_score, icp_rationale, outcome, outcome_note, outcome_at, contact_email")
    .eq("workspace_id", CARTERCO_WORKSPACE_ID)
    .not("outcome", "is", null)
    .not("icp_company_score", "is", null);
  if (pErr) return json({ error: pErr.message }, 500);

  const rows = (pipeRows ?? []) as PipelineWithLead[];

  // Fetch lead enrichment for context.
  const emails = Array.from(new Set(rows.map((r) => r.contact_email).filter(Boolean) as string[]));
  const { data: leadRows } = emails.length
    ? await supabase.from("outreach_leads")
        .select("contact_email, first_name, last_name, company, title, website")
        .in("contact_email", emails)
    : { data: [] as Array<LeadInfo & { contact_email: string }> };
  const leadMap = new Map(
    (leadRows ?? []).map((l) => [l.contact_email as string, l as LeadInfo & { contact_email: string }]),
  );

  const contradictions: Contradiction[] = [];
  for (const r of rows) {
    if (r.icp_company_score == null || r.outcome == null) continue;
    const isHighScore = r.icp_company_score >= 4;
    const isLowScore = r.icp_company_score <= 2;
    const isPositive = POSITIVE_OUTCOMES.includes(r.outcome);
    const isNegative = NEGATIVE_OUTCOMES.includes(r.outcome);

    let kind: Contradiction["kind"] | null = null;
    if (isHighScore && isNegative) kind = "high_score_negative";
    else if (isLowScore && isPositive) kind = "low_score_positive";
    if (!kind) continue;

    const lead = leadMap.get(r.contact_email ?? "") ?? null;
    contradictions.push({
      kind,
      lead_id: r.sendpilot_lead_id,
      name: `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim() || "?",
      company: lead?.company ?? null,
      title: lead?.title ?? null,
      website: lead?.website ?? null,
      comp_score: r.icp_company_score,
      pers_score: r.icp_person_score ?? 0,
      rationale: r.icp_rationale,
      outcome: r.outcome,
      outcome_note: r.outcome_note,
    });
  }

  if (contradictions.length < MIN_CONTRADICTIONS) {
    return json({
      ok: true,
      action: "skipped_insufficient_data",
      contradictions_count: contradictions.length,
      required: MIN_CONTRADICTIONS,
      total_outcomes: rows.length,
    });
  }

  // Ask Sonnet for proposed edits.
  const proposal = await askSonnetForEdits(icp, contradictions);

  const { data: inserted, error: insErr } = await supabase
    .from("icp_tuning_proposals")
    .insert({
      workspace_id: CARTERCO_WORKSPACE_ID,
      current_version_id: icp.versionId,
      contradictions_count: contradictions.length,
      contradictions: contradictions,
      proposed_company_fit: proposal.proposed_company_fit ?? null,
      proposed_person_fit: proposal.proposed_person_fit ?? null,
      proposed_min_company_score: proposal.proposed_min_company_score ?? null,
      proposed_min_person_score: proposal.proposed_min_person_score ?? null,
      rationale: proposal.rationale,
      status: "open",
    })
    .select()
    .single();
  if (insErr) return json({ error: insErr.message }, 500);

  return json({
    ok: true,
    action: "proposal_generated",
    proposal_id: (inserted as { id: string }).id,
    contradictions_count: contradictions.length,
    total_outcomes: rows.length,
  });
});

type SonnetResponse = {
  proposed_company_fit?: string;
  proposed_person_fit?: string;
  proposed_min_company_score?: number;
  proposed_min_person_score?: number;
  rationale: string;
};

async function askSonnetForEdits(
  icp: ResolvedIcp,
  contradictions: Contradiction[],
): Promise<SonnetResponse> {
  if (!ANTHROPIC_API_KEY) {
    return { rationale: "ANTHROPIC_API_KEY not set — no automated edits proposed." };
  }

  const SYSTEM = `You are tuning an ICP scoring prompt for a B2B outreach system.

The CURRENT PROMPT below is used by a smaller model (Haiku) to score
inbound leads on (a) company-fit 1-5 and (b) person-fit 1-5. Louis
tags actual outcomes after the conversation resolves. You are shown
the contradictions: where the scorer disagreed with reality.

Your job: propose specific edits to the prompt that would have produced
the right scores given what we now know.

Rules:
- Edit one or both of company_fit and person_fit. Do NOT change the
  output format or scoring scale.
- Keep the same structure (defaults, exclusions, examples). Tweak
  language, add/remove categories, sharpen exclusions, or add
  concrete patterns drawn from the contradictions.
- If thresholds (min_company_score, min_person_score) should change,
  return them; otherwise leave null.
- Write a rationale paragraph (3-5 sentences) that names the pattern
  you saw and why your edit fixes it. Be concrete: cite the specific
  contradictions you used.
- If the contradictions are too noisy or ambiguous to support an edit,
  return rationale="No clear pattern — recommend more data" with all
  proposed_* fields null.

Output JSON only, no markdown:
{
  "proposed_company_fit": string | null,
  "proposed_person_fit": string | null,
  "proposed_min_company_score": int | null,
  "proposed_min_person_score": int | null,
  "rationale": string
}`;

  const userBlock = [
    `# CURRENT company_fit (version ${icp.version}):`,
    icp.companyFit,
    "",
    `# CURRENT person_fit (version ${icp.version}):`,
    icp.personFit,
    "",
    `# CURRENT thresholds: min_company_score=${icp.minCompanyScore}, min_person_score=${icp.minPersonScore}`,
    "",
    `# CONTRADICTIONS (${contradictions.length}):`,
    JSON.stringify(contradictions, null, 2),
  ].join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      system: SYSTEM,
      messages: [{ role: "user", content: userBlock }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { rationale: `Sonnet error ${res.status}: ${body.slice(0, 200)}` };
  }
  const body = await res.json();
  const blocks = (body.content ?? []) as Array<{ type: string; text?: string }>;
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  const slice = start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped;
  try {
    return JSON.parse(slice) as SonnetResponse;
  } catch {
    return { rationale: `Sonnet returned unparseable output: ${stripped.slice(0, 200)}` };
  }
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
