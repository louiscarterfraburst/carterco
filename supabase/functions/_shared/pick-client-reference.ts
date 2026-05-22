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
    const minConfidence = opts.minConfidence ?? 0.8;
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
Pick 1-3 clients that this prospect would recognise AND that closely mirror the prospect's own business. Order by closeness to the prospect.

STRICTNESS RULES — read carefully, the bar is high:

1. **Product category is a HARD GATE. It is the first test, and if it fails, return null.**
   The two companies must sell or serve the SAME or VERY ADJACENT product/service. "B2B distribution" is not a category — IT hardware, food/grocery, cleaning supplies, building materials are categories.
   - Food/grocery wholesale ≠ IT hardware wholesale (different products → null, even though both B2B distribution at scale).
   - Bike retail ≠ refurbished electronics retail (different products → null).
   - Amusement park ≠ airport (different experiences → null, even though both are Danish landmarks).
   - Home/lifestyle retail ≠ consumer electronics retail (different products → null).
   - Carpentry/trades ≠ tech SaaS (different services → null).
   "Both are e-commerce" is a CHANNEL, not a category. "Both serve B2B" is a CHANNEL, not a category. Match on **what they sell**, not how they sell it.

2. **Same business model (only checked if category gate already passed).**
   - Pure B2C retail and pure B2B distribution are different models.
   - Multi-market European distribution ≠ single-market Danish operation.
   - Omnichannel (web + 250 stores) ≠ pure online with 1 warehouse.

3. **Comparable scale (only checked if category + model gates passed).**
   - 16 stores and 250 stores are an order of magnitude apart.
   - 30,000 B2B customers and 100 B2B customers are different worlds.
   - Pan-European and DK-only differ even when category and model match.

4. **Default to null.** If you find yourself reaching, return null. A weak reference is worse than no reference — Rasmus removed his original references for exactly this reason. Most prospects will end up with no match, and that is correct and expected.
   - "Both Danish" is NOT a match.
   - "Both have a webshop" is NOT a match.
   - "Both have physical stores" is NOT a match.
   - "Both B2B" is NOT a match.
   - "Both at scale" is NOT a match.
   These are all channel/form similarities, not category similarities.

5. **Exception:** Non-profit / mission-driven / award-winning clients (Dansk Blindesamfund, Læger uden Grænser, Plan Børnefonden) can match other non-profits or accessibility-conscious orgs, since the relevant signal there is mission-alignment, not category.

Don't pick more than 3. Two strong picks beats three diluted ones. One strong pick beats two diluted ones.

Respond as STRICT JSON only (no markdown, no other text):
{
  "matches": [{"name": "<exact name from library>", "reason": "<one short sentence — must reference the specific category/model/scale overlap, not generic similarity>"}] OR null,
  "rationale": "<one sentence — if null, explain what category gap killed it>",
  "confidence": <0.0 to 1.0 — set 0.85+ only when the category, model, AND scale all line up>
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
