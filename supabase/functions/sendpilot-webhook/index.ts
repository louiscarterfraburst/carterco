// Receives SendPilot webhooks (delivered via Svix). Verifies the standard
// Svix signature scheme: HMAC-SHA256(base64-decoded(whsec_<...>),
// `${svix-id}.${svix-timestamp}.${body}`) base64-encoded, prefixed with v1,
// in the svix-signature header.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";
import { normalizeWebsiteUrl } from "../_shared/text.ts";
import { fireSendpilotLeadSearch } from "../_shared/sendpilot-client.ts";
import { ICP } from "../_shared/icp.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type SendPilotEvent = {
  eventId: string;
  eventType: string;
  timestamp?: string;
  workspaceId?: string;
  data: {
    leadId?: string;
    linkedinUrl?: string;
    campaignId?: string;
    senderId?: string;
    [k: string]: unknown;
  };
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

const SP_WEBHOOK_SECRET = Deno.env.get("SENDPILOT_WEBHOOK_SECRET") ?? "";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method === "GET") return json({ ok: true, name: "sendpilot-webhook" });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const rawBody = await request.text();

  if (SP_WEBHOOK_SECRET) {
    const ok = await verifySvix(request.headers, rawBody, SP_WEBHOOK_SECRET);
    if (!ok) {
      console.warn("svix verify failed", {
        sigPresent: !!request.headers.get("svix-signature"),
        idPresent: !!request.headers.get("svix-id"),
        tsPresent: !!request.headers.get("svix-timestamp"),
      });
      return json({ error: "Invalid signature" }, 401);
    }
  }

  let evt: SendPilotEvent;
  try { evt = JSON.parse(rawBody); }
  catch { return json({ error: "Invalid JSON" }, 400); }
  if (!evt.eventId || !evt.eventType) return json({ error: "Missing eventId/eventType" }, 400);

  // Look up lead first so we know which workspace owns this event.
  const data = evt.data ?? {};
  const leadId = (data.leadId ?? "").toString();
  const linkedinUrl = (data.linkedinUrl ?? "").toString();
  let campaignId = (data.campaignId ?? "").toString();
  const senderId = (data.senderId ?? "").toString();
  const lead = leadId ? await lookupLead(leadId, linkedinUrl) : null;
  const workspaceId = lead?.workspace_id ?? null;

  // Fallback for alts invited via /v1/inbox/connect (one-off, not
  // campaign-driven). The connection.accepted event may arrive with no
  // campaignId. invite-alt-contact planted outreach_leads.campaign_id with
  // the original lead's value precisely so we can pick it up here and the
  // SendSpark render uses the right dynamic template.
  if (!campaignId && lead && (lead as { campaign_id?: string }).campaign_id) {
    campaignId = String((lead as { campaign_id?: string }).campaign_id);
  }

  const { error: evtErr } = await supabase.from("outreach_events").insert({
    event_id: evt.eventId,
    source: "sendpilot",
    event_type: evt.eventType,
    source_workspace_id: evt.workspaceId ?? null,
    workspace_id: workspaceId,
    payload: evt,
  });
  if (evtErr && !`${evtErr.message}`.includes("duplicate key")) {
    console.error("event insert error", evtErr);
    return json({ error: "DB error", details: evtErr.message }, 500);
  }
  if (evtErr) return json({ ok: true, duplicate: true });

  if (!leadId) return json({ ok: true, ignored: "no leadId" });

  const now = new Date().toISOString();

  // SendPilot renamed event types at some point: connection.sent →
  // connection_request.sent, connection.accepted → connection_request.accepted,
  // message.received → reply.received. Accept both forms so we don't miss
  // events in either naming era.
  const evtType = evt.eventType;
  const isConnectionSent     = evtType === "connection.sent"     || evtType === "connection_request.sent";
  const isConnectionAccepted = evtType === "connection.accepted" || evtType === "connection_request.accepted";
  const isReplyReceived      = evtType === "message.received"    || evtType === "reply.received";

  if (isConnectionSent) {
    await supabase.rpc("outreach_record_invite", {
      _lead_id: leadId,
      _linkedin_url: linkedinUrl,
      _contact_email: lead?.contact_email ?? "",
      _invited_at: now,
    });
    return json({ ok: true, recorded: "invited" });
  }

  if (isConnectionAccepted) {
    const { data: existing } = await supabase
      .from("outreach_pipeline")
      .select("status,is_cold,contact_email")
      .eq("sendpilot_lead_id", leadId)
      .maybeSingle();
    const cold = existing?.status === "invited";

    if (!lead?.contact_email) {
      await supabase.from("outreach_pipeline").upsert({
        sendpilot_lead_id: leadId,
        linkedin_url: linkedinUrl,
        contact_email: "",
        is_cold: cold,
        status: "failed",
        accepted_at: now,
        workspace_id: workspaceId,
        campaign_id: campaignId || null,
        sendpilot_sender_id: senderId || null,
        error: "lead not in outreach_leads CSV",
      }, { onConflict: "sendpilot_lead_id" });
      return json({ ok: true, recorded: "accepted_no_lead" });
    }

    // Pre-connected leads (already in Rasmus's network before this campaign)
    // never get a SendSpark render. Mark them pre_connected and stop. The
    // cockpit can surface them so we can decide manually who's worth a video.
    if (!cold) {
      await supabase.from("outreach_pipeline").upsert({
        sendpilot_lead_id: leadId,
        linkedin_url: linkedinUrl,
        contact_email: lead.contact_email,
        is_cold: false,
        status: "pre_connected",
        accepted_at: now,
        workspace_id: workspaceId,
        campaign_id: campaignId || null,
        sendpilot_sender_id: senderId || null,
      }, { onConflict: "sendpilot_lead_id" });
      return json({ ok: true, recorded: "pre_connected_skipped" });
    }

    // Pause gate: campaigns listed in SENDSPARK_PAUSED_CAMPAIGNS skip the
    // render entirely. Don't write a pipeline row — the cron poll will
    // back-fill the lead via CONNECTION_ACCEPTED status when the pause is
    // lifted, so we don't lose progress. Audit trail lives in
    // outreach_events (already inserted above).
    if (isCampaignPaused(campaignId)) {
      return json({ ok: true, recorded: "render_paused", campaignId });
    }

    // Gate: a missing website turns the SendSpark render into a video shot
    // against the workspace's fallback (carterco.dk) — useless and confusing
    // for the prospect. Mark the row failed and surface it for manual fix.
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
      }, { onConflict: "sendpilot_lead_id" });
      return json({ ok: false, error: "missing_website" });
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
    }, { onConflict: "sendpilot_lead_id" });

    return json({ ok: true, recorded: "accepted_pending_pre_render", cold: true });
  }

  if (isReplyReceived) {
    // SendPilot renamed the field at some point: data.message → data.reply.
    // Accept all three forms so we don't silently drop the body and stamp
    // recorded:'reply_empty' (which is exactly how we missed Michael Bjørn's
    // reply on 2026-05-11 — the message text was in data.reply).
    const replyText = String(
      (data as Record<string, unknown>)["reply"]
        ?? (data as Record<string, unknown>)["message"]
        ?? (data as Record<string, unknown>)["messagePreview"]
        ?? "",
    ).trim();
    if (!replyText) return json({ ok: true, recorded: "reply_empty" });

    const { data: replyRow, error: insErr } = await supabase
      .from("outreach_replies")
      .insert({
        sendpilot_lead_id: leadId,
        linkedin_url: linkedinUrl,
        message: replyText,
        workspace_id: workspaceId,
      })
      .select()
      .single();
    if (insErr) {
      console.error("reply insert error", insErr);
      return json({ ok: false, error: "reply insert failed", details: insErr.message }, 500);
    }

    // CRITICAL: set last_reply_at SYNCHRONOUSLY before doing anything async.
    // Previously this update lived inside classifyReplyAsync — meaning if
    // the classify call failed or was slow, last_reply_at never got set
    // and engagement-tick happily fired follow-ups on a lead who had
    // already replied. This was the Erik Mygind Nielsen incident:
    // reply landed, classification path was broken (renamed event types,
    // webhook outage etc.), last_reply_at stayed null, follow-up went out.
    //
    // The `replied` signal must be authoritative the moment a reply is
    // recorded. Intent classification is a nice-to-have that can be
    // backfilled later; the safety guard cannot.
    await supabase.from("outreach_pipeline").update({
      last_reply_at: now,
    }).eq("sendpilot_lead_id", leadId);

    // Fire intent classification (best effort, async, only enriches data).
    // deno-lint-ignore no-explicit-any
    const er: any = (globalThis as any).EdgeRuntime;
    const task = classifyReplyAsync(replyRow.id, replyText, leadId, lead);
    if (er && typeof er.waitUntil === "function") er.waitUntil(task);
    return json({ ok: true, recorded: "reply", replyId: replyRow.id });
  }

  return json({ ok: true, ignored: evt.eventType });
});

async function classifyReplyAsync(
  replyId: string,
  text: string,
  leadId: string,
  lead: { first_name?: string; company?: string } | null,
): Promise<void> {
  try {
      const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/outreach-ai?op=classify_reply`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          lead: { firstName: lead?.first_name, company: lead?.company },
        }),
      });
      if (!res.ok) {
        console.error("classify_reply non-200", res.status, await res.text());
        return;
      }
      const j = await res.json() as {
        intent: string;
        confidence: number;
        reasoning: string;
        referralTarget?: { name?: string; title?: string; company?: string };
      };
      const now = new Date().toISOString();
      const isReferral = j.intent === "referral";
      await supabase.from("outreach_replies").update({
        intent: j.intent,
        confidence: j.confidence,
        reasoning: j.reasoning,
        classified_at: now,
        referral_target_name:    isReferral ? (j.referralTarget?.name ?? null) : null,
        referral_target_title:   isReferral ? (j.referralTarget?.title ?? null) : null,
        referral_target_company: isReferral ? (j.referralTarget?.company ?? null) : null,
      }).eq("id", replyId);
      await supabase.from("outreach_pipeline").update({
        last_reply_at: now,
        last_reply_intent: j.intent,
      }).eq("sendpilot_lead_id", leadId);

      // Referral pivot: when the prospect points us at someone else, do two
      // things:
      //   1. Plant a `reply_referral` outreach_alt_contacts row with the name
      //      Claude extracted (linkedin_url=null). This is the "hint" — the
      //      user can read it and know who the prospect actually meant.
      //   2. Fire a SendPilot lead-database search against the original
      //      company so the existing poll-alt-searches cron back-fills the
      //      alt_contacts table with 5 real candidates from that company
      //      (one of them is hopefully the same person the prospect named).
      //
      // Both rows land in the same alt-review UI panel; the user picks the
      // one that matches the referral and invites them. We only spawn this
      // when Claude actually extracted a name — "talk to someone else" with
      // no name still needs manual follow-up.
      if (isReferral && j.referralTarget?.name) {
        const { data: pipe } = await supabase
          .from("outreach_pipeline")
          .select("workspace_id, contact_email, alt_search_id")
          .eq("sendpilot_lead_id", leadId)
          .maybeSingle();
        const { data: origLead } = await supabase
          .from("outreach_leads")
          .select("company")
          .eq("contact_email", pipe?.contact_email ?? "")
          .maybeSingle();
        const company = j.referralTarget.company ?? origLead?.company ?? null;

        await supabase.from("outreach_alt_contacts").insert({
          pipeline_lead_id: leadId,
          workspace_id: pipe?.workspace_id ?? null,
          name: j.referralTarget.name,
          title: j.referralTarget.title ?? null,
          company,
          linkedin_url: null,
          source: "reply_referral",
          surfaced_at: now,
        });

        // Kick a SendPilot lead-database search for the company so the user
        // gets profile URLs they can actually invite. poll-alt-searches will
        // pick it up on the next 2-min cron tick.
        if (company) {
          const searchOut = await fireSendpilotLeadSearch({
            apiKey: Deno.env.get("SENDPILOT_API_KEY") ?? "",
            companyName: company,
            titles: ICP.alternateSearchTitles,
            locations: ICP.alternateSearchLocations,
          });
          if (searchOut.id) {
            await supabase.from("outreach_pipeline").update({
              alt_search_id: searchOut.id,
              alt_search_status: "pending",
            }).eq("sendpilot_lead_id", leadId);
          }
        }
      }
  } catch (e) {
    console.error("classifyReplyAsync error", e);
  }
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
  } catch { return ""; }
}

// Kill switch for SendSpark renders by SendPilot campaignId. Set
// SENDSPARK_PAUSED_CAMPAIGNS=<id1>,<id2> in env to suppress all video
// renders for those campaigns. Used to avoid burning SendSpark credits
// while a campaign is parked. LinkedIn invites still flow (SendPilot
// drives those independently); we just skip the render step.
function isCampaignPaused(campaignId: string): boolean {
  const list = Deno.env.get("SENDSPARK_PAUSED_CAMPAIGNS") ?? "";
  if (!list || !campaignId) return false;
  return list.split(",").map((s) => s.trim()).includes(campaignId);
}

async function verifySvix(headers: Headers, rawBody: string, secret: string): Promise<boolean> {
  const svixId = headers.get("svix-id");
  const svixTs = headers.get("svix-timestamp");
  const svixSig = headers.get("svix-signature");
  if (!svixId || !svixTs || !svixSig) return false;
  const ts = Number(svixTs);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 600) return false;

  // Svix signing: secret is base64 after stripping whsec_ prefix.
  const b64 = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let secretBytes: Uint8Array;
  try {
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    secretBytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    secretBytes = new TextEncoder().encode(secret);
  }
  const key = await crypto.subtle.importKey(
    "raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const data = `${svixId}.${svixTs}.${rawBody}`;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  const expected = btoa(String.fromCharCode(...sig));
  const candidates = svixSig.split(/\s+/);
  return candidates.some((c) => c.replace(/^v1,/, "") === expected);
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
