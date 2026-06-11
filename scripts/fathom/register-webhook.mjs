#!/usr/bin/env node
// One-time helper: registers the Fathom webhook that feeds fathom-webhook
// (meeting notes onto the lead timeline). Idempotent-ish: lists existing
// webhooks first and refuses to create a duplicate for the same URL.
//
// Prereq: a Fathom API key (fathom.video → Settings → API Access),
// in the env or .env.local as FATHOM_API_KEY.
//
// Usage:
//   node scripts/fathom/register-webhook.mjs
//
// Prints the webhook secret (whsec_…) and the `supabase secrets set`
// command to run next. Full setup: docs/fathom-meeting-notes.md

import { readFileSync } from "node:fs";

const API = "https://api.fathom.ai/external/v1";
const DESTINATION =
  "https://znpaevzwlcfuzqxsbyie.supabase.co/functions/v1/fathom-webhook";

function fromEnvLocal(name) {
  try {
    const text = readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
    const line = text.split("\n").find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim() : undefined;
  } catch {
    return undefined;
  }
}

const apiKey = process.env.FATHOM_API_KEY ?? fromEnvLocal("FATHOM_API_KEY");
if (!apiKey) {
  console.error(
    "Missing FATHOM_API_KEY. Generate one at fathom.video → Settings → " +
      "API Access and add it to .env.local first.",
  );
  process.exit(1);
}

const headers = { "X-Api-Key": apiKey, "Content-Type": "application/json" };

const existing = await fetch(`${API}/webhooks`, { headers });
if (existing.ok) {
  const body = await existing.json();
  const hooks = body.items ?? body.webhooks ?? (Array.isArray(body) ? body : []);
  const dup = hooks.find((h) => h.url === DESTINATION || h.destination_url === DESTINATION);
  if (dup) {
    console.log(`Webhook already registered (id ${dup.id}) — nothing to do.`);
    console.log("Its secret was only shown at creation; delete + re-run if you lost it.");
    process.exit(0);
  }
}

const res = await fetch(`${API}/webhooks`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    destination_url: DESTINATION,
    triggered_for: ["my_recordings"],
    include_transcript: true,
    include_summary: true,
    include_action_items: true,
  }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Create failed (${res.status}):`, JSON.stringify(body).slice(0, 400));
  process.exit(1);
}

console.log(`Webhook created (id ${body.id}) → ${DESTINATION}\n`);
console.log("Webhook secret (shown only once):\n");
console.log(`  ${body.secret}\n`);
console.log("Set the function secret:\n");
console.log(`  supabase secrets set FATHOM_WEBHOOK_SECRET='${body.secret}'\n`);
console.log("Also add FATHOM_WEBHOOK_SECRET to .env.local (docs/env-tokens.md).");
