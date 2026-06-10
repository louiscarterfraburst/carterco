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
import { getPlayConfig, hookAllowed } from "../_shared/plays.ts";
import { classifyBackground } from "../_shared/background.ts";
import { firstNameForGreeting, humanize, normalizeCompanyName, normalizeWebsiteUrl } from "../_shared/text.ts";

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
    // Background URLs — field names unconfirmed against a real payload (see
    // header caveat). classifyBackground treats absence as 'unknown'.
    backgroundUrl?: string;
    originalBackgroundUrl?: string;
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

// Play-specific DM templates (e.g. hiring_signal's job-posting opener) live in
// outreach_plays.dm_template — see getPlayConfig. Only the referral and
// workspace-default templates remain code/env-level.

// Follow-up template used when the recipient came in via a reply_referral
// alt_contact (referred_from_pipeline_lead_id is set on the pipeline row).
// Substitutions: {firstName} (recipient), {referrerFirstName}, {videoLink}.
// Tunable via OUTREACH_REFERRAL_TEMPLATE env var.
const REFERRAL_TEMPLATE_DEFAULT = [
    "Hej {firstName}, tak for connectet — som lovet, her er videoen {referrerFirstName} så:",
    "",
    "{videoLink}",
].join("\n");

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
        .select("sendpilot_lead_id, contact_email, status, campaign_id, referred_from_pipeline_lead_id, sent_at, personalized_hook, invite_source, lemlist_lead_id, lemlist_campaign_id, play, workspace_id")
        .eq("contact_email", email)
        .maybeSingle();

    if (!pipe) {
        console.warn("video_generated_dv with no matching pipeline row", { email, videoLink });
        return json({ ok: true, recorded: "render_no_pipeline" });
    }

    if (pipe.status === "sent" || pipe.status === "rejected") {
        return json({ ok: true, recorded: "render_after_terminal" });
    }
    // Queued/in-flight/parked guard: once a DM is in the drip queue
    // (approved_queued), being sent (sending), or parked for fallback review
    // (rendered), a late render_ready — SendSpark regeneration,
    // recover-stuck-renders re-post — must NOT rewrite rendered_message
    // (the operator-approved text is a binding contract) or reset status,
    // which would silently yank the DM out of the queue.
    if (pipe.status === "approved_queued" || pipe.status === "sending" || pipe.status === "rendered") {
        console.warn("video_generated_dv arrived for queued/parked lead — ignoring", {
            email,
            new_video_link: videoLink,
            status_was: pipe.status,
        });
        return json({ ok: true, recorded: `render_while_${pipe.status}_ignored` });
    }
    // Already-sent guard: if the DM has gone out, the URL in LinkedIn is the
    // source of truth and is immutable. A late-arriving render_ready (e.g.
    // SendSpark regenerated the asset, or recover-stuck-renders re-posted the
    // prospect) MUST NOT overwrite video_link / rendered_message — doing so
    // detaches the DM from the actual asset and the prospect 404s when they
    // click. We just log the event for audit and ignore the new render. The
    // status stays whatever it was (typically `sent`).
    if (pipe.sent_at) {
        console.warn("video_generated_dv arrived for already-sent lead — ignoring (DM points at original URL)", {
            email,
            new_video_link: videoLink,
            status_was: pipe.status,
            sent_at: pipe.sent_at,
        });
        return json({ ok: true, recorded: "render_after_sent_ignored" });
    }
    if (pipe.status === "pending_pre_render") {
        console.warn("video_generated_dv arrived before pre-render approval", { email, videoLink });
        return json({ ok: true, recorded: "render_before_pre_render_approval" });
    }

    const { data: lead } = await supabase
        .from("outreach_leads")
        .select("first_name, last_name, company, website, role")
        .eq("contact_email", email)
        .maybeSingle();

    const firstName = firstNameForGreeting(lead?.first_name) || "der";
    const company = normalizeCompanyName(lead?.company);
    const website = normalizeWebsiteUrl(lead?.website);
    const role = ((lead?.role as string | null) ?? "").trim();  // hiring-signal: the posted role, for {role}

    // Registry config for this lead's play: dm_template overrides the default
    // template path; use_personalized_hook=false disables the Becc hook. A
    // FAILED lookup (ok:false) falls back to the default template and fails
    // the hook closed — never the other play's behavior.
    const playLookup = await getPlayConfig(supabase, pipe.play, pipe.workspace_id);
    const playCfg = playLookup.ok ? playLookup.config : null;

    // Referral path: when this lead came in via a reply_referral alt_contact,
    // swap the cold opener for a referral-aware template that thanks them for
    // connecting and presents the (freshly rendered, name-personalised) video
    // as the artifact the referrer pointed them to. We look up the referrer's
    // first name from their pipeline row.
    let template: string;
    let referrerFirstName = "vores fælles kontakt";
    if (pipe.referred_from_pipeline_lead_id) {
        const { data: refPipe } = await supabase
            .from("outreach_pipeline")
            .select("contact_email")
            .eq("sendpilot_lead_id", pipe.referred_from_pipeline_lead_id)
            .maybeSingle();
        if (refPipe?.contact_email) {
            const { data: refLead } = await supabase
                .from("outreach_leads")
                .select("first_name")
                .eq("contact_email", refPipe.contact_email)
                .maybeSingle();
            referrerFirstName = firstNameForGreeting(refLead?.first_name) || referrerFirstName;
        }
        template = Deno.env.get("OUTREACH_REFERRAL_TEMPLATE") || REFERRAL_TEMPLATE_DEFAULT;
    } else if (playCfg?.dm_template) {
        // Play-specific DM from the outreach_plays registry (e.g.
        // hiring_signal's job-posting opener). The REGISTRY wins over any
        // legacy per-campaign OUTREACH_TEMPLATE_<id> secret: the registry is
        // the operator-editable source of truth (Louis, 2026-06-10 — "vi skal
        // bruge den nye tekst template"); the env secret survives only as the
        // path for plays/campaigns with no registry template.
        template = playCfg.dm_template;
    } else {
        // Use the SendPilot campaign_id we stored on the pipeline row, not
        // SendSpark's own campaignId — keeps env-var keys consistent with the
        // sequence-template overrides in outreach-engagement-tick.
        template = pickTemplate(pipe.campaign_id ?? undefined);
    }

    const templated = template
        .replaceAll("{firstName}", firstName)
        .replaceAll("{referrerFirstName}", referrerFirstName)
        .replaceAll("{company}", company)
        .replaceAll("{website}", website)
        .replaceAll("{role}", role)
        .replaceAll("{videoLink}", videoLink);

    // Becc-bucket personalization (CarterCo): when a body was generated for this
    // cold lead, it REPLACES the generic website opener. personalized_hook now
    // holds the full DM body (observation + bridge into the video) — the model
    // never emits the URL, so we append the link on its own paragraph here.
    // Referral opens keep their own template; no hook => fall back to the static
    // templated message (Bucket-6 website line).
    // humanize() here is the catch-all: any hook (old-prompt rows generated
    // before the no-dash/no-™ rules, or any path) is cleaned before it's baked
    // into rendered_message, so CarterCo outbound never ships an em dash or ™.
    const hook = humanize((pipe.personalized_hook ?? "").trim());
    // Plays with use_personalized_hook=false (registry config) NEVER use the
    // personalized_hook — e.g. hiring_signal, whose hook generator bakes in
    // the banned "testede jeres lead-flow" claim. Their dm_template wins.
    // hookAllowed fails CLOSED when the registry lookup errored.
    const useHook = !pipe.referred_from_pipeline_lead_id && hook && hookAllowed(playLookup);
    const message = useHook
        ? `Hej ${firstName}\n\n${hook}\n\n${videoLink}`
        : templated;

    const now = new Date().toISOString();

    // Fallback-background gate: when SendSpark demonstrably rendered the
    // workspace-default background instead of the prospect's site, park the
    // row as 'rendered' (no queued_at) instead of queueing it for approval —
    // an approver scanning the cockpit queue won't catch a wrong-branded
    // video (the Victor Lisberg case). 'unknown' (payload didn't expose
    // background URLs — the common case until field names are confirmed)
    // queues normally.
    const backgroundStatus = classifyBackground(evt);
    const parkAsFallback = backgroundStatus === "fallback";
    if (parkAsFallback) {
        console.warn("render used fallback background — parking for manual review, NOT queueing", {
            email,
            requested: evt.originalBackgroundUrl,
            rendered: evt.backgroundUrl,
        });
    }

    // All initial video messages queue for human approval before they go out.
    // No auto-send branch for cold vs warm — every video gets a manual eyeball.
    // The error MUST be checked: a silent failure here (e.g. the function
    // deployed before outreach.sql added background_status → PGRST204, or a
    // trigger rejection) would strand the lead at status='rendering' forever
    // while telling SendSpark everything is fine. A 500 makes SendSpark retry
    // and the gap observable.
    const { error: updErr } = await supabase.from("outreach_pipeline").update({
        video_link: videoLink,
        embed_link: evt.embedLink ?? null,
        thumbnail_url: evt.thumbnailUrl ?? null,
        rendered_message: message,
        rendered_at: now,
        queued_at: parkAsFallback ? null : now,
        status: parkAsFallback ? "rendered" : "pending_approval",
        background_status: backgroundStatus,
    }).eq("sendpilot_lead_id", pipe.sendpilot_lead_id);
    if (updErr) {
        console.error("render_ready pipeline update failed", { email, error: updErr.message });
        return json({ error: "DB error", details: updErr.message }, 500);
    }

    if (parkAsFallback) {
        return json({ ok: true, recorded: "render_fallback_background_parked" });
    }

    // Lemlist branch: push rendered_message + video link as custom variables
    // on the lemlist lead so the campaign's linkedinSend step uses them when
    // it fires. Don't resume yet — outreach-approve calls /leads/start once
    // the human approves the rendered DM (mirrors the SendPilot approval gate).
    if ((pipe as { invite_source?: string }).invite_source === "lemlist") {
        const lemlistLeadId = (pipe as { lemlist_lead_id?: string }).lemlist_lead_id;
        const lemlistCampaignId = (pipe as { lemlist_campaign_id?: string }).lemlist_campaign_id;
        const apiKey = Deno.env.get("LEMLIST_API") ?? "";
        if (lemlistLeadId && lemlistCampaignId && apiKey) {
            const auth = "Basic " + btoa(":" + apiKey);
            const patchUrl = `https://api.lemlist.com/api/campaigns/${lemlistCampaignId}/leads/${lemlistLeadId}`;
            const r = await fetch(patchUrl, {
                method: "PATCH",
                headers: { Authorization: auth, "Content-Type": "application/json" },
                body: JSON.stringify({
                    renderedMessage: message,
                    videoUrl: videoLink,
                    personalizedHook: hook || null,
                    hookBucket: (pipe as { hook_bucket?: string }).hook_bucket ?? null,
                }),
            });
            if (!r.ok) {
                console.warn("lemlist PATCH lead variables failed", {
                    lemlistLeadId, status: r.status, body: await r.text(),
                });
            }
        }
    }

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
        .select(`sendpilot_lead_id, status, sent_at, ${column}`)
        .eq("contact_email", email)
        .maybeSingle();

    if (!pipe) {
        console.warn("engagement event with no pipeline row", { kind, email });
        return json({ ok: true, recorded: `${kind}_no_pipeline` });
    }

    const now = new Date();
    if (kind !== "render_failed") {
        const sentAtRaw = (pipe as { sent_at?: string | null }).sent_at;
        const sentAt = sentAtRaw ? new Date(sentAtRaw) : null;
        const internalPreviewBufferMs = 5 * 60 * 1000;
        if (!sentAt || now.getTime() <= sentAt.getTime() + internalPreviewBufferMs) {
            return json({ ok: true, recorded: `${kind}_ignored_internal_preview` });
        }

        // Skip only if the existing engagement is already a valid post-send
        // prospect signal. Older pre-send/internal previews may be overwritten
        // by a later real engagement.
        const existingRaw = (pipe as Record<string, string | null | undefined>)[column];
        if (existingRaw) {
            const existing = new Date(existingRaw);
            if (existing.getTime() > sentAt.getTime() + internalPreviewBufferMs) {
                return json({ ok: true, recorded: `${kind}_already_set` });
            }
        }
    } else {
        // Skip if column is already set — render_failed events fire idempotently.
        const existingRaw = (pipe as Record<string, string | null | undefined>)[column];
        if (existingRaw) {
            return json({ ok: true, recorded: `${kind}_already_set` });
        }
    }

    const update: Record<string, unknown> = { [column]: now.toISOString() };
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
