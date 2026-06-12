// Drip-queue drainer. Invoked by pg_cron every 5 min (jobname
// outreach-send-queue-5min, migration 20260610_send_queue.sql). Picks due
// approved_queued rows — at most ONE per sender per tick, so even a backlog
// drains at human cadence — and fires the SendPilot DM with the exact text
// the operator approved (the binding contract; outreach-approve froze it in
// rendered_message at decision time).
//
// Safety at SEND time, not just approve time:
//   - playPausedLive: a paused play freezes its queue (rows stay queued).
//     LIVE check, not the 60s-cached one — pause is the kill switch in front
//     of irreversible sends, so it must take effect immediately.
//   - live reply check: someone who replied while the DM sat in the queue
//     gets their send aborted → status 'rejected' with the reason. A
//     fail_safe (unverifiable) result does NOT reject — the row stays queued
//     and retries next tick, so a SendPilot outage delays sends instead of
//     destroying them.
//   - atomic claim: each row is CAS'd approved_queued → 'sending' before the
//     external send fires. A crash mid-send or two overlapping invocations
//     can never double-send; rows stuck in 'sending' >15 min are flipped to
//     'failed' with a verify-manually note.
//   - send-time spacing floor: a sender with a DM sent in the last
//     QUEUE_MIN_GAP_MS is skipped this tick, so even a hammered endpoint or
//     a backlog of past-due slots can't burst.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";
import { checkLeadReplied } from "../_shared/sendpilot-client.ts";
import { playPausedLive } from "../_shared/plays.ts";
import { canonicalSenderFor } from "../_shared/workspaces.ts";
import { QUEUE_MIN_GAP_MS } from "../_shared/send-queue.ts";

const SP_API_KEY = Deno.env.get("SENDPILOT_API_KEY") ?? "";
// Optional shared secret: when OUTREACH_CRON_TOKEN is set in the function's
// env, requests must carry it in X-Cron-Token. verify_jwt=false exposes the
// endpoint, and while the claim/spacing logic makes extra invocations
// harmless, there's no reason to leave the trigger anonymous.
const CRON_TOKEN = Deno.env.get("OUTREACH_CRON_TOKEN") ?? "";

const STUCK_SENDING_MS = 15 * 60_000;

type QueuedRow = {
  sendpilot_lead_id: string;
  contact_email: string | null;
  linkedin_url: string | null;
  rendered_message: string | null;
  scheduled_send_at: string;
  workspace_id: string | null;
  sendpilot_sender_id: string | null;
  queue_sender_id: string | null;
  play: string | null;
};

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }
  if (CRON_TOKEN && request.headers.get("x-cron-token") !== CRON_TOKEN) {
    return json({ error: "unauthorized" }, 401);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  const nowIso = new Date().toISOString();

  // Recover rows stuck in 'sending' (isolate died between claim and finalize).
  // The DM may or may not have gone out — flip to failed with a verify note
  // rather than re-queueing, which would risk a double-send.
  const stuckBefore = new Date(Date.now() - STUCK_SENDING_MS).toISOString();
  const { data: stuck } = await admin
    .from("outreach_pipeline")
    .update({
      status: "failed",
      error: "send-queue: stuck in 'sending' — the DM may have gone out; verify the SendPilot inbox before re-approving",
    })
    .eq("status", "sending")
    .lt("scheduled_send_at", stuckBefore)
    .select("sendpilot_lead_id");
  const recovered = (stuck ?? []).length;

  const { data: due, error: dueErr } = await admin
    .from("outreach_pipeline")
    .select(
      "sendpilot_lead_id, contact_email, linkedin_url, rendered_message, scheduled_send_at, workspace_id, sendpilot_sender_id, queue_sender_id, play",
    )
    .eq("status", "approved_queued")
    .lte("scheduled_send_at", nowIso)
    .order("scheduled_send_at", { ascending: true })
    .limit(50);
  if (dueErr) return json({ error: "db fetch due", details: dueErr.message }, 500);

  // One send per sender per tick, keyed on the SAME identity the DM is sent
  // from: queue_sender_id (persisted at enqueue from canonicalSenderFor).
  // Legacy rows without it resolve the canonical sender here so the throttle
  // key and the send identity can never diverge.
  const bySender = new Map<string, { row: QueuedRow; senderId: string }>();
  for (const row of (due ?? []) as QueuedRow[]) {
    const senderId = row.queue_sender_id
      ?? (await canonicalSenderFor(admin, row.workspace_id ?? ""))
      ?? row.sendpilot_sender_id;
    if (!senderId) {
      await admin.from("outreach_pipeline").update({
        status: "failed",
        error: "send-queue: no resolvable sender",
        scheduled_send_at: null,
      }).eq("sendpilot_lead_id", row.sendpilot_lead_id).eq("status", "approved_queued");
      continue;
    }
    if (!bySender.has(senderId)) bySender.set(senderId, { row, senderId });
  }

  const summary = { sent: 0, failed: 0, aborted_replied: 0, paused: 0, skipped: 0, recovered };
  const results: Record<string, string> = {};

  for (const { row, senderId } of bySender.values()) {
    const leadId = row.sendpilot_lead_id;
    const now = new Date().toISOString();

    // Paused play → leave the row queued, untouched. Live check (no cache).
    if (await playPausedLive(admin, row.play, row.workspace_id)) {
      summary.paused++;
      results[leadId] = "paused_play";
      continue;
    }

    if (!row.linkedin_url || !row.rendered_message) {
      await admin.from("outreach_pipeline").update({
        status: "failed",
        scheduled_send_at: null,
        error: `send-queue: missing ${!row.linkedin_url ? "linkedin_url" : "rendered_message"}`,
      }).eq("sendpilot_lead_id", leadId).eq("status", "approved_queued");
      summary.failed++;
      results[leadId] = "missing_fields";
      continue;
    }

    // Send-time spacing floor: if this sender already had a DM go out within
    // the minimum gap, wait for a later tick. Makes anonymous/extra
    // invocations and past-due backlogs physically unable to burst.
    const sinceGap = new Date(Date.now() - QUEUE_MIN_GAP_MS).toISOString();
    const { count: recentSends } = await admin
      .from("outreach_pipeline")
      .select("sendpilot_lead_id", { count: "exact", head: true })
      .eq("queue_sender_id", senderId)
      .gte("sent_at", sinceGap);
    if ((recentSends ?? 0) > 0) {
      summary.skipped++;
      results[leadId] = "spacing_floor";
      continue;
    }

    // Live reply check at send time. live_api replied → reject (their reply
    // ends the thread's automation). fail_safe → DO NOT touch the row: we
    // couldn't verify, so the send is skipped this tick and retried next —
    // an outage must never terminally reject queued DMs or stamp phantom
    // last_reply_at values into the stats.
    // Scope by the queued row's workspace: the queue scan is global, and the
    // same contact_email can exist as an outreach_leads row in another tenant.
    // limit(1) instead of maybeSingle so an in-workspace duplicate degrades to
    // "first match" rather than an error that silently drops the name (the
    // name feeds checkLeadReplied's participant fallback).
    const { data: leadNameRows, error: leadNameErr } = await admin
      .from("outreach_leads")
      .select("first_name, last_name, full_name")
      .eq("workspace_id", row.workspace_id ?? "")
      .eq("contact_email", row.contact_email ?? "")
      .limit(1);
    if (leadNameErr) {
      console.warn("send-queue: lead name lookup failed — reply check runs without name fallback", {
        leadId,
        error: leadNameErr.message,
      });
    }
    const leadForName = leadNameRows?.[0];
    const fullName = (leadForName?.full_name as string | undefined)?.trim()
      || [leadForName?.first_name, leadForName?.last_name].filter(Boolean).join(" ").trim()
      || undefined;
    const replyCheck = await checkLeadReplied({
      apiKey: SP_API_KEY,
      senderAccountId: senderId,
      recipientLinkedinUrl: row.linkedin_url,
      recipientName: fullName,
    });
    if (replyCheck.replied && replyCheck.source === "fail_safe") {
      console.warn("send-queue: reply check unverifiable — leaving row queued", {
        leadId,
        reason: replyCheck.reason,
      });
      summary.skipped++;
      results[leadId] = "reply_check_unverifiable";
      continue;
    }
    if (replyCheck.replied) {
      await admin.from("outreach_pipeline").update({
        status: "rejected",
        scheduled_send_at: null,
        last_reply_at: replyCheck.lastReplyAt,
        error: `send-queue aborted: live API confirmed prior reply`,
      }).eq("sendpilot_lead_id", leadId).eq("status", "approved_queued");
      summary.aborted_replied++;
      results[leadId] = "aborted_replied";
      continue;
    }

    // Atomic claim BEFORE the irreversible external call. If another
    // invocation (overlapping cron tick, manual POST) already claimed or the
    // operator unqueued, 0 rows match and we skip — never double-send.
    // scheduled_send_at is restamped to claim time so the stuck-'sending'
    // recovery above measures from the claim, not the (possibly long past)
    // original slot — otherwise a backlog row could be declared stuck while
    // its send is still in flight.
    const { data: claimed, error: claimErr } = await admin
      .from("outreach_pipeline")
      .update({ status: "sending", scheduled_send_at: now })
      .eq("sendpilot_lead_id", leadId)
      .eq("status", "approved_queued")
      .select("sendpilot_lead_id");
    if (claimErr || !claimed || claimed.length === 0) {
      summary.skipped++;
      results[leadId] = claimErr ? `claim_error: ${claimErr.message}` : "claim_lost";
      continue;
    }

    const send = await fetch("https://api.sendpilot.ai/v1/inbox/send", {
      method: "POST",
      headers: { "X-API-Key": SP_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        senderId,
        recipientLinkedinUrl: row.linkedin_url,
        message: row.rendered_message,
      }),
    });
    let respBody: unknown = null;
    try { respBody = await send.json(); } catch { /* ignore */ }
    const success = send.status === 200 || send.status === 201;

    // messageId IS the conversation id (see docs/outreach-thread-trust.md) —
    // capture it so the sync has a deterministic thread key.
    const conversationId = (respBody as { messageId?: string } | null)?.messageId ?? null;

    await admin.from("outreach_pipeline").update({
      status: success ? "sent" : "failed",
      sent_at: success ? now : null,
      scheduled_send_at: null,
      sendpilot_response: respBody,
      sendpilot_conversation_id: success && conversationId ? conversationId : undefined,
      error: success ? null : `send-queue inbox/send HTTP ${send.status}`,
    }).eq("sendpilot_lead_id", leadId).eq("status", "sending");

    if (success) {
      summary.sent++;
      results[leadId] = "sent";
    } else {
      summary.failed++;
      results[leadId] = `failed_http_${send.status}`;
    }
  }

  return json({ ok: true, due: (due ?? []).length, ...summary, results });
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
