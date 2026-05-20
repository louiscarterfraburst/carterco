// ai-triage-reply
//
// Triage an inbound LinkedIn reply with one Claude call and persist the
// derived signals back to outreach_replies. Produces:
//   - triage_priority (1-10, higher = act sooner)
//   - triage_action (short Danish prose, next step)
//   - triage_draft (Danish response draft, optional)
//   - triage_signals (structured: budget/timeline/decision_authority/objections/time_signal)
//   - triage_reasoning (why this priority + action)
//   - scheduled_followup_at (ISO timestamp if reply contains a time signal)
//
// Fired automatically by the outreach_replies_triage_trg trigger on INSERT
// (supabase/outreach_triage.sql). Can also be called manually with
// { replyId } in the body for backfill/re-triage.
//
// Auth: deployed with verify_jwt=false because the Postgres trigger that
// calls us doesn't include a JWT. The function is otherwise idempotent —
// safe to invoke multiple times for the same replyId.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.103.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

type PriorityBucket = "high" | "medium" | "low" | "done";

// Sequence-level decision. Distinct from priority — priority drives the
// operator's I dag queue; sequence_decision drives the engagement engine's
// next-step logic. A reply can be high-priority AND a "stop", or low-priority
// AND a "continue". See _shared/engagement-rules.ts for the engine contract.
type SequenceDecision = "stop" | "pause_until" | "reroute_email" | "reroute_call" | "continue";

type TriageResult = {
  todo: string;
  due_at: string | null;
  priority: PriorityBucket;
  draft: string | null;
  signals: {
    timing: string | null;
    objections: string[];
    explicit_ask: string | null;
  };
  sequence_decision: SequenceDecision;
  sequence_decision_resume_at: string | null;  // ISO timestamp when decision == "pause_until"
  sequence_decision_reason: string;             // one-line Danish explanation
  sequence_decision_confidence: number;         // 0.0-1.0
};

const PRIORITY_TO_NUMBER: Record<PriorityBucket, number> = {
  high: 8,
  medium: 5,
  low: 3,
  done: 1,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!ANTHROPIC_API_KEY) {
    return json({ error: "ANTHROPIC_API_KEY not configured" }, 500);
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return json({ error: "invalid json" }, 400); }

  // Trigger payload has shape { type, table, schema, record: { id, ... } }.
  // Manual/backfill payload has shape { replyId }.
  const replyId =
    (body.record as Record<string, unknown> | undefined)?.id as string | undefined ??
    body.replyId as string | undefined;
  if (!replyId) return json({ error: "replyId or record.id required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  try {
    const triage = await triageReply(admin, replyId);
    if ("error" in triage) return json(triage, 502);

    const { error: updateErr } = await admin
      .from("outreach_replies")
      .update({
        triage_priority: PRIORITY_TO_NUMBER[triage.priority],
        triage_action: triage.todo,
        triage_draft: triage.draft,
        triage_signals: {
          ...triage.signals,
          priority_bucket: triage.priority,
          sequence_decision: triage.sequence_decision,
          sequence_decision_reason: triage.sequence_decision_reason,
          sequence_decision_confidence: triage.sequence_decision_confidence,
          sequence_decision_resume_at: triage.sequence_decision_resume_at,
        },
        triage_reasoning: null,
        triage_processed_at: new Date().toISOString(),
        scheduled_followup_at: triage.due_at,
      })
      .eq("id", replyId);

    if (updateErr) return json({ error: `db update failed: ${updateErr.message}` }, 500);

    // Denormalize the sequence decision onto outreach_pipeline so the
    // engagement engine reads a single column per lead instead of joining
    // the latest reply on every tick. We use the reply's
    // sendpilot_lead_id to find the pipeline row.
    const sendpilotLeadId = await lookupSendpilotLeadId(admin, replyId);
    if (sendpilotLeadId) {
      const { error: pipeUpdateErr } = await admin
        .from("outreach_pipeline")
        .update({
          seq_decision: triage.sequence_decision,
          seq_decision_at: new Date().toISOString(),
          seq_decision_resume_at: triage.sequence_decision_resume_at,
          seq_decision_reason: triage.sequence_decision_reason,
          seq_decision_confidence: triage.sequence_decision_confidence,
        })
        .eq("sendpilot_lead_id", sendpilotLeadId);
      if (pipeUpdateErr) {
        console.warn("seq_decision pipeline update failed", pipeUpdateErr);
        // Best-effort: don't fail the whole triage. The reply row still
        // holds the decision in triage_signals as a fallback audit trail.
      }
    }

    return json({ ok: true, replyId, triage });
  } catch (e) {
    console.error("ai-triage-reply error", e);
    return json({ error: `unexpected: ${(e as Error).message}` }, 500);
  }
});

async function triageReply(
  admin: SupabaseClient,
  replyId: string,
): Promise<TriageResult | { error: string }> {
  // Load reply + full context: pipeline, lead, prior thread, voice playbook.
  const { data: reply } = await admin
    .from("outreach_replies")
    .select("id, sendpilot_lead_id, linkedin_url, message, intent, confidence, reasoning, workspace_id, direction, received_at")
    .eq("id", replyId)
    .maybeSingle();
  if (!reply) return { error: "reply not found" };
  if (reply.direction === "outbound") return { error: "skip: outbound message" };

  const { data: pipe } = await admin
    .from("outreach_pipeline")
    .select("contact_email, rendered_message, status, invited_at, accepted_at, sent_at, icp_company_score, icp_person_score, icp_rationale")
    .eq("sendpilot_lead_id", reply.sendpilot_lead_id)
    .maybeSingle();

  const { data: lead } = await admin
    .from("outreach_leads")
    .select("first_name, last_name, company, title, website")
    .eq("contact_email", pipe?.contact_email ?? "")
    .maybeSingle();

  const { data: thread } = await admin
    .from("outreach_replies")
    .select("direction, message, received_at, intent")
    .eq("sendpilot_lead_id", reply.sendpilot_lead_id)
    .order("received_at", { ascending: true });

  const { data: playbook } = await admin
    .from("outreach_voice_playbooks")
    .select("owner_first_name, value_prop, guidelines, cta_preference, booking_link")
    .eq("workspace_id", reply.workspace_id ?? "")
    .maybeSingle();

  const ownerName = playbook?.owner_first_name ?? "operatøren";
  const valueProp = playbook?.value_prop ?? "(intet value-prop registreret for dette workspace)";

  const today = new Date().toISOString().slice(0, 10);
  const systemPrompt = buildSystemPrompt(ownerName, valueProp, today);
  const userPrompt = buildUserPrompt({
    reply,
    lead,
    pipe,
    thread: thread ?? [],
    ownerName,
  });

  const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1200,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!claudeResp.ok) {
    const errText = await claudeResp.text();
    return { error: `claude api ${claudeResp.status}: ${errText.slice(0, 500)}` };
  }

  const claudeJson = await claudeResp.json();
  const textBlock = claudeJson.content?.[0]?.text ?? "";

  // Claude returns JSON wrapped in ```json blocks sometimes; strip them.
  const jsonText = extractJson(textBlock);
  let parsed: TriageResult;
  try { parsed = JSON.parse(jsonText) as TriageResult; }
  catch (e) {
    return { error: `claude json parse failed: ${(e as Error).message}. Raw: ${textBlock.slice(0, 500)}` };
  }

  // Light validation
  if (!parsed.todo || typeof parsed.todo !== "string") {
    return { error: `missing or invalid todo: ${JSON.stringify(parsed.todo)}` };
  }
  if (!["high", "medium", "low", "done"].includes(parsed.priority)) {
    return { error: `invalid priority bucket: ${parsed.priority}` };
  }
  const validDecisions = ["stop", "pause_until", "reroute_email", "reroute_call", "continue"];
  if (!validDecisions.includes(parsed.sequence_decision)) {
    // Safe default: if Haiku skips the field or returns garbage, treat as
    // hard stop. Matches existing replied-exclude behavior and never causes
    // an unintended send.
    parsed.sequence_decision = "stop";
    parsed.sequence_decision_reason = "fallback: AI returned invalid or missing sequence_decision";
    parsed.sequence_decision_confidence = 0;
    parsed.sequence_decision_resume_at = null;
  }
  if (parsed.sequence_decision === "pause_until" && !parsed.sequence_decision_resume_at) {
    // pause_until without a resume_at is meaningless. Coerce to stop.
    parsed.sequence_decision = "stop";
    parsed.sequence_decision_reason = `fallback: pause_until without resume_at (${parsed.sequence_decision_reason ?? ""})`.trim();
  }

  return parsed;
}

async function lookupSendpilotLeadId(
  admin: SupabaseClient,
  replyId: string,
): Promise<string | null> {
  const { data } = await admin
    .from("outreach_replies")
    .select("sendpilot_lead_id")
    .eq("id", replyId)
    .maybeSingle();
  return (data?.sendpilot_lead_id as string | null) ?? null;
}

function buildSystemPrompt(ownerName: string, valueProp: string, today: string): string {
  return [
    `Du er en notetagger for en dansk B2B outbound-operatør ved navn ${ownerName}. Du laver TODO-items ud fra LinkedIn-svar. Ikke en sales-coach. Ikke en strategist. En notetagger.`,
    "",
    "## Hvad operatøren sælger (kun til kontekst)",
    valueProp,
    "",
    "## Princip — VIGTIGT",
    "Gentag hvad prospekten faktisk SAGDE. Gæt aldrig på beslutningskompetence, firma-størrelse, eller intent ud over hvad teksten direkte indeholder. Du er ikke ansvarlig for at vurdere om prospekten er den rigtige kontakt eller om de er værd at forfølge. Operatøren ved det.",
    "",
    "## Din opgave",
    `Et nyt LinkedIn-svar er ankommet. Lav en kort TODO-linje + tidspunkt + bucket-priority. Det er det. Returnér JSON:`,
    "",
    "1. **todo** (string): 1-2 linjer. Beskriv hvad prospekten sagde + hvad operatøren skal gøre næste skridt. Stil: deskriptiv, ikke direktiv. Eksempler:",
    "   - GOD: \"Peter foreslog opkald i morgen formiddag\"",
    "   - GOD: \"Sarah spurgte om pris — afventer svar fra dig\"",
    "   - DÅRLIG: \"Ring Peter i morgen og kortlæg den rigtige kontakt\" (det er for direktivt, du gætter)",
    "",
    "2. **due_at** (ISO timestamp eller null): kun hvis prospekten eksplicit nævner et tidspunkt eller dato.",
    "",
    "3. **priority** (string enum): \"high\" | \"medium\" | \"low\" | \"done\"",
    "   - **high**: prospekten har bedt om konkret handling (opkald, info, møde) ELLER nævnt deadline",
    "   - **medium**: positiv engagement men intet konkret ask",
    "   - **low**: høfligt afvist, lavt signal",
    "   - **done**: klart \"nej\", emoji-respons, eller intet at handle på",
    "",
    `4. **draft** (string eller null): hvis priority er high og det giver mening at svare, skriv et kort dansk udkast i ${ownerName}'s casual stemme. Ingen pitch-pivot. Hvis intet svar giver mening, return null.`,
    "",
    "5. **signals** (object): struktureret data KUN fra eksplicitte mentions i beskeden. Drop felter hvor du ikke har eksplicit data — gæt ikke.",
    "   - **timing**: kort streng hvis prospekten nævnte tid (\"opkald i morgen\", \"efter sommerferien\", \"Q4\"), ellers null",
    "   - **objections**: array af strenge hvis prospekten nævnte specifikke forbehold (\"pris\", \"tilfreds med nuværende\", \"forkert kontakt\"), ellers tom array",
    "   - **explicit_ask**: kort streng hvis prospekten bad om noget specifikt (\"opkald\", \"prisinfo\", \"case studies\"), ellers null",
    "",
    "6. **sequence_decision** (string enum, REQUIRED): hvad skal automation-motoren gøre med follow-up-sekvensen for denne lead? Distinkt fra priority — priority handler operatørens dag, sequence_decision handler om motoren skal sende flere DMs/emails. Vælg PRÆCIS én:",
    "   - **stop** — hard exit. Brug ved: klart nej, \"ikke interesseret\", \"fjern mig\", \"forkert kontakt\", \"vi er kunde hos jer\", \"jeg er gået på pension\". Sekvensen stopper, ingen flere automatiske touches.",
    "   - **pause_until** — midlertidig hold. Brug KUN ved eksplicit tidssignal med slut-dato: \"efter sommerferien\", \"i Q3\", \"ring i september\", \"travlt indtil næste måned\", OOO med return-dato. KRÆVER sequence_decision_resume_at sat til ISO timestamp.",
    "   - **reroute_email** — de bad om email i stedet for LI. Eksempler: \"send det på mail\", \"skriv en mail i stedet\", \"jeg ser ikke LinkedIn — brug min mail\". Motoren springer frem til næste email-step i sekvensen.",
    "   - **reroute_call** — de bad om opkald, eller gav et telefonnummer. Eksempler: \"ring mig\", \"giv mig et kald\", \"lad os tage en snak\", \"+45 XX XX XX XX\". Motoren markerer leadet som klar til opkald (boost i call-queue).",
    "   - **continue** — svaret ændrer ikke planen. Brug KUN ved: generisk takke-svar uden ask, emoji/likes, kort \"tak, læser det\". Sekvensen fortsætter som planlagt. SJÆLDENT — de fleste svar skal være stop, pause, eller reroute.",
    "",
    "7. **sequence_decision_resume_at** (ISO timestamp eller null): KUN sat hvis sequence_decision er \"pause_until\". Brug samme tids-konvertering som due_at.",
    "",
    "8. **sequence_decision_reason** (string): én sætning på dansk der forklarer valget. Eksempel: \"prospekten sagde ikke aktuelt, hard decline\" eller \"venter på efter sommerferien — antaget 15. august\".",
    "",
    "9. **sequence_decision_confidence** (number 0.0-1.0): hvor sikker er du? Brug 0.9+ for indlysende cases (klart \"nej\", konkret \"ring mig\"). Brug 0.5-0.7 for tvetydige cases hvor du gætter mest sandsynlige. Under 0.5 hvis du virkelig er i tvivl — så kan motoren falde tilbage til safe-stop.",
    "",
    `## Time-konvertering (dato i dag: ${today})`,
    "Konvertér tids-fraser til ISO timestamps:",
    "- \"i morgen formiddag\" → i morgen 10:00",
    "- \"i morgen eftermiddag\" → i morgen 14:00",
    "- \"tjek tilbage om en måned\" → +30 dage",
    "- \"efter sommerferien\" → 15. august i indeværende eller næste år (DK sommerferie slutter ~midt-august)",
    "- \"kommer tilbage\" / \"kommer tilbage til dig\" → null (ikke konkret nok til at planlægge)",
    "- \"ikke nu\" / \"ikke aktuel\" → null (intet konkret tidssignal)",
    "- \"Q4\" → 1. oktober",
    "Hvis prospekten intet nævner om tid, sæt due_at til null. Gæt aldrig.",
    "",
    "## Output-format",
    "Ren JSON, ingen markdown. Eksempler:",
    "",
    "Prospect siger: \"Kan vi ringes ved i morgen?\"",
    "→ {",
    "  \"todo\": \"Peter foreslog opkald i morgen — afventer hans nr\",",
    "  \"due_at\": \"2026-05-13T10:00:00Z\",",
    "  \"priority\": \"high\",",
    "  \"draft\": null,",
    "  \"signals\": { \"timing\": \"opkald i morgen\", \"objections\": [], \"explicit_ask\": \"opkald\" },",
    "  \"sequence_decision\": \"reroute_call\",",
    "  \"sequence_decision_resume_at\": null,",
    "  \"sequence_decision_reason\": \"prospekten bad om opkald i morgen — boost til call-queue\",",
    "  \"sequence_decision_confidence\": 0.95",
    "}",
    "",
    "Prospect siger: \"Tak, ikke aktuelt for os\"",
    "→ {",
    "  \"todo\": \"Decline — markér som behandlet\",",
    "  \"due_at\": null,",
    "  \"priority\": \"done\",",
    "  \"draft\": null,",
    "  \"signals\": { \"timing\": null, \"objections\": [\"ikke aktuelt\"], \"explicit_ask\": null },",
    "  \"sequence_decision\": \"stop\",",
    "  \"sequence_decision_resume_at\": null,",
    "  \"sequence_decision_reason\": \"hard decline — ikke aktuelt\",",
    "  \"sequence_decision_confidence\": 0.95",
    "}",
    "",
    "Prospect siger: \"Send det venligst på mail — kigger ikke på LinkedIn ofte\"",
    "→ {",
    "  \"todo\": \"Prospekten vil have mail i stedet for LI — næste step bliver email\",",
    "  \"due_at\": null,",
    "  \"priority\": \"medium\",",
    "  \"draft\": null,",
    "  \"signals\": { \"timing\": null, \"objections\": [], \"explicit_ask\": \"mail\" },",
    "  \"sequence_decision\": \"reroute_email\",",
    "  \"sequence_decision_resume_at\": null,",
    "  \"sequence_decision_reason\": \"bad eksplicit om mail-kanal\",",
    "  \"sequence_decision_confidence\": 0.92",
    "}",
    "",
    "Prospect siger: \"På ferie til 15. august, vender tilbage efter det\"",
    "→ {",
    "  \"todo\": \"OOO indtil 15. august — pause sekvensen\",",
    "  \"due_at\": \"2026-08-15T09:00:00Z\",",
    "  \"priority\": \"low\",",
    "  \"draft\": null,",
    "  \"signals\": { \"timing\": \"efter 15. august\", \"objections\": [], \"explicit_ask\": null },",
    "  \"sequence_decision\": \"pause_until\",",
    "  \"sequence_decision_resume_at\": \"2026-08-15T09:00:00Z\",",
    "  \"sequence_decision_reason\": \"OOO til 15. august\",",
    "  \"sequence_decision_confidence\": 0.9",
    "}",
  ].join("\n");
}

function buildUserPrompt(args: {
  reply: {
    message: string;
    intent: string | null;
    confidence: number | null;
    reasoning: string | null;
  };
  lead: { first_name: string | null; last_name: string | null; company: string | null; title: string | null; website: string | null } | null;
  pipe: { rendered_message: string | null; status: string | null; invited_at: string | null; accepted_at: string | null; icp_company_score: number | null; icp_person_score: number | null; icp_rationale: string | null } | null;
  thread: Array<{ direction: string | null; message: string; received_at: string; intent: string | null }>;
  ownerName: string;
}): string {
  const lines: string[] = [];

  lines.push("# PROSPECT");
  lines.push(`- Navn: ${args.lead?.first_name ?? "?"} ${args.lead?.last_name ?? ""}`.trim());
  lines.push(`- Titel: ${args.lead?.title ?? "?"}`);
  lines.push(`- Firma: ${args.lead?.company ?? "?"}`);
  if (args.lead?.website) lines.push(`- Website: ${args.lead.website}`);
  if (args.pipe?.icp_company_score !== null && args.pipe?.icp_company_score !== undefined) {
    lines.push(`- ICP firma-score: ${args.pipe.icp_company_score}/10`);
  }
  if (args.pipe?.icp_person_score !== null && args.pipe?.icp_person_score !== undefined) {
    lines.push(`- ICP person-score: ${args.pipe.icp_person_score}/10`);
  }
  if (args.pipe?.icp_rationale) {
    lines.push(`- ICP-vurdering: ${args.pipe.icp_rationale}`);
  }
  lines.push("");

  lines.push("# CONVERSATION-HISTORIK");
  if (args.pipe?.rendered_message) {
    lines.push(`${args.ownerName}'s oprindelige cold opener:`);
    lines.push(`> ${args.pipe.rendered_message.replaceAll("\n", "\n> ")}`);
    lines.push("");
  }
  if (args.thread.length > 0) {
    lines.push("Hele tråden derefter (kronologisk):");
    for (const m of args.thread) {
      const role = m.direction === "outbound" ? args.ownerName : (args.lead?.first_name ?? "Prospect");
      lines.push(`${role} (${m.received_at?.slice(0, 10) ?? "?"}): ${m.message}`);
    }
    lines.push("");
  }

  lines.push("# DET NYE SVAR (det her er hvad du skal triage)");
  lines.push(`Intent allerede klassificeret: ${args.reply.intent ?? "?"} (konfidens: ${args.reply.confidence ?? "?"})`);
  if (args.reply.reasoning) lines.push(`Intent-reasoning: ${args.reply.reasoning}`);
  lines.push("");
  lines.push(`Beskedtekst:`);
  lines.push(`"${args.reply.message}"`);
  lines.push("");
  lines.push("Returnér nu kun JSON som beskrevet i systemprompten.");

  return lines.join("\n");
}

function extractJson(text: string): string {
  // Strip ```json fences if present
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  // Otherwise return the text as-is, trimmed
  return text.trim();
}

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
