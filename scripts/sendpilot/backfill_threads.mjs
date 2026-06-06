#!/usr/bin/env node
// Backfill thread completeness + stable conversation linkage.
//
// Why: manual outbound (replies you send from SendPilot's UI) only ever reach
// the DB via sync-sendpilot-messages, whose lead<->conversation matching is
// fragile, so it drops them silently. Inbound is fine (webhook). This script:
//   1. matches each active lead to its SendPilot conversation (by display name),
//   2. stores sendpilot_conversation_id + participant_urn for deterministic
//      future syncs,
//   3. inserts MISSING OUTBOUND messages only (never inbound — inbound inserts
//      would fire reply-triage/drafts on old, already-handled messages),
//   4. records thread_sp_count / thread_db_count / thread_out_of_sync so a
//      half-synced thread surfaces instead of misleading.
//
// Dry-run by default. Pass --apply to write.
//
//   node scripts/sendpilot/backfill_threads.mjs --workspace <id> [--lead <id>] [--limit N] [--apply]
//
// See docs/outreach-thread-trust.md.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SP_BASE = "https://api.sendpilot.ai";

async function loadEnv() {
  const raw = await fs.readFile(path.join(ROOT, ".env.local"), "utf8");
  const out = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const APPLY = flag("apply");
const LEAD = opt("lead");
const LIMIT = parseInt(opt("limit", "500"), 10);

const normName = (s) =>
  (s || "").normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
const canonDir = (d) => {
  d = (d || "").toLowerCase();
  if (["sent", "outgoing", "outbound", "out"].includes(d)) return "sent";
  if (["received", "incoming", "inbound", "in"].includes(d)) return "received";
  return d;
};

async function spGet(key, url) {
  const res = await fetch(url, { headers: { "X-API-Key": key } });
  if (!res.ok) throw new Error(`SendPilot HTTP ${res.status} ${url}`);
  return res.json();
}

async function fetchAllConversations(key, accountId) {
  const out = [];
  let token = null;
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const url =
      `${SP_BASE}/v1/inbox/conversations?accountId=${encodeURIComponent(accountId)}&limit=50` +
      (token ? `&continuationToken=${encodeURIComponent(token)}` : "");
    const b = await spGet(key, url);
    const cs = b.conversations || [];
    const fresh = cs.filter((c) => !seen.has(c.id));
    fresh.forEach((c) => seen.add(c.id));
    out.push(...fresh);
    token = b.pagination?.continuationToken;
    if (!token || !fresh.length) break;
  }
  return out;
}

async function main() {
  const env = await loadEnv();
  const SUPA_URL = env.NEXT_PUBLIC_SUPABASE_URL;
  const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
  const SP_KEY = env.SENDPILOT_API_KEY;
  if (!SUPA_URL || !SERVICE || !SP_KEY) throw new Error("missing env (SUPABASE url / service role / SENDPILOT_API_KEY)");
  const WORKSPACE = opt("workspace", "1e067f9a-d453-41a7-8bc4-9fdb5644a5fa");
  const db = createClient(SUPA_URL, SERVICE, { auth: { persistSession: false } });

  console.log(`mode: ${APPLY ? "APPLY" : "DRY-RUN"} | workspace: ${WORKSPACE}${LEAD ? ` | lead: ${LEAD}` : ""}`);

  // Target leads: active (sent or replied), with sender + linkedin.
  let q = db
    .from("outreach_pipeline")
    .select("sendpilot_lead_id, sendpilot_sender_id, workspace_id, contact_email, linkedin_url, sent_at, last_reply_at, sendpilot_conversation_id")
    .eq("workspace_id", WORKSPACE)
    .not("sendpilot_sender_id", "is", null)
    .not("linkedin_url", "is", null)
    .or("sent_at.not.is.null,last_reply_at.not.is.null")
    .limit(LIMIT);
  if (LEAD) q = q.eq("sendpilot_lead_id", LEAD);
  const { data: leads, error: lerr } = await q;
  if (lerr) throw lerr;
  console.log(`leads to check: ${leads.length}`);

  // Lead display names for name-matching.
  const emails = leads.map((l) => l.contact_email).filter(Boolean);
  const { data: leadRows } = await db
    .from("outreach_leads")
    .select("contact_email, full_name, first_name, last_name")
    .in("contact_email", emails.length ? emails : [""]);
  const nameByEmail = new Map();
  for (const l of leadRows || []) {
    const nm = (l.full_name || `${l.first_name || ""} ${l.last_name || ""}`).trim();
    if (nm) nameByEmail.set(l.contact_email, nm);
  }

  // Conversations per sender account (fetch once).
  const senders = [...new Set(leads.map((l) => l.sendpilot_sender_id))];
  const convByAccount = new Map();
  for (const acct of senders) {
    const convs = await fetchAllConversations(SP_KEY, acct);
    const byName = new Map();
    for (const c of convs) {
      for (const p of c.participants || []) {
        const k = normName(p.name);
        if (!k) continue;
        if (!byName.has(k)) byName.set(k, []);
        byName.get(k).push({ conv: c, participant: p });
      }
    }
    convByAccount.set(acct, { convs, byName });
    console.log(`account ${acct}: ${convs.length} conversations`);
  }

  let completed = 0, linked = 0, insertedTotal = 0, noMatch = 0, flagged = 0;
  for (const lead of leads) {
    const acct = convByAccount.get(lead.sendpilot_sender_id);
    const wantName = normName(nameByEmail.get(lead.contact_email));
    let match = null;
    // Prefer an already-stored conversation id.
    if (lead.sendpilot_conversation_id) {
      const c = acct.convs.find((x) => x.id === lead.sendpilot_conversation_id);
      if (c) match = { conv: c, participant: (c.participants || []).find((p) => normName(p.name) === wantName) || null };
    }
    if (!match && wantName && acct.byName.has(wantName)) {
      const cand = acct.byName.get(wantName);
      if (cand.length === 1) match = cand[0]; // skip ambiguous duplicate names
    }
    if (!match) { noMatch++; continue; }

    const convId = match.conv.id;
    const urn = match.participant?.id || null;
    const msgs = (await spGet(SP_KEY, `${SP_BASE}/v1/inbox/conversations/${encodeURIComponent(convId)}/messages?accountId=${encodeURIComponent(lead.sendpilot_sender_id)}&limit=50`)).messages || [];
    const spCount = msgs.length;

    // Existing rows for this lead (dedupe key = direction|trimmed text).
    const { data: existing } = await db
      .from("outreach_replies")
      .select("direction, message")
      .eq("sendpilot_lead_id", lead.sendpilot_lead_id);
    const have = new Set((existing || []).map((r) => `${r.direction}|${(r.message || "").trim().slice(0, 8000)}`));

    const toInsert = [];
    for (const m of msgs) {
      if (!m.id || !m.content) continue;
      if (canonDir(m.direction) !== "sent") continue; // OUTBOUND ONLY
      const text = m.content.trim().slice(0, 8000);
      if (have.has(`outbound|${text}`)) continue;
      toInsert.push({
        sendpilot_lead_id: lead.sendpilot_lead_id,
        linkedin_url: lead.linkedin_url,
        message: text,
        workspace_id: lead.workspace_id,
        direction: "outbound",
        external_id: m.id,
        received_at: m.sentAt ?? new Date().toISOString(),
      });
      have.add(`outbound|${text}`);
    }

    const dbCount = (existing?.length || 0) + toInsert.length;
    const outOfSync = spCount !== dbCount;

    if (toInsert.length || outOfSync) {
      const label = `${(nameByEmail.get(lead.contact_email) || lead.sendpilot_lead_id)}`;
      console.log(`  ${label}: sp=${spCount} db=${dbCount} +${toInsert.length} outbound${outOfSync ? "  [OUT-OF-SYNC]" : ""}`);
    }

    if (APPLY) {
      if (toInsert.length) {
        const { error: ie } = await db.from("outreach_replies").insert(toInsert);
        if (ie && !`${ie.message}`.includes("duplicate")) { console.error(`  insert error ${lead.sendpilot_lead_id}:`, ie.message); continue; }
      }
      const { error: ue } = await db
        .from("outreach_pipeline")
        .update({
          sendpilot_conversation_id: convId,
          participant_urn: urn,
          thread_sp_count: spCount,
          thread_db_count: dbCount,
          thread_out_of_sync: outOfSync,
          thread_checked_at: new Date().toISOString(),
        })
        .eq("sendpilot_lead_id", lead.sendpilot_lead_id);
      if (ue) { console.error(`  update error ${lead.sendpilot_lead_id}:`, ue.message); continue; }
    }
    linked++;
    insertedTotal += toInsert.length;
    if (toInsert.length) completed++;
    if (outOfSync) flagged++;
  }

  console.log(`\nsummary: linked=${linked} threads_completed=${completed} outbound_inserted=${insertedTotal} still_out_of_sync=${flagged} no_match=${noMatch}`);
  if (!APPLY) console.log("(dry-run — re-run with --apply to write)");
}

main().catch((e) => { console.error(e); process.exit(1); });
