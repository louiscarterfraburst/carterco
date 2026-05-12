// Pulls full conversation history from SendPilot for any lead we've sent a
// message to or received a reply from. Inserts outbound messages (Louis's
// replies sent via SendPilot UI or API) into outreach_replies with
// direction='outbound', keyed by SendPilot's message id for idempotency.
//
// Why: sendpilot-webhook captures inbound replies in real time, but outbound
// messages sent manually via SendPilot's UI never fire a webhook we can
// trust. Polling closes that gap so the Svar tab can show the full thread.
//
// Strategy:
//   1. Find pipeline rows where we have a conversation (sent_at or
//      last_reply_at set), batched per workspace.
//   2. For each: list inbox/conversations by senderId, match the right
//      thread by recipient linkedinUrl/name (SendPilot returns id-encoded
//      URLs, so name match is the practical key).
//   3. Fetch all messages in that conversation, upsert outbound ones.
//
// Callable manually or wired to pg_cron.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SP_API_KEY = Deno.env.get("SENDPILOT_API_KEY") ?? "";
const SP_BASE = "https://api.sendpilot.ai";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

type PipelineRow = {
  sendpilot_lead_id: string;
  workspace_id: string | null;
  contact_email: string;
  linkedin_url: string | null;
  sendpilot_sender_id: string | null;
  sent_at: string | null;
  last_reply_at: string | null;
};

type ConvSummary = {
  id?: string;
  participants?: Array<{ name?: string; profileUrl?: string; linkedinUrl?: string }>;
};

type Message = {
  id?: string;
  content?: string;
  direction?: "sent" | "received" | string;
  sentAt?: string;
  sender?: { name?: string; profileUrl?: string };
  recipient?: { name?: string; profileUrl?: string };
};

function normaliseLinkedinUrl(url: string): string {
  return (url || "").toLowerCase().trim().replace(/\/+$/, "");
}

function normaliseName(s: string): string {
  return (s || "").toLowerCase().normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method === "GET") return json({ ok: true, name: "sync-sendpilot-messages" });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: { leadIds?: string[]; limit?: number; dryRun?: boolean } = {};
  try { body = await req.json().catch(() => ({})); } catch { body = {}; }
  const dryRun = body.dryRun === true;
  const limit = body.limit ?? 100;

  let query = supabase
    .from("outreach_pipeline")
    .select("sendpilot_lead_id, workspace_id, contact_email, linkedin_url, sendpilot_sender_id, sent_at, last_reply_at")
    .or("sent_at.not.is.null,last_reply_at.not.is.null")
    .not("sendpilot_sender_id", "is", null)
    .not("linkedin_url", "is", null)
    .limit(limit);
  if (body.leadIds?.length) query = query.in("sendpilot_lead_id", body.leadIds);

  const { data: rows, error: rowsErr } = await query;
  if (rowsErr) return json({ error: rowsErr.message }, 500);
  if (!rows || rows.length === 0) return json({ ok: true, scanned: 0, note: "no eligible leads" });

  // Lead names for fuzzy participant matching (SendPilot returns id-encoded
  // URLs that won't match the vanity URLs we stored).
  const emails = rows.map((r) => r.contact_email).filter(Boolean) as string[];
  const { data: leads } = await supabase
    .from("outreach_leads")
    .select("contact_email, first_name, last_name, full_name")
    .in("contact_email", emails.length ? emails : [""]);
  const nameByEmail = new Map<string, string>();
  for (const l of leads ?? []) {
    const fullName = (l.full_name as string | undefined)?.trim()
      || [l.first_name, l.last_name].filter(Boolean).join(" ").trim()
      || "";
    if (fullName) nameByEmail.set(l.contact_email as string, fullName);
  }

  const summary: Array<Record<string, unknown>> = [];
  let totalOutboundInserted = 0;
  for (const row of rows as PipelineRow[]) {
    try {
      const fullName = nameByEmail.get(row.contact_email) ?? "";
      const result = await syncOne(row, fullName, dryRun);
      totalOutboundInserted += result.outbound_inserted;
      summary.push(result);
    } catch (e) {
      summary.push({ lead: row.sendpilot_lead_id, error: (e as Error).message.slice(0, 200) });
    }
  }

  return json({
    ok: true,
    dryRun,
    scanned: rows.length,
    outbound_inserted: totalOutboundInserted,
    samples: summary.slice(0, 10),
  });
});

async function syncOne(
  row: PipelineRow,
  fullName: string,
  dryRun: boolean,
): Promise<Record<string, unknown> & { outbound_inserted: number }> {
  if (!row.sendpilot_sender_id || !row.linkedin_url) {
    return { lead: row.sendpilot_lead_id, skipped: "missing_sender_or_url", outbound_inserted: 0 };
  }

  // Step 1: find the conversation for this lead.
  const listUrl = `${SP_BASE}/v1/inbox/conversations?accountId=${encodeURIComponent(row.sendpilot_sender_id)}&limit=20`;
  const listRes = await fetch(listUrl, { headers: { "X-API-Key": SP_API_KEY } });
  if (!listRes.ok) {
    return { lead: row.sendpilot_lead_id, error: `list HTTP ${listRes.status}`, outbound_inserted: 0 };
  }
  const listBody = await listRes.json() as { conversations?: ConvSummary[] };
  const targetUrl = normaliseLinkedinUrl(row.linkedin_url);
  const targetName = normaliseName(fullName);
  let convId: string | null = null;
  for (const c of listBody.conversations ?? []) {
    for (const p of c.participants ?? []) {
      const pUrl = normaliseLinkedinUrl((p.profileUrl ?? p.linkedinUrl ?? "") as string);
      const pName = normaliseName(p.name ?? "");
      if ((targetUrl && pUrl === targetUrl) || (targetName && pName && pName === targetName)) {
        convId = c.id ?? null;
        break;
      }
    }
    if (convId) break;
  }
  if (!convId) {
    return { lead: row.sendpilot_lead_id, skipped: "no_conversation_match", outbound_inserted: 0 };
  }

  // Step 2: fetch messages. Single page (limit=50) covers nearly every real
  // thread; we can add pagination later if needed.
  const msgUrl = `${SP_BASE}/v1/inbox/conversations/${encodeURIComponent(convId)}/messages?accountId=${encodeURIComponent(row.sendpilot_sender_id)}&limit=50`;
  const msgRes = await fetch(msgUrl, { headers: { "X-API-Key": SP_API_KEY } });
  if (!msgRes.ok) {
    return { lead: row.sendpilot_lead_id, conv: convId, error: `messages HTTP ${msgRes.status}`, outbound_inserted: 0 };
  }
  const msgBody = await msgRes.json() as { messages?: Message[] };
  const messages = msgBody.messages ?? [];

  // Step 3: upsert outbound messages. We skip inbound — reply.received
  // webhook already handles those, and our legacy rows lack external_id so
  // a content-based dedupe is fragile.
  const outbound = messages.filter((m) => m.direction === "sent" && m.id && m.content);
  if (outbound.length === 0) {
    return { lead: row.sendpilot_lead_id, conv: convId, outbound_in_thread: 0, outbound_inserted: 0 };
  }

  if (dryRun) {
    return { lead: row.sendpilot_lead_id, conv: convId, outbound_in_thread: outbound.length, outbound_inserted: 0, dryRun: true };
  }

  let inserted = 0;
  for (const m of outbound) {
    const { error: insErr } = await supabase.from("outreach_replies").insert({
      sendpilot_lead_id: row.sendpilot_lead_id,
      linkedin_url: row.linkedin_url,
      message: (m.content ?? "").slice(0, 8000),
      workspace_id: row.workspace_id,
      direction: "outbound",
      external_id: m.id,
      received_at: m.sentAt ?? new Date().toISOString(),
    });
    if (insErr && !`${insErr.message}`.includes("duplicate")) {
      console.error("outbound insert error", row.sendpilot_lead_id, insErr.message);
      continue;
    }
    if (!insErr) inserted++;
  }

  return { lead: row.sendpilot_lead_id, conv: convId, outbound_in_thread: outbound.length, outbound_inserted: inserted };
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
