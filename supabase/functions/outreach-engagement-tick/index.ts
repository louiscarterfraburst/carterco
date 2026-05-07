// Outreach engagement worker. Drives leads through code-defined sequences in
// supabase/functions/_shared/sequences.ts. Two execution paths into one
// state-machine evaluator:
//
//   { mode: "scan" }                    — cron, every 5 min. Walks all open
//                                         leads, enrols new ones, advances
//                                         due ones.
//   { mode: "lead", sendpilot_lead_id } — DB trigger fires this when an
//                                         instant signal lands (cta_clicked /
//                                         render_failed). Bypasses the
//                                         per-step wait gate so we react now.
//
// Auth: deployed with verify_jwt=false. Trigger + cron call without a bearer
// (mirrors notify-pending-approval). If ENGAGEMENT_WEBHOOK_SECRET is set,
// require x-webhook-secret to match.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";
import {
    signalsForLead,
    renderTemplate,
    type LeadSignals,
    type Action,
    type Signal,
} from "../_shared/engagement-rules.ts";
import {
    SEQUENCES,
    findSequence,
    effectiveExcludes,
    type Sequence,
    type SequenceBranch,
} from "../_shared/sequences.ts";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-webhook-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SP_API_KEY = Deno.env.get("SENDPILOT_API_KEY") ?? "";

const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

// Statuses where the engine stops touching a lead. Reply-driven exits go
// through the sequence's excludesGlobal (default ["replied"]); these handle
// hard human/system halts.
const TERMINAL_STATUSES = new Set(["rejected", "failed"]);

type PipelineRow = {
    sendpilot_lead_id: string;
    linkedin_url: string;
    contact_email: string;
    status: string;
    sent_at: string | null;
    viewed_at: string | null;
    played_at: string | null;
    watched_end_at: string | null;
    cta_clicked_at: string | null;
    liked_at: string | null;
    last_reply_at: string | null;
    render_failed_at: string | null;
    video_link: string | null;
    workspace_id: string | null;
    campaign_id: string | null;
    sendpilot_sender_id: string | null;
    sequence_id: string | null;
    sequence_step: number | null;
    sequence_parked_until: string | null;
    sequence_started_at: string | null;
    sequence_completed_at: string | null;
    sequence_step_entered_at: string | null;
};

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const secret = Deno.env.get("ENGAGEMENT_WEBHOOK_SECRET");
    if (secret) {
        const provided = req.headers.get("x-webhook-secret");
        if (provided !== secret) return json({ error: "Unauthorized" }, 401);
    }

    let body: { mode?: string; sendpilot_lead_id?: string };
    try { body = await req.json(); }
    catch { return json({ error: "invalid json" }, 400); }

    const mode = body.mode ?? "";

    if (mode === "scan") {
        const result = await scan();
        return json({ ok: true, mode, ...result });
    }
    if (mode === "lead") {
        const id = (body.sendpilot_lead_id ?? "").trim();
        if (!id) return json({ error: "sendpilot_lead_id required" }, 400);
        const result = await tickLead(id);
        return json({ ok: true, mode, ...result });
    }

    return json({ error: `unknown mode: ${mode}` }, 400);
});

// --- Scan path ---------------------------------------------------------------

// Workspace-level kill switch. Set OUTREACH_SEQUENCES_PAUSED_WORKSPACES
// (comma-separated workspace UUIDs) to halt ALL sequence enrolment +
// advancement for those workspaces. The function returns early per row
// before doing anything else. Used when a campaign needs to be stopped
// IMMEDIATELY (e.g. broken templates, client request, debugging).
function pausedWorkspaceIds(): Set<string> {
    const raw = Deno.env.get("OUTREACH_SEQUENCES_PAUSED_WORKSPACES") ?? "";
    return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

async function scan(): Promise<{ scanned: number; fires: number }> {
    if (SEQUENCES.length === 0) return { scanned: 0, fires: 0 };

    const { data, error } = await supabase
        .from("outreach_pipeline")
        .select("*")
        .not("status", "in", `(${[...TERMINAL_STATUSES].map((s) => `"${s}"`).join(",")})`)
        .limit(500);
    if (error) {
        console.error("scan select error", error);
        return { scanned: 0, fires: 0 };
    }

    const paused = pausedWorkspaceIds();
    let fires = 0;
    for (const row of (data ?? []) as PipelineRow[]) {
        if (row.workspace_id && paused.has(row.workspace_id)) continue;
        fires += await evaluateLead(row, /* bypassWait */ false);
    }
    return { scanned: data?.length ?? 0, fires };
}

// --- Single-lead path --------------------------------------------------------

async function tickLead(sendpilotLeadId: string): Promise<{ fires: number }> {
    if (SEQUENCES.length === 0) return { fires: 0 };

    const { data, error } = await supabase
        .from("outreach_pipeline")
        .select("*")
        .eq("sendpilot_lead_id", sendpilotLeadId)
        .maybeSingle();
    if (error || !data) {
        if (error) console.error("tickLead select error", error);
        return { fires: 0 };
    }
    const row = data as PipelineRow;
    // Honour the workspace kill switch on per-lead invokes too.
    if (row.workspace_id && pausedWorkspaceIds().has(row.workspace_id)) {
        return { fires: 0 };
    }
    if (TERMINAL_STATUSES.has(row.status)) return { fires: 0 };

    return { fires: await evaluateLead(row, /* bypassWait */ true) };
}

// --- Per-lead state machine --------------------------------------------------

async function evaluateLead(row: PipelineRow, bypassWait: boolean): Promise<number> {
    const signals = signalsForLead(row);
    const now = new Date();

    // Re-enrolment: lead has finished a sequence and a *different* one's
    // trigger now matches. Common case: enrolled in unwatched_followup,
    // played the video later, was excluded out → eligible for watched_followup.
    if (row.sequence_id && row.sequence_completed_at) {
        const next = findEnrolmentMatch(signals);
        if (!next || next.id === row.sequence_id) return 0;
        const firstStep = next.steps[0];
        if (!firstStep) return 0;
        const excludes = effectiveExcludes(next, firstStep);
        if (excludes.some((s) => signals[s])) return 0;
        await supabase.from("outreach_pipeline").update({
            sequence_id: next.id,
            sequence_step: 0,
            sequence_started_at: now.toISOString(),
            sequence_step_entered_at: now.toISOString(),
            sequence_parked_until: addHours(now, firstStep.waitHours).toISOString(),
            sequence_completed_at: null,
        }).eq("sendpilot_lead_id", row.sendpilot_lead_id);
        return 0;
    }

    // Already completed and no other sequence matches — nothing to do.
    if (row.sequence_completed_at) return 0;

    // 1. Enrolment: lead not yet in any sequence.
    if (!row.sequence_id) {
        const seq = findEnrolmentMatch(signals);
        if (!seq) return 0;
        const firstStep = seq.steps[0];
        if (!firstStep) return 0;
        // Don't enrol someone already excluded (e.g. already replied).
        const excludes = effectiveExcludes(seq, firstStep);
        if (excludes.some((s) => signals[s])) return 0;

        await supabase.from("outreach_pipeline").update({
            sequence_id: seq.id,
            sequence_step: 0,
            sequence_started_at: now.toISOString(),
            sequence_step_entered_at: now.toISOString(),
            sequence_parked_until: addHours(now, firstStep.waitHours).toISOString(),
            sequence_completed_at: null,
        }).eq("sendpilot_lead_id", row.sendpilot_lead_id);
        // Don't fall through; the next tick (or instant trigger) advances it.
        return 0;
    }

    // 2. Active sequence — locate it and the current step.
    const seq = findSequence(row.sequence_id);
    if (!seq) {
        // Sequence id no longer exists in code (renamed/removed). Mark
        // complete so the engine stops touching this lead.
        await markCompleted(row.sendpilot_lead_id, now);
        return 0;
    }
    const stepIdx = row.sequence_step ?? 0;
    const step = seq.steps[stepIdx];
    if (!step) {
        await markCompleted(row.sendpilot_lead_id, now);
        return 0;
    }

    // 3. Global / step-local exit.
    const excludes = effectiveExcludes(seq, step);
    if (excludes.some((s) => signals[s])) {
        await markCompleted(row.sendpilot_lead_id, now);
        return 0;
    }

    // 4. Wait gate.
    const enteredAt = parseTs(row.sequence_step_entered_at)
        ?? parseTs(row.sequence_started_at)
        ?? now;
    const waitDeadline = addHours(enteredAt, step.waitHours);
    const maxWaitDeadline = addHours(enteredAt, step.maxWaitHours ?? step.waitHours);

    // Lead-mode bypass only applies to step 0 (the step the lead just
    // entered via enrolment). Subsequent steps must respect their wait
    // gate even when called from an instant DB trigger — otherwise an
    // unrelated signal (e.g. cta_clicked) would prematurely fire later
    // steps that have unconditional branches.
    const allowBypass = bypassWait && stepIdx === 0;
    if (!allowBypass && now < waitDeadline) {
        const parkIso = waitDeadline.toISOString();
        if (row.sequence_parked_until !== parkIso) {
            await supabase.from("outreach_pipeline")
                .update({ sequence_parked_until: parkIso })
                .eq("sendpilot_lead_id", row.sendpilot_lead_id);
        }
        return 0;
    }

    // 5. Branch evaluation. First branch whose `requires` are all present wins.
    const chosen = pickBranch(step.branches, signals);
    if (!chosen) {
        // Nothing matched yet. If we've passed maxWaitHours, advance silently.
        if (now >= maxWaitDeadline) {
            await advanceStep(row.sendpilot_lead_id, seq, stepIdx, now);
        } else {
            const target = maxWaitDeadline > now ? maxWaitDeadline : now;
            await supabase.from("outreach_pipeline")
                .update({ sequence_parked_until: target.toISOString() })
                .eq("sendpilot_lead_id", row.sendpilot_lead_id);
        }
        return 0;
    }

    // 6. Idempotency guard: if an audit row already exists for this
    // (lead, sequence::step), the action ran on a prior tick — just advance.
    const ruleId = `${seq.id}::${step.id}`;
    const { count: existingFires } = await supabase
        .from("outreach_engagement_actions")
        .select("id", { count: "exact", head: true })
        .eq("sendpilot_lead_id", row.sendpilot_lead_id)
        .eq("rule_id", ruleId);
    if ((existingFires ?? 0) > 0) {
        await advanceStep(row.sendpilot_lead_id, seq, stepIdx, now);
        return 0;
    }

    // 7. Fire the action and advance. Per-campaign template override:
    // if `OUTREACH_TEMPLATE_<campaignId>_<seqId>_<stepId>` is set in env,
    // use it instead of the inline template. Lets the same sequences fire
    // for two different campaigns with different copy (e.g. Carter & Co
    // form-followup vs. the legacy product pitch).
    const templatedAction = applyCampaignOverride(chosen.action, row.campaign_id, seq.id, step.id);
    const result = await executeAction(templatedAction, row);
    await supabase.from("outreach_engagement_actions").insert({
        sendpilot_lead_id: row.sendpilot_lead_id,
        workspace_id: row.workspace_id,
        rule_id: ruleId,
        action_type: templatedAction.type,
        template_id: "template" in templatedAction
            ? templatedAction.template.slice(0, 80)
            : null,
        result,
    });
    await advanceStep(row.sendpilot_lead_id, seq, stepIdx, now);
    return 1;
}

function findEnrolmentMatch(signals: LeadSignals): Sequence | undefined {
    for (const seq of SEQUENCES) {
        if (signals[seq.trigger.signal]) return seq;
    }
    return undefined;
}

function pickBranch(
    branches: SequenceBranch[],
    signals: LeadSignals,
): SequenceBranch | null {
    for (const b of branches) {
        const reqs: Signal[] = b.requires ?? [];
        if (reqs.every((s) => signals[s])) return b;
    }
    return null;
}

async function advanceStep(
    sendpilotLeadId: string,
    seq: Sequence,
    currentIdx: number,
    now: Date,
): Promise<void> {
    const nextIdx = currentIdx + 1;
    const next = seq.steps[nextIdx];
    if (!next) {
        await supabase.from("outreach_pipeline").update({
            sequence_step: nextIdx,
            sequence_completed_at: now.toISOString(),
            sequence_parked_until: null,
        }).eq("sendpilot_lead_id", sendpilotLeadId);
        return;
    }
    await supabase.from("outreach_pipeline").update({
        sequence_step: nextIdx,
        sequence_step_entered_at: now.toISOString(),
        sequence_parked_until: addHours(now, next.waitHours).toISOString(),
    }).eq("sendpilot_lead_id", sendpilotLeadId);
}

async function markCompleted(sendpilotLeadId: string, now: Date): Promise<void> {
    await supabase.from("outreach_pipeline").update({
        sequence_completed_at: now.toISOString(),
        sequence_parked_until: null,
    }).eq("sendpilot_lead_id", sendpilotLeadId);
}

// --- Action dispatch (unchanged from rule-engine version) --------------------

// Per-campaign template override. Returns the action with .template swapped
// out if a campaign-specific env var is set; otherwise returns the action
// untouched. Only applies to actions that carry a template field.
function applyCampaignOverride(
    action: Action,
    campaignId: string | null,
    seqId: string,
    stepId: string,
): Action {
    if (!campaignId) return action;
    if (action.type !== "auto_send" && action.type !== "queue_approval") return action;
    const key = `OUTREACH_TEMPLATE_${campaignId}_${seqId}_${stepId}`;
    const override = Deno.env.get(key);
    if (!override) return action;
    return { type: action.type, template: override };
}

async function executeAction(
    action: Action,
    row: PipelineRow,
): Promise<Record<string, unknown>> {
    if (action.type === "push_only") {
        return { dispatched: "push_only", note: "no auto-message; cockpit only" };
    }

    const { data: lead } = await supabase
        .from("outreach_leads")
        .select("first_name, last_name, company, website")
        .eq("contact_email", row.contact_email)
        .maybeSingle();

    const message = renderTemplate(action.template, {
        first_name: lead?.first_name ?? null,
        company:    lead?.company    ?? null,
        video_link: row.video_link,
    });

    if (action.type === "queue_approval") {
        await supabase.from("outreach_pipeline").update({
            rendered_message: message,
            queued_at: new Date().toISOString(),
            status: "pending_approval",
        }).eq("sendpilot_lead_id", row.sendpilot_lead_id);
        return { dispatched: "queue_approval", message_len: message.length };
    }

    // auto_send → straight to SendPilot inbox.
    // SendPilot's API requires senderId + recipientLinkedinUrl + message
    // (NOT leadId + message). senderId is captured from the connection.accepted
    // webhook payload at acceptance time and stored on the pipeline row.
    if (!row.sendpilot_sender_id || !row.linkedin_url) {
        await supabase.from("outreach_pipeline").update({
            error: "auto_send skipped: missing sendpilot_sender_id or linkedin_url",
        }).eq("sendpilot_lead_id", row.sendpilot_lead_id);
        return { dispatched: "auto_send_skipped", reason: "missing sender_id or linkedin_url" };
    }
    // Defense-in-depth reply check. last_reply_at on the row is the
    // primary signal (set synchronously by sendpilot-webhook on reply
    // receipt), but if for any reason that propagation failed, also
    // scan outreach_events for ANY reply event for this leadId.
    // This catches: webhook outages, renamed event types, async
    // classification failures, manual data inconsistency. Erik Mygind
    // Nielsen replied "På ingen måde!" and we still fired a follow-up
    // because his reply never made it to last_reply_at — never again.
    const { data: replyEvents } = await supabase
        .from("outreach_events")
        .select("event_id,received_at")
        .eq("source", "sendpilot")
        .in("event_type", ["message.received", "reply.received"])
        .filter("payload->data->>leadId", "eq", row.sendpilot_lead_id)
        .limit(1);
    if (replyEvents && replyEvents.length > 0) {
        const replyTs = replyEvents[0].received_at;
        await supabase.from("outreach_pipeline").update({
            last_reply_at: replyTs,
            error: "auto_send aborted: reply event found in outreach_events but last_reply_at was null",
        }).eq("sendpilot_lead_id", row.sendpilot_lead_id);
        return {
            dispatched: "auto_send_aborted",
            reason: "reply detected via outreach_events fallback",
            reply_received_at: replyTs,
        };
    }
    const send = await fetch("https://api.sendpilot.ai/v1/inbox/send", {
        method: "POST",
        headers: { "X-API-Key": SP_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
            senderId: row.sendpilot_sender_id,
            recipientLinkedinUrl: row.linkedin_url,
            message,
        }),
    });
    let respBody: unknown = null;
    try { respBody = await send.json(); } catch { /* ignore */ }
    const success = send.status === 200 || send.status === 201;

    await supabase.from("outreach_pipeline").update({
        rendered_message: message,
        sent_at: success ? new Date().toISOString() : null,
        status: success ? "sent" : "failed",
        sendpilot_response: respBody,
        error: success ? null : `engagement auto_send HTTP ${send.status}`,
    }).eq("sendpilot_lead_id", row.sendpilot_lead_id);

    return { dispatched: "auto_send", status: send.status, ok: success };
}

// --- Misc helpers ------------------------------------------------------------

function addHours(d: Date, hours: number): Date {
    return new Date(d.getTime() + hours * 3600_000);
}

function parseTs(v: string | null | undefined): Date | null {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
}

function json(obj: unknown, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}
