// Webhook health monitor. Triggered by pg_cron once an hour.
//
// Today's incident exposed a 7-day silent SendPilot webhook outage that
// only surfaced because Erik replied "På ingen måde!" to a follow-up
// nobody knew shouldn't have fired. This function exists so we never
// learn about an outage from a customer's client again.
//
// Logic:
//   - Compute max(received_at) of source='sendpilot' events in the last
//     30 days.
//   - If that's older than STALE_HOURS (default 4) AND there's any
//     active outreach_pipeline activity in the last 7 days (so we'd
//     EXPECT events to be flowing), insert an alert in
//     outreach_health_alerts (deduped — only one open alert of type
//     'sendpilot_webhook_silent' at a time).
//   - When events resume (max_received_at fresh again), mark the open
//     alert resolved.
//
// Surfaces in: outreach_health_alerts table. Hook to Slack/Twilio/push
// notifications as a follow-up — the alert row is the canonical signal.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

const STALE_HOURS = parseInt(Deno.env.get("WEBHOOK_HEALTH_STALE_HOURS") ?? "4", 10);
const ALERT_TYPE = "sendpilot_webhook_silent";

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method === "GET") {
        return json({ ok: true, name: "outreach-webhook-health" });
    }

    const now = new Date();
    const stale_cutoff = new Date(now.getTime() - STALE_HOURS * 3600_000);
    const expectation_cutoff = new Date(now.getTime() - 7 * 86400_000);

    // 1. Latest sendpilot event we received
    const { data: lastEv } = await supabase
        .from("outreach_events")
        .select("received_at")
        .eq("source", "sendpilot")
        .order("received_at", { ascending: false })
        .limit(1);
    const lastReceived: Date | null = lastEv && lastEv.length
        ? new Date(lastEv[0].received_at as string)
        : null;
    const hoursSince = lastReceived
        ? Math.round((now.getTime() - lastReceived.getTime()) / 3600_000 * 10) / 10
        : null;

    // 2. Are we expecting webhooks? Any pipeline activity in the last 7 days?
    const { data: recentPipe } = await supabase
        .from("outreach_pipeline")
        .select("sendpilot_lead_id", { count: "exact", head: false })
        .gte("updated_at", expectation_cutoff.toISOString())
        .limit(1);
    const hasRecentActivity = (recentPipe?.length ?? 0) > 0;

    // 3. Existing open alert?
    const { data: openAlerts } = await supabase
        .from("outreach_health_alerts")
        .select("id, detected_at")
        .eq("alert_type", ALERT_TYPE)
        .is("resolved_at", null)
        .limit(1);
    const openAlert = openAlerts?.[0] ?? null;

    const isStale = !lastReceived || lastReceived < stale_cutoff;

    // 4. Decide what to do
    if (isStale && hasRecentActivity && !openAlert) {
        // Outage detected, no open alert → create one
        const message = lastReceived
            ? `No SendPilot webhooks in ${hoursSince}h (since ${lastReceived.toISOString()}). Recent pipeline activity expected events to flow. Likely cause: webhook subscription disabled at SendPilot, signature mismatch (rotated whsec_), or SendPilot delivery failure.`
            : `No SendPilot webhooks have EVER been received but pipeline activity exists. Webhook never configured or never working.`;
        await supabase.from("outreach_health_alerts").insert({
            alert_type: ALERT_TYPE,
            message,
            payload: {
                last_received_at: lastReceived?.toISOString() ?? null,
                hours_since: hoursSince,
                stale_threshold_hours: STALE_HOURS,
            },
        });
        return json({ ok: true, action: "alert_opened", message, hours_since: hoursSince });
    }

    if (!isStale && openAlert) {
        // Events flowing again → resolve the open alert
        await supabase
            .from("outreach_health_alerts")
            .update({ resolved_at: now.toISOString() })
            .eq("id", openAlert.id);
        return json({
            ok: true,
            action: "alert_resolved",
            alert_id: openAlert.id,
            hours_since: hoursSince,
        });
    }

    // Steady state
    return json({
        ok: true,
        action: "no_change",
        is_stale: isStale,
        has_recent_activity: hasRecentActivity,
        hours_since_last_event: hoursSince,
        open_alert: openAlert?.id ?? null,
    });
});

function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}
