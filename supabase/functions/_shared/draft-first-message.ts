// Drafts the first cold-outreach DM for a given lead, using the workspace's
// voice playbook + (per-workspace) agent brief, and writes the result onto
// the lead's outreach_pipeline row.
//
// Returns the parsed AI envelope plus the resolved workspace_id, or { error }.
//
// Per-workspace: each client's brief + allowed strategies live in their own
// _shared/briefs/<client>.ts module. Add a workspace by adding a brief module
// and a branch in briefForWorkspace — no client shares a file with another.

import { CARTERCO_WORKSPACE_ID, ODAGROUP_WORKSPACE_ID } from "./workspaces.ts";
import { ODAGROUP_AGENT_BRIEF, ODAGROUP_STRATEGIES } from "./briefs/odagroup.ts";
import { CARTERCO_AGENT_BRIEF, CARTERCO_STRATEGIES } from "./briefs/carterco.ts";


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
    | "ad_funnel_leak";
  language: "da" | "en";
  rationale: string;
};

const MODEL = "claude-sonnet-4-6";

// Each workspace resolves to its OWN brief + the strategy keys that brief is
// allowed to emit. The validator checks the model's chosen strategy against
// the SELECTED brief's set — never a cross-client union — so a CarterCo draft
// can never validate an OdaGroup strategy string and vice versa.
function briefForWorkspace(
  workspaceId: string,
): { brief: string; strategies: ReadonlySet<string> } | null {
  if (workspaceId === ODAGROUP_WORKSPACE_ID) {
    return { brief: ODAGROUP_AGENT_BRIEF, strategies: new Set(ODAGROUP_STRATEGIES) };
  }
  if (workspaceId === CARTERCO_WORKSPACE_ID) {
    return { brief: CARTERCO_AGENT_BRIEF, strategies: new Set(CARTERCO_STRATEGIES) };
  }
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

  const briefConfig = briefForWorkspace(workspaceId);
  if (!briefConfig) return { error: `no agent brief bundled for workspace ${workspaceId}` };
  const { brief, strategies: allowedStrategies } = briefConfig;

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
  if (!allowedStrategies.has(strategy)) return { error: `invalid strategy for this workspace: ${strategy}` };
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
