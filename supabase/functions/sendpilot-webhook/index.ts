// Receives SendPilot webhooks (delivered via Svix). Verifies the standard
// Svix signature scheme: HMAC-SHA256(base64-decoded(whsec_<...>),
// `${svix-id}.${svix-timestamp}.${body}`) base64-encoded, prefixed with v1,
// in the svix-signature header.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";
import { normalizeWebsiteUrl, firstNameForGreeting } from "../_shared/text.ts";
import { CARTERCO_WORKSPACE_ID, ODAGROUP_WORKSPACE_ID } from "../_shared/workspaces.ts";
import { draftFirstMessage } from "../_shared/draft-first-message.ts";
import { autoRenderEnabled, getDefaultPlayId, getPlayConfig, hookAllowed, playPaused, playStamp } from "../_shared/plays.ts";
import { sendsparkRender } from "../_shared/sendspark-render.ts";
import { fireReferralTitleSearch } from "../_shared/referral-search.ts";
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
    // Stamp the lead's play on every pipeline write below. Omitted (not null)
    // when unknown so the DB trigger fills the registry default on insert and
    // an existing tag survives on conflict.
    const play = playStamp(lead as { play?: string | null });

    // Referral detection: if this LinkedIn URL was invited via either a
    // reply_referral (named referral — prospect typed the name) or a
    // reply_referral_search (title-only referral — SendPilot found the URL)
    // alt_contact, capture the chain back to the referrer's pipeline. We stamp
    // referred_from_pipeline_lead_id so (a) sendspark-webhook picks the
    // referral-aware follow-up template instead of the cold opener, (b)
    // draft_first_message can open with the referral context for AI-DM
    // workspaces, and (c) the UI can show "Henvist af X". We do NOT inherit
    // the referrer's video — a fresh render preserves engagement tracking
    // (events keyed on contactEmail) and gets Morten's actual name in the
    // voice-over.
    const { data: refAlt } = await supabase
      .from("outreach_alt_contacts")
      .select("pipeline_lead_id")
      .in("source", ["reply_referral", "reply_referral_search"])
      .eq("linkedin_url", linkedinUrl)
      .maybeSingle();
    const referredFrom = refAlt?.pipeline_lead_id ?? null;

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
        ...play,
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
        ...play,
      }, { onConflict: "sendpilot_lead_id" });
      scheduleScoutPhones("pipeline", leadId);
      return json({ ok: true, recorded: "pre_connected_skipped" });
    }

    // OdaGroup branch: no SendSpark video. Write the pipeline row, then
    // call draftFirstMessage which writes rendered_message + strategy +
    // status='pending_approval' inline. The /outreach UI shows it in the
    // approval queue same as a CarterCo render. Errors fall through to
    // status='failed' so the row is visible for manual handling.
    if (workspaceId === ODAGROUP_WORKSPACE_ID) {
      // Hard blocklist: Novo Nordisk is Oda's flagship customer — never
      // outreach to anyone employed there, even if they slip through Sales
      // Nav filters. Belt-and-suspenders against the proof point becoming
      // an embarrassment ("we use it at Novo!" → recipient works at Novo).
      const companyLower = String(lead.company ?? "").toLowerCase();
      if (companyLower.includes("novo nordisk") || companyLower.includes("novonordisk")) {
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
          error: "workspace_blocklist: company is Novo Nordisk (Oda customer)",
          ...play,
        }, { onConflict: "sendpilot_lead_id" });
        return json({ ok: true, recorded: "blocked_novo_nordisk_employee" });
      }

      await supabase.from("outreach_pipeline").upsert({
        sendpilot_lead_id: leadId,
        linkedin_url: linkedinUrl,
        contact_email: lead.contact_email,
        is_cold: true,
        status: "pending_ai_draft",
        accepted_at: now,
        workspace_id: workspaceId,
        campaign_id: campaignId || null,
        sendpilot_sender_id: senderId || null,
        referred_from_pipeline_lead_id: referredFrom,
        ...play,
      }, { onConflict: "sendpilot_lead_id" });

      const draft = await draftFirstMessage(supabase, leadId);
      if ("error" in draft) {
        await supabase.from("outreach_pipeline").update({
          status: "failed",
          error: `draft_first_message: ${draft.error}`,
        }).eq("sendpilot_lead_id", leadId);
        return json({ ok: false, recorded: "accepted_draft_failed", error: draft.error });
      }
      scheduleScoutPhones("pipeline", leadId);
      return json({
        ok: true,
        recorded: "accepted_drafted_pending_approval",
        strategy: draft.envelope.strategy,
        language: draft.envelope.language,
      });
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
        ...play,
      }, { onConflict: "sendpilot_lead_id" });
      return json({ ok: false, error: "missing_website" });
    }

    // Tresyv customer blocklist: never pitch an existing Tresyv customer.
    // Match the lead's company against the Tresyv client library (word-
    // boundary, case-insensitive). On match, auto-reject and stop. Same
    // trust-break logic as the workspace-separation guards — sending to a
    // current customer is the brand-equivalent of sending from the wrong
    // account.
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
        return json({ ok: true, recorded: "blocked_tresyv_client", matched });
      }
    }

    // Tresyv 3-arm A/B: assign variant at accept time (locked by trigger).
    // v1_long / v2_short skip SendSpark — write rendered_message inline and
    // jump straight to pending_approval. v3_video keeps the existing flow.
    // CarterCo + OdaGroup accepts get no variant (null), behave as before.
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
      // Text arm: ready for approval immediately. No render gate, no
      // SendSpark credits burned. Operator opens INBOX → "Godkend videoer"
      // (which also surfaces text-arm pending_approval rows) and approves.
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
        referred_from_pipeline_lead_id: referredFrom,
        ...play,
      }, { onConflict: "sendpilot_lead_id" });
      scheduleScoutPhones("pipeline", leadId);
      return json({ ok: true, recorded: "accepted_text_arm_pending_approval", variant, referred_from: referredFrom });
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
      referred_from_pipeline_lead_id: referredFrom,
      first_dm_variant: variant, // null for non-Tresyv, "v3_video" for Tresyv video arm
      ...play,
    }, { onConflict: "sendpilot_lead_id" });

    scheduleScoutPhones("pipeline", leadId);
    // CarterCo only: generate the Becc-bucket personalization hook now (async),
    // so it's ready before the render completes and gets baked into the DM.
    // Plays with use_personalized_hook=false in the registry (e.g.
    // hiring_signal, which has its own dm_template) skip the Becc hook so
    // personalized_hook stays empty and the play's template wins. Paused
    // plays skip automation too (the row is still recorded + tagged above).
    // hookAllowed fails CLOSED on a registry lookup error.
    const playLookup = await getPlayConfig(supabase, lead?.play as string | undefined, workspaceId);
    if (workspaceId === CARTERCO_WORKSPACE_ID) {
      if (hookAllowed(playLookup) && !playPaused(playLookup)) scheduleEnrichBuckets(leadId);
    }

    // Auto-render plays (registry auto_render=true, e.g. hiring_signal) fire
    // the SendSpark render at accept instead of waiting for the operator's
    // pre-render release — the DM still parks in pending_approval afterwards
    // (sendspark-webhook), so the approved-text gate is untouched. Fails
    // closed: a registry lookup error keeps the manual gate; a render failure
    // leaves a visible failed status, never a silent skip. NB: auto_render
    // plays should keep use_personalized_hook=false — the async Becc hook
    // can't be guaranteed ready when the render starts.
    if (autoRenderEnabled(playLookup) && !playPaused(playLookup)) {
      // Claim BEFORE the paid external render: CAS pending_pre_render →
      // rendering. A redelivered accept or the webhook/poll race both pass
      // autoRenderEnabled; only the first claim fires SendSpark — the loser
      // sees 0 rows and skips, so the same accept never double-renders
      // (= double SendSpark charges + clashing render_ready callbacks).
      const { data: renderClaim } = await supabase
        .from("outreach_pipeline")
        .update({ status: "rendering" })
        .eq("sendpilot_lead_id", leadId)
        .eq("status", "pending_pre_render")
        .select("sendpilot_lead_id");
      if (!renderClaim || renderClaim.length === 0) {
        return json({ ok: true, recorded: "accepted_auto_render_already_claimed", cold: true, referred_from: referredFrom, variant });
      }
      const renderRes = await sendsparkRender(
        lead as Record<string, unknown>,
        campaignId ?? "",
        workspaceId,
      );
      if (!renderRes.ok) {
        await supabase.from("outreach_pipeline").update({
          status: "failed",
          error: `auto-render: HTTP ${renderRes.status} — ${renderRes.errorBody}`,
        }).eq("sendpilot_lead_id", leadId).eq("status", "rendering");
      }
      return json({
        ok: renderRes.ok,
        recorded: renderRes.ok ? "accepted_auto_rendering" : "accepted_auto_render_failed",
        cold: true,
        referred_from: referredFrom,
        variant,
      });
    }
    return json({ ok: true, recorded: "accepted_pending_pre_render", cold: true, referred_from: referredFrom, variant });
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
    // already replied. This was the Erik Mygind Nielsen incident.
    //
    // Also close any active sequence: the engagement-tick reply-guard
    // would block the actual send, but the row would stay in the UI's
    // "queued" view (sequence_completed_at IS NULL + sequence_parked_until
    // in the future). Closing here keeps UI in sync with reality and stops
    // the cron from even evaluating this row again.
    await supabase.from("outreach_pipeline").update({
      last_reply_at: now,
      sequence_completed_at: now,
      sequence_parked_until: null,
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
      // Declines/OOO don't need a response — auto-handle inline so they fall
      // out of the Svar tab immediately. Anything else stays unhandled until
      // the user explicitly marks it.
      const autoHandle = j.intent === "decline" || j.intent === "ooo";
      await supabase.from("outreach_replies").update({
        intent: j.intent,
        confidence: j.confidence,
        reasoning: j.reasoning,
        classified_at: now,
        handled: autoHandle ? true : undefined,
        referral_target_name:    isReferral ? (j.referralTarget?.name ?? null) : null,
        referral_target_title:   isReferral ? (j.referralTarget?.title ?? null) : null,
        referral_target_company: isReferral ? (j.referralTarget?.company ?? null) : null,
      }).eq("id", replyId);
      await supabase.from("outreach_pipeline").update({
        last_reply_at: now,
        last_reply_intent: j.intent,
        sequence_completed_at: now,
        sequence_parked_until: null,
      }).eq("sendpilot_lead_id", leadId);

      // Referral pivot: when the prospect points us at someone else, plant a
      // `reply_referral` outreach_alt_contacts row with the name Claude
      // extracted (linkedin_url=null). The UI surfaces this as a hint — the
      // user looks up Bjarne manually (LinkedIn search, mutual contacts,
      // company page) and pastes the URL before clicking invite.
      //
      // Title-only path ("kontakt vores COO" — no name): fire a SendPilot
      // lead-database search filtered by that title at the same company. The
      // existing poll-alt-searches cron picks it up and surfaces candidates
      // as referral / invite_pending rows in vw_action_queue.
      // Draftable intents trigger an automatic suggested-reply generation.
      // Decline/ooo/other don't get auto-drafts — they rarely need a reply.
      // Referral has its own alt-contact flow (handled below), so we skip
      // draft there too to avoid wasted Sonnet calls.
      const DRAFTABLE = new Set(["question", "interested"]);
      if (DRAFTABLE.has(j.intent)) {
        try {
          const draftUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/outreach-ai?op=draft_reply`;
          const draftRes = await fetch(draftUrl, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ replyId }),
          });
          if (draftRes.ok) {
            const dj = await draftRes.json() as { draft?: string };
            if (dj.draft) {
              await supabase.from("outreach_replies").update({
                suggested_reply: dj.draft,
                suggested_reply_generated_at: new Date().toISOString(),
              }).eq("id", replyId);
            }
          } else {
            console.error("draft_reply non-200", draftRes.status, await draftRes.text());
          }
        } catch (e) {
          console.error("draft_reply error", e);
        }
      }

      if (isReferral && j.referralTarget?.name) {
        const { data: pipe } = await supabase
          .from("outreach_pipeline")
          .select("workspace_id, contact_email")
          .eq("sendpilot_lead_id", leadId)
          .maybeSingle();
        const { data: origLead } = await supabase
          .from("outreach_leads")
          .select("company")
          .eq("contact_email", pipe?.contact_email ?? "")
          .maybeSingle();
        await supabase.from("outreach_alt_contacts").insert({
          pipeline_lead_id: leadId,
          workspace_id: pipe?.workspace_id ?? null,
          name: j.referralTarget.name,
          title: j.referralTarget.title ?? null,
          company: j.referralTarget.company ?? origLead?.company ?? null,
          linkedin_url: null,
          source: "reply_referral",
          surfaced_at: now,
        });
      } else if (isReferral && j.referralTarget?.title) {
        await fireReferralTitleSearch(supabase, leadId, j.referralTarget.title);
      }
  } catch (e) {
    console.error("classifyReplyAsync error", e);
  }
}

// Fire scout-phones in the background. Best-effort: failures are logged
// but don't fail the webhook. EdgeRuntime.waitUntil keeps the request open
// long enough for the scout call to complete before the function shuts down,
// which matters for both Supabase metering and avoiding orphaned fetches.
function scheduleEnrichBuckets(leadId: string): void {
  // deno-lint-ignore no-explicit-any
  const er: any = (globalThis as any).EdgeRuntime;
  const task = (async () => {
    try {
      const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/enrich-buckets`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ leadId }),
      });
      if (!res.ok) console.warn("enrich-buckets non-200", res.status, await res.text());
    } catch (e) {
      console.error("enrich-buckets fire error", leadId, e);
    }
  })();
  if (er && typeof er.waitUntil === "function") er.waitUntil(task);
}

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
      await supabase.from("outreach_leads")
        .update({ sendpilot_lead_id: sendpilotLeadId })
        .eq("linkedin_url", bySlug.linkedin_url);
      return bySlug;
    }
    // Fall through to lead_inbox staging table. Lets clients (currently
    // OdaGroup) upload cleaned leads to SendPilot without pre-seeding
    // outreach_leads — the row gets promoted to outreach_leads only on
    // connection.accepted, so the active pipeline table stays small
    // (~5% acceptance rate means ~95% of staged leads never need a row).
    const promoted = await promoteFromInbox(sendpilotLeadId, linkedinUrl, slug);
    if (promoted) return promoted;
  }
  return null;
}

// Promote a lead from lead_inbox → outreach_leads. Synthesises a contact_email
// (no real email available — it's just a stable join key for downstream tables
// like outreach_pipeline). Returns the new outreach_leads row, or null if no
// inbox match.
async function promoteFromInbox(
  sendpilotLeadId: string,
  linkedinUrl: string,
  slug: string,
): Promise<Record<string, unknown> | null> {
  if (!slug) return null;
  const { data: inbox } = await supabase
    .from("lead_inbox")
    .select("*")
    .eq("linkedin_slug", slug)
    .maybeSingle();
  if (!inbox) return null;
  const i = inbox as Record<string, string | null>;
  const wsId = String(i.workspace_id ?? "");
  if (!wsId) return null;
  const contactEmail = await synthesizeContactEmail(wsId, linkedinUrl, slug);
  const fullName = [i.first_name, i.last_name].filter(Boolean).join(" ").trim() || null;
  // Carry the staged play tag through promotion — but only a NON-default tag.
  // Inbox rows always carry a play (the DB trigger defaults them), so stamping
  // unconditionally would let a default-tagged inbox row downgrade a lead
  // pre-staged under a real play when the upsert conflicts on linkedin_url.
  // FAIL CLOSED when the default can't be resolved (null = error or
  // unconfigured): skipping the stamp risks nothing — an existing tag
  // survives the conflict and an insert gets the trigger default — while
  // stamping blind risks exactly the downgrade this guard exists to prevent.
  const defaultPlay = await getDefaultPlayId(supabase, wsId);
  if (!defaultPlay) {
    console.warn("promoteFromInbox: could not resolve default play — not stamping play on promotion", { slug });
  }
  const stagedPlay = (i.play ?? "").trim();
  const promotedPlay = defaultPlay && stagedPlay && stagedPlay !== defaultPlay ? { play: stagedPlay } : {};
  const { data: promoted, error } = await supabase
    .from("outreach_leads")
    .upsert({
      linkedin_url: i.linkedin_url ?? linkedinUrl,
      sendpilot_lead_id: sendpilotLeadId,
      first_name: i.first_name,
      last_name: i.last_name,
      full_name: fullName,
      company: i.company,
      title: i.title,
      country: i.country,
      vertical: (i as Record<string, string | null>).vertical ?? null,
      website: i.website ?? null,
      contact_email: contactEmail,
      slug,
      workspace_id: wsId,
      source: "lead_inbox",
      ...promotedPlay,
    }, { onConflict: "linkedin_url" })
    .select()
    .single();
  if (error) {
    console.error("promoteFromInbox upsert error", error);
    return null;
  }
  return promoted as Record<string, unknown>;
}

// Per-workspace synth email patterns. Real email is unavailable for cold
// LinkedIn leads — we just need a stable join key that won't collide with
// real customer emails. Uses SHA-1(url)[:6] suffix for collision safety,
// matching the pattern in scripts/lead-enrichment-v2/export_for_sendpilot.py.
async function synthesizeContactEmail(
  workspaceId: string,
  linkedinUrl: string,
  slug: string,
): Promise<string> {
  const cleanSlug = slug.slice(0, 30).replace(/[^a-z0-9-]/g, "-");
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(linkedinUrl));
  const hash = Array.from(new Uint8Array(buf))
    .slice(0, 3)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (workspaceId === ODAGROUP_WORKSPACE_ID) {
    return `kontakt+li-${cleanSlug}-${hash}@odagroup.dk`;
  }
  // Fallback — only OdaGroup uses lead_inbox right now. Adding a new client
  // means adding a branch here.
  return `noreply+li-${cleanSlug}-${hash}@example.invalid`;
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
