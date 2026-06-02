#!/usr/bin/env node
// Removes lemlist campaign leads that are already in the SendPilot pipeline
// (sendpilotStatus = invited | accepted | declined). Only the `not_sent`
// bucket stays — those are safe to Auto-Launch from lemlist without colliding
// with SendPilot on the same LinkedIn account.
//
// Reversible: deletes only the lemlist campaign-lead row. The underlying
// outreach_pipeline / outreach_leads rows in Supabase are untouched.
//
// Usage:
//   node scripts/lemlist/remove_sendpilot_overlap.mjs --dry    # show what'd be removed
//   node scripts/lemlist/remove_sendpilot_overlap.mjs          # actually remove

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "../..");
const CAMPAIGN_ID = "cam_M8mQPzp3iYh5NHbsH";

async function loadKey() {
  const raw = await fs.readFile(path.join(ROOT, ".env.local"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*LEMLIST_API\s*=\s*(.*)\s*$/);
    if (m) return m[1].replace(/^['"]|['"]$/g, "");
  }
  throw new Error("LEMLIST_API missing");
}

async function main() {
  const dry = process.argv.includes("--dry");
  const apiKey = await loadKey();
  const auth = "Basic " + Buffer.from(":" + apiKey).toString("base64");
  const headers = { Authorization: auth };

  // Pull the lead list (export endpoint returns full lead objects with custom vars)
  const r = await fetch(
    `https://api.lemlist.com/api/campaigns/${CAMPAIGN_ID}/export/leads?state=all&format=json&limit=5000`,
    { headers },
  );
  if (!r.ok) throw new Error(`list leads ${r.status}: ${await r.text()}`);
  const leads = await r.json();

  const KEEP = "not_sent";
  const counts = {};
  const toRemove = [];
  for (const l of leads) {
    const bucket = l.sendpilotStatus ?? "(none)";
    counts[bucket] = (counts[bucket] ?? 0) + 1;
    if (bucket !== KEEP) toRemove.push(l);
  }

  console.log("Current lemlist leads:");
  for (const k of Object.keys(counts).sort()) {
    console.log(`  ${k.padEnd(20)} ${String(counts[k]).padStart(5)}`);
  }
  console.log(`  TOTAL                ${leads.length}`);
  console.log("");
  console.log(`Will remove ${toRemove.length} (everything where sendpilotStatus != "${KEEP}").`);

  if (dry) { console.log("Dry run. Add no flag to actually remove."); return; }

  let ok = 0, err = 0;
  const errors = [];
  for (let i = 0; i < toRemove.length; i++) {
    const l = toRemove[i];
    const id = l._id;
    const r = await fetch(
      `https://api.lemlist.com/api/campaigns/${CAMPAIGN_ID}/leads/${id}?action=remove`,
      { method: "DELETE", headers },
    );
    if (r.ok) { ok++; }
    else if (r.status === 429) {
      await new Promise((res) => setTimeout(res, 2200));
      const r2 = await fetch(
        `https://api.lemlist.com/api/campaigns/${CAMPAIGN_ID}/leads/${id}?action=remove`,
        { method: "DELETE", headers },
      );
      if (r2.ok) ok++;
      else { err++; errors.push({ id, status: r2.status }); }
    } else {
      err++;
      if (errors.length < 5) errors.push({ id, status: r.status, name: `${l.firstName} ${l.lastName}` });
    }
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${toRemove.length}  ok=${ok} err=${err}`);
    await new Promise((res) => setTimeout(res, 130));
  }

  console.log("");
  console.log("=== Done ===");
  console.log(`  removed: ${ok}`);
  console.log(`  errors:  ${err}`);
  if (errors.length) errors.forEach((e) => console.log(`  -`, JSON.stringify(e)));
}

main().catch((e) => { console.error(e); process.exit(1); });
