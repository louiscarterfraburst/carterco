// Hourly cron poll against Sendpilot's API to backfill leads where the
// connection.accepted webhook never landed. Mirrors the relevant branch of
// sendpilot-webhook so a polled lead ends up in the same state as one that
// arrived via webhook — pipeline row + sendspark render kicked off.
//
// Trigger:
//   - pg_cron: every hour at :00 (configured in supabase/outreach.sql)
//   - Manual: POST {} or POST {"campaignIds": ["..."]}
//
// Env:
//   SENDPILOT_API_KEY        — required
//   SENDPILOT_CAMPAIGN_IDS   — comma-separated campaign IDs to poll
//   SENDSPARK_API_KEY/SECRET/WORKSPACE/DYNAMIC — to render videos
//
// The function is idempotent: leads already in outreach_pipeline (matched by
// sendpilot_lead_id OR linkedin_url) are skipped, so re-runs don't re-render.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";
import { normalizeCompanyName, urlOrigin } from "../_shared/text.ts";

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

const SS_API_KEY = Deno.env.get("SENDSPARK_API_KEY") ?? "";
const SS_API_SECRET = Deno.env.get("SENDSPARK_API_SECRET") ?? "";
const SS_WORKSPACE = Deno.env.get("SENDSPARK_WORKSPACE") ?? "";
const SS_DYNAMIC = Deno.env.get("SENDSPARK_DYNAMIC") ?? "";

type SendPilotLead = {
  id: string;
  linkedinUrl: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  title?: string;
  status: string;
  campaignId: string;
};

type ProcessResult =
  | "skipped"
  | "rendering"
  | "invited"
  | "failed_no_email"
  | "no_outreach_lead"
  | "sendspark_fail";

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
    accepted_backfilled_rendering: 0,
    accepted_backfilled_failed: 0,
    accepted_not_in_outreach_leads: 0,
    accepted_sendspark_failures: 0,
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

    // CONNECTION_ACCEPTED + DONE — full webhook-equivalent flow with sendspark
    // render. SendPilot moves leads from CONNECTION_ACCEPTED to DONE once their
    // sequence completes; we treat DONE the same so accepted leads we missed
    // (webhook downtime, between-poll status flip) still get a video.
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
            case "rendering": summary.accepted_backfilled_rendering++; break;
            case "failed_no_email": summary.accepted_backfilled_failed++; break;
            case "no_outreach_lead": summary.accepted_not_in_outreach_leads++; break;
            case "sendspark_fail": summary.accepted_sendspark_failures++; break;
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

  if (!lead) {
    await supabase.from("outreach_pipeline").upsert({
      sendpilot_lead_id: leadId,
      linkedin_url: linkedinUrl,
      contact_email: "",
      is_cold: true,
      status: "failed",
      accepted_at: now,
      workspace_id: workspaceId,
      error: "lead not in outreach_leads CSV (poll)",
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
      error: "missing contact_email (poll)",
    }, { onConflict: "sendpilot_lead_id" });
    return "failed_no_email";
  }

  // Polled accepted leads are treated as cold — they slipped past the
  // webhook so we have no connection.sent signal to determine pre-connected
  // status. Worst case: a pre-connected lead gets rendered. That's preferable
  // to leaving them stranded.
  await supabase.from("outreach_pipeline").upsert({
    sendpilot_lead_id: leadId,
    linkedin_url: linkedinUrl,
    contact_email: lead.contact_email,
    is_cold: true,
    status: "rendering",
    accepted_at: now,
    workspace_id: workspaceId,
  }, { onConflict: "sendpilot_lead_id" });

  const renderRes = await sendsparkRender(lead, spLead.campaignId ?? "");
  if (!renderRes.ok) {
    await supabase.from("outreach_pipeline").update({
      status: "failed",
      error: `sendspark render failed (poll): HTTP ${renderRes.status} — ${renderRes.errorBody}`,
    }).eq("sendpilot_lead_id", leadId);
    return "sendspark_fail";
  }
  return "rendering";
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

// Per-campaign SendSpark dynamic override. Set SS_DYNAMIC_<sendpilotCampaignId>
// to point a specific SendPilot campaign at a different SendSpark dynamic;
// falls back to SENDSPARK_DYNAMIC. Mirrors the pickDynamic helper in
// sendpilot-webhook so both code paths agree.
function pickDynamic(campaignId: string): string {
  const id = (campaignId ?? "").trim();
  if (id) {
    const perCampaign = Deno.env.get(`SS_DYNAMIC_${id}`);
    if (perCampaign) return perCampaign;
  }
  return SS_DYNAMIC;
}

async function sendsparkRender(lead: Record<string, unknown>, campaignId: string = "") {
  const payload = {
    processAndAuthorizeCharge: true,
    prospect: {
      contactName: ((lead.first_name as string) ?? "").trim() || "there",
      contactEmail: lead.contact_email as string,
      company: normalizeCompanyName(lead.company as string).slice(0, 80),
      jobTitle: ((lead.title as string) ?? "").slice(0, 100),
      backgroundUrl: urlOrigin(lead.website as string),
    },
  };
  const dynamicId = pickDynamic(campaignId);
  const url =
    `https://api-gw.sendspark.com/v1/workspaces/${SS_WORKSPACE}/dynamics/${dynamicId}/prospect`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": SS_API_KEY,
      "x-api-secret": SS_API_SECRET,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (res.ok) return { ok: true, status: res.status, errorBody: "" };
  const errorBody = await res.text().catch(() => "");
  return { ok: false, status: res.status, errorBody: errorBody.slice(0, 400) };
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
