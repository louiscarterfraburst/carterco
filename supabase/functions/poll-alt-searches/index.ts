// Cron-triggered every 2 min. For each outreach_pipeline row with
// alt_search_status='pending':
//   1. GET /v1/lead-database/searches/{id}/status
//   2. On 'completed': GET /results, upsert outreach_alt_contacts, mark
//      alt_search_status = 'completed' (or 'empty' if 0 leads).
//   3. On 'failed': mark alt_search_status='failed'.
//   4. Push-notify subscribers per pipeline row that just got fresh alts.
//
// /team-page Jina fallback is deferred: when SendPilot returns 'empty',
// the row is surfaced in /outreach as "no automated match — research manually."
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";
import webpush from "npm:web-push@3.6.7";
import { workspaceLabel } from "../_shared/workspaces.ts";
import { CARTERCO_WORKSPACE_ID } from "../_shared/icp.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SP_API_KEY = Deno.env.get("SENDPILOT_API_KEY") ?? "";
const SP_SEARCH_BASE = "https://api.sendpilot.ai/v1/lead-database/searches";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

type PipelineRow = {
  sendpilot_lead_id: string;
  workspace_id: string;
  contact_email: string;
  alt_search_id: string;
};

type SpLead = {
  id?: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  job_title?: string;
  linkedin_url?: string;
  seniority?: string;
  employees?: string;
  company?: string;
};

type PushSubscriptionRow = { endpoint: string; p256dh: string; auth: string };
type WebPushError = Error & { statusCode?: number };

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method === "GET") return json({ ok: true, name: "poll-alt-searches" });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const vapidSubject = Deno.env.get("VAPID_SUBJECT") ?? "mailto:louis@carterco.dk";
  const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
  const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
  if (vapidPublicKey && vapidPrivateKey) {
    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  }

  // CarterCo-only — same scoping as score-accepted-lead.
  const { data: rows, error } = await supabase
    .from("outreach_pipeline")
    .select("sendpilot_lead_id, workspace_id, contact_email, alt_search_id")
    .eq("workspace_id", CARTERCO_WORKSPACE_ID)
    .eq("alt_search_status", "pending")
    .not("alt_search_id", "is", null)
    .limit(50);
  if (error) return json({ error: error.message }, 500);
  if (!rows || rows.length === 0) return json({ ok: true, polled: 0 });

  const summary: Array<Record<string, unknown>> = [];
  for (const row of rows as PipelineRow[]) {
    summary.push(await pollOne(row));
  }
  return json({ ok: true, polled: summary.length, summary });
});

async function pollOne(row: PipelineRow): Promise<Record<string, unknown>> {
  const statusRes = await fetch(`${SP_SEARCH_BASE}/${row.alt_search_id}/status`, {
    headers: { "X-API-Key": SP_API_KEY },
  });
  if (!statusRes.ok) {
    return { lead: row.sendpilot_lead_id, error: `status http ${statusRes.status}` };
  }
  const statusBody = await statusRes.json().catch(() => null) as { status?: string } | null;
  const sStatus = statusBody?.status;

  if (sStatus === "pending" || sStatus === "processing") {
    return { lead: row.sendpilot_lead_id, sendpilot_status: sStatus, action: "still_pending" };
  }

  if (sStatus === "failed") {
    await supabase.from("outreach_pipeline")
      .update({ alt_search_status: "failed" })
      .eq("sendpilot_lead_id", row.sendpilot_lead_id);
    return { lead: row.sendpilot_lead_id, action: "marked_failed" };
  }

  if (sStatus !== "completed") {
    return { lead: row.sendpilot_lead_id, sendpilot_status: sStatus, action: "unknown_status" };
  }

  // Completed → fetch results.
  const resRes = await fetch(`${SP_SEARCH_BASE}/${row.alt_search_id}/results`, {
    headers: { "X-API-Key": SP_API_KEY },
  });
  if (!resRes.ok) {
    return { lead: row.sendpilot_lead_id, error: `results http ${resRes.status}` };
  }
  const resBody = await resRes.json().catch(() => null) as { leads?: SpLead[] } | null;
  const leads = (resBody?.leads ?? []) as SpLead[];

  if (leads.length === 0) {
    await supabase.from("outreach_pipeline")
      .update({ alt_search_status: "empty" })
      .eq("sendpilot_lead_id", row.sendpilot_lead_id);
    return { lead: row.sendpilot_lead_id, action: "marked_empty" };
  }

  // Pull the original lead's company name so we can sanity-check that the
  // returned alternates are actually from THAT company (name match is fuzzy).
  const { data: origLead } = await supabase
    .from("outreach_leads")
    .select("company")
    .eq("contact_email", row.contact_email)
    .maybeSingle();
  const origCompany = ((origLead?.company as string | undefined) ?? "").toLowerCase().trim();

  let inserted = 0;
  for (const l of leads) {
    const linkedinUrl = (l.linkedin_url ?? "").trim();
    if (!linkedinUrl) continue;
    const fullName = (l.full_name ?? `${l.first_name ?? ""} ${l.last_name ?? ""}`).trim();
    if (!fullName) continue;

    // Sanity-check: only insert if the company name roughly matches. SendPilot
    // sometimes broadens results when the strict filter doesn't yield enough.
    const altCompany = (l.company ?? "").toLowerCase().trim();
    if (origCompany && altCompany && !companiesMatch(origCompany, altCompany)) {
      continue;
    }

    const { error: insErr } = await supabase.from("outreach_alt_contacts").insert({
      workspace_id: row.workspace_id,
      pipeline_lead_id: row.sendpilot_lead_id,
      name: fullName,
      linkedin_url: linkedinUrl,
      title: l.job_title ?? null,
      seniority: l.seniority ?? null,
      employees: l.employees ?? null,
      company: l.company ?? null,
      source: "sendpilot",
      sendpilot_lead_db_id: l.id ?? null,
    });
    if (insErr && !`${insErr.message}`.includes("duplicate key")) {
      console.error("alt_contact insert error", insErr);
      continue;
    }
    if (!insErr) inserted++;
  }

  const finalStatus = inserted > 0 ? "completed" : "empty";
  await supabase.from("outreach_pipeline")
    .update({ alt_search_status: finalStatus })
    .eq("sendpilot_lead_id", row.sendpilot_lead_id);

  if (inserted > 0) {
    await pushAltsReady(row, origLead?.company as string | null | undefined, inserted);
  }

  return {
    lead: row.sendpilot_lead_id,
    action: finalStatus,
    inserted,
    returned: leads.length,
  };
}

// Cheap fuzzy company-name match. SendPilot may return "Opiniosec" when we
// queried "OpinioSec" — strip whitespace, lowercase, drop common DK suffixes,
// then check inclusion.
function companiesMatch(a: string, b: string): boolean {
  const norm = (s: string) => s
    .replace(/\b(aps|a\/s|ivs|ks|ehv|holding|group|ltd|inc|llc|gmbh|sa|sas)\b\.?/gi, "")
    .replace(/[^a-z0-9]+/gi, "")
    .toLowerCase();
  const aa = norm(a);
  const bb = norm(b);
  if (!aa || !bb) return true;
  return aa.includes(bb) || bb.includes(aa);
}

async function pushAltsReady(row: PipelineRow, company: string | null | undefined, count: number) {
  if (!Deno.env.get("VAPID_PUBLIC_KEY") || !Deno.env.get("VAPID_PRIVATE_KEY")) return;
  const { data: subs } = await supabase
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("workspace_id", row.workspace_id);
  if (!subs || subs.length === 0) return;

  const payload = JSON.stringify({
    title: `${workspaceLabel(row.workspace_id)} /outreach · ${count} alternative${count === 1 ? "" : "r"} fundet`,
    body: company ? `Nye kontaktforslag hos ${company}` : "Nye kontaktforslag fundet",
    url: "/outreach",
  });

  const results = await Promise.allSettled(
    (subs as PushSubscriptionRow[]).map((sub) =>
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      ),
    ),
  );
  const expired: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      const reason = r.reason as WebPushError;
      if (reason.statusCode === 404 || reason.statusCode === 410) {
        expired.push((subs as PushSubscriptionRow[])[i].endpoint);
      }
    }
  });
  if (expired.length > 0) {
    await supabase.from("push_subscriptions").delete().in("endpoint", expired);
  }
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
