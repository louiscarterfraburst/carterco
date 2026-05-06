// Receives SendSpark webhooks. Dispatches on event type:
//
//   video_generated_dv         — render complete; auto-send (cold) or
//                                queue for approval (warm). Existing path.
//   video_viewed               — set viewed_at
//   video_played               — set played_at
//   video_watched_to_end       — set watched_end_at
//   video_cta_clicked          — set cta_clicked_at (instant trigger fires
//                                outreach-engagement-tick)
//   video_liked                — set liked_at
//   video_failed_to_generate   — set render_failed_at, status='failed'
//   video_created              — audit only (no pipeline update)
//
// Engagement-column writes are no-op'd if the column is already set, so
// duplicate events from SendSpark don't churn the row.
//
// IMPORTANT: SendSpark's exact eventType slug strings still need to be
// confirmed against a real payload. We accept several common forms per
// signal (see EVENT_TYPE_MAP). Once a real payload lands in
// outreach_events, prune the map to the actual strings.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";
import { normalizeCompanyName, normalizeWebsiteUrl } from "../_shared/text.ts";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type SendSparkEvent = {
    eventType: string;
    campaignId?: string;
    campaignName?: string;
    contactEmail?: string;
    contactInfo?: { contactFirstName?: string; company?: string; jobTitle?: string };
    videoLink?: string;
    embedLink?: string;
    thumbnailUrl?: string;
};

const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

const DEFAULT_TEMPLATE = [
    "Hej {firstName}",
    "",
    "Jeg var lige inde på {website} og optog en kort video om én ting, jeg tror I mister lidt værdi på:",
    "{videoLink}",
].join("\n");

const FALLBACK_TEMPLATE = Deno.env.get("OUTREACH_MESSAGE_TEMPLATE") || DEFAULT_TEMPLATE;

// Per-campaign template lookup. Set OUTREACH_TEMPLATE_<sendsparkCampaignId>
// in the function's env vars to override the message body for one campaign
// (e.g. the form-followup angle) while keeping the legacy default for others.
function pickTemplate(campaignId: string | undefined): string {
    const id = (campaignId ?? "").trim();
    if (!id) return FALLBACK_TEMPLATE;
    const perCampaign = Deno.env.get(`OUTREACH_TEMPLATE_${id}`);
    return perCampaign || FALLBACK_TEMPLATE;
}

// Normalise a SendSpark eventType to one of our internal kinds. Accepts
// several common slug forms (snake/camel/dot-separated) so we don't break if
// the real payload uses a slightly different spelling than we guessed.
type EventKind =
    | "render_ready"
    | "viewed"
    | "played"
    | "watched_end"
    | "cta_clicked"
    | "liked"
    | "render_failed"
    | "created"
    | "unknown";

function classifyEvent(rawType: string): EventKind {
    const t = rawType.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    if (t === "video_generated_dv" || t === "video_ready_to_download" || t === "ready_to_download") {
        return "render_ready";
    }
    if (t.includes("watched_to_the_end") || t.includes("watched_to_end") || t.includes("watched_end")) {
        return "watched_end";
    }
    if (t.includes("cta_clicked") || t.includes("clicked")) return "cta_clicked";
    if (t.includes("failed_to_generate") || t.includes("failed")) return "render_failed";
    if (t.includes("created")) return "created";
    if (t.includes("liked")) return "liked";
    if (t.includes("played")) return "played";
    if (t.includes("viewed")) return "viewed";
    return "unknown";
}

Deno.serve(async (request) => {
    if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (request.method === "GET") return json({ ok: true, name: "sendspark-webhook" });
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const rawBody = await request.text();
    let evt: SendSparkEvent;
    try {
        evt = JSON.parse(rawBody);
    } catch {
        return json({ error: "Invalid JSON" }, 400);
    }

    const kind = classifyEvent(evt.eventType ?? "");
    const email = (evt.contactEmail ?? "").toLowerCase();
    const videoLink = evt.videoLink ?? "";

    // Idempotency: deterministic event_id per (kind, email, videoLink). Falls
    // back to a random string if we lack the inputs (so the insert still
    // succeeds and we get the audit row).
    const eventId = `sendspark:${kind}:${email}:${videoLink}` || `sendspark:${crypto.randomUUID()}`;

    // Resolve workspace via the related outreach lead (1:1 on contact_email).
    // null is acceptable if the email doesn't match any lead — we still want
    // the event recorded for audit.
    let eventWorkspaceId: string | null = null;
    if (email) {
        const { data: lookupLead } = await supabase
            .from("outreach_leads")
            .select("workspace_id")
            .eq("contact_email", email)
            .maybeSingle();
        eventWorkspaceId = lookupLead?.workspace_id ?? null;
    }

    const { error: evtErr } = await supabase.from("outreach_events").insert({
        event_id: eventId,
        source: "sendspark",
        event_type: evt.eventType ?? "unknown",
        workspace_id: eventWorkspaceId,
        payload: evt,
    });
    if (evtErr && !`${evtErr.message}`.includes("duplicate key")) {
        console.error("event insert error", evtErr);
        return json({ error: "DB error", details: evtErr.message }, 500);
    }
    if (evtErr) return json({ ok: true, duplicate: true });

    if (kind === "created" || kind === "unknown") {
        return json({ ok: true, recorded: kind, eventType: evt.eventType });
    }

    if (kind === "render_ready") {
        return await handleRenderReady(evt, email, videoLink);
    }

    if (!email) {
        return json({ ok: true, recorded: `${kind}_no_email` });
    }

    return await handleEngagement(kind, email);
});

// --- Render-ready: existing send/queue path ---------------------------------

async function handleRenderReady(evt: SendSparkEvent, email: string, videoLink: string) {
    if (!email || !videoLink) {
        return json({ error: "missing contactEmail or videoLink" }, 400);
    }

    const { data: pipe } = await supabase
        .from("outreach_pipeline")
        .select("sendpilot_lead_id, contact_email, status, campaign_id")
        .eq("contact_email", email)
        .maybeSingle();

    if (!pipe) {
        console.warn("video_generated_dv with no matching pipeline row", { email, videoLink });
        return json({ ok: true, recorded: "render_no_pipeline" });
    }

    if (pipe.status === "sent" || pipe.status === "rejected") {
        return json({ ok: true, recorded: "render_after_terminal" });
    }

    const { data: lead } = await supabase
        .from("outreach_leads")
        .select("first_name, last_name, company, website")
        .eq("contact_email", email)
        .maybeSingle();

    const firstName = (lead?.first_name ?? "").trim() || "der";
    const company = normalizeCompanyName(lead?.company);
    const website = normalizeWebsiteUrl(lead?.website);
    // Use the SendPilot campaign_id we stored on the pipeline row, not
    // SendSpark's own campaignId — keeps env-var keys consistent with the
    // sequence-template overrides in outreach-engagement-tick.
    const message = pickTemplate(pipe.campaign_id ?? undefined)
        .replaceAll("{firstName}", firstName)
        .replaceAll("{company}", company)
        .replaceAll("{website}", website)
        .replaceAll("{videoLink}", videoLink);

    const now = new Date().toISOString();

    // All initial video messages queue for human approval before they go out.
    // No auto-send branch for cold vs warm — every video gets a manual eyeball.
    await supabase.from("outreach_pipeline").update({
        video_link: videoLink,
        embed_link: evt.embedLink ?? null,
        thumbnail_url: evt.thumbnailUrl ?? null,
        rendered_message: message,
        rendered_at: now,
        queued_at: now,
        status: "pending_approval",
    }).eq("sendpilot_lead_id", pipe.sendpilot_lead_id);

    return json({ ok: true, branch: "queued_for_approval" });
}

// --- Engagement: stamp the corresponding column if not already set ----------

const KIND_TO_COLUMN: Record<Exclude<EventKind, "render_ready" | "created" | "unknown">, string> = {
    viewed:        "viewed_at",
    played:        "played_at",
    watched_end:   "watched_end_at",
    cta_clicked:   "cta_clicked_at",
    liked:         "liked_at",
    render_failed: "render_failed_at",
};

async function handleEngagement(kind: EventKind, email: string) {
    const column = KIND_TO_COLUMN[kind as keyof typeof KIND_TO_COLUMN];
    if (!column) return json({ ok: true, recorded: `${kind}_no_column` });

    const { data: pipe } = await supabase
        .from("outreach_pipeline")
        .select(`sendpilot_lead_id, status, ${column}`)
        .eq("contact_email", email)
        .maybeSingle();

    if (!pipe) {
        console.warn("engagement event with no pipeline row", { kind, email });
        return json({ ok: true, recorded: `${kind}_no_pipeline` });
    }

    // Skip if column is already set — engagement events fire idempotently.
    // deno-lint-ignore no-explicit-any
    if ((pipe as any)[column]) {
        return json({ ok: true, recorded: `${kind}_already_set` });
    }

    const now = new Date().toISOString();
    const update: Record<string, unknown> = { [column]: now };
    if (kind === "render_failed") {
        update.status = "failed";
        update.error = "sendspark video_failed_to_generate";
    }

    await supabase.from("outreach_pipeline").update(update)
        .eq("sendpilot_lead_id", pipe.sendpilot_lead_id);

    return json({ ok: true, recorded: kind, leadId: pipe.sendpilot_lead_id });
}

function json(obj: unknown, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}
