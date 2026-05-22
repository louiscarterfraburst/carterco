#!/usr/bin/env python3
"""Dry-run the Tresyv client-reference matcher against sample prospects.

Mirrors the production matcher in supabase/functions/_shared/pick-client-reference.ts
so we can validate Haiku's picks before wiring to the live draft flow.

Usage:
  set -a; source .env.local; set +a
  python3 scripts/tresyv/test_matcher.py
"""
from __future__ import annotations
import json
import os
import re
import sys
from pathlib import Path

import anthropic  # type: ignore

MODEL = "claude-haiku-4-5-20251001"

# Reuse the TS library by parsing it as a near-JSON blob.
# This is fine for the test — the production matcher reads it directly.
TS_FILE = Path(__file__).resolve().parents[2] / "supabase/functions/_shared/tresyv-clients.ts"

def load_clients():
    src = TS_FILE.read_text()
    # Pull out the array literal after "TRESYV_CLIENTS: TresyvClient[] = "
    m = re.search(r"TRESYV_CLIENTS:\s*TresyvClient\[\]\s*=\s*(\[.*?\n\]);", src, re.S)
    if not m:
        sys.exit("could not parse tresyv-clients.ts")
    arr = m.group(1)
    # Convert TS object literals to JSON: keys are bare → quote them
    arr = re.sub(r'(\b[a-z_]+):', r'"\1":', arr)
    # Strip trailing commas
    arr = re.sub(r",(\s*[\]}])", r"\1", arr)
    return json.loads(arr)


SAMPLES = [
    dict(company="Hjulster", website="hjulster.dk",
         industry="Bike retailer + B2B fleet — webshop and physical stores"),
    dict(company="Eldorado A/S", website="eldorado.dk",
         industry="Danish food/grocery wholesale, distribution to retail"),
    dict(company="Sostrene Grene", website="sostrenegrene.com",
         industry="Retail chain — Danish home/lifestyle, omnichannel webshop + 250+ stores"),
    dict(company="Onomondo", website="onomondo.com",
         industry="B2B IoT connectivity SaaS, global telco-replacement platform"),
    dict(company="GBIF", website="gbif.org",
         industry="International biodiversity data infrastructure (UN-adjacent, non-profit)"),
    dict(company="Cleanstep", website="cleanstep.dk",
         industry="DK cleaning-supply wholesaler — DanDomain webshop, B2B engros"),
    dict(company="Karaoke King ApS", website="karaokeking.dk",
         industry="Karaoke equipment retailer for events"),
    dict(company="Tivoli", website="tivoli.dk",
         industry="Iconic Copenhagen amusement park, omnichannel ticketing + retail"),
]


def pick(client, library, prospect, min_confidence=0.8):
    library_compact = [
        {
            "name": c["name"],
            "sectors": c["sectors"],
            "type": c["project_type"],
            "summary": c["summary"],
            "metrics": c["metrics"],
            "awards": c["awards"],
            "impressiveness": c["impressiveness"],
        }
        for c in library
    ]
    prompt = (
        "You are picking which of Tresyv's prior clients a Danish B2B prospect would find most "
        "impressive, to mention in a cold LinkedIn message.\n\n"
        f"PROSPECT:\n- Company: {prospect['company']}\n- Website: {prospect.get('website') or '(none)'}\n"
        f"- Industry/notes: {prospect.get('industry') or ''}\n\n"
        "TRESYV'S CLIENT LIBRARY (already filtered to recognizable names):\n"
        f"{json.dumps(library_compact, ensure_ascii=False, indent=2)}\n\n"
        "TASK:\n"
        "Pick 1-3 clients that this prospect would recognise AND that closely mirror the prospect's own business. Order by closeness to the prospect.\n\n"
        "STRICTNESS RULES — read carefully, the bar is high:\n\n"
        "1. **Product category is a HARD GATE. It is the first test, and if it fails, return null.**\n"
        "   The two companies must sell or serve the SAME or VERY ADJACENT product/service. \"B2B distribution\" is not a category — IT hardware, food/grocery, cleaning supplies, building materials are categories.\n"
        "   - Food/grocery wholesale ≠ IT hardware wholesale (different products → null, even though both B2B distribution at scale).\n"
        "   - Bike retail ≠ refurbished electronics retail (different products → null).\n"
        "   - Amusement park ≠ airport (different experiences → null, even though both are Danish landmarks).\n"
        "   - Home/lifestyle retail ≠ consumer electronics retail (different products → null).\n"
        "   - Carpentry/trades ≠ tech SaaS (different services → null).\n"
        "   \"Both are e-commerce\" is a CHANNEL, not a category. \"Both serve B2B\" is a CHANNEL, not a category. Match on **what they sell**, not how they sell it.\n\n"
        "2. **Same business model (only checked if category gate already passed).**\n"
        "   - Pure B2C retail and pure B2B distribution are different models.\n"
        "   - Multi-market European distribution ≠ single-market Danish operation.\n"
        "   - Omnichannel (web + 250 stores) ≠ pure online with 1 warehouse.\n\n"
        "3. **Comparable scale (only checked if category + model gates passed).**\n"
        "   - 16 stores and 250 stores are an order of magnitude apart.\n"
        "   - 30,000 B2B customers and 100 B2B customers are different worlds.\n"
        "   - Pan-European and DK-only differ even when category and model match.\n\n"
        "4. **Default to null.** If you find yourself reaching, return null. A weak reference is worse than no reference. Most prospects will end up with no match, and that is correct and expected.\n"
        "   - \"Both Danish\" is NOT a match.\n"
        "   - \"Both have a webshop\" is NOT a match.\n"
        "   - \"Both have physical stores\" is NOT a match.\n"
        "   - \"Both B2B\" is NOT a match.\n"
        "   - \"Both at scale\" is NOT a match.\n"
        "   These are all channel/form similarities, not category similarities.\n\n"
        "5. **Exception:** Non-profit / mission-driven / award-winning clients (Dansk Blindesamfund, Læger uden Grænser, Plan Børnefonden) can match other non-profits or accessibility-conscious orgs.\n\n"
        "Don't pick more than 3. Two strong picks beats three diluted ones. One strong pick beats two diluted ones.\n\n"
        "Respond as STRICT JSON only (no markdown, no other text):\n"
        "{\n"
        '  "matches": [{"name": "<exact name from library>", "reason": "<one short sentence — must reference category/model/scale overlap>"}] OR null,\n'
        '  "rationale": "<one sentence — if null, explain what category gap killed it>",\n'
        '  "confidence": <0.0 to 1.0 — set 0.85+ only when category, model, AND scale all line up>\n'
        "}"
    )
    resp = client.messages.create(model=MODEL, max_tokens=500,
                                  messages=[{"role": "user", "content": prompt}])
    text = resp.content[0].text.strip()
    text = re.sub(r"^```(?:json)?", "", text, flags=re.I).rstrip("`").strip()
    parsed = json.loads(text)
    known = {c["name"] for c in library}
    if parsed.get("matches"):
        parsed["matches"] = [m for m in parsed["matches"] if m["name"] in known]
        if not parsed["matches"]:
            parsed["matches"] = None
    if parsed.get("matches") and parsed.get("confidence", 0) < min_confidence:
        parsed["rationale"] = f"low confidence ({parsed['confidence']:.2f}); {parsed['rationale']}"
        parsed["matches"] = None
    return parsed


def main():
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        sys.exit("ANTHROPIC_API_KEY not set")
    client = anthropic.Anthropic(api_key=key)
    library = load_clients()
    print(f"loaded {len(library)} clients from library\n")

    for p in SAMPLES:
        print(f"=== {p['company']}  ({p['industry']})")
        try:
            r = pick(client, library, p)
            if r.get("matches"):
                print(f"  Lane A — conf {r['confidence']:.2f}")
                print(f"  rationale: {r['rationale']}")
                for m in r["matches"]:
                    print(f"    • {m['name']}: {m['reason']}")
            else:
                print(f"  Lane B (no ref) — conf {r.get('confidence', 0):.2f}")
                print(f"  why: {r.get('rationale','')}")
        except Exception as e:
            print(f"  ERR: {e}")
        print()


if __name__ == "__main__":
    main()
