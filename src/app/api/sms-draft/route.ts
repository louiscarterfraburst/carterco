// AI SMS draft generator. Operator hits this from /leads when they
// want a context-aware reply to a prospect who's been texting them.
// Reads recent lead_conversation_events for the lead, builds a short
// system prompt, asks Claude Haiku for a 1-2 sentence Danish SMS reply.
// Returns the draft string; caller (the /leads UI) opens iMessage via
// the sms: URL scheme with this body prefilled. Operator reviews +
// sends from their personal number.
//
// Added 2026-05-22 (Phase 2 SMS rebuild). Pairs with the inbound iOS
// Shortcut webhook at /api/sms-replies/shortcut.

import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/utils/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { leadId?: string };

type LeadRow = {
  id: string;
  name: string | null;
  company: string | null;
  notes: string | null;
  source: string | null;
};

type ConversationEvent = {
  channel: string;
  direction: string;
  occurred_at: string;
  body: string | null;
};

export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not configured" },
      { status: 500 },
    );
  }

  let payload: Body;
  try {
    payload = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const leadId = payload.leadId?.trim();
  if (!leadId) {
    return NextResponse.json({ error: "leadId required" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data: lead, error: leadErr } = await supabase
    .from("leads")
    .select("id, name, company, notes, source")
    .eq("id", leadId)
    .maybeSingle<LeadRow>();

  if (leadErr) {
    return NextResponse.json({ error: leadErr.message }, { status: 500 });
  }
  if (!lead) {
    return NextResponse.json({ error: "lead not found" }, { status: 404 });
  }

  // Conversation history — last 20 SMS events, oldest-first for prompt clarity.
  const { data: events } = await supabase
    .from("lead_conversation_events")
    .select("channel, direction, occurred_at, body")
    .eq("lead_id", leadId)
    .eq("channel", "sms")
    .order("occurred_at", { ascending: false })
    .limit(20);

  const conversation: ConversationEvent[] = (events ?? []).reverse();

  const firstName = (lead.name ?? "").split(/\s+/)[0] || "der";
  const conversationLines = conversation
    .map((e) => {
      const who = e.direction === "inbound" ? firstName : "Louis";
      return `${who}: ${(e.body ?? "").trim()}`;
    })
    .filter((line) => line.split(": ")[1])
    .join("\n");

  const systemPrompt = `Du er Louis fra Carter & Co. Du skriver korte, varme SMS-svar på dansk til en B2B-prospect.

Stil:
- 1-2 korte sætninger, max 280 tegn.
- Direkte, ærlig, konversationel — som en SMS fra en bekendt, ikke en sælger.
- Brug "I/jeres" (formelt B2B-plural), ikke "du/dit".
- Ingen emojis. Ingen marketing-floskler.
- Hvis prospecten har stillet et konkret spørgsmål, svar konkret.
- Hvis det er deres første svar, byd dem velkommen kort og foreslå næste skridt (typisk: en 30-min snak eller view-only CRM-adgang til Loom-audit).
- Aldrig opfind tal, navne på kunder, eller løfter du ikke kan holde.

Returnér KUN selve SMS-teksten. Ingen forklaring, ingen citationstegn, ingen prefix.`;

  const contextBlock = [
    lead.company ? `Firma: ${lead.company}` : null,
    lead.name ? `Kontakt: ${lead.name}` : null,
    lead.source ? `Kilde: ${lead.source}` : null,
    lead.notes ? `Notater:\n${lead.notes.slice(0, 1500)}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const userPrompt = conversationLines
    ? `Kontext om leadet:\n${contextBlock}\n\nSamtalehistorik (ældst først):\n${conversationLines}\n\nSkriv næste SMS fra Louis.`
    : `Kontext om leadet:\n${contextBlock}\n\nDer er ingen tidligere SMS-historik. Skriv den første SMS efter et missed call.`;

  const client = new Anthropic({ apiKey });
  let draft = "";
  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const block = message.content[0];
    if (block && block.type === "text") {
      draft = block.text.trim();
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown";
    return NextResponse.json(
      { error: "AI draft failed", detail },
      { status: 502 },
    );
  }

  if (!draft) {
    return NextResponse.json({ error: "empty draft" }, { status: 502 });
  }

  return NextResponse.json({ draft });
}
