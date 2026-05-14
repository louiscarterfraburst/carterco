// signal-search-people
//
// Fires a SendPilot lead-database search for the company on an outreach_signals
// row. Uses the workspace's active ICP titles + locations so results are
// pre-filtered to decision-makers we'd actually want to outreach.
//
// Returns immediately after the search is kicked off. poll-alt-searches picks
// it up on its next 2-min cron tick, fetches results, and writes them to
// outreach_alt_contacts with signal_id set (pipeline_lead_id null).
//
// Auth: requires user JWT (UI calls via supabase.functions.invoke).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";
import { fireSendpilotLeadSearch } from "../_shared/sendpilot-client.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SP_API_KEY = Deno.env.get("SENDPILOT_API_KEY") ?? "";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method === "GET") return json({ ok: true, name: "signal-search-people" });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!SP_API_KEY) return json({ error: "SENDPILOT_API_KEY not configured" }, 500);

  let body: { signalId?: string };
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const signalId = body.signalId;
  if (!signalId) return json({ error: "signalId required" }, 400);

  const { data: signal, error: sigErr } = await supabase
    .from("outreach_signals")
    .select("id, workspace_id, company_name, company_domain, alt_search_id, alt_search_status")
    .eq("id", signalId)
    .single();
  if (sigErr || !signal) return json({ error: "signal not found", details: sigErr?.message }, 404);

  if (!signal.company_name) {
    return json({ error: "signal has no company_name — can't search" }, 400);
  }

  if (signal.alt_search_status === "pending") {
    return json({ ok: true, message: "already pending", search_id: signal.alt_search_id });
  }

  // Active ICP for this workspace gives us titles + locations to narrow the search.
  // Without an active ICP we fall back to a broad title net so the search still works.
  const { data: icp } = await supabase
    .from("icp_versions")
    .select("alternate_search_titles, alternate_search_locations")
    .eq("workspace_id", signal.workspace_id)
    .eq("is_active", true)
    .maybeSingle();

  const titles = (icp?.alternate_search_titles as string[] | undefined) ?? [
    "CEO", "Founder", "Owner", "Managing Director", "VP Sales", "Head of Sales", "Sales Director",
  ];
  const locations = (icp?.alternate_search_locations as string[] | undefined) ?? ["Denmark"];

  const search = await fireSendpilotLeadSearch({
    apiKey: SP_API_KEY,
    companyName: signal.company_name,
    titles,
    locations,
    limit: 5,
  });
  if (!search.id) {
    return json({ ok: false, error: "sendpilot search failed", details: search.error }, 502);
  }

  const { error: updErr } = await supabase
    .from("outreach_signals")
    .update({
      alt_search_id: search.id,
      alt_search_status: "pending",
    })
    .eq("id", signalId);
  if (updErr) return json({ ok: false, error: "DB update failed", details: updErr.message }, 500);

  return json({
    ok: true,
    signal_id: signalId,
    search_id: search.id,
    titles_used: titles,
    locations_used: locations,
    company: signal.company_name,
  });
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
