// User-triggered from /outreach Læring tab. Promotes an open proposal to a
// new active icp_version. Atomic: deactivate current, insert new, mark
// proposal applied — all in one go.
//
// Reject path: just sets proposal.status='rejected' without creating a
// version.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ALLOWED = new Set(["louis@carterco.dk", "rm@tresyv.dk", "haugefrom@haugefrom.com"]);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

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

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  let body: { proposalId?: string; decision?: "apply" | "reject" };
  try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
  const proposalId = (body.proposalId ?? "").trim();
  const decision = body.decision;
  if (!proposalId || (decision !== "apply" && decision !== "reject")) {
    return json({ error: "proposalId + decision (apply|reject) required" }, 400);
  }

  const { data: proposal, error: pErr } = await admin
    .from("icp_tuning_proposals")
    .select("*")
    .eq("id", proposalId)
    .maybeSingle();
  if (pErr) return json({ error: "db fetch", details: pErr.message }, 500);
  if (!proposal) return json({ error: "proposal not found" }, 404);
  const p = proposal as {
    id: string;
    workspace_id: string;
    current_version_id: string | null;
    status: string;
    proposed_company_fit: string | null;
    proposed_person_fit: string | null;
    proposed_min_company_score: number | null;
    proposed_min_person_score: number | null;
    rationale: string;
  };
  if (p.status !== "open") return json({ error: `proposal is ${p.status}, not open` }, 409);

  const now = new Date().toISOString();

  if (decision === "reject") {
    await admin.from("icp_tuning_proposals").update({
      status: "rejected",
      decided_at: now,
      decided_by: email,
    }).eq("id", proposalId);
    return json({ ok: true, decision: "rejected" });
  }

  // Apply: fetch current active version (to use as base for unmodified fields).
  const { data: current } = await admin
    .from("icp_versions")
    .select("*")
    .eq("workspace_id", p.workspace_id)
    .eq("is_active", true)
    .maybeSingle();
  if (!current) return json({ error: "no active version to base the new one on" }, 500);
  const cur = current as {
    id: string;
    version: number;
    company_fit: string;
    person_fit: string;
    alternate_search_titles: string[];
    alternate_search_locations: string[];
    min_company_score: number;
    min_person_score: number;
  };

  // Deactivate current.
  await admin.from("icp_versions").update({ is_active: false }).eq("id", cur.id);

  // Insert new version with proposed values where set, otherwise inherit
  // from current. Bump version number.
  const { data: newVersion, error: insErr } = await admin.from("icp_versions").insert({
    workspace_id: p.workspace_id,
    version: cur.version + 1,
    company_fit: p.proposed_company_fit ?? cur.company_fit,
    person_fit: p.proposed_person_fit ?? cur.person_fit,
    alternate_search_titles: cur.alternate_search_titles,
    alternate_search_locations: cur.alternate_search_locations,
    min_company_score: p.proposed_min_company_score ?? cur.min_company_score,
    min_person_score: p.proposed_min_person_score ?? cur.min_person_score,
    is_active: true,
    created_by: email,
    parent_version_id: cur.id,
    rationale: p.rationale,
  }).select().single();
  if (insErr) {
    // Roll back deactivation if insert failed.
    await admin.from("icp_versions").update({ is_active: true }).eq("id", cur.id);
    return json({ error: "version insert failed", details: insErr.message }, 500);
  }

  await admin.from("icp_tuning_proposals").update({
    status: "applied",
    decided_at: now,
    decided_by: email,
    becomes_version_id: (newVersion as { id: string }).id,
  }).eq("id", proposalId);

  return json({
    ok: true,
    decision: "applied",
    new_version_id: (newVersion as { id: string }).id,
    new_version_number: cur.version + 1,
  });
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
