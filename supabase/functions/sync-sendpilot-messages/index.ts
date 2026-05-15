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
  participants?: Array<{
    id?: string;
    leadId?: string;
    name?: string;
    profileUrl?: string;
    linkedinUrl?: string;
  }>;
};

type Message = {
  id?: string;
  content?: string;
  direction?: string;
  sentAt?: string;
  sender?: { name?: string; profileUrl?: string };
  recipient?: { name?: string; profileUrl?: string };
};

// SendPilot has renamed message direction values at least once already
// (cf. sendpilot-webhook's event-type and data-field fallbacks). Map every
// known variant to a canonical "sent" | "received"; surface unknowns in the
// response so we notice the next rename instead of silently dropping rows.
function canonicaliseDirection(raw: unknown): "sent" | "received" | null {
  const v = String(raw ?? "").toLowerCase();
  if (v === "sent" || v === "outgoing" || v === "outbound" || v === "out") return "sent";
  if (v === "received" || v === "incoming" || v === "inbound" || v === "in") return "received";
  return null;
}

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

  let body: { leadIds?: string[]; limit?: number; dryRun?: boolean; enrichOnly?: boolean } = {};
  try { body = await req.json().catch(() => ({})); } catch { body = {}; }
  const dryRun = body.dryRun === true;
  const limit = body.limit ?? 100;

  // Enrich-only mode: find existing inbound rows with intent=null and run
  // classification + auto-draft on them. Used to backfill rows that were
  // inserted via sync (no webhook → no classifyReplyAsync) or that landed
  // before the auto-draft system existed.
  if (body.enrichOnly) {
    const { data: unenriched } = await supabase
      .from("outreach_replies")
      .select("id, message, sendpilot_lead_id")
      .eq("direction", "inbound")
      .is("intent", null)
      .limit(limit);
    if (!unenriched || unenriched.length === 0) {
      return json({ ok: true, enriched: 0, note: "nothing to enrich" });
    }
    const emails = new Map<string, string>();
    for (const r of unenriched) {
      const { data: p } = await supabase
        .from("outreach_pipeline")
        .select("contact_email")
        .eq("sendpilot_lead_id", r.sendpilot_lead_id)
        .maybeSingle();
      if (p?.contact_email) emails.set(r.id as string, p.contact_email as string);
    }
    let enriched = 0;
    for (const r of unenriched) {
      const email = emails.get(r.id as string);
      if (!email) continue;
      await enrichInbound(r.id as string, r.message as string, email);
      enriched++;
    }
    return json({ ok: true, enriched, scanned: unenriched.length });
  }

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
  let totalInboundInserted = 0;
  for (const row of rows as PipelineRow[]) {
    try {
      const fullName = nameByEmail.get(row.contact_email) ?? "";
      const result = await syncOne(row, fullName, dryRun);
      totalOutboundInserted += result.outbound_inserted;
      totalInboundInserted += (result.inbound_inserted as number | undefined) ?? 0;
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
    inbound_inserted: totalInboundInserted,
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

  // Step 1: find the conversation for this lead. List up to 50 — name/URL
  // match alone misses threads that drop off the top-20 window when a sender
  // is active across many conversations (the original limit=20 was why most
  // CarterCo leads came back skipped:"no_conversation_match" in May 2026).
  // SendPilot caps this endpoint below 100 (returns 500 at limit=100).
  const listUrl = `${SP_BASE}/v1/inbox/conversations?accountId=${encodeURIComponent(row.sendpilot_sender_id)}&limit=50`;
  const listRes = await fetch(listUrl, { headers: { "X-API-Key": SP_API_KEY } });
  if (!listRes.ok) {
    return { lead: row.sendpilot_lead_id, error: `list HTTP ${listRes.status}`, outbound_inserted: 0 };
  }
  const listBody = await listRes.json() as { conversations?: ConvSummary[] };
  const targetUrl = normaliseLinkedinUrl(row.linkedin_url);
  const targetName = normaliseName(fullName);
  const targetLeadId = row.sendpilot_lead_id;
  let convId: string | null = null;
  for (const c of listBody.conversations ?? []) {
    for (const p of c.participants ?? []) {
      const pId = String(p.id ?? p.leadId ?? "");
      const pUrl = normaliseLinkedinUrl((p.profileUrl ?? p.linkedinUrl ?? "") as string);
      const pName = normaliseName(p.name ?? "");
      if (
        (pId && pId === targetLeadId) ||
        (targetUrl && pUrl === targetUrl) ||
        (targetName && pName && pName === targetName)
      ) {
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

  // Step 3: upsert both inbound and outbound messages, idempotent on
  // external_id (SendPilot's message id). Legacy webhook-inserted inbound
  // rows lack external_id; this sync can repopulate them for backfill but
  // can't dedupe against them (NULL ≠ NULL in unique). Acceptable: the
  // backfill creates a second copy of any legacy inbound, but only for
  // workspaces whose webhook never fired in the first place — Tresyv being
  // the primary case (no legacy inbound rows to clash with).
  const unknownDirs = new Set<string>();
  const relevant: Array<Message & { _canonDir: "sent" | "received" }> = [];
  for (const m of messages) {
    if (!m.id || !m.content) continue;
    const canon = canonicaliseDirection(m.direction);
    if (!canon) {
      unknownDirs.add(String(m.direction ?? "<missing>"));
      continue;
    }
    relevant.push({ ...m, _canonDir: canon });
  }
  if (unknownDirs.size > 0) {
    console.warn("sync: unknown message directions", {
      lead: row.sendpilot_lead_id,
      conv: convId,
      unknownDirs: [...unknownDirs],
    });
  }
  if (relevant.length === 0) {
    return {
      lead: row.sendpilot_lead_id,
      conv: convId,
      in_thread: 0,
      outbound_inserted: 0,
      inbound_inserted: 0,
      unknown_dirs: unknownDirs.size > 0 ? [...unknownDirs] : undefined,
    };
  }

  if (dryRun) {
    const ob = relevant.filter((m) => m._canonDir === "sent").length;
    const ib = relevant.filter((m) => m._canonDir === "received").length;
    return {
      lead: row.sendpilot_lead_id,
      conv: convId,
      in_thread: relevant.length,
      outbound_in_thread: ob,
      inbound_in_thread: ib,
      outbound_inserted: 0,
      inbound_inserted: 0,
      unknown_dirs: unknownDirs.size > 0 ? [...unknownDirs] : undefined,
      dryRun: true,
    };
  }

  let outboundInserted = 0;
  let inboundInserted = 0;
  for (const m of relevant) {
    const direction = m._canonDir === "sent" ? "outbound" : "inbound";
    // CRITICAL: trim. SendPilot's conversations API returns messages with
    // trailing whitespace, but sendpilot-webhook trims via .trim() in its
    // own insert path. Without trimming here, the dedupe-by-content check
    // below misses the webhook row (off-by-1 trailing space → exact-match
    // fails), and we end up with duplicate inbound bubbles in the Svar tab.
    const messageText = (m.content ?? "").trim().slice(0, 8000);

    // For inbound: legacy rows from sendpilot-webhook lack external_id. Look
    // for an existing row with the same content first, and if found, just
    // patch its external_id instead of inserting a duplicate. Outbound rows
    // are always sync-inserted with external_id set, so the unique index
    // alone handles their idempotency.
    if (direction === "inbound") {
      const { data: existing } = await supabase
        .from("outreach_replies")
        .select("id, external_id")
        .eq("sendpilot_lead_id", row.sendpilot_lead_id)
        .eq("direction", "inbound")
        .eq("message", messageText)
        .maybeSingle();
      if (existing) {
        if (!existing.external_id) {
          await supabase.from("outreach_replies")
            .update({ external_id: m.id })
            .eq("id", existing.id);
        }
        continue;
      }
    }

    const { data: inserted, error: insErr } = await supabase.from("outreach_replies").insert({
      sendpilot_lead_id: row.sendpilot_lead_id,
      linkedin_url: row.linkedin_url,
      message: messageText,
      workspace_id: row.workspace_id,
      direction,
      external_id: m.id,
      received_at: m.sentAt ?? new Date().toISOString(),
    }).select("id").maybeSingle();
    if (insErr && !`${insErr.message}`.includes("duplicate")) {
      console.error(`${direction} insert error`, row.sendpilot_lead_id, insErr.message);
      continue;
    }
    if (!insErr) {
      if (direction === "outbound") outboundInserted++;
      else {
        inboundInserted++;
        // Newly-discovered inbound (the webhook missed it, or this is a
        // pre-webhook lead). Trigger classification + auto-draft inline so
        // Tresyv backfill gets the same intent/draft enrichment that
        // webhook-fed CarterCo replies already have.
        if (inserted?.id && row.contact_email) {
          void enrichInbound(inserted.id, messageText, row.contact_email);
        }
      }
    }
  }

  return {
    lead: row.sendpilot_lead_id,
    conv: convId,
    in_thread: relevant.length,
    outbound_inserted: outboundInserted,
    inbound_inserted: inboundInserted,
  };
}

// Fire classify_reply (and draft_reply when intent matches) on a newly
// inserted inbound row. Same enrichment path sendpilot-webhook's
// classifyReplyAsync provides for live webhook events. Fire-and-forget —
// failures log and don't block the sync.
async function enrichInbound(replyId: string, text: string, contactEmail: string): Promise<void> {
  try {
    const { data: lead } = await supabase
      .from("outreach_leads")
      .select("first_name, company")
      .eq("contact_email", contactEmail)
      .maybeSingle();

    const aiBase = `${Deno.env.get("SUPABASE_URL")}/functions/v1/outreach-ai`;
    const authHeader = `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`;

    const classifyRes = await fetch(`${aiBase}?op=classify_reply`, {
      method: "POST",
      headers: { "Authorization": authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        lead: { firstName: lead?.first_name, company: lead?.company },
      }),
    });
    if (!classifyRes.ok) {
      console.error("enrich classify non-200", classifyRes.status);
      return;
    }
    const cj = await classifyRes.json() as {
      intent: string; confidence: number; reasoning: string;
      referralTarget?: { name?: string; title?: string; company?: string };
    };
    const isReferral = cj.intent === "referral";
    await supabase.from("outreach_replies").update({
      intent: cj.intent,
      confidence: cj.confidence,
      reasoning: cj.reasoning,
      classified_at: new Date().toISOString(),
      referral_target_name:    isReferral ? (cj.referralTarget?.name ?? null) : null,
      referral_target_title:   isReferral ? (cj.referralTarget?.title ?? null) : null,
      referral_target_company: isReferral ? (cj.referralTarget?.company ?? null) : null,
    }).eq("id", replyId);

    if (cj.intent === "question" || cj.intent === "interested") {
      const draftRes = await fetch(`${aiBase}?op=draft_reply`, {
        method: "POST",
        headers: { "Authorization": authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ replyId }),
      });
      if (draftRes.ok) {
        const dj = await draftRes.json() as { draft?: string };
        if (dj.draft) {
          await supabase.from("outreach_replies").update({
            suggested_reply: dj.draft,
            suggested_reply_generated_at: new Date().toISOString(),
          }).eq("id", replyId);
        }
      } else {
        console.error("enrich draft non-200", draftRes.status);
      }
    }
  } catch (e) {
    console.error("enrichInbound error", e);
  }
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
