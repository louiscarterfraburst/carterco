// Reconciler for outreach_pipeline rows stuck in `rendering`. Defends
// against the failure mode where SendSpark renders successfully and fires
// the webhook, but the webhook delivery is dropped (auth gate, network,
// Svix retry exhaustion). Without this, the row sits in `rendering`
// forever even though the video exists.
//
// Strategy: find rows in `rendering` for ≥ min_age_minutes (default 30),
// and for each, re-POST the prospect to SendSpark. SendSpark either
// regenerates in place (regenerationCount++) or accepts a duplicate;
// either way it fires a fresh `video_generated_dv` webhook with the
// share token. Our (now-fixed) sendspark-webhook captures it and flips
// the row to `pending_approval`.
//
// Wired to pg_cron every 10 min (see supabase/recover_stuck_renders.sql).
// Also callable manually with `{"dryRun": true}` for inspection or
// `{"diagnose": true}` to dump SendSpark prospect state.
//
// Safety:
//   - min_age_minutes (default 30) avoids racing healthy renders.
//   - missing_website rows skipped (sendspark-webhook gate already
//     marks them failed).
//   - max_attempts (default 3): we tag the error column with
//     `reconcile_attempt_N` so we stop after N retries instead of
//     looping forever on a render SendSpark genuinely can't complete.
//   - hard_fail_after_hours (default 24): rows older than this are
//     marked failed so the cron stops touching them.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";
import { firstNameForGreeting, normalizeCompanyName, normalizeWebsiteUrl, urlOrigin } from "../_shared/text.ts";
import { sendsparkCredsFor } from "../_shared/sendspark-config.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

const SS_DYNAMIC_DEFAULT = Deno.env.get("SENDSPARK_DYNAMIC") ?? "";

const RECONCILE_TAG = "reconcile_attempt_";

function pickDynamic(campaignId: string | null | undefined): string {
  const id = (campaignId ?? "").trim();
  if (id) {
    const perCampaign = Deno.env.get(`SS_DYNAMIC_${id}`);
    if (perCampaign) return perCampaign;
  }
  return SS_DYNAMIC_DEFAULT;
}

// Parse `reconcile_attempt_N: ...` out of the error column. Returns 0 if
// not previously reconciled. This is a poor man's audit log — we could
// move it to a dedicated table later if we end up wanting per-attempt
// timestamps.
function priorAttempts(errorMsg: string | null | undefined): number {
  if (!errorMsg) return 0;
  const m = String(errorMsg).match(new RegExp(`${RECONCILE_TAG}(\\d+)`));
  return m ? Number(m[1]) : 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: {
    dryRun?: boolean;
    limit?: number;
    diagnose?: boolean;
    min_age_minutes?: number;
    max_attempts?: number;
    hard_fail_after_hours?: number;
  };
  try { body = await req.json().catch(() => ({})); } catch { body = {}; }

  const dryRun = body.dryRun === true;
  const limit = body.limit ?? 50;
  const minAgeMin = body.min_age_minutes ?? 30;
  const maxAttempts = body.max_attempts ?? 3;
  const hardFailHrs = body.hard_fail_after_hours ?? 24;

  if (body.diagnose === true) return await diagnose(limit);

  const cutoffIso = new Date(Date.now() - minAgeMin * 60_000).toISOString();
  const hardFailIso = new Date(Date.now() - hardFailHrs * 3600_000).toISOString();

  // Age gates use `decided_at` (when the render was actually kicked off via
  // outreach-approve), falling back to `accepted_at` for legacy rows that
  // pre-date the pending_pre_render gate and went straight from accept to
  // rendering. Using accepted_at alone would hard-fail any lead that sat in
  // pending_pre_render for >24h the moment its render starts.
  const { data: candidates, error: stuckErr } = await supabase
    .from("outreach_pipeline")
    .select("sendpilot_lead_id, contact_email, accepted_at, decided_at, campaign_id, workspace_id, error")
    .eq("status", "rendering")
    .not("contact_email", "eq", "")
    .order("accepted_at", { ascending: true })
    .limit(limit * 4);
  if (stuckErr) return json({ error: "DB select failed", details: stuckErr.message }, 500);
  const stuck = (candidates ?? [])
    .filter((r) => {
      const renderStarted = (r.decided_at as string | null) ?? (r.accepted_at as string | null);
      return renderStarted !== null && renderStarted < cutoffIso;
    })
    .slice(0, limit);
  if (stuck.length === 0) return json({ ok: true, reconciled: 0, note: "nothing stuck" });

  const reconciled: Array<{ sendpilot_lead_id: string; attempt: number }> = [];
  const skipped: Array<{ sendpilot_lead_id: string; reason: string }> = [];
  const hardFailed: string[] = [];

  for (const row of stuck) {
    const errMsg = row.error as string | null;
    const renderStarted = (row.decided_at as string | null) ?? (row.accepted_at as string | null);

    // Hard fail: too old, give up.
    if (renderStarted && renderStarted < hardFailIso) {
      if (!dryRun) {
        await supabase.from("outreach_pipeline").update({
          status: "failed",
          error: `${errMsg ?? ""}; hard_fail_after_${hardFailHrs}h`.slice(0, 500),
        }).eq("sendpilot_lead_id", row.sendpilot_lead_id);
      }
      hardFailed.push(row.sendpilot_lead_id);
      continue;
    }

    const attempts = priorAttempts(errMsg);
    if (attempts >= maxAttempts) {
      skipped.push({ sendpilot_lead_id: row.sendpilot_lead_id, reason: `max_attempts_${attempts}` });
      continue;
    }

    // Skip already-known unfixable conditions.
    if (errMsg && errMsg.startsWith("missing_website")) {
      skipped.push({ sendpilot_lead_id: row.sendpilot_lead_id, reason: "missing_website" });
      continue;
    }

    const { data: lead } = await supabase
      .from("outreach_leads")
      .select("first_name, last_name, company, title, website")
      .eq("contact_email", row.contact_email)
      .maybeSingle();
    if (!lead) {
      skipped.push({ sendpilot_lead_id: row.sendpilot_lead_id, reason: "no_outreach_leads_row" });
      continue;
    }
    if (!normalizeWebsiteUrl(lead.website)) {
      if (!dryRun) {
        await supabase.from("outreach_pipeline").update({
          status: "failed",
          error: "missing_website: lead.website empty — render skipped to avoid carterco.dk fallback",
        }).eq("sendpilot_lead_id", row.sendpilot_lead_id);
      }
      skipped.push({ sendpilot_lead_id: row.sendpilot_lead_id, reason: "missing_website" });
      continue;
    }

    if (dryRun) {
      reconciled.push({ sendpilot_lead_id: row.sendpilot_lead_id, attempt: attempts + 1 });
      continue;
    }

    const dynamicId = pickDynamic(row.campaign_id as string | null);
    const creds = sendsparkCredsFor(row.workspace_id as string | null);
    if (creds.source === "missing") {
      skipped.push({ sendpilot_lead_id: row.sendpilot_lead_id, reason: `no_sendspark_creds_for_workspace_${row.workspace_id}` });
      continue;
    }
    const ssRes = await fetch(
      `https://api-gw.sendspark.com/v1/workspaces/${creds.workspace}/dynamics/${dynamicId}/prospect`,
      {
        method: "POST",
        headers: {
          "x-api-key": creds.apiKey,
          "x-api-secret": creds.apiSecret,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          processAndAuthorizeCharge: true,
          prospect: {
            contactName: firstNameForGreeting(lead.first_name as string) || "there",
            contactEmail: row.contact_email,
            company: normalizeCompanyName(lead.company as string).slice(0, 80),
            jobTitle: ((lead.title as string) ?? "").slice(0, 100),
            backgroundUrl: urlOrigin(lead.website as string),
          },
        }),
      },
    );

    const nextAttempt = attempts + 1;
    if (!ssRes.ok) {
      const errBody = await ssRes.text().catch(() => "");
      await supabase.from("outreach_pipeline").update({
        status: "failed",
        error: `${RECONCILE_TAG}${nextAttempt}: HTTP ${ssRes.status} — ${errBody.slice(0, 200)}`,
      }).eq("sendpilot_lead_id", row.sendpilot_lead_id);
      skipped.push({ sendpilot_lead_id: row.sendpilot_lead_id, reason: `sendspark_${ssRes.status}` });
      continue;
    }

    // Tag the error column with the attempt count so the next cron tick
    // knows we tried. Status stays `rendering` — the new webhook will
    // flip it to `pending_approval` when SendSpark re-fires.
    await supabase.from("outreach_pipeline").update({
      error: `${RECONCILE_TAG}${nextAttempt}: re-posted to sendspark`,
    }).eq("sendpilot_lead_id", row.sendpilot_lead_id);
    reconciled.push({ sendpilot_lead_id: row.sendpilot_lead_id, attempt: nextAttempt });
  }

  return json({
    ok: true,
    dryRun,
    minAgeMin,
    maxAttempts,
    hardFailHrs,
    stuckScanned: stuck.length,
    reconciled: reconciled.length,
    skipped: skipped.length,
    hardFailed: hardFailed.length,
    samples: {
      reconciled: reconciled.slice(0, 5),
      skipped: skipped.slice(0, 5),
      hardFailed: hardFailed.slice(0, 5),
    },
  });
});

async function diagnose(limit: number) {
  const { data: stuck } = await supabase
    .from("outreach_pipeline")
    .select("sendpilot_lead_id, contact_email, accepted_at, decided_at, campaign_id, workspace_id")
    .eq("status", "rendering")
    .not("contact_email", "eq", "")
    .order("accepted_at", { ascending: true })
    .limit(limit);
  if (!stuck || stuck.length === 0) return json({ ok: true, note: "nothing stuck" });

  // Group by (workspace_id, dynamic_id): each combo hits a different SendSpark
  // account + a different dynamic within that account, so each needs its own
  // probe call.
  const byKey = new Map<string, { workspaceId: string | null; dynamicId: string; probeEmail: string }>();
  for (const r of stuck) {
    const dyn = pickDynamic(r.campaign_id as string | null);
    const ws = (r.workspace_id as string | null) ?? null;
    const key = `${ws ?? "null"}::${dyn}`;
    if (!byKey.has(key)) byKey.set(key, { workspaceId: ws, dynamicId: dyn, probeEmail: r.contact_email as string });
  }

  const out: Record<string, unknown> = { groups: {} };
  for (const [key, { workspaceId, dynamicId, probeEmail }] of byKey) {
    const creds = sendsparkCredsFor(workspaceId);
    if (creds.source === "missing") {
      (out.groups as Record<string, unknown>)[key] = { error: `no SendSpark creds for workspace ${workspaceId}` };
      continue;
    }
    const { data: probeLead } = await supabase
      .from("outreach_leads")
      .select("first_name, company, title, website")
      .eq("contact_email", probeEmail)
      .maybeSingle();
    const ssRes = await fetch(
      `https://api-gw.sendspark.com/v1/workspaces/${creds.workspace}/dynamics/${dynamicId}/prospect`,
      {
        method: "POST",
        headers: {
          "x-api-key": creds.apiKey,
          "x-api-secret": creds.apiSecret,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          processAndAuthorizeCharge: false,
          prospect: {
            contactName: firstNameForGreeting(probeLead?.first_name) || "there",
            contactEmail: probeEmail,
            company: (probeLead?.company ?? "").slice(0, 80),
            jobTitle: (probeLead?.title ?? "").slice(0, 100),
            backgroundUrl: probeLead?.website ?? "",
          },
        }),
      },
    );
    if (!ssRes.ok) {
      (out.groups as Record<string, unknown>)[key] = { error: `HTTP ${ssRes.status}`, creds_source: creds.source };
      continue;
    }
    const j = await ssRes.json() as { prospectList?: Array<Record<string, unknown>> };
    const list = j.prospectList ?? [];
    const stuckEmails = new Set(stuck.map((r) => (r.contact_email as string).toLowerCase()));
    const ours = list.filter((p) => stuckEmails.has(String(p.contactEmail ?? "").toLowerCase()));
    (out.groups as Record<string, unknown>)[key] = {
      workspace_id: workspaceId,
      sendspark_workspace: creds.workspace,
      dynamic_id: dynamicId,
      creds_source: creds.source,
      total_in_dynamic: list.length,
      our_stuck_in_dynamic: ours.length,
      compact: ours.map((p) => ({
        contactEmail: p.contactEmail,
        status: p.status,
        valid: p.valid,
        backgroundUrl: p.backgroundUrl,
        originalBackgroundUrl: p.originalBackgroundUrl,
        videoStatus: (p.resourcesStatus as Record<string, Record<string, unknown>> | undefined)?.video,
        regenerationCount: p.regenerationCount,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })),
    };
  }
  return json(out);
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
