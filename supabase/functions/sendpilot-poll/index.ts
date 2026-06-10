// Hourly cron poll against Sendpilot's API to backfill leads where the
// connection.accepted webhook never landed. Mirrors the relevant branch of
// sendpilot-webhook so a polled lead ends up in the same state as one that
// arrived via webhook — pipeline row parked for pre-render review.
//
// Trigger:
//   - pg_cron: every hour at :00 (configured in supabase/outreach.sql)
//   - Manual: POST {} or POST {"campaignIds": ["..."]}
//
// Env:
//   SENDPILOT_API_KEY        — required
//   SENDPILOT_CAMPAIGN_IDS   — comma-separated campaign IDs to poll
//
// The function is idempotent: leads already in outreach_pipeline (matched by
// sendpilot_lead_id OR linkedin_url) are skipped, so re-runs don't re-render.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";
import { normalizeWebsiteUrl, firstNameForGreeting } from "../_shared/text.ts";
import { autoRenderEnabled, getPlayConfig, playPaused, playStamp } from "../_shared/plays.ts";
import { sendsparkRender } from "../_shared/sendspark-render.ts";
import { matchTresyvClient } from "../_shared/tresyv-clients.ts";
import {
  assignFirstDmVariant,
  renderTresyvBody,
  TRESYV_V1_LONG,
  TRESYV_V2_SHORT,
  type FirstDmVariant,
} from "../_shared/tresyv-arm-templates.ts";

const TRESYV_WORKSPACE_ID = "2740ba1f-d5d5-4008-bf43-b45367c73134";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

const SP_API_KEY = Deno.env.get("SENDPILOT_API_KEY") ?? "";
const SP_CAMPAIGN_IDS = (Deno.env.get("SENDPILOT_CAMPAIGN_IDS") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

type SendPilotLead = {
  id: string;
  linkedinUrl: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  title?: string;
  status: string;
  campaignId: string;
  // SendPilot's API includes the senderId on each lead since it's the
  // sender LinkedIn account that issued the invite. Required by
  // /v1/inbox/send so we capture it on the pipeline row.
  senderId?: string;
};

type ProcessResult =
  | "skipped"
  | "pending_pre_render"
  | "rendering"
  | "invited"
  | "failed_no_email"
  | "no_outreach_lead"
  | "sendspark_fail"
  | "missing_website";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method === "GET") return json({ ok: true, name: "sendpilot-poll" });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!SP_API_KEY) return json({ ok: false, error: "SENDPILOT_API_KEY not set" }, 500);

  let bodyJson: { campaignIds?: string[] } = {};
  try {
    if (req.headers.get("content-length") !== "0") {
      bodyJson = (await req.json().catch(() => ({}))) as { campaignIds?: string[] };
    }
  } catch { /* ignore */ }

  const campaignIds = bodyJson.campaignIds ?? SP_CAMPAIGN_IDS;
  if (!campaignIds.length) {
    return json({
      ok: false,
      error: "no campaign IDs (set SENDPILOT_CAMPAIGN_IDS env var or pass {\"campaignIds\":[...]})",
    }, 400);
  }

  const summary = {
    campaigns: 0,
    sent_fetched: 0,
    sent_recorded: 0,
    sent_skipped: 0,
    accepted_fetched: 0,
    accepted_skipped_already_in_pipeline: 0,
    accepted_backfilled_pending_pre_render: 0,
    accepted_backfilled_rendering: 0,
    accepted_backfilled_failed: 0,
    accepted_not_in_outreach_leads: 0,
    accepted_sendspark_failures: 0,
    accepted_missing_website: 0,
    errors: [] as string[],
  };

  for (const campaignId of campaignIds) {
    summary.campaigns++;

    // CONNECTION_SENT — record invites idempotently via outreach_record_invite RPC.
    try {
      const sentLeads = await fetchLeadsByStatus(campaignId, "CONNECTION_SENT");
      summary.sent_fetched += sentLeads.length;
      for (const lead of sentLeads) {
        try {
          const result = await processInvitedLead(lead);
          if (result === "skipped") summary.sent_skipped++;
          else summary.sent_recorded++;
        } catch (e) {
          summary.errors.push(`sent lead ${lead.id}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      summary.errors.push(`campaign ${campaignId} (sent): ${(e as Error).message}`);
    }

    // CONNECTION_ACCEPTED + DONE — full webhook-equivalent flow that parks
    // the lead for human pre-render review. SendPilot moves leads from CONNECTION_ACCEPTED to DONE once their
    // sequence completes; we treat DONE the same so accepted leads we missed
    // (webhook downtime, between-poll status flip) still reach the review queue.
    try {
      const acceptedLeads = await fetchLeadsByStatus(campaignId, "CONNECTION_ACCEPTED");
      const doneLeads = await fetchLeadsByStatus(campaignId, "DONE");
      const allAccepted = [...acceptedLeads, ...doneLeads];
      summary.accepted_fetched += allAccepted.length;
      for (const lead of allAccepted) {
        try {
          const result = await processAcceptedLead(lead);
          switch (result) {
            case "skipped": summary.accepted_skipped_already_in_pipeline++; break;
            case "pending_pre_render": summary.accepted_backfilled_pending_pre_render++; break;
            case "rendering": summary.accepted_backfilled_rendering++; break;
            case "failed_no_email": summary.accepted_backfilled_failed++; break;
            case "no_outreach_lead": summary.accepted_not_in_outreach_leads++; break;
            case "sendspark_fail": summary.accepted_sendspark_failures++; break;
            case "missing_website": summary.accepted_missing_website++; break;
          }
        } catch (e) {
          summary.errors.push(`accepted lead ${lead.id}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      summary.errors.push(`campaign ${campaignId} (accepted): ${(e as Error).message}`);
    }
  }

  return json({ ok: true, summary });
});

async function fetchLeadsByStatus(campaignId: string, status: string): Promise<SendPilotLead[]> {
  const all: SendPilotLead[] = [];
  let page = 1;
  const limit = 100;
  while (page <= 50) {
    const url =
      `https://api.sendpilot.ai/v1/leads?campaignId=${encodeURIComponent(campaignId)}` +
      `&status=${encodeURIComponent(status)}&page=${page}&limit=${limit}`;
    const res = await fetch(url, { headers: { "X-API-Key": SP_API_KEY } });
    if (!res.ok) {
      throw new Error(`Sendpilot API ${res.status}: ${await res.text().catch(() => "")}`);
    }
    const j = (await res.json()) as {
      leads: SendPilotLead[];
      pagination?: { totalPages?: number };
    };
    all.push(...(j.leads ?? []));
    const totalPages = j.pagination?.totalPages ?? 1;
    if (page >= totalPages) break;
    page++;
  }
  return all;
}

async function processInvitedLead(spLead: SendPilotLead): Promise<"recorded" | "skipped"> {
  const leadId = spLead.id;
  const linkedinUrl = spLead.linkedinUrl ?? "";

  // If the pipeline already has any state for this person (invited/accepted/rendering/sent/etc),
  // skip — RPC is idempotent but no need to spam it.
  const { data: byId } = await supabase
    .from("outreach_pipeline")
    .select("sendpilot_lead_id, invited_at")
    .eq("sendpilot_lead_id", leadId)
    .maybeSingle();
  if (byId?.invited_at) return "skipped";
  if (linkedinUrl) {
    const { data: byUrl } = await supabase
      .from("outreach_pipeline")
      .select("sendpilot_lead_id, invited_at")
      .eq("linkedin_url", linkedinUrl)
      .maybeSingle();
    if (byUrl?.invited_at) return "skipped";
  }

  // Self-heal stale Sendpilot lead ID via slug if needed.
  const lead = await lookupLead(leadId, linkedinUrl);
  await supabase.rpc("outreach_record_invite", {
    _lead_id: leadId,
    _linkedin_url: linkedinUrl,
    _contact_email: lead?.contact_email ?? "",
    _invited_at: new Date().toISOString(),
  });
  return "recorded";
}

async function processAcceptedLead(spLead: SendPilotLead): Promise<ProcessResult> {
  const leadId = spLead.id;
  const linkedinUrl = spLead.linkedinUrl ?? "";

  // Skip only if the row is already past invited (accepted_at filled). A row
  // in 'invited' state is exactly what we need to upgrade — earlier this was
  // the webhook's job, but since the webhook went silent we have to treat the
  // poll as the upgrade path too.
  const { data: byId } = await supabase
    .from("outreach_pipeline")
    .select("sendpilot_lead_id, accepted_at")
    .eq("sendpilot_lead_id", leadId)
    .maybeSingle();
  if (byId?.accepted_at) return "skipped";
  if (!byId && linkedinUrl) {
    const { data: byUrl } = await supabase
      .from("outreach_pipeline")
      .select("sendpilot_lead_id, accepted_at")
      .eq("linkedin_url", linkedinUrl)
      .maybeSingle();
    if (byUrl?.accepted_at) return "skipped";
  }

  const lead = await lookupLead(leadId, linkedinUrl);
  const workspaceId = (lead?.workspace_id as string | null) ?? null;
  const now = new Date().toISOString();
  // Stamp the lead's play on every pipeline write below. Omitted (not null)
  // when unknown so the DB trigger fills the registry default on insert and
  // an existing tag survives on conflict.
  const play = playStamp(lead as { play?: string | null });

  const campaignId = spLead.campaignId ?? "";
  const senderId = spLead.senderId ?? "";

  // Pause gate: skip both pipeline upsert and render so we don't spend
  // SendSpark credits while a campaign is parked. The lead stays in
  // CONNECTION_ACCEPTED on SendPilot's side; when the pause lifts, the
  // next poll will pick it up and process normally.
  if (isCampaignPaused(campaignId)) {
    return "skipped";
  }

  if (!lead) {
    await supabase.from("outreach_pipeline").upsert({
      sendpilot_lead_id: leadId,
      linkedin_url: linkedinUrl,
      contact_email: "",
      is_cold: true,
      status: "failed",
      accepted_at: now,
      workspace_id: workspaceId,
      campaign_id: campaignId || null,
      sendpilot_sender_id: senderId || null,
      error: "lead not in outreach_leads CSV (poll)",
      ...play,
    }, { onConflict: "sendpilot_lead_id" });
    return "no_outreach_lead";
  }

  if (!lead.contact_email) {
    await supabase.from("outreach_pipeline").upsert({
      sendpilot_lead_id: leadId,
      linkedin_url: linkedinUrl,
      contact_email: "",
      is_cold: true,
      status: "failed",
      accepted_at: now,
      workspace_id: workspaceId,
      campaign_id: campaignId || null,
      sendpilot_sender_id: senderId || null,
      error: "missing contact_email (poll)",
      ...play,
    }, { onConflict: "sendpilot_lead_id" });
    return "failed_no_email";
  }

  // Polled accepted leads are treated as cold — they slipped past the
  // webhook so we have no connection.sent signal to determine pre-connected
  // status. Worst case: a pre-connected lead gets rendered. That's preferable
  // to leaving them stranded.
  // Gate: empty website → SendSpark renders against workspace fallback
  // (carterco.dk). Skip render and mark failed so we notice + fix the lead
  // rather than ship a generic video.
  if (!normalizeWebsiteUrl(lead.website)) {
    await supabase.from("outreach_pipeline").upsert({
      sendpilot_lead_id: leadId,
      linkedin_url: linkedinUrl,
      contact_email: lead.contact_email,
      is_cold: true,
      status: "failed",
      accepted_at: now,
      workspace_id: workspaceId,
      campaign_id: campaignId || null,
      sendpilot_sender_id: senderId || null,
      error: "missing_website: lead.website empty — render skipped to avoid carterco.dk fallback",
      ...play,
    }, { onConflict: "sendpilot_lead_id" });
    return "missing_website";
  }

  // Tresyv customer blocklist: never pitch an existing Tresyv customer.
  // Mirrors the check in sendpilot-webhook. Both ingress points must enforce
  // it (the poll catches accepts the webhook missed due to delivery flakes).
  if (workspaceId === TRESYV_WORKSPACE_ID) {
    const matched = matchTresyvClient(lead.company);
    if (matched) {
      await supabase.from("outreach_pipeline").upsert({
        sendpilot_lead_id: leadId,
        linkedin_url: linkedinUrl,
        contact_email: lead.contact_email,
        is_cold: true,
        status: "rejected",
        accepted_at: now,
        workspace_id: workspaceId,
        campaign_id: campaignId || null,
        sendpilot_sender_id: senderId || null,
        decided_at: now,
        decided_by: "auto:tresyv_client_blocklist",
        error: `existing Tresyv client (${matched}) — blocked from outreach`,
        ...play,
      }, { onConflict: "sendpilot_lead_id" });
      return "blocked_tresyv_client";
    }
  }

  // Tresyv 3-arm A/B: same assignment + routing logic as sendpilot-webhook.
  // The poll catches accepts the webhook missed (delivery failures, replays),
  // so both ingress paths MUST do the same coin flip + arm routing.
  let variant: FirstDmVariant | null = null;
  let renderedMessage: string | null = null;
  if (workspaceId === TRESYV_WORKSPACE_ID) {
    variant = assignFirstDmVariant();
    if (variant === "v1_long" || variant === "v2_short") {
      const fn = firstNameForGreeting(lead.first_name);
      const ws = normalizeWebsiteUrl(lead.website);
      const tpl = variant === "v1_long" ? TRESYV_V1_LONG : TRESYV_V2_SHORT;
      renderedMessage = renderTresyvBody(tpl, fn, ws);
    }
  }

  if (variant === "v1_long" || variant === "v2_short") {
    await supabase.from("outreach_pipeline").upsert({
      sendpilot_lead_id: leadId,
      linkedin_url: linkedinUrl,
      contact_email: lead.contact_email,
      is_cold: true,
      status: "pending_approval",
      accepted_at: now,
      queued_at: now,
      rendered_at: now,
      rendered_message: renderedMessage,
      first_dm_variant: variant,
      workspace_id: workspaceId,
      campaign_id: campaignId || null,
      sendpilot_sender_id: senderId || null,
      ...play,
    }, { onConflict: "sendpilot_lead_id" });
    scheduleScoutPhones("pipeline", leadId);
    return "pending_approval_text_arm";
  }

  await supabase.from("outreach_pipeline").upsert({
    sendpilot_lead_id: leadId,
    linkedin_url: linkedinUrl,
    contact_email: lead.contact_email,
    is_cold: true,
    status: "pending_pre_render",
    accepted_at: now,
    workspace_id: workspaceId,
    campaign_id: campaignId || null,
    sendpilot_sender_id: senderId || null,
    first_dm_variant: variant, // null or "v3_video"
    ...play,
  }, { onConflict: "sendpilot_lead_id" });

  scheduleScoutPhones("pipeline", leadId);

  // Auto-render plays: same branch as sendpilot-webhook — the poll catches
  // accepts the webhook missed, so both ingress paths must route identically.
  // Fails closed (lookup error → manual gate; render failure → visible
  // failed status).
  const playLookup = await getPlayConfig(supabase, lead?.play as string | undefined, workspaceId);
  if (autoRenderEnabled(playLookup) && !playPaused(playLookup)) {
    const renderRes = await sendsparkRender(
      lead as Record<string, unknown>,
      campaignId ?? "",
      workspaceId,
    );
    await supabase.from("outreach_pipeline").update({
      status: renderRes.ok ? "rendering" : "failed",
      error: renderRes.ok ? null : `auto-render: HTTP ${renderRes.status} — ${renderRes.errorBody}`,
    }).eq("sendpilot_lead_id", leadId);
    return renderRes.ok ? "accepted_auto_rendering" : "accepted_auto_render_failed";
  }
  return "pending_pre_render";
}

// Fire scout-phones in the background. Best-effort: failures are logged
// but don't fail the poll. EdgeRuntime.waitUntil keeps the function alive
// long enough for the scout call to complete. Mirrors the helper in
// sendpilot-webhook so polled-accept leads get phone enrichment with the
// same latency as webhook-accept leads.
function scheduleScoutPhones(kind: "pipeline" | "alt", id: string): void {
  // deno-lint-ignore no-explicit-any
  const er: any = (globalThis as any).EdgeRuntime;
  const task = (async () => {
    try {
      const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/scout-phones`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ kind, id }),
      });
      if (!res.ok) {
        console.warn("scout-phones non-200", res.status, await res.text());
      }
    } catch (e) {
      console.error("scout-phones fire error", kind, id, e);
    }
  })();
  if (er && typeof er.waitUntil === "function") er.waitUntil(task);
}

async function lookupLead(sendpilotLeadId: string, linkedinUrl: string) {
  const { data: byId } = await supabase
    .from("outreach_leads")
    .select("*")
    .eq("sendpilot_lead_id", sendpilotLeadId)
    .maybeSingle();
  if (byId) return byId;
  if (linkedinUrl) {
    const slug = linkedinSlug(linkedinUrl);
    const { data: bySlug } = await supabase
      .from("outreach_leads")
      .select("*")
      .eq("slug", slug)
      .maybeSingle();
    if (bySlug) {
      // Self-heal the stale Sendpilot lead ID so subsequent webhook events
      // can match by ID directly.
      await supabase.from("outreach_leads")
        .update({ sendpilot_lead_id: sendpilotLeadId })
        .eq("linkedin_url", bySlug.linkedin_url);
      return bySlug;
    }
  }
  return null;
}

function linkedinSlug(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    return (path.split("/").pop() ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  } catch {
    return "";
  }
}

// Kill switch for SendSpark renders. Mirrors sendpilot-webhook's helper.
function isCampaignPaused(campaignId: string): boolean {
  const list = Deno.env.get("SENDSPARK_PAUSED_CAMPAIGNS") ?? "";
  if (!list || !campaignId) return false;
  return list.split(",").map((s) => s.trim()).includes(campaignId);
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
