#!/usr/bin/env node
// Provisions the CarterCo lemlist campaign as a parallel installation of the
// existing /outreach setup (workspace 1e067f9a-d453-41a7-8bc4-9fdb5644a5fa,
// ad_funnel_leak strategy). Idempotent: re-running finds the existing campaign
// by name and prints its layout instead of duplicating.
//
// Mirrors the unwatched_followup_v1 cadence from outreach_sequences (text-only;
// SendSpark video render has no lemlist equivalent and is intentionally out of
// scope for this duplicate).
//
// Reads LEMLIST_API from .env.local.
//
// Usage:
//   node scripts/lemlist/provision_carterco_campaign.mjs            # create or describe
//   node scripts/lemlist/provision_carterco_campaign.mjs --layout   # describe only
//   node scripts/lemlist/provision_carterco_campaign.mjs --reset    # wipe steps + re-add
//
// Manual cleanup of stale campaigns: lemlist API does not expose DELETE on
// /campaigns/{id}. Use the lemlist UI to archive/delete (Campaigns → menu).

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");

const CAMPAIGN_NAME = "CarterCo — ad_funnel_leak (DK)";
const TIMEZONE = "Europe/Copenhagen";

// Voice mirrors clients/carterco/agent-brief.md + outreach_sequences.steps.
// Liquid placeholders: {{firstName}}, {{companyName}} are lemlist built-ins.
// For per-lead AI-personalised first DM, upgrade by pre-computing the message
// as a custom variable on the lead (e.g. {{firstDM}}) and swapping FIRST_DM
// below to reference it. See docs/lemlist.md for the upgrade path.
const FIRST_DM = [
  "Hej {{firstName}}, så I kører annoncer for {{companyName}} i øjeblikket — hurtig spørgsmål: hvad sker der lige nu når leadsne lander?",
  "",
  "Skriver en del med danske SMV'er om response-time og opfølgning, og det er som regel der det halter.",
  "",
  "Hvis det er noget hos jer, fortæller jeg gerne hvad jeg har bygget hos andre — sig til.",
].join("\n");

const QUALIFIER = [
  "Hej {{firstName}}",
  "",
  "Hurtigt spørgsmål: er du den rigtige hos jer at tale med om dette, eller skal jeg fange en anden? Sig også til hvis det ikke er relevant.",
].join("\n");

const GRACEFUL_EXIT = [
  "Hej {{firstName}}",
  "",
  "Jeg lukker den herfra for nu.",
  "",
  "Hvis det bliver relevant senere, er du meget velkommen til at skrive, så tager vi den derfra.",
  "",
  "God dag.",
].join("\n");

// ---------- env ----------
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

// ---------- client ----------
function makeClient(apiKey) {
  const auth = "Basic " + Buffer.from(":" + apiKey).toString("base64");
  const base = "https://api.lemlist.com/api";

  async function req(method, pathname, body) {
    const url = pathname.startsWith("http") ? pathname : base + pathname;
    const r = await fetch(url, {
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
    if (!r.ok) {
      const err = new Error(`lemlist ${method} ${pathname} → ${r.status}: ${text.slice(0, 400)}`);
      err.status = r.status;
      err.body = parsed;
      throw err;
    }
    return parsed;
  }

  return {
    get: (p) => req("GET", p),
    post: (p, b) => req("POST", p, b),
    patch: (p, b) => req("PATCH", p, b),
    delete: (p) => req("DELETE", p),
  };
}

// ---------- ops ----------
async function findCampaignByName(client, name) {
  // /campaigns defaults to v1; v2 returns paginated {campaigns, pagination}.
  let page = 1;
  for (;;) {
    const res = await client.get(`/campaigns?version=v2&page=${page}&limit=100`);
    const list = res.campaigns ?? [];
    for (const c of list) if (c.name === name) return c;
    if (!res.pagination || page >= (res.pagination.totalPage ?? 0)) return null;
    page++;
  }
}

async function createCampaign(client, name) {
  return client.post("/campaigns", { name, timezone: TIMEZONE, autoReview: false });
}

async function getSequences(client, campaignId) {
  return client.get(`/campaigns/${campaignId}/sequences`);
}

async function addStep(client, sequenceId, step) {
  return client.post(`/sequences/${sequenceId}/steps`, step);
}

async function deleteStep(client, sequenceId, stepId) {
  return client.delete(`/sequences/${sequenceId}/steps/${stepId}`);
}

function findRootSequence(sequencesObj) {
  for (const [id, seq] of Object.entries(sequencesObj)) {
    if (seq.level === 0 || (!seq.parentId && (seq.level ?? 0) === 0)) return { id, seq };
  }
  // Fallback: first key.
  const first = Object.entries(sequencesObj)[0];
  return first ? { id: first[0], seq: first[1] } : null;
}

function findAcceptedBranchSequenceId(rootSeq) {
  for (const step of rootSeq.steps ?? []) {
    if (step.type !== "conditional") continue;
    const accepted = (step.conditions ?? []).find(
      (c) => c.key === "linkedinInviteAccepted",
    );
    if (accepted) return accepted.sequenceId;
  }
  return null;
}

async function wipeSteps(client, rootSequenceId, rootSeq) {
  // Delete steps in reverse order (last first) — fewer index shifts.
  const steps = (rootSeq.steps ?? []).slice().reverse();
  for (const s of steps) {
    console.log(`  wipe ${s.type} ${s._id}`);
    await deleteStep(client, rootSequenceId, s._id);
  }
}

async function buildSteps(client, rootSequenceId) {
  // 1) profile visit — shows up in their "who viewed your profile". Soft
  // warmup before the invite lifts accept rate (Becc-Holland-style).
  console.log("  + linkedinVisit (warmup)");
  await addStep(client, rootSequenceId, { type: "linkedinVisit", delay: 0 });

  // 2) cold invite, no note. /outreach default — cold invites perform
  // better without a 300-char note that hits LinkedIn premium limits.
  // +1d after visit so the visit registers before they see the request.
  console.log("  + linkedinInvite (cold, no note, +1d)");
  await addStep(client, rootSequenceId, { type: "linkedinInvite", delay: 1, message: "" });

  // 3) conditional: did they accept?
  console.log("  + conditional linkedinInviteAccepted waitUntil");
  const cond = await addStep(client, rootSequenceId, {
    type: "conditional",
    conditionKey: "linkedinInviteAccepted",
    delayType: "waitUntil",
  });
  const acceptedBranchId = cond.conditions.find((c) => c.key === "linkedinInviteAccepted")
    .sequenceId;

  // 4) first DM (ad_funnel_leak voice) — fires immediately on accept
  console.log(`  + linkedinSend (first DM) → ${acceptedBranchId}`);
  await addStep(client, acceptedBranchId, {
    type: "linkedinSend",
    delay: 0,
    message: FIRST_DM,
  });

  // 5) qualifier at +3 days (mirrors unwatched_followup_v1 step "qualifier" @ 72h)
  console.log(`  + linkedinSend (qualifier, +3d) → ${acceptedBranchId}`);
  await addStep(client, acceptedBranchId, {
    type: "linkedinSend",
    delay: 3,
    message: QUALIFIER,
  });

  // 6) graceful exit at +5 days from qualifier (mirrors "graceful_exit" @ 120h)
  console.log(`  + linkedinSend (graceful exit, +5d) → ${acceptedBranchId}`);
  await addStep(client, acceptedBranchId, {
    type: "linkedinSend",
    delay: 5,
    message: GRACEFUL_EXIT,
  });
}

function printLayout(campaign, sequences) {
  console.log("");
  console.log("=".repeat(70));
  console.log(`Campaign: ${campaign.name}`);
  console.log(`  id:      ${campaign._id}`);
  console.log(`  state:   ${campaign.state}`);
  console.log(`  tz:      ${campaign.timezone ?? TIMEZONE}`);
  console.log(`  autoRev: ${campaign.autoReview ?? false}`);
  console.log("");
  const root = findRootSequence(sequences);
  if (!root) { console.log("  (no sequences)"); return; }
  console.log(`Root sequence ${root.id}:`);
  for (const s of root.seq.steps ?? []) {
    const tag = s.type === "conditional"
      ? `conditional:${s.conditions?.map((c) => c.key ?? "fallback").join("/")}`
      : s.type;
    console.log(`  step ${s.sequenceStep ?? "?"}: ${tag} delay=${s.delay}d`);
    if (s.type === "conditional") {
      for (const c of s.conditions ?? []) {
        const childSeq = sequences[c.sequenceId];
        if (!childSeq) continue;
        const label = c.fallback ? "fallback" : c.label ?? c.key;
        console.log(`    └─ branch [${label}] ${c.sequenceId}:`);
        for (const cs of childSeq.steps ?? []) {
          const preview = (cs.message ?? "").split("\n")[0].slice(0, 60);
          console.log(`         step ${cs.sequenceStep ?? "?"}: ${cs.type} delay=${cs.delay}d "${preview}…"`);
        }
      }
    }
  }
  console.log("=".repeat(70));
}

// ---------- main ----------
async function main() {
  const args = new Set(process.argv.slice(2));
  const env = await loadEnv();
  const apiKey = env.LEMLIST_API;
  if (!apiKey) {
    console.error("LEMLIST_API missing from .env.local");
    process.exit(1);
  }
  const client = makeClient(apiKey);

  let campaign = await findCampaignByName(client, CAMPAIGN_NAME);

  if (args.has("--layout")) {
    if (!campaign) { console.log("No campaign yet."); return; }
    const sequences = await getSequences(client, campaign._id);
    printLayout(campaign, sequences);
    return;
  }

  if (campaign && args.has("--reset")) {
    console.log(`Resetting steps in existing campaign ${campaign._id}…`);
    const sequences = await getSequences(client, campaign._id);
    const root = findRootSequence(sequences);
    if (root) await wipeSteps(client, root.id, root.seq);
  }

  if (!campaign) {
    console.log(`Creating campaign "${CAMPAIGN_NAME}"…`);
    campaign = await createCampaign(client, CAMPAIGN_NAME);
    console.log(`  → ${campaign._id} (sequence ${campaign.sequenceId})`);
  } else {
    console.log(`Campaign "${CAMPAIGN_NAME}" already exists (${campaign._id}).`);
  }

  // Re-fetch sequences fresh — if --reset wiped, this is empty.
  let sequences = await getSequences(client, campaign._id);
  let root = findRootSequence(sequences);
  const hasSteps = (root?.seq?.steps ?? []).length > 0;

  if (!hasSteps) {
    console.log("Building sequence…");
    await buildSteps(client, root.id);
    sequences = await getSequences(client, campaign._id);
  } else {
    console.log(`Sequence already has ${root.seq.steps.length} steps — skipping build (use --reset to rebuild).`);
  }

  printLayout(campaign, sequences);
  console.log("");
  console.log("Next steps:");
  console.log("  1. Open lemlist → Settings → Connect Email Account (lemwarm starts after).");
  console.log("  2. Add a sender on the campaign (Settings → Sending account).");
  console.log("  3. Add leads via API: POST /campaigns/" + campaign._id + "/leads/");
  console.log("  4. (Optional) Add a reply webhook → see scripts/lemlist/setup_webhooks.mjs (todo).");
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
