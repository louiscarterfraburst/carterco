#!/usr/bin/env node
// Mirrors the CarterCo SendPilot pipeline into the CarterCo lemlist campaign.
//
// What it does:
//   1. Reads every CarterCo outreach_pipeline row + every outreach_leads row
//      that doesn't yet have a pipeline row (workspace 1e067f9a-…-5fa).
//   2. Buckets each lead by SendPilot status: invited / accepted / declined /
//      operator_rejected / not_sent.
//   3. POSTs each to /campaigns/{id}/leads with linkedinUrl, names, company,
//      and a `sendpilotStatus` custom variable so the bucket is visible in
//      the lemlist UI and filterable.
//   4. Prints a breakdown at the end.
//
// Things this DOESN'T do (by design):
//   - It does NOT push the SendPilot reply-routing alias (`carterco+…@carterco.dk`)
//     as the lead email. Those aliases are not real prospect mailboxes — see
//     project_tresyv_carterco_aliases memory + scripts/test-leads/.
//   - It does NOT touch the 2483 stale CRM contacts left over from the
//     pre-script CSV import. lemlist's API has no DELETE /contacts — those
//     must be bulk-deleted from the lemlist UI (Contacts → select all →
//     delete). Re-running this script after deletion is safe (idempotent
//     dedupe on linkedinUrl).
//   - It does NOT launch any leads. autoReview is off on the campaign;
//     every lead lands in "review" until Louis launches it from the UI.
//
// Usage:
//   node scripts/lemlist/sync_carterco_pipeline.mjs            # dry-run (counts only)
//   node scripts/lemlist/sync_carterco_pipeline.mjs --push     # actually push
//   node scripts/lemlist/sync_carterco_pipeline.mjs --push --limit=50  # cap for testing

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");

const WORKSPACE_ID = "1e067f9a-d453-41a7-8bc4-9fdb5644a5fa";
const CAMPAIGN_ID = "cam_M8mQPzp3iYh5NHbsH";

// SendPilot status → lemlist bucket. Captures every status seen on
// outreach_pipeline; new statuses fall through to "unknown" and are imported
// so we don't lose data silently.
function bucketForStatus(status) {
  switch (status) {
    case "invited": return "invited";
    case "accepted":
    case "pending_pre_render":
    case "pending_ai_draft":
    case "rendering":
    case "rendered":
    case "pending_approval":
    case "sent":
    case "pre_connected":
      return "accepted";
    case "failed":
      return "declined";
    case "rejected":
    case "rejected_by_icp":
    case "pending_alt_review":
      return "operator_rejected";
    default:
      return "unknown:" + status;
  }
}

async function loadEnv() {
  const raw = await fs.readFile(path.join(ROOT, ".env.local"), "utf8");
  const out = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function makeLemlist(apiKey) {
  const auth = "Basic " + Buffer.from(":" + apiKey).toString("base64");
  return async function req(method, path, body) {
    const r = await fetch("https://api.lemlist.com/api" + path, {
      method,
      headers: {
        Authorization: auth,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { ok: r.ok, status: r.status, body: parsed, rate: {
      limit: Number(r.headers.get("x-ratelimit-limit") ?? 20),
      remaining: Number(r.headers.get("x-ratelimit-remaining") ?? 20),
    } };
  };
}

async function pageAll(sb, table, select, eq, pageSize = 1000) {
  // Supabase PostgREST has a db-max-rows cap (default 1000). Page via .range().
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await sb
      .from(table)
      .select(select)
      .eq(eq.col, eq.val)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`${table} read: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return out;
}

async function pullCarterco(sb) {
  const pipe = await pageAll(
    sb,
    "outreach_pipeline",
    "sendpilot_lead_id, status, contact_email, linkedin_url, invited_at, accepted_at, sent_at, last_reply_at",
    { col: "workspace_id", val: WORKSPACE_ID },
  );
  const leads = await pageAll(
    sb,
    "outreach_leads",
    "contact_email, linkedin_url, first_name, last_name, company, title, country, vertical, website",
    { col: "workspace_id", val: WORKSPACE_ID },
  );

  const leadByEmail = new Map(leads.map((l) => [l.contact_email, l]));
  const pipelineEmails = new Set(pipe.map((p) => p.contact_email).filter(Boolean));

  // "not_sent" = leads not in pipeline yet
  const notSent = leads.filter((l) => !pipelineEmails.has(l.contact_email));

  return { pipe, leadByEmail, notSent };
}

function toLemlistLead(common, bucket, sourceStatus) {
  // Required-ish for LinkedIn outreach: linkedinUrl. Other fields are
  // nice-to-have. We deliberately omit `email` since SendPilot aliases aren't
  // real mailboxes; an email step would bounce against carterco+…@carterco.dk.
  return {
    firstName: common.first_name ?? "",
    lastName: common.last_name ?? "",
    companyName: common.company ?? "",
    linkedinUrl: common.linkedin_url ?? "",
    jobTitle: common.title ?? "",
    // Custom variables go as flat top-level keys (lemlist quirk — nesting them
    // under `customVariables` serialises to "[object Object]" silently).
    sendpilotStatus: bucket,
    sendpilotRawStatus: sourceStatus ?? "",
    sendpilotCountry: common.country ?? "",
    sendpilotVertical: common.vertical ?? "",
  };
}

async function main() {
  const args = process.argv.slice(2);
  const push = args.includes("--push");
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : null;

  const env = await loadEnv();
  if (!env.LEMLIST_API) throw new Error("LEMLIST_API missing in .env.local");
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase env missing in .env.local");
  }
  const sb = createSupabaseClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );
  const lemlist = makeLemlist(env.LEMLIST_API);

  console.log("Pulling CarterCo SendPilot data…");
  const { pipe, leadByEmail, notSent } = await pullCarterco(sb);
  console.log(`  pipeline: ${pipe.length}, leads-not-in-pipeline: ${notSent.length}`);

  // Operator-rejected leads (rejected, rejected_by_icp, pending_alt_review)
  // are excluded from the lemlist import — we explicitly said no to them, and
  // pushing them in queues them for re-invite. Pass --include-rejected to
  // override.
  const includeRejected = args.includes("--include-rejected");

  // Build the full job list with buckets
  const jobs = [];
  const counts = {};
  for (const p of pipe) {
    const bucket = bucketForStatus(p.status);
    counts[bucket] = (counts[bucket] ?? 0) + 1;
    if (bucket === "operator_rejected" && !includeRejected) continue;
    const common = leadByEmail.get(p.contact_email) ?? {};
    // Prefer pipeline linkedin_url (authoritative for invite path)
    common.linkedin_url = p.linkedin_url || common.linkedin_url;
    if (!common.linkedin_url) continue;
    jobs.push({ bucket, sourceStatus: p.status, body: toLemlistLead(common, bucket, p.status) });
  }
  for (const l of notSent) {
    counts.not_sent = (counts.not_sent ?? 0) + 1;
    if (!l.linkedin_url) continue;
    jobs.push({ bucket: "not_sent", sourceStatus: null, body: toLemlistLead(l, "not_sent", null) });
  }

  console.log("");
  console.log("=== SendPilot status breakdown ===");
  const order = ["invited", "accepted", "declined", "operator_rejected", "not_sent"];
  let total = 0;
  for (const k of order) {
    const n = counts[k] ?? 0;
    if (n) console.log(`  ${k.padEnd(20)} ${String(n).padStart(5)}`);
    total += n;
  }
  for (const k of Object.keys(counts)) {
    if (!order.includes(k)) console.log(`  ${k.padEnd(20)} ${String(counts[k]).padStart(5)}  ← unmapped status`);
  }
  console.log(`  ${"TOTAL".padEnd(20)} ${String(total).padStart(5)}`);
  const skipped = total - jobs.length;
  if (skipped > 0) console.log(`  ${"(skipped: no LinkedIn URL)".padEnd(20)} ${String(skipped).padStart(5)}`);
  console.log("");

  if (!push) {
    console.log("Dry run. Pass --push to actually create leads in lemlist.");
    console.log(`Target: ${CAMPAIGN_ID}`);
    return;
  }

  // Throttle to ~8 req/sec to stay safely under 20/2s.
  const SLEEP_MS = 130;
  const toPush = limit ? jobs.slice(0, limit) : jobs;
  console.log(`Pushing ${toPush.length} leads → ${CAMPAIGN_ID}…`);
  const result = { ok: 0, dupe: 0, err: 0, errors: [] };
  for (let i = 0; i < toPush.length; i++) {
    const job = toPush[i];
    const r = await lemlist("POST", `/campaigns/${CAMPAIGN_ID}/leads/`, job.body);
    if (r.ok) {
      result.ok++;
    } else if (r.status === 409 || (r.body?.error ?? "").toString().toLowerCase().includes("already")) {
      result.dupe++;
    } else if (r.status === 429) {
      // Rate-limited — back off and retry once.
      await new Promise((res) => setTimeout(res, 2200));
      const r2 = await lemlist("POST", `/campaigns/${CAMPAIGN_ID}/leads/`, job.body);
      if (r2.ok) result.ok++;
      else { result.err++; result.errors.push({ idx: i, status: r2.status, body: r2.body, name: `${job.body.firstName} ${job.body.lastName}` }); }
    } else {
      result.err++;
      if (result.errors.length < 10) {
        result.errors.push({ idx: i, status: r.status, body: r.body, name: `${job.body.firstName} ${job.body.lastName}` });
      }
    }
    if ((i + 1) % 50 === 0) {
      console.log(`  ${i + 1}/${toPush.length}  ok=${result.ok} dupe=${result.dupe} err=${result.err}`);
    }
    await new Promise((res) => setTimeout(res, SLEEP_MS));
  }
  console.log("");
  console.log("=== Push complete ===");
  console.log(`  created:    ${result.ok}`);
  console.log(`  duplicates: ${result.dupe}`);
  console.log(`  errors:     ${result.err}`);
  if (result.errors.length) {
    console.log("First errors:");
    for (const e of result.errors.slice(0, 5)) {
      console.log(`  [${e.idx}] ${e.name} → HTTP ${e.status}: ${JSON.stringify(e.body).slice(0, 200)}`);
    }
  }
  console.log("");
  console.log("Next: open the campaign in lemlist → Leads tab → filter by `sendpilotStatus` to see each bucket.");
}

main().catch((e) => { console.error(e); process.exit(1); });
