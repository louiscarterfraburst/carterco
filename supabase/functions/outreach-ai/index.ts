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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ALLOWED_USERS = new Set([
  "louis@carterco.dk",
  "rm@tresyv.dk",
  "haugefrom@haugefrom.com",
]);

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

type ReplyIntent = "interested" | "question" | "decline" | "ooo" | "other";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!ANTHROPIC_API_KEY) {
    return json({ error: "ANTHROPIC_API_KEY not configured on this function" }, 500);
  }

  // Authorisation: edge runtime already verified the JWT signature.
  // We additionally check that human callers are workspace-allowed; service
  // role bypasses the email check (no `email` claim).
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { global: { headers: { Authorization: `Bearer ${token}` } } },
  );
  const { data: { user } } = await userClient.auth.getUser();
  if (user) {
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

  return json({ error: `unknown op: ${op}` }, 400);
});

async function classifyReply(
  text: string,
  lead: { firstName?: string; company?: string },
): Promise<{ intent: ReplyIntent; confidence: number; reasoning: string } | null> {
  const prompt = [
    "Classify a LinkedIn reply to a cold outreach message.",
    "",
    "Choose ONE intent from this enum:",
    "- interested: shows positive engagement, wants more info, asks for a meeting, says 'sounds good'.",
    "- question: asks a clarifying question about the offer or sender, no clear yes/no yet.",
    "- decline: not interested, says no, asks to be removed, currently happy with provider.",
    "- ooo: out-of-office auto-reply or temporary unavailability.",
    "- other: small talk, thanks-only, off-topic, unclassifiable.",
    "",
    "Output ONLY valid JSON, no preamble:",
    `{"intent":"<enum>", "confidence":<0..1>, "reasoning":"<10 words max>"}`,
    "",
    "Lead context:",
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
    console.error("anthropic error", res.status, await res.text());
    return null;
  }
  const data = await res.json();
  const txt = data?.content?.[0]?.text ?? "";
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    const intent = String(parsed.intent ?? "").toLowerCase() as ReplyIntent;
    if (!["interested","question","decline","ooo","other"].includes(intent)) return null;
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence ?? 0.5)));
    const reasoning = String(parsed.reasoning ?? "").slice(0, 200);
    return { intent, confidence, reasoning };
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
