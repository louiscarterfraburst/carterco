// score-signal: cron-triggered. For each workspace with an active ICP version,
// scores unscored inbound signals (outreach_signals.icp_score IS NULL, not
// handled) — COMPANY fit only, on a 1-10 scale to match the Besøg / vw_action_
// queue thresholds (>=7 strong, >=4 partial) — against that workspace's active
// ICP company_fit. Mirrors score-accepted-lead, which only scores accepted
// leads. Self-contained (no _shared imports) so it deploys as one file.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const BATCH_LIMIT = Number(Deno.env.get("SIGNAL_SCORE_BATCH") ?? "25");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

type SignalRow = {
  id: string;
  company_name: string | null;
  company_domain: string | null;
  company_industry: string | null;
  company_size: string | null;
  person_title: string | null;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method === "GET") return json({ ok: true, name: "score-signal" });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Only workspaces with an active ICP version (the company_fit prompt) get scored.
  const { data: activeRows, error: actErr } = await supabase
    .from("icp_versions")
    .select("workspace_id, company_fit, version")
    .eq("is_active", true);
  if (actErr) return json({ error: actErr.message }, 500);
  const active = (activeRows ?? []).filter((r) => (r.company_fit as string | null)?.trim());
  if (active.length === 0) return json({ ok: true, scored: 0, note: "no active ICP versions with company_fit" });

  let totalScored = 0;
  const perWorkspace: Array<Record<string, unknown>> = [];
  for (const icp of active as Array<{ workspace_id: string; company_fit: string; version: number }>) {
    const { data: rows, error } = await supabase
      .from("outreach_signals")
      .select("id, company_name, company_domain, company_industry, company_size, person_title")
      .eq("workspace_id", icp.workspace_id)
      .is("icp_score", null)
      .eq("handled", false)
      .order("identified_at", { ascending: false })
      .limit(BATCH_LIMIT);
    if (error) { perWorkspace.push({ workspace: icp.workspace_id, error: error.message }); continue; }
    if (!rows?.length) { perWorkspace.push({ workspace: icp.workspace_id, scored: 0 }); continue; }

    let scored = 0;
    for (const row of rows as SignalRow[]) {
      try {
        const { score, reasoning } = await scoreCompany(row, icp.company_fit);
        await supabase.from("outreach_signals").update({
          icp_score: score,
          icp_reasoning: reasoning,
          scored_at: new Date().toISOString(),
        }).eq("id", row.id);
        scored++;
      } catch (e) {
        // Leave icp_score null on transient failure — next cron tick retries.
        perWorkspace.push({ workspace: icp.workspace_id, signal: row.id, error: (e instanceof Error ? e.message : String(e)).slice(0, 160) });
      }
    }
    totalScored += scored;
    perWorkspace.push({ workspace: icp.workspace_id, scored, icp_version: icp.version });
  }
  return json({ ok: true, scored: totalScored, per_workspace: perWorkspace });
});

function buildSystemPrompt(companyFit: string): string {
  return `You score how well a B2B COMPANY fits the following ICP. The ICP
description names the company we sell for; do not assume otherwise.

${companyFit}

Return ONLY a JSON object, no markdown fences, no commentary:
{"score": int 1-10, "reasoning": "one short sentence on why"}

score = company fit: 10 = perfect ICP match, 7-9 = strong, 4-6 = partial, 1-3 = poor.
reasoning = one terse sentence, no preamble.`;
}

async function scoreCompany(row: SignalRow, companyFit: string): Promise<{ score: number; reasoning: string }> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const userBlock = [
    `Company: ${row.company_name ?? row.company_domain ?? "(unknown)"}`,
    `Domain: ${row.company_domain ?? "(unknown)"}`,
    `Industry: ${row.company_industry ?? "(unknown)"}`,
    `Size: ${row.company_size ?? "(unknown)"}`,
    `A visitor from this company had title: ${row.person_title ?? "(unknown)"}`,
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
      system: buildSystemPrompt(companyFit),
      messages: [{ role: "user", content: userBlock }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`haiku ${res.status}: ${body.slice(0, 160)}`);
  }
  const body = await res.json();
  const blocks = (body.content ?? []) as Array<{ type: string; text?: string }>;
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  const slice = start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped;
  const parsed = JSON.parse(slice) as { score?: number; reasoning?: string };
  return {
    score: Math.max(1, Math.min(10, Math.round(parsed.score ?? 5))),
    reasoning: (parsed.reasoning ?? "").slice(0, 500),
  };
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
