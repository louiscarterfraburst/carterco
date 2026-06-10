// User-triggered from the /outreach UI. Pushes an alternate contact
// (suggested by SendPilot's lead-database for a wrong-person row) into
// CarterCo's connection-request flow:
//
//   1. Validate caller + the alt_contact / pipeline row.
//   2. Plant an outreach_leads row for the alternate using website + company
//      from the original (so the future SendSpark render renders for the
//      right company once they accept).
//   3. POST /v1/inbox/connect with the original's senderId.
//   4. Stamp acted_on_at on the alt_contact + alt_decided_at on the original
//      pipeline row.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";
import { createHash } from "node:crypto";
import { canonicalSenderFor } from "../_shared/workspaces.ts";
import { getPlayConfig, playPaused, playStamp } from "../_shared/plays.ts";
// firstNameForGreeting was used by the old referral connect-note default;
// kept the import nuked when we ripped out auto-notes. If a future caller
// passes body.messageOverride that needs templating, do the substitution
// at the call site, not here.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ALLOWED = new Set(["louis@carterco.dk", "rm@tresyv.dk", "haugefrom@haugefrom.com"]);
const SP_API_KEY = Deno.env.get("SENDPILOT_API_KEY") ?? "";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = request.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "missing bearer" }, 401);

  // Two valid caller types:
  // - service role (poll-alt-searches auto-fire): no user identity, but the
  //   caller is trusted infra. invite-alt-contact attribution is 'auto'.
  // - user JWT (UI button): validated through Supabase Auth + workspace allowlist.
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const isServiceRole = SERVICE_ROLE.length > 0 && token === SERVICE_ROLE;
  let email = "auto";
  if (!isServiceRole) {
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "",
      { global: { headers: { Authorization: `Bearer ${token}` } } },
    );
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return json({ error: "invalid auth" }, 401);
    email = (user.email ?? "").toLowerCase();
    if (!ALLOWED.has(email)) return json({ error: "forbidden" }, 403);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  let body: { altContactId?: string; messageOverride?: string };
  try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
  const altContactId = (body.altContactId ?? "").trim();
  if (!altContactId) return json({ error: "altContactId required" }, 400);

  // Fetch the alternate contact + original pipeline lead in two queries.
  const { data: alt, error: altErr } = await admin
    .from("outreach_alt_contacts")
    .select("*")
    .eq("id", altContactId)
    .maybeSingle();
  if (altErr) return json({ error: "db fetch alt", details: altErr.message }, 500);
  if (!alt) return json({ error: "alt_contact not found" }, 404);
  if (alt.acted_on_at) return json({ error: "alt already acted on" }, 409);

  const { data: orig, error: origErr } = await admin
    .from("outreach_pipeline")
    .select("sendpilot_lead_id, workspace_id, contact_email, sendpilot_sender_id, campaign_id, play")
    .eq("sendpilot_lead_id", alt.pipeline_lead_id)
    .maybeSingle();
  if (origErr) return json({ error: "db fetch orig", details: origErr.message }, 500);
  if (!orig) return json({ error: "original pipeline row not found" }, 404);

  // Workspace drift guard: alt_contacts are inserted with workspace_id =
  // parent pipeline's workspace_id (poll-alt-searches + sendpilot-webhook).
  // If they ever diverge (manual edit, corrupt import, future bug), refuse
  // the send. Codex flagged that the planted lead later uses alt.workspace_id
  // while we invite from orig.workspace_id's sender — drift would let the
  // accept webhook resolve the wrong workspace downstream.
  if (alt.workspace_id !== orig.workspace_id) {
    return json({
      error: "workspace mismatch between alt_contact and parent pipeline — refusing send",
      alt_workspace_id: alt.workspace_id,
      pipeline_workspace_id: orig.workspace_id,
    }, 409);
  }

  // Canonical sender lookup: never trust orig.sendpilot_sender_id blindly.
  // The workspace_senders table is the source of truth — we send under THAT
  // account regardless of what's stamped on the pipeline row. Prevents
  // cross-workspace contamination if pipeline data drifts.
  const canonicalSenderId = await canonicalSenderFor(admin, orig.workspace_id as string);
  if (!canonicalSenderId) {
    return json({
      error: "no canonical sender registered for workspace — add a row to workspace_senders",
      workspace_id: orig.workspace_id,
    }, 500);
  }
  if (orig.sendpilot_sender_id && orig.sendpilot_sender_id !== canonicalSenderId) {
    console.warn("invite-alt-contact: pipeline sender mismatch — using canonical", {
      pipeline_lead_id: orig.sendpilot_lead_id,
      pipeline_sender: orig.sendpilot_sender_id,
      canonical_sender: canonicalSenderId,
      workspace_id: orig.workspace_id,
    });
  }

  const { data: origLead } = await admin
    .from("outreach_leads")
    .select("first_name, company, website")
    .eq("contact_email", orig.contact_email ?? "")
    .maybeSingle();

  const now = new Date().toISOString();
  // Both reply_referral (named referral, no URL) and reply_referral_search
  // (title-only referral → SendPilot-found URL) use the referral connect note.
  // They share the same UX semantics: the prospect pointed us at someone.
  const isReplyReferral = alt.source === "reply_referral" || alt.source === "reply_referral_search";

  // Pause gate: firing a brand-new connection request IS automation, so a
  // paused play must stop it — same contract as the accept/render/sequence
  // paths (intake stays, outbound halts). The alt inherits the referrer's
  // play (playStamp(orig) below), so that's the play whose pause applies.
  const altPlayLookup = await getPlayConfig(admin, (orig as { play?: string | null }).play, alt.workspace_id);
  if (playPaused(altPlayLookup)) {
    return json({ error: "play is paused — alt-contact invite not sent (resume the play or invite manually)" }, 409);
  }

  // Plant an outreach_leads row for the alternate so the future accept
  // webhook can look them up by linkedin_url and the SendSpark render uses
  // the same company/website context. campaign_id mirrors the original so
  // sendpilot-webhook can fall back to it when the connection.accepted
  // event payload has no campaignId (the /v1/inbox/connect path is one-off,
  // not campaign-driven, so the event may arrive bare).
  const altContactEmail = synthContactEmail(alt.linkedin_url);
  const [altFirst, ...altRest] = (alt.name as string).trim().split(/\s+/);
  await admin.from("outreach_leads").upsert({
    linkedin_url: alt.linkedin_url,
    first_name: altFirst,
    last_name: altRest.join(" "),
    full_name: alt.name,
    company: alt.company ?? (origLead?.company ?? null),
    title: alt.title ?? null,
    website: origLead?.website ?? null,
    contact_email: altContactEmail,
    workspace_id: alt.workspace_id,
    campaign_id: orig.campaign_id ?? null,
    // The alt belongs to the same motion as the lead who referred them —
    // inherit the play so the accept webhook stamps it onto the pipeline.
    ...playStamp(orig),
  }, { onConflict: "linkedin_url" });

  // Connect-note policy: never auto-attach a note. Bare connects out-perform
  // note-bearing connects across the board (LinkedIn flags noted invites as
  // outreach; bare looks like a normal professional connection). Referral
  // context — including the referrer's name — moves to the post-accept first
  // DM, where there's room to do it right.
  //
  // The only way a note goes out now is if the caller explicitly supplies
  // body.messageOverride. UI buttons can still pass one for one-off cases;
  // the auto-fire path from poll-alt-searches never does.
  const connectMessage = body.messageOverride?.trim() ?? "";

  const connectRes = await fetch("https://api.sendpilot.ai/v1/inbox/connect", {
    method: "POST",
    headers: { "X-API-Key": SP_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      senderId: canonicalSenderId,
      recipientLinkedinUrl: alt.linkedin_url,
      ...(connectMessage ? { message: connectMessage } : {}),
    }),
  });
  let connectBody: unknown = null;
  try { connectBody = await connectRes.json(); } catch { /* ignore */ }
  const success = connectRes.status === 200 || connectRes.status === 201;

  // Update the alt_contact row regardless of success — we want the audit trail.
  await admin.from("outreach_alt_contacts").update({
    acted_on_at: now,
    invite_response: connectBody,
    error: success ? null : `connect HTTP ${connectRes.status}`,
  }).eq("id", altContactId);

  if (success) {
    // For ICP-rejected pivots: flip orig status to 'rejected_by_icp' so it
    // leaves the pending_alt_review bucket. For reply_referrals: the orig
    // prospect actually replied (politely pointed us to someone else), so
    // we keep their pipeline as-is (last_reply_at already gates follow-ups).
    const origUpdate: Record<string, unknown> = {
      alt_decided_at: now,
      alt_decided_by: email,
    };
    if (!isReplyReferral) origUpdate.status = "rejected_by_icp";
    await admin.from("outreach_pipeline").update(origUpdate).eq("sendpilot_lead_id", alt.pipeline_lead_id);

    // For reply_referrals: sendpilot-webhook resolves the referrer at
    // connection.accepted time by looking up outreach_alt_contacts on the
    // recipient's linkedin_url (alt.pipeline_lead_id then points back to
    // the referrer's pipeline row). Avoids racing the SendPilot-assigned
    // leadId, which is unknown at invite time.
  }

  return json({
    ok: success,
    status: connectRes.status,
    response: connectBody,
  }, success ? 200 : 502);
});

// Mirror export_for_sendpilot.py's contact_email synthesis. SHA-1 over the
// stripped URL, take the first 6 chars; slugify the last URL segment.
function synthContactEmail(linkedinUrl: string): string {
  const trimmed = linkedinUrl.replace(/\/+$/, "");
  const last = trimmed.split("/").pop() ?? "alt";
  const slug = last.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
  const hash = createHash("sha1").update(trimmed).digest("hex").slice(0, 6);
  return `carterco+li-${slug}-${hash}@carterco.dk`;
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
