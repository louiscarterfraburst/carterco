// Receives SendPilot webhooks (delivered via Svix). Verifies the standard
// Svix signature scheme: HMAC-SHA256(base64-decoded(whsec_<...>),
// `${svix-id}.${svix-timestamp}.${body}`) base64-encoded, prefixed with v1,
// in the svix-signature header.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";
import { normalizeCompanyName, urlOrigin } from "../_shared/text.ts";

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
const SS_API_KEY = Deno.env.get("SENDSPARK_API_KEY") ?? "";
const SS_API_SECRET = Deno.env.get("SENDSPARK_API_SECRET") ?? "";
const SS_WORKSPACE = Deno.env.get("SENDSPARK_WORKSPACE") ?? "";
const SS_DYNAMIC = Deno.env.get("SENDSPARK_DYNAMIC") ?? "";

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
  const campaignId = (data.campaignId ?? "").toString();
  const lead = leadId ? await lookupLead(leadId, linkedinUrl) : null;
  const workspaceId = lead?.workspace_id ?? null;

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

  if (evt.eventType === "connection.sent") {
    await supabase.rpc("outreach_record_invite", {
      _lead_id: leadId,
      _linkedin_url: linkedinUrl,
      _contact_email: lead?.contact_email ?? "",
      _invited_at: now,
    });
    return json({ ok: true, recorded: "invited" });
  }

  if (evt.eventType === "connection.accepted") {
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
      }, { onConflict: "sendpilot_lead_id" });
      return json({ ok: true, recorded: "pre_connected_skipped" });
    }

    await supabase.from("outreach_pipeline").upsert({
      sendpilot_lead_id: leadId,
      linkedin_url: linkedinUrl,
      contact_email: lead.contact_email,
      is_cold: true,
      status: "rendering",
      accepted_at: now,
      workspace_id: workspaceId,
      campaign_id: campaignId || null,
    }, { onConflict: "sendpilot_lead_id" });

    const renderRes = await sendsparkRender(lead, campaignId);
    if (!renderRes.ok) {
      await supabase.from("outreach_pipeline").update({
        status: "failed",
        error: `sendspark render failed: HTTP ${renderRes.status}`,
      }).eq("sendpilot_lead_id", leadId);
      return json({ ok: false, error: "sendspark render failed", status: renderRes.status });
    }
    return json({ ok: true, recorded: "accepted_rendering", cold: true });
  }

  if (evt.eventType === "message.received") {
    const replyText = String(
      (data as Record<string, unknown>)["message"]
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

    // Fire intent classification (best effort).
    // Keep the runtime alive while we classify after responding.
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
      };
      const now = new Date().toISOString();
      await supabase.from("outreach_replies").update({
        intent: j.intent,
        confidence: j.confidence,
        reasoning: j.reasoning,
        classified_at: now,
      }).eq("id", replyId);
      await supabase.from("outreach_pipeline").update({
        last_reply_at: now,
        last_reply_intent: j.intent,
      }).eq("sendpilot_lead_id", leadId);
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

// Pick the SendSpark dynamic to render against. Per-campaign override:
// set SS_DYNAMIC_<sendpilotCampaignId> in the function env to point a
// specific SendPilot campaign at a different SendSpark dynamic (e.g. for
// a parallel "form-followup" angle). Falls back to SENDSPARK_DYNAMIC.
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
  const url = `https://api-gw.sendspark.com/v1/workspaces/${SS_WORKSPACE}/dynamics/${dynamicId}/prospect`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": SS_API_KEY,
      "x-api-secret": SS_API_SECRET,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return { ok: res.ok, status: res.status };
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
