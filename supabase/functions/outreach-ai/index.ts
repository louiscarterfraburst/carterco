// Lightweight AI helper for /outreach. Single endpoint, op selected via ?op=.
// Currently supports:
//   ?op=classify_reply  body { text, lead?: { firstName, company } }
//                       → { intent, confidence, reasoning }
//
// Auth: verify_jwt=true. Callers must hold either the service role JWT
// (sendpilot-webhook) or an authorised user's JWT (the UI). The edge runtime
// validates the bearer for us when verify_jwt is on; we additionally restrict
// human callers to the workspace allow-list.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";
import { draftFirstMessage } from "../_shared/draft-first-message.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ALLOWED_USERS = new Set([
  "louis@carterco.dk",
  "rm@tresyv.dk",
  "haugefrom@haugefrom.com",
  "kontakt@odagroup.dk",
]);

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

type ReplyIntent = "interested" | "question" | "decline" | "ooo" | "referral" | "other";

type ReferralTarget = {
  name?: string;
  title?: string;
  company?: string;
};

// Deployed with verify_jwt=false because we have two valid caller types:
// - the service-role bearer (sendpilot-webhook calling internally), which
//   is not a user JWT and so fails the gateway's user-JWT check.
// - the UI's user JWT, which we validate ourselves below.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!ANTHROPIC_API_KEY) {
    return json({ error: "ANTHROPIC_API_KEY not configured on this function" }, 500);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "missing bearer" }, 401);
  const isServiceRole = token === SERVICE_ROLE;
  if (!isServiceRole) {
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: `Bearer ${token}` } } },
    );
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return json({ error: "invalid auth" }, 401);
    const email = (user.email ?? "").toLowerCase();
    if (!ALLOWED_USERS.has(email)) return json({ error: "forbidden" }, 403);
  }
  // No user resolved → assume service-role caller (sendpilot-webhook).

  const url = new URL(req.url);
  const op = url.searchParams.get("op") ?? "";

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return json({ error: "invalid json" }, 400); }

  if (op === "classify_reply") {
    const text = String((body.text ?? "")).slice(0, 4000).trim();
    if (!text) return json({ error: "text required" }, 400);
    const lead = (body.lead ?? {}) as { firstName?: string; company?: string };
    const result = await classifyReply(text, lead);
    if (!result) return json({ error: "AI classification failed" }, 502);
    return json(result);
  }

  if (op === "draft_reply") {
    const replyId = String(body.replyId ?? "").trim();
    if (!replyId) return json({ error: "replyId required" }, 400);
    const admin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );
    const result = await draftReply(admin, replyId);
    if ("error" in result) return json(result, 502);
    return json(result);
  }

  if (op === "draft_first_message") {
    const leadId = String(body.leadId ?? "").trim();
    if (!leadId) return json({ error: "leadId required" }, 400);
    const admin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );
    const result = await draftFirstMessage(admin, leadId);
    if ("error" in result) return json(result, 502);
    return json(result);
  }

  if (op === "draft_email") {
    const leadId = String(body.leadId ?? "").trim();
    if (!leadId) return json({ error: "leadId required" }, 400);
    // Optional strategy override. When the engagement engine fires
    // email_draft for a specific sequence step, it passes the step's
    // intended strategy so different steps don't collapse into
    // first_contact / first_contact / first_contact.
    const rawStrategy = body.strategy;
    const strategyOverride = typeof rawStrategy === "string" && rawStrategy.length > 0
      ? rawStrategy as EmailStrategy
      : null;
    const admin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );
    const result = await draftEmail(admin, leadId, strategyOverride);
    if ("error" in result) return json(result, 502);
    return json(result);
  }

  return json({ error: `unknown op: ${op}` }, 400);
});

// ---------- draft_email ----------------------------------------------------
//
// Drafts an outbound email to a prospect, picking a strategy based on the
// lead's current state (call_outcome, last_reply_intent, prior LinkedIn
// thread). Persists the draft to outreach_emails with the chosen strategy
// + rationale so we can later A/B which strategies convert.
//
// Strategies (closed list — keep this short so analytics are clean):
//   reconnect_post_call  — call attempt happened, no progress yet
//   reply_redirect       — they replied on LinkedIn but no booking
//   warm_recap           — accepted LinkedIn invite, never replied
//   referral_intro       — fresh contact via someone else's referral
//   first_contact        — none of the above (cold email start)

type EmailStrategy =
  | "reconnect_post_call"
  | "reply_redirect"
  | "warm_recap"
  | "referral_intro"
  | "first_contact";

async function draftEmail(
  admin: ReturnType<typeof createClient>,
  leadId: string,
  strategyOverride: EmailStrategy | null = null,
): Promise<
  | { id: string; subject: string; body: string; strategy: EmailStrategy; rationale: string; language: string; to: string }
  | { error: string }
> {
  const { data: pipe } = await admin
    .from("outreach_pipeline")
    .select("sendpilot_lead_id, contact_email, workspace_id, rendered_message, call_outcome, last_reply_intent, last_reply_at, accepted_at, referred_from_pipeline_lead_id, email_direct, email_office")
    .eq("sendpilot_lead_id", leadId)
    .maybeSingle();
  if (!pipe) return { error: "pipeline lead not found" };

  const toEmail = pipe.email_direct ?? pipe.email_office;
  if (!toEmail) return { error: "no email enriched for this lead" };

  const { data: playbook } = await admin
    .from("outreach_voice_playbooks")
    .select("*")
    .eq("workspace_id", pipe.workspace_id ?? "")
    .maybeSingle<Playbook>();
  if (!playbook) return { error: `no voice playbook for workspace ${pipe.workspace_id}` };

  const { data: lead } = await admin
    .from("outreach_leads")
    .select("first_name, last_name, company, title, country")
    .eq("contact_email", pipe?.contact_email ?? "")
    .maybeSingle();

  const { data: thread } = await admin
    .from("outreach_replies")
    .select("direction, message, received_at, intent")
    .eq("sendpilot_lead_id", leadId)
    .order("received_at", { ascending: true })
    .limit(20);

  // Language: DK by country, else English.
  const country = (lead?.country ?? "").toUpperCase();
  const language = ["DK", "SE", "NO"].includes(country) ? "da" : "en";

  // Pick the strategy. Sonnet validates this — but we suggest the default
  // based on state so the model has a strong prior. If the engagement engine
  // passed an explicit strategy (per-sequence-step), use that as the prior
  // instead of the state-derived guess.
  let suggestedStrategy: EmailStrategy = "first_contact";
  if (strategyOverride) {
    suggestedStrategy = strategyOverride;
  } else if (pipe.referred_from_pipeline_lead_id) suggestedStrategy = "referral_intro";
  else if (pipe.call_outcome) suggestedStrategy = "reconnect_post_call";
  else if (pipe.last_reply_intent && pipe.last_reply_intent !== "decline" && pipe.last_reply_intent !== "ooo") suggestedStrategy = "reply_redirect";
  else if (pipe.accepted_at) suggestedStrategy = "warm_recap";

  const ctaInstruction = playbook.cta_preference === "no_cta"
    ? "Do NOT push for a meeting. Leave room for a low-friction next exchange."
    : playbook.cta_preference === "booking_link"
    ? `Include the booking link: ${playbook.booking_link ?? "(missing)"}`
    : "Use soft-discovery framing — informal exchange invitation. No aggressive close.";

  const systemPrompt = [
    `You're drafting an outbound EMAIL on behalf of ${playbook.owner_first_name}.`,
    "",
    "## What we offer",
    playbook.value_prop,
    "",
    "## Voice — match the owner's LinkedIn voice from the thread (below) exactly. Slightly more formal for email but never corporate.",
    "",
    `## Owner-specific guidelines`,
    playbook.guidelines,
    "",
    `## CTA preference`,
    ctaInstruction,
    "",
    "## Output — JSON ONLY, no preamble, no markdown fences:",
    `{`,
    `  "subject": "<short, lowercase-friendly, max 60 chars>",`,
    `  "body": "<plain text body — no signature, no greeting line if naturally implied>",`,
    `  "strategy": "<one of: reconnect_post_call | reply_redirect | warm_recap | referral_intro | first_contact>",`,
    `  "rationale": "<≤15 words on which signals drove the strategy choice>",`,
    `  "language": "<da | en>"`,
    `}`,
    "",
    "## Hard rules",
    `- Length: 60–140 words body, single paragraph or 2 short paragraphs.`,
    `- ${language === "da" ? "Danish" : "English"}.`,
    `- Open with the prospect's name. No "Hope you're well".`,
    `- Reference the LinkedIn connection ("vi connected på LinkedIn" / "we connected on LinkedIn") so they remember context.`,
    `- If there's been a call attempt, acknowledge it gently.`,
    `- End with a clear, low-pressure next step.`,
    `- Sign off with the owner's first name only.`,
  ].join("\n");

  const ctxLines: string[] = [];
  ctxLines.push(`Lead: ${lead?.first_name ?? "?"} ${lead?.last_name ?? ""} at ${lead?.company ?? "?"}, ${lead?.title ?? "?"} (${country || "?"})`);
  ctxLines.push(`To-email: ${toEmail}`);
  ctxLines.push(`Suggested strategy: ${suggestedStrategy}`);
  ctxLines.push(`call_outcome: ${pipe.call_outcome ?? "none"}`);
  ctxLines.push(`last_reply_intent: ${pipe.last_reply_intent ?? "none"}`);
  ctxLines.push("");
  if (pipe.rendered_message) {
    ctxLines.push(`Original LinkedIn opener:`);
    ctxLines.push(`> ${pipe.rendered_message.replaceAll("\n", "\n> ")}`);
    ctxLines.push("");
  }
  if (thread && thread.length > 0) {
    ctxLines.push("LinkedIn thread (chronological):");
    for (const m of thread) {
      const role = m.direction === "outbound" ? playbook.owner_first_name : (lead?.first_name ?? "Prospect");
      ctxLines.push(`${role}: ${m.message}`);
    }
  }
  ctxLines.push("");
  ctxLines.push(`Draft the email now. JSON only.`);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: "user", content: ctxLines.join("\n") }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("draft_email ai error", res.status, body);
    return { error: `ai HTTP ${res.status}` };
  }
  const data = await res.json();
  const blocks = (data.content ?? []) as Array<{ type: string; text?: string }>;
  const raw = blocks.find((b) => b.type === "text")?.text?.trim() ?? "";
  // Strip code fences if Sonnet adds them despite the prompt
  const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let parsed: { subject?: string; body?: string; strategy?: EmailStrategy; rationale?: string; language?: string };
  try { parsed = JSON.parse(cleaned); }
  catch { return { error: "ai returned non-JSON" }; }
  if (!parsed.subject || !parsed.body) return { error: "ai missing subject/body" };

  const { data: inserted, error: insErr } = await admin
    .from("outreach_emails")
    .insert({
      workspace_id: pipe.workspace_id,
      pipeline_lead_id: leadId,
      to_email: toEmail,
      subject: parsed.subject,
      body: parsed.body,
      strategy: parsed.strategy ?? suggestedStrategy,
      rationale: parsed.rationale ?? null,
      language: parsed.language ?? language,
      drafted_by: "outreach-ai",
    })
    .select("id")
    .single();
  if (insErr || !inserted) {
    console.error("outreach_emails insert error", insErr);
    return { error: "failed to persist draft" };
  }

  return {
    id: inserted.id,
    subject: parsed.subject,
    body: parsed.body,
    strategy: parsed.strategy ?? suggestedStrategy,
    rationale: parsed.rationale ?? "",
    language: parsed.language ?? language,
    to: toEmail,
  };
}

type Playbook = {
  workspace_id: string;
  owner_first_name: string;
  value_prop: string;
  guidelines: string;
  cta_preference: "no_cta" | "soft_discovery" | "booking_link";
  booking_link: string | null;
};

async function draftReply(
  admin: ReturnType<typeof createClient>,
  replyId: string,
): Promise<{ draft: string; model: string; workspace_id: string } | { error: string }> {
  // Load the inbound reply + lead context + workspace playbook + full thread.
  const { data: reply } = await admin
    .from("outreach_replies")
    .select("id, sendpilot_lead_id, linkedin_url, message, intent, reasoning, workspace_id, direction")
    .eq("id", replyId)
    .maybeSingle();
  if (!reply) return { error: "reply not found" };
  if (reply.direction !== "inbound") return { error: "can only draft against inbound replies" };

  const { data: playbook } = await admin
    .from("outreach_voice_playbooks")
    .select("*")
    .eq("workspace_id", reply.workspace_id ?? "")
    .maybeSingle<Playbook>();
  if (!playbook) return { error: `no voice playbook for workspace ${reply.workspace_id}` };

  // Pull pipeline row for the original cold message + lead identity.
  const { data: pipe } = await admin
    .from("outreach_pipeline")
    .select("contact_email, rendered_message, referred_from_pipeline_lead_id")
    .eq("sendpilot_lead_id", reply.sendpilot_lead_id)
    .maybeSingle();
  const { data: lead } = await admin
    .from("outreach_leads")
    .select("first_name, last_name, company, title, website")
    .eq("contact_email", pipe?.contact_email ?? "")
    .maybeSingle();

  // Full thread history for this lead, oldest first — so Claude sees how the
  // owner has been writing on this exact thread.
  const { data: thread } = await admin
    .from("outreach_replies")
    .select("direction, message, received_at")
    .eq("sendpilot_lead_id", reply.sendpilot_lead_id)
    .order("received_at", { ascending: true });

  const ctaInstruction = playbook.cta_preference === "no_cta"
    ? "Do NOT push for a meeting, demo, or call. The vibe is collaborative — leave room for a low-friction next exchange."
    : playbook.cta_preference === "booking_link"
    ? `When suggesting a next step, include the booking link: ${playbook.booking_link ?? "(missing)"}`
    : "Use soft-discovery framing — suggest informal exchange (\"stikke hovederne sammen\", \"sig til hvis det giver mening\"). Never aggressive close.";

  const systemPrompt = [
    `You're drafting a LinkedIn reply on behalf of ${playbook.owner_first_name}.`,
    "",
    "## What we offer",
    playbook.value_prop,
    "",
    "## Voice — VERY IMPORTANT",
    `Your reference voice is ${playbook.owner_first_name}'s OWN past outbound messages in the conversation history below. Match that voice EXACTLY: same sentence length, same word choice, same level of formality, same use of emoji (or lack of). Never sound more salesy or more corporate than ${playbook.owner_first_name} actually writes.`,
    "",
    "If no prior outbound exists in this thread (this is the first inbound reply to a fresh cold message), fall back to the guidelines below.",
    "",
    "## Match the prospect's tone",
    "- They wrote casually (emoji, contractions, joking) → match casual",
    "- They wrote formally → match more measured",
    "- They wrote terse → keep yours short",
    "- They wrote long → match length but stay concise",
    "Never sacrifice clarity for tone-matching.",
    "",
    `## Guidelines specific to ${playbook.owner_first_name}`,
    playbook.guidelines,
    "",
    "## CTA preference",
    ctaInstruction,
    "",
    "## Output format",
    "- Plain Danish text, ready to paste into LinkedIn",
    "- No \"Best regards\", no \"/\"-signature, no \"Bh,\" closing — SendPilot adds those",
    "- No <reasoning> tags, no preamble, no explanation",
    "- Just the message body",
  ].join("\n");

  const conversationLines: string[] = [];
  conversationLines.push(`Lead: ${lead?.first_name ?? "?"} ${lead?.last_name ?? ""} at ${lead?.company ?? "?"}, ${lead?.title ?? "?"}`);
  conversationLines.push("");
  if (pipe?.rendered_message) {
    conversationLines.push(`${playbook.owner_first_name}'s original outbound (the cold opener):`);
    conversationLines.push(`> ${pipe.rendered_message.replaceAll("\n", "\n> ")}`);
    conversationLines.push("");
  }
  if (thread && thread.length > 0) {
    conversationLines.push("Conversation since then (chronological):");
    for (const m of thread) {
      const role = m.direction === "outbound" ? playbook.owner_first_name : (lead?.first_name ?? "Prospect");
      conversationLines.push(`${role}: ${m.message}`);
    }
    conversationLines.push("");
  }
  conversationLines.push(`The prospect just sent the latest inbound reply above (intent classified as "${reply.intent}", reasoning: "${reply.reasoning ?? ""}").`);
  conversationLines.push("");
  conversationLines.push(`Draft ${playbook.owner_first_name}'s reply now. Plain text only.`);

  const userBlock = conversationLines.join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: "user", content: userBlock }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("draft_reply ai error", res.status, body);
    return { error: `ai HTTP ${res.status}` };
  }
  const data = await res.json();
  const blocks = (data.content ?? []) as Array<{ type: string; text?: string }>;
  const draft = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
  if (!draft) return { error: "empty draft" };
  return { draft, model: "claude-sonnet-4-6", workspace_id: reply.workspace_id ?? "" };
}

async function classifyReply(
  text: string,
  lead: { firstName?: string; company?: string },
): Promise<{ intent: ReplyIntent; confidence: number; reasoning: string; referralTarget?: ReferralTarget } | null> {
  const prompt = [
    "Classify a LinkedIn reply to a cold outreach message.",
    "",
    "Choose ONE intent from this enum:",
    "- interested: shows positive engagement, wants more info, asks for a meeting, says 'sounds good'.",
    "- question: asks a clarifying question about the offer or sender, no clear yes/no yet.",
    "- decline: not interested, says no, asks to be removed, currently happy with provider.",
    "- ooo: out-of-office auto-reply or temporary unavailability.",
    "- referral: says you should talk to someone else (a colleague, the owner, another department).",
    "            Examples: 'wrong person — try our owner', 'tal med min kollega Bjarne', 'reach out to marketing'.",
    "- other: small talk, thanks-only, off-topic, unclassifiable.",
    "",
    "If intent=referral, ALSO extract whatever target info is in the reply:",
    "- name:    the referred person's name if mentioned, else null. Use the form they wrote it (don't invent surnames).",
    "- title:   the referred person's role/title if mentioned (e.g. 'owner', 'CMO', 'marketing manager', 'COO', 'salgschef'), else null.",
    "           Only set title if it's an ACTUAL job role. DO NOT extract generic referential phrases like 'right person', 'rette person', 'someone', 'anyone' as a title — those mean we don't know and should be null.",
    "           If the reply names multiple roles (e.g. 'COO eller marketingschef', 'CMO or marketing manager'), join them with ' or ' in title.",
    "- company: only if they referred us to a different company than theirs; usually null.",
    "Leave fields null when unknown rather than guessing. If intent != referral, omit referralTarget entirely.",
    "",
    "Output ONLY valid JSON, no preamble:",
    `{"intent":"<enum>", "confidence":<0..1>, "reasoning":"<10 words max>", "referralTarget":{"name":"<or null>","title":"<or null>","company":"<or null>"}}`,
    "",
    "Lead context (the original recipient of our message):",
    `  firstName: ${lead.firstName ?? "?"}`,
    `  company:   ${lead.company ?? "?"}`,
    "",
    "Reply text:",
    text,
  ].join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 120,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    console.error("ai provider error", res.status, await res.text());
    return null;
  }
  const data = await res.json();
  const txt = data?.content?.[0]?.text ?? "";
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    const intent = String(parsed.intent ?? "").toLowerCase() as ReplyIntent;
    if (!["interested","question","decline","ooo","referral","other"].includes(intent)) return null;
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence ?? 0.5)));
    const reasoning = String(parsed.reasoning ?? "").slice(0, 200);
    const out: { intent: ReplyIntent; confidence: number; reasoning: string; referralTarget?: ReferralTarget } = {
      intent, confidence, reasoning,
    };
    if (intent === "referral" && parsed.referralTarget && typeof parsed.referralTarget === "object") {
      const rt = parsed.referralTarget as Record<string, unknown>;
      const clean = (v: unknown): string | undefined => {
        const s = (typeof v === "string" ? v : "").trim();
        return s && s.toLowerCase() !== "null" ? s.slice(0, 120) : undefined;
      };
      out.referralTarget = {
        name:    clean(rt.name),
        title:   clean(rt.title),
        company: clean(rt.company),
      };
    }
    return out;
  } catch {
    return null;
  }
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
