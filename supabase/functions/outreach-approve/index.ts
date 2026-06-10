// Approval endpoint called from the /outreach UI. Authenticated user must
// be a member of the lead's workspace (workspace_members). Actions:
//   approve → status='approved_queued' + scheduled_send_at (drip queue —
//             the outreach-send-queue cron sends it; approving NEVER fires
//             the DM directly, so batch approvals can't burst-send)
//   unqueue → approved_queued → pending_approval (operator cancel before send)
//   reject  → status='rejected'
//   render  → POST /v1/dynamics/.../prospect → kicks a SendSpark render
//             for any accepted/pre-render/failed lead.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";
import { checkLeadReplied } from "../_shared/sendpilot-client.ts";
import { sendsparkRender } from "../_shared/sendspark-render.ts";
import { nextSendSlot, type SlotClaim } from "../_shared/send-queue.ts";
import { getDefaultPlayId } from "../_shared/plays.ts";
import { canonicalSenderFor } from "../_shared/workspaces.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SP_API_KEY = Deno.env.get("SENDPILOT_API_KEY") ?? "";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Auth: rely on Supabase verify_jwt (it auto-validates Authorization Bearer
  // <jwt>) and read the user from the token.
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
  if (!email) return json({ error: "forbidden" }, 403);

  // Service-role client for mutations.
  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  let body: { leadId?: string; replyId?: string; decision?: string; messageOverride?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const decision = (body.decision ?? "").toLowerCase();
  if (!["approve", "reject", "render", "reply", "unqueue"].includes(decision)) {
    return json({ error: "decision must be one of: approve | reject | render | reply | unqueue" }, 400);
  }

  // Reply path uses replyId (the inbound row we're responding to). Look up
  // the reply, then resolve the pipeline row from its sendpilot_lead_id.
  // Approve/reject/render use leadId directly.
  let leadId = (body.leadId ?? "").trim();
  let replyRow: { id: string; sendpilot_lead_id: string; suggested_reply: string | null; handled: boolean } | null = null;
  if (decision === "reply") {
    const replyId = (body.replyId ?? "").trim();
    if (!replyId) return json({ error: "replyId required for decision=reply" }, 400);
    const { data: r, error: rErr } = await admin
      .from("outreach_replies")
      .select("id, sendpilot_lead_id, suggested_reply, handled, direction")
      .eq("id", replyId)
      .maybeSingle();
    if (rErr) return json({ error: "db fetch reply", details: rErr.message }, 500);
    if (!r) return json({ error: "reply not found" }, 404);
    if (r.direction !== "inbound") return json({ error: "can only reply to inbound messages" }, 400);
    leadId = r.sendpilot_lead_id;
    replyRow = r as typeof replyRow;
  } else if (!leadId) {
    return json({ error: "leadId required" }, 400);
  }

  // Fetch the pipeline row.
  const { data: pipe, error: fetchErr } = await admin
    .from("outreach_pipeline")
    .select("sendpilot_lead_id, contact_email, linkedin_url, status, rendered_message, video_link, accepted_at, sent_at, workspace_id, sendpilot_sender_id, campaign_id, invite_source, lemlist_lead_id, lemlist_campaign_id, play")
    .eq("sendpilot_lead_id", leadId)
    .maybeSingle();
  if (fetchErr) return json({ error: "db fetch", details: fetchErr.message }, 500);
  if (!pipe) return json({ error: "lead not found" }, 404);

  // Workspace authorization: the authed user must be a member of the lead's
  // workspace. Replaces the old hard-coded operator allowlist so any
  // workspace member (e.g. Caroline on OdaGroup) can approve their own
  // workspace's leads.
  if (!pipe.workspace_id) {
    return json({ error: "lead has no workspace_id" }, 409);
  }
  const { data: membership, error: memErr } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", pipe.workspace_id)
    .eq("user_email", email)
    .maybeSingle();
  if (memErr) return json({ error: "db fetch membership", details: memErr.message }, 500);
  if (!membership) return json({ error: "forbidden" }, 403);

  // Canonical sender: always look up from workspace_senders, never trust the
  // pipeline row blindly. If the pipeline row was stamped with a wrong
  // sender_id (legacy data, manual edit, bug), the workspace_senders table
  // is the source of truth and we'd rather send from the right account than
  // honor a corrupt value. If pipeline.sender is missing, the canonical
  // lookup also serves as the backfill source.
  const resolvedSenderId = await canonicalSenderFor(admin, pipe.workspace_id as string);
  if (pipe.sendpilot_sender_id && resolvedSenderId && pipe.sendpilot_sender_id !== resolvedSenderId) {
    console.warn("outreach-approve: pipeline sender mismatch — using canonical", {
      lead: leadId,
      pipeline_sender: pipe.sendpilot_sender_id,
      canonical_sender: resolvedSenderId,
      workspace_id: pipe.workspace_id,
    });
  }
  if (resolvedSenderId && !pipe.sendpilot_sender_id) {
    // Backfill so the action queue / phone-scout etc see the right value.
    await admin.from("outreach_pipeline")
      .update({ sendpilot_sender_id: resolvedSenderId })
      .eq("sendpilot_lead_id", leadId);
  }

  // Auto-inherit the play tag from the enrichment row at decision time.
  // Safety net for rows written before play stamping was wired through every
  // intake path (poll/webhook upserts used to rely on the column default).
  // Same rule as the invite RPC: only upgrade a still-default tag — the
  // default is registry data (outreach_plays.is_default), never a literal.
  // getDefaultPlayId is cached and logs lookup errors; a null here means the
  // repair is skipped this time, so make that observable.
  const defaultPlay = await getDefaultPlayId(admin, pipe.workspace_id as string);
  if (!defaultPlay) {
    console.warn("outreach-approve: could not resolve default play — skipping play re-derivation", { lead: leadId });
  }
  if (defaultPlay && (pipe.play ?? defaultPlay) === defaultPlay) {
    const orParts = [`sendpilot_lead_id.eq.${leadId}`];
    if (pipe.contact_email) orParts.unshift(`contact_email.eq.${pipe.contact_email}`);
    const { data: leadPlayRows } = await admin
      .from("outreach_leads")
      .select("play")
      .or(orParts.join(","))
      .limit(1);
    const truePlay = (leadPlayRows?.[0]?.play as string | undefined)?.trim();
    if (truePlay && truePlay !== defaultPlay) {
      await admin.from("outreach_pipeline")
        .update({ play: truePlay })
        .eq("sendpilot_lead_id", leadId);
      pipe.play = truePlay;
    }
  }

  const now = new Date().toISOString();

  if (decision === "reply") {
    if (!resolvedSenderId) {
      return json({ error: "lead has no sendpilot_sender_id (and no fallback sender found in workspace)" }, 400);
    }
    if (!pipe.linkedin_url) {
      return json({ error: "lead has no linkedin_url" }, 400);
    }
    const message = (body.messageOverride && body.messageOverride.trim())
      ? body.messageOverride.trim()
      : (replyRow?.suggested_reply ?? "").trim();
    if (!message) return json({ error: "no message to send (empty messageOverride and no suggested_reply)" }, 400);

    const send = await fetch("https://api.sendpilot.ai/v1/inbox/send", {
      method: "POST",
      headers: { "X-API-Key": SP_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        senderId: resolvedSenderId,
        recipientLinkedinUrl: pipe.linkedin_url,
        message,
      }),
    });
    let respBody: unknown = null;
    try { respBody = await send.json(); } catch { /* ignore */ }
    const success = send.status === 200 || send.status === 201;

    if (success) {
      // Insert the outbound row immediately so UI updates without waiting
      // for the next sync tick. external_id stays null; sync will patch it
      // in within ~15min when SendPilot's conversation API exposes the id.
      await admin.from("outreach_replies").insert({
        sendpilot_lead_id: leadId,
        linkedin_url: pipe.linkedin_url,
        message,
        workspace_id: pipe.workspace_id,
        direction: "outbound",
        external_id: null,
        received_at: now,
      });
      // Mark the inbound we're answering as handled.
      if (replyRow) {
        await admin.from("outreach_replies").update({
          handled: true,
          handled_at: now,
          handled_by: email,
        }).eq("id", replyRow.id);
      }
    }

    return json({
      ok: success,
      decision: "reply",
      status: send.status,
      response: respBody,
    }, success ? 200 : 502);
  }

  if (decision === "render") {
    if (!pipe.contact_email) return json({ error: "lead has no contact_email" }, 400);
    // Guard: never re-render a lead that has been sent. The DM in LinkedIn
    // points at the original video URL — re-rendering replaces the asset on
    // Tresyv's CDN, breaks the link the prospect already clicked, and burns
    // SendSpark credits for an asset nobody will see.
    if (pipe.sent_at) {
      return json({
        error: "lead has already been sent; re-rendering would orphan the link in the delivered DM",
        sent_at: pipe.sent_at,
        status: pipe.status,
      }, 409);
    }
    const { data: lead } = await admin
      .from("outreach_leads")
      .select("first_name, last_name, company, title, website, contact_email")
      .eq("contact_email", pipe.contact_email)
      .maybeSingle();
    if (!lead) return json({ error: "outreach_leads row missing for this contact_email" }, 404);

    const renderRes = await sendsparkRender(lead, pipe.campaign_id ?? "", pipe.workspace_id ?? null);
    await admin.from("outreach_pipeline").update({
      status: renderRes.ok ? "rendering" : "failed",
      accepted_at: pipe.accepted_at ?? now,
      decided_at: now,
      decided_by: email,
      error: renderRes.ok ? null : `manual render: HTTP ${renderRes.status} — ${renderRes.errorBody}`,
    }).eq("sendpilot_lead_id", leadId);
    return json({ ok: renderRes.ok, decision: "render", status: renderRes.status });
  }

  if (decision === "reject") {
    if (pipe.status === "sent") {
      return json({ error: "lead is already sent" }, 409);
    }
    await admin.from("outreach_pipeline").update({
      status: "rejected",
      decided_at: now,
      decided_by: email,
    }).eq("sendpilot_lead_id", leadId);
    return json({ ok: true, decision: "rejected" });
  }

  // Operator cancel: pull a queued DM back to the approval gate before the
  // drainer reaches it. rendered_message and video_link stay untouched — no
  // re-render (renders are only retried via decision=render, and the row was
  // never sent so the no-re-render-after-send guard is unaffected).
  if (decision === "unqueue") {
    if (pipe.status !== "approved_queued") {
      return json({ error: `lead is in status '${pipe.status}', not approved_queued` }, 409);
    }
    await admin.from("outreach_pipeline").update({
      status: "pending_approval",
      scheduled_send_at: null,
      decided_at: now,
      decided_by: email,
    }).eq("sendpilot_lead_id", leadId);
    return json({ ok: true, decision: "unqueued" });
  }

  if (pipe.status !== "pending_approval") {
    return json({ error: `lead is in status '${pipe.status}', not pending_approval` }, 409);
  }

  // Approve → enqueue. The approved text is the contract: it's frozen into
  // rendered_message here and the drainer sends exactly that, nothing else.
  const message = (body.messageOverride && body.messageOverride.trim())
    ? body.messageOverride.trim()
    : pipe.rendered_message;
  if (!message) return json({ error: "no message to send" }, 400);

  // Lemlist branch: the message + video URL are already pushed to the lemlist
  // lead as custom variables (renderedMessage / videoUrl) by sendspark-webhook
  // when render finished. Approving here means resuming the paused lemlist
  // lead — its linkedinSend step then fires through Louis's Chrome extension
  // with the approved variables. No SendPilot involved.
  if (pipe.invite_source === "lemlist") {
    const apiKey = Deno.env.get("LEMLIST_API") ?? "";
    if (!apiKey) return json({ error: "LEMLIST_API not configured" }, 500);
    if (!pipe.lemlist_lead_id) return json({ error: "lead has no lemlist_lead_id" }, 400);
    if (!pipe.lemlist_campaign_id) return json({ error: "lead has no lemlist_campaign_id" }, 400);

    const auth = "Basic " + btoa(":" + apiKey);

    // If the human edited the message, push the override back as a custom var
    // so the linkedinSend step picks up the new text (the message argument is
    // ignored — lemlist substitutes from custom vars on the lead).
    if (body.messageOverride && body.messageOverride.trim() && body.messageOverride.trim() !== pipe.rendered_message) {
      const patchUrl = `https://api.lemlist.com/api/campaigns/${pipe.lemlist_campaign_id}/leads/${pipe.lemlist_lead_id}`;
      await fetch(patchUrl, {
        method: "PATCH",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({ renderedMessage: body.messageOverride.trim() }),
      });
    }

    // Resume the lemlist lead → triggers the next sequence step (linkedinSend)
    // which fires the DM via the Chrome extension.
    const startUrl = `https://api.lemlist.com/api/leads/start/${pipe.lemlist_lead_id}`;
    const r = await fetch(startUrl, { method: "POST", headers: { Authorization: auth } });
    const ok = r.status === 200 || r.status === 201;
    const respText = await r.text();

    await admin.from("outreach_pipeline").update({
      status: ok ? "sent" : "failed",
      sent_at: ok ? now : null,
      decided_at: now,
      decided_by: email,
      error: ok ? null : `lemlist /leads/start HTTP ${r.status}: ${respText.slice(0, 300)}`,
      rendered_message: message,
    }).eq("sendpilot_lead_id", leadId);

    return json({ ok, decision: "lemlist_resumed", status: r.status, response: respText.slice(0, 500) });
  }

  if (!resolvedSenderId) {
    return json({ error: "lead has no sendpilot_sender_id and no fallback sender found in workspace" }, 400);
  }
  if (!pipe.linkedin_url) {
    return json({ error: "lead has no linkedin_url" }, 400);
  }

  // LIVE SAFETY CHECK: ask SendPilot directly whether this lead has replied
  // before sending. Stateless — doesn't depend on webhooks arriving, our DB
  // being current, or async classification succeeding. Fail-safe: if we
  // can't verify, we treat as replied and abort the send (better to miss a
  // follow-up than to fire on someone who already responded).
  // We pass recipientName because SendPilot returns LinkedIn's id-encoded
  // URL form, not the vanity URL we stored, so URL matching alone always
  // fails — name match is the practical way to find the conversation.
  const { data: leadForName } = await admin
    .from("outreach_leads")
    .select("first_name, last_name, full_name")
    .eq("contact_email", pipe.contact_email ?? "")
    .maybeSingle();
  const fullName = (leadForName?.full_name as string | undefined)?.trim()
    || [leadForName?.first_name, leadForName?.last_name].filter(Boolean).join(" ").trim()
    || undefined;
  const replyCheck = await checkLeadReplied({
    apiKey: SP_API_KEY,
    senderAccountId: resolvedSenderId,
    recipientLinkedinUrl: pipe.linkedin_url,
    recipientName: fullName,
  });
  if (replyCheck.replied) {
    const lastReplyAt = "lastReplyAt" in replyCheck ? replyCheck.lastReplyAt : now;
    const reason = "reason" in replyCheck ? replyCheck.reason : "live API confirmed prior reply";
    await admin.from("outreach_pipeline").update({
      status: "rejected",
      decided_at: now,
      decided_by: email,
      last_reply_at: lastReplyAt,
      error: `approve aborted: ${replyCheck.source} — ${reason}`,
    }).eq("sendpilot_lead_id", leadId);
    return json({
      ok: false,
      decision: "blocked_by_live_reply_check",
      source: replyCheck.source,
      reason,
      last_reply_at: lastReplyAt,
    }, 409);
  }

  // Enqueue: compute the sender's next free drip slot. Claims = every queued
  // slot (spacing + cap) plus everything sent in the last 48h (daily cap on
  // the slot's CPH day). The drainer (outreach-send-queue) re-runs the live
  // reply check at SEND time, so a reply arriving while queued still aborts.
  const since48h = new Date(Date.now() - 48 * 3600_000).toISOString();
  const { data: claimRows, error: claimErr } = await admin
    .from("outreach_pipeline")
    .select("status, scheduled_send_at, sent_at")
    .eq("sendpilot_sender_id", resolvedSenderId)
    .or(`status.eq.approved_queued,and(status.eq.sent,sent_at.gte.${since48h})`);
  if (claimErr) return json({ error: "db fetch queue claims", details: claimErr.message }, 500);
  const claims: SlotClaim[] = (claimRows ?? [])
    .map((r) => {
      const at = r.status === "approved_queued" ? r.scheduled_send_at : r.sent_at;
      return at ? { at: new Date(at as string) } : null;
    })
    .filter((c): c is SlotClaim => c !== null);
  const slot = nextSendSlot(claims, new Date());

  await admin.from("outreach_pipeline").update({
    status: "approved_queued",
    scheduled_send_at: slot.toISOString(),
    decided_at: now,
    decided_by: email,
    rendered_message: message,
    error: null,
  }).eq("sendpilot_lead_id", leadId);

  return json({
    ok: true,
    decision: "queued",
    scheduled_send_at: slot.toISOString(),
    queue_position: claims.filter((c) => c.at > new Date()).length + 1,
  });
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
