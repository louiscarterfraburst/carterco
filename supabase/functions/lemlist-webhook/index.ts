// lemlist-webhook — handles inbound lemlist activity events for the CarterCo
// outreach campaign. Mirrors sendpilot-webhook's CarterCo accept branch so the
// rest of the /outreach flow (enrich-buckets → SendSpark render → approval
// gate → follow-up sequences) works identically regardless of which tool sent
// the LinkedIn invite.
//
// Phase 1: handles linkedinInviteAccepted only. linkedinReplied / SendDone /
// other events are logged and ignored until Phase 2.
//
// Webhook URL to register in lemlist: https://<project>.supabase.co/functions/v1/lemlist-webhook
//
// Auth: deployed with verify_jwt=false (lemlist doesn't send a JWT). If
// LEMLIST_WEBHOOK_SECRET is set, lemlist must include that exact string in the
// payload's `secret` field — otherwise we reject the request.
//
// Payload shape (per lemlist docs):
//   { _id, type, teamId, campaignId, campaignName, leadId,
//     leadEmail, leadFirstName, leadLastName, sendUserEmail, secret? }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";
import { CARTERCO_WORKSPACE_ID } from "../_shared/workspaces.ts";
import { getPlayConfig, hookAllowed, playPaused, playStamp } from "../_shared/plays.ts";
import { sendsparkCredsFor } from "../_shared/sendspark-config.ts";
import { firstNameForGreeting, normalizeCompanyName, urlOrigin } from "../_shared/text.ts";

const SS_DYNAMIC = Deno.env.get("SENDSPARK_DYNAMIC") ?? "";

function pickDynamic(campaignId: string): string {
  const id = (campaignId ?? "").trim();
  if (id) {
    const perCampaign = Deno.env.get(`SS_DYNAMIC_${id}`);
    if (perCampaign) return perCampaign;
  }
  return SS_DYNAMIC;
}

// Mirrors outreach-approve.sendsparkRender — kicks the per-prospect render so
// it's ready by the time the human opens the approval card.
async function kickSendsparkRender(
  lead: { first_name?: string | null; company?: string | null; title?: string | null; website?: string | null; contact_email: string },
  campaignId = "",
) {
  const creds = sendsparkCredsFor(CARTERCO_WORKSPACE_ID);
  if (creds.source === "missing") {
    console.warn("kickSendsparkRender: no SendSpark creds for CarterCo workspace");
    return { ok: false, status: 0 };
  }
  const payload = {
    processAndAuthorizeCharge: true,
    prospect: {
      contactName: firstNameForGreeting(lead.first_name) || "there",
      contactEmail: lead.contact_email,
      company: normalizeCompanyName(lead.company ?? "").slice(0, 80),
      jobTitle: (lead.title ?? "").slice(0, 100),
      backgroundUrl: urlOrigin(lead.website ?? ""),
    },
  };
  const dynamicId = pickDynamic(campaignId);
  const url = `https://api-gw.sendspark.com/v1/workspaces/${creds.workspace}/dynamics/${dynamicId}/prospect`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": creds.apiKey,
      "x-api-secret": creds.apiSecret,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    console.warn("kickSendsparkRender failed", { status: r.status, body: body.slice(0, 300) });
  }
  return { ok: r.ok, status: r.status };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const LEMLIST_API_KEY = Deno.env.get("LEMLIST_API") ?? "";
const LEMLIST_WEBHOOK_SECRET = Deno.env.get("LEMLIST_WEBHOOK_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

function lemlistAuth(): Record<string, string> {
  return { Authorization: "Basic " + btoa(":" + LEMLIST_API_KEY) };
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type LemlistEvent = {
  _id?: string;
  type?: string;
  teamId?: string;
  campaignId?: string;
  campaignName?: string;
  leadId?: string;
  leadEmail?: string | null;
  leadFirstName?: string | null;
  leadLastName?: string | null;
  sendUserEmail?: string | null;
  secret?: string;
};

// Lemlist webhooks don't include linkedinUrl on linkedin* events. Pull the
// full lead record so we can match it to outreach_leads.
async function fetchLemlistLead(leadId: string): Promise<Record<string, unknown> | null> {
  const r = await fetch(
    `https://api.lemlist.com/api/leads?id=${encodeURIComponent(leadId)}&version=v2`,
    { headers: lemlistAuth() },
  );
  if (!r.ok) {
    console.warn("fetchLemlistLead failed", { leadId, status: r.status });
    return null;
  }
  try {
    return await r.json();
  } catch (e) {
    console.warn("fetchLemlistLead parse failed", { leadId, err: String(e) });
    return null;
  }
}

// Fire-and-forget enrich-buckets so the bucket-hook is ready before render.
function scheduleEnrichBuckets(leadId: string) {
  fetch(`${SUPABASE_URL}/functions/v1/enrich-buckets`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ leadId }),
  }).catch((e) => console.error("scheduleEnrichBuckets failed", e));
}

// Pause the lemlist lead so its linkedinSend step doesn't fire until
// outreach-approve resumes it after the human approves the rendered DM.
async function pauseLemlistLead(leadId: string): Promise<boolean> {
  const r = await fetch(`https://api.lemlist.com/api/leads/pause/${leadId}`, {
    method: "POST",
    headers: lemlistAuth(),
  });
  if (!r.ok) {
    console.warn("pauseLemlistLead failed", {
      leadId, status: r.status, body: await r.text(),
    });
    return false;
  }
  return true;
}

async function handleInviteAccepted(evt: LemlistEvent) {
  const lemlistLeadId = String(evt.leadId ?? "").trim();
  const lemlistCampaignId = String(evt.campaignId ?? "").trim();
  if (!lemlistLeadId || !lemlistCampaignId) {
    return { ok: false, reason: "missing leadId or campaignId" };
  }

  const lead = await fetchLemlistLead(lemlistLeadId);
  if (!lead) return { ok: false, reason: "fetchLemlistLead returned null" };

  const linkedinUrl = String((lead as Record<string, unknown>).linkedinUrl ?? "").trim();
  if (!linkedinUrl) return { ok: false, reason: "lemlist lead has no linkedinUrl" };

  const { data: leadRow } = await supabase
    .from("outreach_leads")
    .select("contact_email, first_name, last_name, company, title, website, play")
    .eq("workspace_id", CARTERCO_WORKSPACE_ID)
    .eq("linkedin_url", linkedinUrl)
    .maybeSingle();

  if (!leadRow) {
    // Surfaces an import-flow gap rather than silently dropping.
    console.warn("lemlist accept with no matching outreach_leads row", {
      lemlistLeadId, linkedinUrl,
    });
    return { ok: false, reason: "no matching outreach_leads row" };
  }

  // sendpilot_lead_id is the pipeline PK. For lemlist-sourced rows we use the
  // lemlist leadId as-is — lemlist IDs (lea_…) don't collide with the cuids
  // SendPilot uses.
  const pipelineKey = lemlistLeadId;
  const now = new Date().toISOString();

  await supabase.from("outreach_pipeline").upsert({
    sendpilot_lead_id: pipelineKey,
    linkedin_url: linkedinUrl,
    contact_email: leadRow.contact_email,
    is_cold: true,
    status: "pending_pre_render",
    accepted_at: now,
    workspace_id: CARTERCO_WORKSPACE_ID,
    invite_source: "lemlist",
    lemlist_lead_id: lemlistLeadId,
    lemlist_campaign_id: lemlistCampaignId,
    ...playStamp(leadRow),
  }, { onConflict: "sendpilot_lead_id" });

  await pauseLemlistLead(lemlistLeadId);

  // Paused play: the lead is recorded + tagged above and the lemlist sequence
  // is paused, but no automation fires (no hook, no SendSpark render). The
  // row parks at pending_pre_render for the operator.
  const playLookup = await getPlayConfig(supabase, leadRow.play, CARTERCO_WORKSPACE_ID);
  if (playPaused(playLookup)) {
    return { ok: true, recorded: "accepted_play_paused", pipelineKey };
  }

  // Plays with use_personalized_hook=false in the registry keep their own
  // dm_template — no Becc bucket-hook for them (mirrors sendpilot-webhook).
  // hookAllowed fails CLOSED on a registry lookup error.
  if (hookAllowed(playLookup)) scheduleEnrichBuckets(pipelineKey);

  // Auto-fire SendSpark render so the rendered video is ready by the time the
  // human opens the approval card. Status flips to 'rendering' to surface the
  // in-flight state; sendspark-webhook then bakes the message + PATCHes back
  // to lemlist when render_ready arrives.
  const render = await kickSendsparkRender(
    {
      first_name: leadRow.first_name,
      company: leadRow.company,
      title: leadRow.title,
      website: leadRow.website,
      contact_email: leadRow.contact_email,
    },
    lemlistCampaignId,
  );
  if (render.ok) {
    await supabase.from("outreach_pipeline").update({
      status: "rendering",
    }).eq("sendpilot_lead_id", pipelineKey);
  } else {
    await supabase.from("outreach_pipeline").update({
      error: `auto-render failed: HTTP ${render.status}`,
    }).eq("sendpilot_lead_id", pipelineKey);
  }

  return {
    ok: true,
    recorded: "accepted_pending_pre_render",
    pipelineKey,
    render: render.ok ? "kicked" : `failed:${render.status}`,
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method === "GET") return json({ ok: true, name: "lemlist-webhook" });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let evt: LemlistEvent;
  try { evt = await request.json(); }
  catch { return json({ error: "invalid JSON" }, 400); }

  if (LEMLIST_WEBHOOK_SECRET && evt.secret !== LEMLIST_WEBHOOK_SECRET) {
    return json({ error: "invalid secret" }, 401);
  }

  const type = String(evt.type ?? "").trim();
  console.log("lemlist-webhook", {
    type, leadId: evt.leadId, campaignId: evt.campaignId,
  });

  if (type === "linkedinInviteAccepted") {
    const result = await handleInviteAccepted(evt);
    return json(result);
  }

  // Phase 2 events — log + ignore for now.
  return json({ ok: true, ignored: type });
});
