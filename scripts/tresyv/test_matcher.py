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


def pick(client, library, prospect, min_confidence=0.7):
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
        "Pick 1-3 clients from the library that this prospect would recognize AND find directly "
        "relevant to their own business (same industry, comparable scale, similar challenge solved). "
        "Order by impressiveness for THIS prospect.\n\n"
        "Be strict:\n"
        "- If no client is a strong match (same sector OR comparable scale + recognizable name), "
        "return matches: null. A weak match makes the outreach feel automated and is worse than no reference.\n"
        "- \"Same sector\" is the strongest signal. \"Recognizable Danish brand\" is the second. "
        "Generic \"we both have a website\" is NOT a match.\n"
        "- Don't pick more than 3. If two clients fit, picking two is better than padding with a third weak one.\n\n"
        "Respond as STRICT JSON only (no markdown, no other text):\n"
        "{\n"
        '  "matches": [{"name": "<exact name from library>", "reason": "<one short sentence>"}] OR null,\n'
        '  "rationale": "<one sentence explaining overall pick or why nothing matched>",\n'
        '  "confidence": <0.0 to 1.0>\n'
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
