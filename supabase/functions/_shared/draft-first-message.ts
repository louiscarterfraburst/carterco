// Drafts the first cold-outreach DM for a given lead, using the workspace's
// voice playbook + (per-workspace) agent brief, and writes the result onto
// the lead's outreach_pipeline row.
//
// Returns the parsed AI envelope plus the resolved workspace_id, or { error }.
//
// Currently wired for OdaGroup, CarterCo, and Bikenor. Add more workspaces by
// branching on workspace_id and pointing at a different brief.

import { BIKENOR_WORKSPACE_ID, CARTERCO_WORKSPACE_ID, ODAGROUP_WORKSPACE_ID } from "./workspaces.ts";

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
- **One link allowed in the first message** — the Jarvis booklet, anchored
  *after* the CTA as a single secondary line. Never bare-pasted on its own
  line at the top, never before the CTA, never as the primary ask. The demo
  offer remains the primary CTA; the booklet is the self-serve path for
  buyers who prefer to read before booking.
  - Danish: *"Eller læs den korte version her: https://jarvis-ignite-narrative.lovable.app"*
  - English: *"Or read the short version here: https://jarvis-ignite-narrative.lovable.app"*
  - (TODO: migrate to a custom OdaGroup-owned domain — e.g. jarvis.odagroup.com
    301 → lovable.app — for branding. Edit this brief and re-sync when DNS is live.)

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
  "message": "Hej Lars,\n\nMSL-debriefs er stadig overraskende manuelle hos de fleste — værdifulde scientific signaler ender ofte i fritekst-noter eller bliver helt tabt mellem felt og brand-team, og compliance-kravene gør det ikke nemmere at strukturere undervejs.\n\nJarvis er et AI-native lag oven på jeres eksisterende systemer, som håndterer hands-free MSL-debriefing og automatisk strukturerer medical insights med transparens og audit-trail bygget ind. Bruges i dag hos en global pharma-virksomhed i Europa og Asien.\n\nHvis det giver mening, viser jeg gerne en kort demo (15 min) med fokus på konkrete use cases.\n\nEller læs den korte version her: https://jarvis-ignite-narrative.lovable.app",
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
  "message": "Hi Priya,\n\nMost of the AI work landing on innovation desks in pharma right now is either generic horizontal copilots that ignore field workflows, or pilots that look great in a deck but never make it past a single affiliate. Neither moves the needle on what reps and MSLs actually do day-to-day.\n\nJarvis is a pharma-native AI layer running in production today — meeting prep, hands-free debriefs, HCP intelligence — sitting on top of existing CRM rather than competing with it. Already operating across Europe and Asia at one of the global tier-1s.\n\nIf it's relevant, happy to show a 15-min demo focused on concrete use cases.\n\nOr read the short version here: https://jarvis-ignite-narrative.lovable.app",
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

// Brief mirror — canonical source: clients/carterco/agent-brief.md
const CARTERCO_AGENT_BRIEF = String.raw`
## 1. The core idea

**The fact that they're running ads IS the personalization.** They have
budget, they have a funnel, and the funnel probably leaks faster than they
can keep up with. We don't need to scrape their profile or guess at their
problem — the ad is the signal.

The pitch isn't "buy our software." It's "what happens right now when those
leads land?" — a real founder question between two people who both know how
SMB sales actually works.

---

## 2. Client context

- **Sender:** Louis (Carter & Co, DK).
- **What Louis builds:** AI/automation systems that capture, qualify, and
  respond to inbound leads. Concrete examples: instant LinkedIn DM after a
  form fill; auto-quote generation from a brief; lead-score → routing to the
  right partner; follow-up sequences that wake up ghosted leads.
- **Service, not SaaS.** Louis builds and runs the system for the client.
  No signup, no trial, no monthly subscription. Billed as hours + thin infra.
- **Differentiation:** direct, no juniors, hands-on. NOT "solo / én mand /
  bare mig" framing. The substance is that the person they talk to is the
  person who'll build it.
- **No fabricated proof.** Don't invent client names, stats, or case studies.
  If a proof point would help, leave room for Louis to fill it in by hand at
  approval time rather than inventing one.

---

## 3. Voice — Louis's reference samples

Mirror Louis's existing CarterCo voice playbook exactly: casual Danish,
short, direct sentences, no sales clichés ("synergi", "leverage", "best
in class", "value-add" — banned). Match the prospect's tone if they
respond. Never push for a meeting. Offer easy yes.

**Reference (CarterCo voice in the wild):**

> Hej Mads, så I kører Meta-annoncer i øjeblikket — hurtig spørgsmål:
> hvad sker der lige nu når leadsne lander? Skriver en del med danske
> SMV'er om response-time og opfølgning, og det er som regel der det
> halter.
>
> Hvis det er noget hos jer, fortæller jeg gerne hvad jeg har bygget hos
> andre — sig til.

**Voice traits:**
- Casual Danish, lowercase-ish, contractions OK ("I" → fine, "Jer" → fine)
- 2–4 short sentences. Resist longer. Louis writes tight.
- No emoji. No exclamation marks. No marketing puffery.
- "stikke hovederne sammen" / "tage en uformel snak" — collaborative
  language, not closing language
- End naturally — no "/Louis" sign-off (SendPilot appends signature)

---

## 4. The strategy: \`ad_funnel_leak\`

Single strategy — every lead from this source gets this treatment because
they all share one buyer profile (DK SMB owner-operator running ads).

**Pain bank** (pick the one or two that fit best — name them in their
voice, not as a generic list):
- "leads kommer ind hurtigere end vi kan svare"
- "manuel opfølgning på alle henvendelser"
- "response-time fra 4 timer til 2 dage"
- "ad spend stiger men close rate gør ikke"
- "leads ghoster fordi vi ikke følger op"
- "kunder ringer ind og vi når dem ikke"
- "ingen sammenhæng mellem ad-data og hvem der faktisk køber"

**Hook:** what Louis builds — pick whichever fits the inferred vertical:
- For service businesses (cleaning, trades, accounting): "system der svarer
  inden for 5 min og booker mødet automatisk"
- For B2B with longer sales cycle: "lead-routing + follow-up der vækker
  ghosted leads"
- For high-volume inbound: "auto-kvalificering så I kun ringer dem op der
  faktisk er klar"

**Tone notes:**
- The prospect is a founder/owner — talk to them like one, not like an
  enterprise buyer
- Don't assume they're sophisticated. Don't assume they're naive. They run
  a real business and they know their numbers.
- Curiosity > pitch. "what happens when X lands" is better than "we solve X"

---

## 5. Inputs (provided per-call)

\`\`\`json
{
  "firstName": "string",
  "lastName": "string",
  "title": "string",
  "company": "string",
  "country": "DK | GB | US | ...",
  "vertical": "b2b_cleaning | b2b_accounting | b2b_services_misc | home_services | b2b_realestate | ...",
  "linkedinUrl": "string"
}
\`\`\`

\`vertical\` comes from the Instagram-ads pipeline and tells you what kind of
business this is. Use it to pick which \`hook\` phrasing makes sense (a
cleaning company doesn't need "lead-routing", but they do need "instant
quote response").

---

## 6. Output format

Return JSON only. No preamble, no code fences.

\`\`\`json
{
  "message": "<plain text, ready to paste into LinkedIn DM>",
  "strategy": "ad_funnel_leak",
  "language": "da | en",
  "rationale": "<≤15 words: which pain bank phrase + which hook you picked>"
}
\`\`\`

---

## 7. Hard rules

- **Length: 60–100 words.** This is a CarterCo-voice DM — Louis writes
  tighter than Niels. 2–4 short sentences total.
- **Open with the ad observation.** Acknowledge the visible signal (they're
  running ads) in the first line. Not "I noticed your profile" — "I saw your
  ads / saw I kører annoncer / saw {{company}}'s ads."
- **One pain question.** Pick from the pain bank. Phrase it as a question
  about THEIR funnel, not a statement about their problem. ("hvad sker der
  når leadsne lander?" not "I har problemer med response-time.")
- **One sentence on what Louis builds** — pick the hook that fits the
  vertical. Concrete, not abstract.
- **Soft close.** "sig til hvis det er noget" / "fortæller gerne mere hvis
  det giver mening" / "skriv tilbage hvis det fanger." Never "would you
  like to schedule a call?"
- **Language routing:** \`country in {DK}\` → Danish. Everything else → English.
  (The DK/SE/NO Danish-blanket rule does NOT apply here — Louis's existing
  voice is Danish-first DK only.)
- **Banned:** emoji, exclamation marks, "Hope you're well", "I noticed
  you're", "Just wanted to reach out", "synergi", "leverage", "best in
  class", "value-add", "drive value", "circle back", "quick question"
  (overused). Also banned: any made-up customer names, percentages, or
  testimonials.
- **No signature.** SendPilot appends Louis's signature.
- **No links** in the first message.

---

## 8. Reference output — DK SMB, b2b_accounting

Input:
\`\`\`json
{"firstName":"Anders","lastName":"Sørensen","title":"Adm. Direktør","company":"Valentin Regnskab","country":"DK","vertical":"b2b_accounting"}
\`\`\`

Acceptable output:
\`\`\`json
{
  "message": "Hej Anders, så I kører Meta-annoncer for Valentin Regnskab i øjeblikket — hurtig spørgsmål: hvad sker der lige nu når leadsne lander? Skriver en del med danske revisorer om response-time og opfølgning, og det er som regel der det halter.\n\nHvis det er noget I tænker over, fortæller jeg gerne hvad jeg har bygget hos andre. Sig til.",
  "strategy": "ad_funnel_leak",
  "language": "da",
  "rationale": "B2B accounting + DK → ad observation + response-time pain + soft discovery"
}
\`\`\`

---

## 9. When in doubt

- Be shorter, not longer.
- Be more curious, not more pitchy.
- The ad is the proof Louis paid attention — don't waste that signal with
  generic outreach.
- If the vertical is unclear or the brand is genuinely tiny, default to the
  most universal pain ("response-time on inbound") and the most universal
  hook ("auto-respond + auto-book"). Note in rationale.
`;

// Brief mirror — canonical source: clients/bikenor/agent-brief.md
// Bikenor (PUKY) — DK/LinkedIn lane only, single strategy kids_assortment.
const BIKENOR_AGENT_BRIEF = String.raw`
## 1. Core idea

One strategy: kids_assortment. Every accepted lead is a DK bike- or sports-shop
owner / indkøbschef. Nikolaj already sent a connection note as PUKY's DK
distributor, and they accepted, so they are at least curious. The first DM does
NOT re-introduce. It offers the one concrete, low-friction next step:
forhandlervilkår + the best-selling PUKY models for THEIR shop type.

Shop type -> which best-sellers fit -> soft offer to send terms + bestseller list.

## 2. Client context

- Sender: Nikolaj, Bikenor ApS, dansk distributør for PUKY.
- Product: PUKY børnecykler og løbecykler (kvalitets-tysk mærke).
- Audience: ejere / indkøbschefer hos cykel- og sportsbutikker i DK.
- The connection note already framed who Nikolaj is. Do not repeat it.
- Seasonal truth: børnecykler topper op mod foråret. Use as a timing nudge when
  it fits naturally, not in every message.

## 3. Voice — Nikolaj

Casual, human-typed Danish. Short and direct (2-4 sentences). Match the rhythm
of his own follow-ups:

> Hej Anders, vender lige tilbage på min besked, har du fået kigget på den?
> Nemmeste er måske, at jeg sender forhandlervilkår plus de bedst sælgende
> PUKY-modeller for jeres butikstype, så kan du se om det passer ind. Skal jeg det?

Voice traits:
- Plain, human Danish. No em dashes, no trademark symbols, no ALL-CAPS; write
  "PUKY" in normal text.
- No sales clichés ("synergi", "leverage", "best in class", "value-add" banned).
- No meeting push. Offer an easy yes.
- No performative signals ("jeg testede jeres lead-flow", "skrev mig op som
  lead"). Observation from outside only.
- End naturally. No signature in the body; the campaign appends it.

## 4. Strategy: kids_assortment

Single strategy, every lead. The pitch is always: get the best-selling PUKY
children's-bike assortment into their shop, with a no-obligation offer to send
dealer terms + the bestseller list tailored to their shop type.

Angle bank:
- Børnecykel-sortiment der faktisk sælger (ikke gætteri).
- Timing: foråret topper, så sortimentet bør være på plads i tide.
- Uforpligtende: bare se vilkår + bestsellers, ingen binding.

## 5. Message construction

- Open by picking up the thread (you just connected), never a cold "jeg så".
- One clear value line: PUKY's best-sellers for their shop type.
- One soft CTA: "skal jeg sende forhandlervilkår plus de bedst sælgende modeller?"
- Optional seasonal nudge if it fits.
- 2-4 short sentences, Danish. Shorter beats longer.

## 6. Output envelope

Return ONLY this JSON object:

{
  "message": "<the DM>",
  "strategy": "kids_assortment",
  "language": "da",
  "rationale": "<=15 words: shop-type signal -> assortment offer>"
}

language is always "da" (DK LinkedIn lane). Never draft email here.

## 7. Example

{
  "message": "Hej Anders, fedt vi fik forbindelse. Det letteste er nok, at jeg sender jer forhandlervilkår plus de PUKY-modeller der sælger bedst for en butik som jeres, så kan du se om det passer ind. Børnecykler topper op mod foråret, så timingen er meget god nu. Skal jeg sende det?",
  "strategy": "kids_assortment",
  "language": "da",
  "rationale": "bike retailer + DK -> bestseller assortment + spring timing + soft offer"
}
`;

type AdminClient = {
  // deno-lint-ignore no-explicit-any
  from: (table: string) => any;
};

export type FirstMessageEnvelope = {
  message: string;
  strategy:
    | "commercial_excellence"
    | "crm_platform"
    | "ai_innovation"
    | "medical_affairs"
    | "ad_funnel_leak"
    | "kids_assortment";
  language: "da" | "en";
  rationale: string;
};

const MODEL = "claude-sonnet-4-6";
// Union of strategies known across all workspace briefs. Each brief constrains
// its own AI to a subset via prompt; this set is the validator's allowlist.
const VALID_STRATEGIES = new Set([
  // OdaGroup
  "commercial_excellence",
  "crm_platform",
  "ai_innovation",
  "medical_affairs",
  // CarterCo (ad-spending leads)
  "ad_funnel_leak",
  // Bikenor (PUKY children's-bike assortment)
  "kids_assortment",
]);

export function briefForWorkspace(workspaceId: string): string | null {
  if (workspaceId === ODAGROUP_WORKSPACE_ID) return ODAGROUP_AGENT_BRIEF;
  if (workspaceId === CARTERCO_WORKSPACE_ID) return CARTERCO_AGENT_BRIEF;
  if (workspaceId === BIKENOR_WORKSPACE_ID) return BIKENOR_AGENT_BRIEF;
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
    .select("sendpilot_lead_id, contact_email, workspace_id, status, referred_from_pipeline_lead_id")
    .eq("sendpilot_lead_id", leadId)
    .maybeSingle();
  if (!pipe) return { error: "pipeline row not found" };
  const workspaceId = (pipe as { workspace_id?: string }).workspace_id ?? "";
  if (!workspaceId) return { error: "pipeline row has no workspace_id" };

  const brief = briefForWorkspace(workspaceId);
  if (!brief) return { error: `no agent brief bundled for workspace ${workspaceId}` };

  const { data: lead } = await admin
    .from("outreach_leads")
    .select("first_name, last_name, title, company, country, linkedin_url, vertical")
    .eq("contact_email", (pipe as { contact_email?: string }).contact_email ?? "")
    .maybeSingle();
  if (!lead) return { error: "lead not found in outreach_leads" };

  const { data: playbook } = await admin
    .from("outreach_voice_playbooks")
    .select("owner_first_name, value_prop")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const ownerFirst = (playbook as { owner_first_name?: string })?.owner_first_name ?? "";

  // Referral context: if the prospect was referred by another lead's reply,
  // pull the referrer's name + the specific reply that triggered the referral.
  // We inject this into the prompt so the opener acknowledges the chain
  // naturally ("Thomas Eilersen i jeres team pegede mig din retning…")
  // rather than going cold-strategy. The brief's strategy choice still
  // applies for the body's substance — only the opener shifts.
  const referredFromLeadId = (pipe as { referred_from_pipeline_lead_id?: string }).referred_from_pipeline_lead_id;
  let referral: { firstName: string; lastName: string; replyText: string } | null = null;
  if (referredFromLeadId) {
    const { data: refPipe } = await admin
      .from("outreach_pipeline")
      .select("contact_email")
      .eq("sendpilot_lead_id", referredFromLeadId)
      .maybeSingle();
    if ((refPipe as { contact_email?: string } | null)?.contact_email) {
      const { data: refLead } = await admin
        .from("outreach_leads")
        .select("first_name, last_name")
        .eq("contact_email", (refPipe as { contact_email: string }).contact_email)
        .maybeSingle();
      const { data: refReply } = await admin
        .from("outreach_replies")
        .select("message")
        .eq("sendpilot_lead_id", referredFromLeadId)
        .eq("direction", "inbound")
        .eq("intent", "referral")
        .order("received_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (refLead) {
        referral = {
          firstName: ((refLead as { first_name?: string }).first_name ?? "").split(/\s+/)[0] ?? "",
          lastName:  (refLead as { last_name?: string }).last_name ?? "",
          replyText: ((refReply as { message?: string } | null)?.message ?? "").trim().slice(0, 400),
        };
      }
    }
  }

  const leadJson = {
    firstName: (lead as { first_name?: string }).first_name ?? "",
    lastName:  (lead as { last_name?: string }).last_name ?? "",
    title:     (lead as { title?: string }).title ?? "",
    company:   (lead as { company?: string }).company ?? "",
    country:   (lead as { country?: string }).country ?? "",
    vertical:  (lead as { vertical?: string }).vertical ?? "",
    linkedinUrl: (lead as { linkedin_url?: string }).linkedin_url ?? "",
  };

  const systemPromptLines = [
    `You are drafting a first LinkedIn DM on behalf of ${ownerFirst || "the sender"} immediately after a connection request was accepted.`,
    "",
    "Follow the brief below to the letter. Pick ONE strategy based on the prospect's title, write in the chosen language, and return ONLY a JSON object — no preamble, no code fences, no extra keys.",
    "",
    "=== AGENT BRIEF ===",
    brief.trim(),
    "=== END BRIEF ===",
  ];

  if (referral) {
    // Referral chain override — sits between the brief and the lead so the
    // model knows to weave the referrer into the opener while still using
    // the brief's strategy/voice for substance.
    systemPromptLines.push(
      "",
      "=== REFERRAL CONTEXT (overrides cold opener) ===",
      `This lead came in via a referral: a colleague at the same company replied to our cold outreach pointing us here.`,
      `Referrer first name: ${referral.firstName}`,
      `Referrer last name:  ${referral.lastName}`,
      `Referrer's actual reply text (verbatim):`,
      `"${referral.replyText}"`,
      "",
      "Rules for this referral path:",
      `- Open by naming ${referral.firstName} as the referrer — natural, not "${referral.firstName} sagde du var den rette" stiffness. Match the warmth level of the reply text: warm reply = warm opener, curt reply = matter-of-fact opener.`,
      `- DO NOT open with the cold-strategy opener (no ad observation, no "I saw your title" pain hook). The referral itself IS the personalization.`,
      `- Keep the rest of the message faithful to the brief's strategy, voice, length, language rules, and CTA preferences. The substance still picks one strategy from the brief; only the opener changes.`,
      `- Strategy in the JSON envelope: still pick from the brief's allowed strategies based on the prospect's title. The referral changes the OPENING, not the strategy choice.`,
      "=== END REFERRAL CONTEXT ===",
    );
  }

  const systemPrompt = systemPromptLines.join("\n");

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
