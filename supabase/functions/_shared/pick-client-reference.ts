// pick-client-reference: ask Claude Haiku to pick the 1-3 Tresyv clients a
// given prospect would find most impressive — or return null when nothing
// is a strong-enough match.
//
// Used by the Tresyv outbound flow to route between three message lanes:
//   - matches != null  → Lane A: long template WITH reference line
//   - matches == null  → Lane B: long template WITHOUT references (Rasmus's
//                        25-år flex), or Lane C: short bait variant
//
// The matcher is intentionally strict: false matches ("vaguely related")
// are worse than no match — they make the outreach feel automated.

import Anthropic from "npm:@anthropic-ai/sdk@0.32.1";
import { TRESYV_CLIENTS } from "./tresyv-clients.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MATCHER_MODEL = "claude-haiku-4-5-20251001";

export type Prospect = {
    company: string;
    website?: string | null;
    industry?: string | null;
    notes?: string | null;
};

export type ReferenceMatch = {
    matches: { name: string; reason: string }[];
    rationale: string;       // one-sentence why-these
    confidence: number;      // 0..1, from Claude's self-assessment
};

export type NoMatch = {
    matches: null;
    rationale: string;       // why no match — useful for debug
    confidence: number;
};

export async function pickClientReference(
    prospect: Prospect,
    opts: { minConfidence?: number; cache?: boolean } = {},
): Promise<ReferenceMatch | NoMatch> {
    const minConfidence = opts.minConfidence ?? 0.7;
    if (!ANTHROPIC_API_KEY) {
        return { matches: null, rationale: "ANTHROPIC_API_KEY not configured", confidence: 0 };
    }

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    // Pass a compact view of the library to keep tokens down. Hide internal
    // notes from Claude — only feed the fields needed for the match decision.
    const library = TRESYV_CLIENTS.map((c) => ({
        name: c.name,
        sectors: c.sectors,
        type: c.project_type,
        summary: c.summary,
        metrics: c.metrics,
        awards: c.awards,
        impressiveness: c.impressiveness,
    }));

    const prompt = `You are picking which of Tresyv's prior clients a Danish B2B prospect would find most impressive, to mention in a cold LinkedIn message.

PROSPECT:
- Company: ${prospect.company}
- Website: ${prospect.website ?? "(none)"}
- Industry/notes: ${prospect.industry ?? ""} ${prospect.notes ?? ""}

TRESYV'S CLIENT LIBRARY (already filtered to recognizable names):
${JSON.stringify(library, null, 2)}

TASK:
Pick 1-3 clients from the library that this prospect would recognize AND find directly relevant to their own business (same industry, comparable scale, similar challenge solved). Order by impressiveness for THIS prospect.

Be strict:
- If no client is a strong match (same sector OR comparable scale + recognizable name), return matches: null. A weak match makes the outreach feel automated and is worse than no reference.
- "Same sector" is the strongest signal. "Recognizable Danish brand" is the second. Generic "we both have a website" is NOT a match.
- Don't pick more than 3. If two clients fit, picking two is better than padding with a third weak one.

Respond as STRICT JSON only (no markdown, no other text):
{
  "matches": [{"name": "<exact name from library>", "reason": "<one short sentence why this prospect would find them impressive>"}] OR null,
  "rationale": "<one sentence explaining overall pick or why nothing matched>",
  "confidence": <0.0 to 1.0 — how strong the match is>
}`;

    const resp = await client.messages.create({
        model: MATCHER_MODEL,
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
    });

    const text = (resp.content[0] as { type: string; text?: string }).text ?? "";
    const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/m, "").trim();

    let parsed: { matches: { name: string; reason: string }[] | null; rationale: string; confidence: number };
    try {
        parsed = JSON.parse(cleaned);
    } catch {
        return { matches: null, rationale: `parse error: ${text.slice(0, 120)}`, confidence: 0 };
    }

    // Sanity: filter out hallucinated client names
    const known = new Set(TRESYV_CLIENTS.map((c) => c.name));
    if (parsed.matches) {
        parsed.matches = parsed.matches.filter((m) => known.has(m.name));
        if (parsed.matches.length === 0) parsed.matches = null;
    }

    if (parsed.matches && parsed.confidence < minConfidence) {
        return {
            matches: null,
            rationale: `low confidence (${parsed.confidence.toFixed(2)} < ${minConfidence}); original: ${parsed.rationale}`,
            confidence: parsed.confidence,
        };
    }

    return parsed.matches
        ? { matches: parsed.matches, rationale: parsed.rationale, confidence: parsed.confidence }
        : { matches: null, rationale: parsed.rationale, confidence: parsed.confidence };
}
