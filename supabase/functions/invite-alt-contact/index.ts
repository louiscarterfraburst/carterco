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
import { firstNameForGreeting } from "../_shared/text.ts";

// Default connect-note template for reply_referral alt_contacts. Tunable
// via OUTREACH_REFERRAL_CONNECT_NOTE env var; substitutions: {firstName}
// (recipient), {referrerFirstName} (original prospect who pointed us to
// them). Kept compact for LinkedIn's 300-char note limit.
const REFERRAL_CONNECT_NOTE_DEFAULT =
  "Hej {firstName}, {referrerFirstName} sagde jeg skulle prikke til dig — har en kort video til dig";

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
    .select("sendpilot_lead_id, workspace_id, contact_email, sendpilot_sender_id, campaign_id")
    .eq("sendpilot_lead_id", alt.pipeline_lead_id)
    .maybeSingle();
  if (origErr) return json({ error: "db fetch orig", details: origErr.message }, 500);
  if (!orig) return json({ error: "original pipeline row not found" }, 404);
  if (!orig.sendpilot_sender_id) {
    return json({ error: "original has no sendpilot_sender_id (cannot send connection)" }, 400);
  }

  const { data: origLead } = await admin
    .from("outreach_leads")
    .select("first_name, company, website")
    .eq("contact_email", orig.contact_email ?? "")
    .maybeSingle();

  const now = new Date().toISOString();
  const isReplyReferral = alt.source === "reply_referral";

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
  }, { onConflict: "linkedin_url" });

  // Connect-note: if the caller supplied one, use it verbatim. Otherwise
  // for reply_referral alts, default to a referral-aware note so Morten sees
  // "Justyna sagde jeg skulle prikke til dig" instead of a bare connect.
  // For sendpilot/team_page alts we still send bare (higher accept rate on
  // cold connects).
  let connectMessage = body.messageOverride?.trim() ?? "";
  if (!connectMessage && isReplyReferral) {
    const template = Deno.env.get("OUTREACH_REFERRAL_CONNECT_NOTE") || REFERRAL_CONNECT_NOTE_DEFAULT;
    connectMessage = template
      .replaceAll("{firstName}", altFirst || "der")
      .replaceAll("{referrerFirstName}", firstNameForGreeting(origLead?.first_name) || "vores fælles kontakt");
  }

  const connectRes = await fetch("https://api.sendpilot.ai/v1/inbox/connect", {
    method: "POST",
    headers: { "X-API-Key": SP_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      senderId: orig.sendpilot_sender_id,
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
