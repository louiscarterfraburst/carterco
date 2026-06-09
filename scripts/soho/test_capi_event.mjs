// scripts/soho/test_capi_event.mjs
// One-shot Conversions API smoke test for the Soho dataset.
// Sends a single event into Events Manager -> Test events (counts toward
// nothing) to verify the access token + dataset id + PII hashing pipeline
// before we build the real Soho sender.
//
//   node scripts/soho/test_capi_event.mjs <TEST_EVENT_CODE>
//   node scripts/soho/test_capi_event.mjs --live        # send a real event (no test code)
//
// Reads META_CAPI_ACCESS_TOKEN_SOHO + META_CAPI_DATASET_ID_SOHO from .env.local.
// Without a test code it refuses to send, so it can never pollute live data.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const GRAPH_VERSION = "v21.0";

function loadEnv(path = ".env.local") {
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const env = loadEnv();
const TOKEN = env.META_CAPI_ACCESS_TOKEN_SOHO;
const DATASET = env.META_CAPI_DATASET_ID_SOHO;

const args = process.argv.slice(2);
const live = args.includes("--live");
const testCode = args.find((a) => !a.startsWith("--"));

if (!TOKEN || !DATASET) {
  console.error("Missing META_CAPI_ACCESS_TOKEN_SOHO / META_CAPI_DATASET_ID_SOHO in .env.local");
  process.exit(1);
}
if (!testCode && !live) {
  console.error(
    "Refusing to send without a test_event_code.\n" +
    "Pass the code from Events Manager > Test events, or --live to send a real event.",
  );
  process.exit(1);
}

const sha256 = (s) => createHash("sha256").update(String(s).trim().toLowerCase()).digest("hex");

const event = {
  event_name: "Schedule", // stand-in for "booket"; proves the pipe end to end
  event_time: Math.floor(Date.now() / 1000),
  action_source: "system_generated",
  event_id: `soho-capi-smoketest-${Math.floor(Date.now() / 1000)}`,
  user_data: {
    em: [sha256("smoketest@example.com")],
    fn: [sha256("test")],
    ln: [sha256("lead")],
  },
  custom_data: {
    event_source: "crm",
    lead_event_source: "Soho",
  },
};

const body = { data: [event] };
if (testCode) body.test_event_code = testCode;

const url = `https://graph.facebook.com/${GRAPH_VERSION}/${DATASET}/events?access_token=${encodeURIComponent(TOKEN)}`;

const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const json = await res.json().catch(() => ({}));

console.log("HTTP", res.status);
console.log(JSON.stringify(json, null, 2));

if (!res.ok) {
  console.error(
    "\n❌ Send failed. Common causes:\n" +
    "  (#190) invalid/expired access token\n" +
    "  (#100) wrong dataset id  ← if this fires, the ...307172 vs ...507172 guess was wrong\n" +
    "  (#803/#200) token lacks permission on this dataset",
  );
  process.exit(1);
}
console.log(
  `\n✅ Sent (events_received: ${json.events_received ?? "?"}). ` +
  (testCode
    ? `Open Events Manager > dataset ${DATASET} > Test events — it should appear within seconds.`
    : "Live event sent."),
);
