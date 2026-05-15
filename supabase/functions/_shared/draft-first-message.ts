// Drafts the first cold-outreach DM for a given lead, using the workspace's
// voice playbook + (per-workspace) agent brief, and writes the result onto
// the lead's outreach_pipeline row.
//
// Returns the parsed AI envelope plus the resolved workspace_id, or { error }.
//
// Currently wired for OdaGroup. Add more workspaces by branching on
// workspace_id and pointing at a different brief.

import { ODAGROUP_WORKSPACE_ID } from "./workspaces.ts";

// Brief mirror — canonical source: clients/odagroup/agent-brief.md
const ODAGROUP_AGENT_BRIEF = String.raw`
## 1. The core idea

**The role is the personalization signal.** No LinkedIn scraping. No
"recent activity" lookups. The prospect's title alone tells us which of 4
pains they wake up worrying about, and we write directly to that pain.

Title → Strategy → Pain → Hook → Message. That's the whole chain.

---

## 2. Client context

- **Company:** Oda ApS — Danish AI/software firm focused on pharma field teams and commercial organisations.
- **Founder / sender:** Niels.
- **Product:** **Jarvis** — AI-native augmentation layer. In production at Novo Nordisk EU + Asia (meeting prep, hands-free debriefing, HCP/HCO insights, coaching).
- **Positioning (non-negotiable):** Jarvis sits **on top of** Veeva, IQVIA, Salesforce. Never replaces them. Pharma buyers are skeptical of "yet another system" — augmentation framing is what unlocks the conversation.
- **Anchor proof point:** Novo Nordisk EU + Asia. Mention exactly once per message. Matter-of-fact. No hype.

---

## 3. Voice — Niels's reference sample

Voice DNA = the lead message Niels wrote himself. Match its sentence length,
formality, vocabulary, and rhythm precisely.

> Hej [Name],
>
> Mit navn er Niels, og jeg er founder af Oda ApS, et dansk software- og AI-firma med fokus på pharma field teams og kommercielle organisationer.
> Vi har udviklet Jarvis, som allerede anvendes hos Novo Nordisk i både Europa og Asien til bl.a. meeting prep, hands-free debriefing, HCP/HCO insights og coaching.
> Vores fokus har været at bygge en mere moderne og AI-native platform end de klassiske enterprise-løsninger på markedet, uden at virksomheder behøver udskifte eksisterende systemer eller arbejdsgange.
> Jarvis fungerer derfor oven på løsninger som Veeva, IQVIA og Salesforce og kræver primært adgang til data.
>
> Kort fortalt hjælper platformen med at:
> • forbedre kvaliteten af debriefs
> • strukturere insights automatisk
> • reducere administrativt arbejde
> • give ledere bedre realtime-overblik
>
> Jeg tænkte, det måske kunne være relevant i jeres setup. Hvis ja, viser jeg gerne en kort demo på 15 min med fokus på konkrete use cases og værdiskabelse.
>
> Bedste hilsner
> Niels

**Voice traits to replicate:**
- Measured, professional. Never breathless.
- Names products by name (Veeva, IQVIA, Salesforce, Novo Nordisk). Concrete > abstract.
- Bullets only when they earn their keep. Otherwise prose.
- Always offers a low-friction next step. Never aggressive close.
- No emoji. No exclamation marks. No marketing puffery.

---

## 4. The four strategies

Pick **one** strategy per message based on the prospect's title. Output the
strategy key in the JSON envelope so we can A/B them.

### \`commercial_excellence\` — most mature buyers, often closes fastest

- **Title triggers:** Commercial Excellence, Field Excellence, Customer Engagement (non-tech), Omnichannel, Sales Force Effectiveness, Business Excellence, Field Force Effectiveness, Head of Commercial Excellence
- **Pain bank** (pick the one or two that fit best — name them in the prospect's voice, not as a generic list):
  - dårlig debrief-kvalitet
  - lav CRM-disciplin
  - manglende field insights
  - for meget admin
  - svært at få overblik på tværs af affiliates
- **Hook:** "løft kvaliteten af debriefs og insights uden CRM-udskiftning"
- **Phrase bank:** field force effectiveness, customer engagement, omnichannel, next best action, CRM adoption, debrief quality

### \`crm_platform\` — strongest edge, but skeptics by default

- **Title triggers:** Veeva, CRM, Salesforce, Digital Platform, Customer Engagement Technology, Enterprise Architect, CRM Product Owner, Veeva Product Owner, Salesforce Lead
- **Pain bank:**
  - "endnu et system" fatigue
  - fragmented commercial stack
  - slow vendor cycles
  - pressure to deliver AI value without rip-and-replace
- **Hook:** "AI-native layer oven på eksisterende stack" — not a replacement
- **Phrase bank:** Veeva, Salesforce, IQVIA, CRM transformation, commercial platforms, augmentation layer
- **Tone note:** lead with the augmentation positioning *before* anything else. These prospects auto-reject "another platform".

### \`ai_innovation\` — higher reply rate, longer sales cycle, can be more offensive

- **Title triggers:** AI Lead, GenAI Lead, Digital Innovation Director, Transformation Lead, Emerging Technology, Copilot
- **Pain bank:**
  - pilot purgatory — POCs that never reach production
  - generic horizontal copilots that don't fit pharma workflows
  - lack of pharma-native, compliance-aware AI
  - struggle to show ROI on AI investment
- **Hook:** "bleeding-edge enterprise AI der allerede er i produktion i global pharma"
- **Phrase bank:** GenAI, LLM, AI transformation, digital innovation, copilot, in-production, hands-free debrief, HCP intelligence
- **Tone note:** can be slightly more confident/offensive here than other strategies. These prospects respect production-grade boldness.

### \`medical_affairs\` — undervalued, ekstremt godt fit

- **Title triggers:** Medical Excellence, Medical Affairs, Medical Affairs Director, MSL Excellence, MSL, Scientific Engagement, Medical Operations
- **Pain bank:**
  - manual MSL debriefs
  - fragmented medical insights across the field
  - compliance friction slowing insight capture
  - hard to surface scientific signals to brand teams
- **Hook:** "strukturerede medical insights med compliance og transparens"
- **Phrase bank:** MSL, medical insights, scientific engagement, field medical, compliance, transparency

### Fallback

If the title doesn't cleanly map (e.g. "Director, Operations & Strategy"):
default to \`commercial_excellence\` and note \`"title ambiguous, defaulted to commex"\` in \`rationale\`.

---

## 5. Inputs (provided per-call)

\`\`\`json
{
  "firstName": "string",
  "lastName": "string",
  "title": "string",
  "company": "string",
  "country": "DK | SE | NO | DE | CH | UK | NL | FR | ES | CA | JP | …",
  "linkedinUrl": "string"
}
\`\`\`

That's it. No scraped profile. No company snippet. The title carries the strategy; the strategy carries the message.

---

## 6. Output format

Return JSON only. No preamble, no code fences.

\`\`\`json
{
  "message": "<plain text, ready to paste into LinkedIn DM>",
  "strategy": "commercial_excellence | crm_platform | ai_innovation | medical_affairs",
  "language": "da | en",
  "rationale": "<≤15 words: which title signal triggered the strategy choice>"
}
\`\`\`

---

## 7. Hard rules

- **Length:** 90–150 words for the body. Hard cap.
- **Open with their world, not yours.** First sentence acknowledges the pain *they* live with based on their role — using one or two phrases from that strategy's pain bank in their natural language. Never start with "I noticed" or "I saw your profile".
- **One sentence on Jarvis** — what it is + the augmentation framing.
- **Anchor proof point:** mention Novo Nordisk EU + Asia exactly once. Matter-of-fact.
- **Positioning:** never frame Jarvis as a replacement for Veeva/IQVIA/Salesforce. Always "augmentation layer / works on top of".
- **Language routing:** \`country ∈ {DK, SE, NO}\` → Danish. Everywhere else → English. Use the \`country\` field, not company name.
- **CTA:** end with the low-friction demo offer.
  - Danish: *"Hvis det giver mening, viser jeg gerne en kort demo (15 min) med fokus på konkrete use cases."*
  - English: *"If it's relevant, happy to show a 15-min demo focused on concrete use cases."*
- **Banned:** emoji, exclamation marks, "Hope you're well", "I noticed you're", "Just wanted to reach out", "synergi", "leverage", "best in class", "value-add", "drive value", "circle back", "quick question".
- **No signature.** SendPilot appends it.
- **No links** in the first message — the longer pitch + URL goes in a follow-up step.

---

## 8. Reference outputs — for STRUCTURE & VOICE only

**These are calibration samples, not templates.** Your output must use
different phrasing — never copy a sentence or distinctive phrase verbatim.
Re-state the same ideas in different words. The shape is: role-pain →
Jarvis-as-augmentation → Novo proof → CTA. The words are yours each time.

### Reference A — \`medical_affairs\`, Danish

Input:
\`\`\`json
{"firstName":"Lars","lastName":"Nielsen","title":"MSL Excellence Lead","company":"Lundbeck","country":"DK"}
\`\`\`

Acceptable output:
\`\`\`json
{
  "message": "Hej Lars,\n\nMSL-debriefs er stadig overraskende manuelle hos de fleste — værdifulde scientific signaler ender ofte i fritekst-noter eller bliver helt tabt mellem felt og brand-team, og compliance-kravene gør det ikke nemmere at strukturere undervejs.\n\nJarvis er et AI-native lag oven på jeres eksisterende systemer, som håndterer hands-free MSL-debriefing og automatisk strukturerer medical insights med transparens og audit-trail bygget ind. Bruges i dag hos en global pharma-virksomhed i Europa og Asien.\n\nHvis det giver mening, viser jeg gerne en kort demo (15 min) med fokus på konkrete use cases.",
  "strategy": "medical_affairs",
  "language": "da",
  "rationale": "MSL Excellence Lead → medical_affairs; DK → Danish"
}
\`\`\`

### Reference B — \`ai_innovation\`, English

Input:
\`\`\`json
{"firstName":"Priya","lastName":"Shah","title":"Director, Digital Innovation","company":"Pfizer","country":"UK"}
\`\`\`

Acceptable output:
\`\`\`json
{
  "message": "Hi Priya,\n\nMost of the AI work landing on innovation desks in pharma right now is either generic horizontal copilots that ignore field workflows, or pilots that look great in a deck but never make it past a single affiliate. Neither moves the needle on what reps and MSLs actually do day-to-day.\n\nJarvis is a pharma-native AI layer running in production today — meeting prep, hands-free debriefs, HCP intelligence — sitting on top of existing CRM rather than competing with it. Already operating across Europe and Asia at one of the global tier-1s.\n\nIf it's relevant, happy to show a 15-min demo focused on concrete use cases.",
  "strategy": "ai_innovation",
  "language": "en",
  "rationale": "Digital Innovation Director → ai_innovation; UK → English"
}
\`\`\`

---

## 9. When in doubt

- Be shorter, not longer.
- Be more concrete (name the workflow / vendor / product), not more abstract.
- Be more measured (Niels never sells), not more enthusiastic.
- If the title is genuinely ambiguous: pick \`commercial_excellence\`, note it in \`rationale\`, let the human review catch edge cases.
`;

type AdminClient = {
  // deno-lint-ignore no-explicit-any
  from: (table: string) => any;
};

export type FirstMessageEnvelope = {
  message: string;
  strategy: "commercial_excellence" | "crm_platform" | "ai_innovation" | "medical_affairs";
  language: "da" | "en";
  rationale: string;
};

const MODEL = "claude-sonnet-4-6";
const VALID_STRATEGIES = new Set([
  "commercial_excellence",
  "crm_platform",
  "ai_innovation",
  "medical_affairs",
]);

function briefForWorkspace(workspaceId: string): string | null {
  if (workspaceId === ODAGROUP_WORKSPACE_ID) return ODAGROUP_AGENT_BRIEF;
  return null;
}

export async function draftFirstMessage(
  admin: AdminClient,
  leadId: string,
): Promise<{ envelope: FirstMessageEnvelope; model: string; workspace_id: string } | { error: string }> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (!apiKey) return { error: "ANTHROPIC_API_KEY not configured" };

  const { data: pipe } = await admin
    .from("outreach_pipeline")
    .select("sendpilot_lead_id, contact_email, workspace_id, status")
    .eq("sendpilot_lead_id", leadId)
    .maybeSingle();
  if (!pipe) return { error: "pipeline row not found" };
  const workspaceId = (pipe as { workspace_id?: string }).workspace_id ?? "";
  if (!workspaceId) return { error: "pipeline row has no workspace_id" };

  const brief = briefForWorkspace(workspaceId);
  if (!brief) return { error: `no agent brief bundled for workspace ${workspaceId}` };

  const { data: lead } = await admin
    .from("outreach_leads")
    .select("first_name, last_name, title, company, country, linkedin_url")
    .eq("contact_email", (pipe as { contact_email?: string }).contact_email ?? "")
    .maybeSingle();
  if (!lead) return { error: "lead not found in outreach_leads" };

  const { data: playbook } = await admin
    .from("outreach_voice_playbooks")
    .select("owner_first_name, value_prop")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const ownerFirst = (playbook as { owner_first_name?: string })?.owner_first_name ?? "";

  const leadJson = {
    firstName: (lead as { first_name?: string }).first_name ?? "",
    lastName:  (lead as { last_name?: string }).last_name ?? "",
    title:     (lead as { title?: string }).title ?? "",
    company:   (lead as { company?: string }).company ?? "",
    country:   (lead as { country?: string }).country ?? "",
    linkedinUrl: (lead as { linkedin_url?: string }).linkedin_url ?? "",
  };

  const systemPrompt = [
    `You are drafting a first LinkedIn DM on behalf of ${ownerFirst || "the sender"} immediately after a connection request was accepted.`,
    "",
    "Follow the brief below to the letter. Pick ONE strategy based on the prospect's title, write in the chosen language, and return ONLY a JSON object — no preamble, no code fences, no extra keys.",
    "",
    "=== AGENT BRIEF ===",
    brief.trim(),
    "=== END BRIEF ===",
  ].join("\n");

  const userPrompt = [
    "Draft the first message for this lead. Output the JSON envelope only.",
    "",
    "LEAD:",
    JSON.stringify(leadJson, null, 2),
  ].join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error("draft_first_message ai HTTP error", res.status, txt);
    return { error: `ai HTTP ${res.status}` };
  }
  const data = await res.json();
  const blocks = (data.content ?? []) as Array<{ type: string; text?: string }>;
  const raw = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { error: "ai output was not JSON" };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return { error: "ai JSON parse failed" };
  }

  const message = String(parsed.message ?? "").trim();
  const strategy = String(parsed.strategy ?? "").trim();
  const language = String(parsed.language ?? "").trim().toLowerCase();
  const rationale = String(parsed.rationale ?? "").trim().slice(0, 200);
  if (!message) return { error: "ai envelope missing message" };
  if (!VALID_STRATEGIES.has(strategy)) return { error: `invalid strategy: ${strategy}` };
  if (language !== "da" && language !== "en") return { error: `invalid language: ${language}` };

  const envelope: FirstMessageEnvelope = {
    message,
    strategy: strategy as FirstMessageEnvelope["strategy"],
    language: language as "da" | "en",
    rationale,
  };

  // Persist onto the pipeline row. Mirrors the SendSpark render path:
  // rendered_message + rendered_at + queued_at + status='pending_approval'.
  const now = new Date().toISOString();
  const { error: updErr } = await admin
    .from("outreach_pipeline")
    .update({
      rendered_message: envelope.message,
      message_strategy: envelope.strategy,
      message_strategy_rationale: envelope.rationale,
      message_model: MODEL,
      message_language: envelope.language,
      rendered_at: now,
      queued_at: now,
      status: "pending_approval",
    })
    .eq("sendpilot_lead_id", leadId);
  if (updErr) {
    console.error("draft_first_message pipeline update error", updErr);
    return { error: `pipeline update failed: ${updErr.message ?? "unknown"}` };
  }

  return { envelope, model: MODEL, workspace_id: workspaceId };
}
