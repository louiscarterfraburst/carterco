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
  workspace_id: string | null;
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
    .select("id, name, company, notes, source, workspace_id")
    .eq("id", leadId)
    .maybeSingle<LeadRow>();

  if (leadErr) {
    return NextResponse.json({ error: leadErr.message }, { status: 500 });
  }
  if (!lead) {
    return NextResponse.json({ error: "lead not found" }, { status: 404 });
  }

  // Sender identity follows the lead's WORKSPACE, not a hardcoded operator:
  // the brand is the workspace's outbound name (signoff, e.g. "Soho", falling
  // back to its internal name) and the signer is the requesting user's roster
  // name in that workspace. Only with no workspace at all do we fall back to
  // the CarterCo identity this route originally hardcoded.
  let senderName = "Louis";
  let brandName = "Carter & Co";
  let bookingUrl: string | null = null;
  let smsTemplate: string | null = null;
  if (lead.workspace_id) {
    const [wsRes, memberRes] = await Promise.all([
      supabase
        .from("workspaces")
        .select("name, signoff, booking_url, sms_template")
        .eq("id", lead.workspace_id)
        .maybeSingle<{
          name: string | null;
          signoff: string | null;
          booking_url: string | null;
          sms_template: string | null;
        }>(),
      supabase
        .from("workspace_members")
        .select("display_name")
        .eq("workspace_id", lead.workspace_id)
        .eq("user_email", user.email ?? "")
        .maybeSingle<{ display_name: string | null }>(),
    ]);
    const ws = wsRes.data;
    if (ws) {
      brandName = ws.signoff?.trim() || ws.name?.trim() || brandName;
      bookingUrl = ws.booking_url?.trim() || null;
      smsTemplate = ws.sms_template?.trim() || null;
    }
    senderName = memberRes.data?.display_name?.trim() || senderName;
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
      const who = e.direction === "inbound" ? firstName : senderName;
      return `${who}: ${(e.body ?? "").trim()}`;
    })
    .filter((line) => line.split(": ")[1])
    .join("\n");

  // Next-step suggestion differs by workspace type: client panels with a
  // booking link nudge towards that link; the CarterCo pipeline nudges towards
  // its own next steps (snak / CRM-adgang).
  const nextStepLine = bookingUrl
    ? `- Hvis det er deres første svar, byd dem velkommen kort og foreslå næste skridt (book direkte: ${bookingUrl} — eller et opkald).`
    : `- Hvis det er deres første svar, byd dem velkommen kort og foreslå næste skridt (typisk: en 30-min snak eller view-only CRM-adgang til Loom-audit).`;

  // Workspaces with their own no-answer template (workspaces.sms_template)
  // anchor the draft's tone and vocabulary to that message.
  const toneLine = smsTemplate
    ? `\n\nWorkspacets faste no-answer SMS lyder sådan (match tone og ordvalg, men kopiér ikke {pladsholdere}):\n"${smsTemplate}"`
    : "";

  const systemPrompt = `Du er ${senderName} fra ${brandName}. Du skriver korte, varme SMS-svar på dansk til en B2B-prospect.${toneLine}

Stil:
- 1-2 korte sætninger, max 280 tegn.
- Direkte, ærlig, konversationel — som en SMS fra en bekendt, ikke en sælger.
- Brug "I/jeres" (formelt B2B-plural), ikke "du/dit".
- Ingen emojis. Ingen marketing-floskler.
- Hvis prospecten har stillet et konkret spørgsmål, svar konkret.
${nextStepLine}
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
    ? `Kontext om leadet:\n${contextBlock}\n\nSamtalehistorik (ældst først):\n${conversationLines}\n\nSkriv næste SMS fra ${senderName}.`
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
