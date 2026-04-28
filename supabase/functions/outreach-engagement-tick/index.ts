// Outreach engagement worker. Two execution paths into one rule evaluator:
//
//   { mode: "scan" }                    — cron, every 5 min. Walks all open
//                                         leads against RULES.
//   { mode: "lead", sendpilot_lead_id } — DB trigger fires this when an
//                                         instant signal lands (cta_clicked /
//                                         render_failed) so we react now
//                                         instead of waiting up to 5 min.
//
// Auth: deployed with verify_jwt=false. Trigger + cron call without a bearer
// (mirrors notify-pending-approval). If ENGAGEMENT_WEBHOOK_SECRET is set,
// require x-webhook-secret to match.
//
// Rules live in ../_shared/engagement-rules.ts. The array is empty by design —
// this function is the infrastructure; rules ship one-at-a-time as code PRs.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";
import {
    RULES,
    signalsForLead,
    ruleMatches,
    renderTemplate,
    type EngagementRule,
} from "../_shared/engagement-rules.ts";

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

// Statuses where the auto-flow stops touching a lead. Replies and explicit
// human decisions both halt it (they're handled by humans in the cockpit).
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

async function scan(): Promise<{ scanned: number; fires: number }> {
    if (RULES.length === 0) return { scanned: 0, fires: 0 };

    const { data, error } = await supabase
        .from("outreach_pipeline")
        .select("*")
        .not("status", "in", `(${[...TERMINAL_STATUSES].map((s) => `"${s}"`).join(",")})`)
        .limit(500);
    if (error) {
        console.error("scan select error", error);
        return { scanned: 0, fires: 0 };
    }

    let fires = 0;
    for (const row of (data ?? []) as PipelineRow[]) {
        const fired = await evaluateLead(row);
        fires += fired;
    }
    return { scanned: data?.length ?? 0, fires };
}

// --- Single-lead path --------------------------------------------------------

async function tickLead(sendpilotLeadId: string): Promise<{ fires: number }> {
    if (RULES.length === 0) return { fires: 0 };

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
    if (TERMINAL_STATUSES.has(row.status)) return { fires: 0 };

    return { fires: await evaluateLead(row) };
}

// --- Shared evaluation -------------------------------------------------------

async function evaluateLead(row: PipelineRow): Promise<number> {
    const signals = signalsForLead(row);
    const now = new Date();

    let fires = 0;
    for (const rule of RULES) {
        if (!ruleMatches(rule, signals, now)) continue;

        const max = rule.maxFiresPerLead ?? 1;
        const { count } = await supabase
            .from("outreach_engagement_actions")
            .select("id", { count: "exact", head: true })
            .eq("sendpilot_lead_id", row.sendpilot_lead_id)
            .eq("rule_id", rule.id);
        if ((count ?? 0) >= max) continue;

        const result = await executeAction(rule, row);
        await supabase.from("outreach_engagement_actions").insert({
            sendpilot_lead_id: row.sendpilot_lead_id,
            rule_id: rule.id,
            action_type: rule.action.type,
            template_id: "template" in rule.action ? rule.action.template.slice(0, 80) : null,
            result,
        });
        fires += 1;

        // Stop after first match per tick so a single signal can't fan out
        // into multiple actions in one pass — predictable precedence.
        break;
    }
    return fires;
}

async function executeAction(
    rule: EngagementRule,
    row: PipelineRow,
): Promise<Record<string, unknown>> {
    if (rule.action.type === "push_only") {
        // Reuse the pending-approval push fan-out by transitioning state.
        // Future: dedicated notify-engagement function with rule-aware copy.
        return { dispatched: "push_only", note: "no auto-message; cockpit only" };
    }

    const { data: lead } = await supabase
        .from("outreach_leads")
        .select("first_name, last_name, company, website")
        .eq("contact_email", row.contact_email)
        .maybeSingle();

    const message = renderTemplate(rule.action.template, {
        first_name: lead?.first_name ?? null,
        company:    lead?.company    ?? null,
        video_link: row.video_link,
    });

    if (rule.action.type === "queue_approval") {
        await supabase.from("outreach_pipeline").update({
            rendered_message: message,
            queued_at: new Date().toISOString(),
            status: "pending_approval",
        }).eq("sendpilot_lead_id", row.sendpilot_lead_id);
        return { dispatched: "queue_approval", message_len: message.length };
    }

    // auto_send → straight to SendPilot inbox.
    const send = await fetch("https://api.sendpilot.ai/v1/inbox/send", {
        method: "POST",
        headers: { "X-API-Key": SP_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ leadId: row.sendpilot_lead_id, message }),
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

function json(obj: unknown, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}
