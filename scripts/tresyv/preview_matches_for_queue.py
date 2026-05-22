#!/usr/bin/env python3
"""Run the Tresyv client-reference matcher against the current V1/V2 leads
in pending_approval for Tresyv workspace. Shows which prospects would get a
brand name-drop if reference-line logic were turned on.

Usage:
  set -a; source .env.local; set +a
  python3 scripts/tresyv/preview_matches_for_queue.py
"""
from __future__ import annotations
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

import anthropic  # type: ignore

MODEL = "claude-haiku-4-5-20251001"
TRESYV_WS = "2740ba1f-d5d5-4008-bf43-b45367c73134"

SB_URL = os.environ.get("SUPABASE_URL") or os.environ["NEXT_PUBLIC_SUPABASE_URL"]
SB_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
AN_KEY = os.environ["ANTHROPIC_API_KEY"]

TS_FILE = Path(__file__).resolve().parents[2] / "supabase/functions/_shared/tresyv-clients.ts"


def load_clients():
    src = TS_FILE.read_text()
    m = re.search(r"TRESYV_CLIENTS:\s*TresyvClient\[\]\s*=\s*(\[.*?\n\]);", src, re.S)
    if not m:
        sys.exit("could not parse tresyv-clients.ts")
    arr = m.group(1)
    arr = re.sub(r'(\b[a-z_]+):', r'"\1":', arr)
    arr = re.sub(r",(\s*[\]}])", r"\1", arr)
    return json.loads(arr)


def fetch_leads():
    url = (
        f"{SB_URL}/rest/v1/outreach_pipeline"
        f"?workspace_id=eq.{TRESYV_WS}"
        f"&status=eq.pending_approval"
        f"&first_dm_variant=in.(v1_long,v2_short)"
        f"&select=sendpilot_lead_id,contact_email,first_dm_variant"
    )
    req = urllib.request.Request(url, headers={
        "apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}",
    })
    with urllib.request.urlopen(req, timeout=30) as f:
        pipes = json.loads(f.read())
    if not pipes:
        return []
    # Fetch all Tresyv outreach_leads in one shot (workspace_id has no special
    # chars). Join in Python — avoids URL-encoding hell with `+` in emails.
    url = (
        f"{SB_URL}/rest/v1/outreach_leads"
        f"?workspace_id=eq.{TRESYV_WS}"
        f"&select=contact_email,first_name,last_name,company,title,website"
    )
    req = urllib.request.Request(url, headers={
        "apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}",
    })
    with urllib.request.urlopen(req, timeout=60) as f:
        leads = {l["contact_email"]: l for l in json.loads(f.read())}
    out = []
    for p in pipes:
        l = leads.get(p["contact_email"]) or {}
        out.append({
            "lead_id": p["sendpilot_lead_id"],
            "variant": p["first_dm_variant"],
            "company": l.get("company") or "",
            "website": l.get("website") or "",
            "title": l.get("title") or "",
        })
    return out


PROMPT_TPL = """You are picking which of Tresyv's prior clients a Danish B2B prospect would find most impressive, to mention in a cold LinkedIn message.

PROSPECT:
- Company: {company}
- Website: {website}
- Industry/notes: {industry}

TRESYV'S CLIENT LIBRARY:
{library}

TASK:
Pick 1-3 clients that this prospect would recognise AND that closely mirror the prospect's own business. Order by closeness.

STRICTNESS RULES:
1. Product category is a HARD GATE. Different products → null even if both B2B / both ecom / both Danish.
2. Same business model. Pure B2C ≠ pure B2B. Multi-market ≠ single-market.
3. Comparable scale. Order-of-magnitude scale gaps → null.
4. Default to null. Weak references are worse than no reference.
5. Exception: non-profits / mission-driven / award-winners match other non-profits.

Respond as STRICT JSON only:
{{
  "matches": [{{"name": "<exact name from library>", "reason": "<short>"}}] OR null,
  "rationale": "<one sentence>",
  "confidence": <0.0 to 1.0>
}}
"""


def match_one(client_lib_json: str, prospect: dict):
    a = anthropic.Anthropic(api_key=AN_KEY)
    prompt = PROMPT_TPL.format(
        company=prospect["company"] or "(unknown)",
        website=prospect["website"] or "(none)",
        industry=prospect["title"] or "",
        library=client_lib_json,
    )
    resp = a.messages.create(
        model=MODEL, max_tokens=400,
        messages=[{"role": "user", "content": prompt}],
    )
    text = resp.content[0].text.strip()  # type: ignore
    cleaned = re.sub(r"^```(?:json)?", "", text).strip()
    cleaned = re.sub(r"```$", "", cleaned).strip()
    try:
        return json.loads(cleaned)
    except Exception:
        return {"matches": None, "rationale": f"parse error: {text[:100]}", "confidence": 0}


def main():
    clients = load_clients()
    # Compact library
    library = [{
        "name": c["name"],
        "sectors": c["sectors"],
        "type": c["project_type"],
        "summary": c["summary"],
        "metrics": c.get("metrics", []),
        "awards": c.get("awards", []),
        "impressiveness": c["impressiveness"],
    } for c in clients]
    lib_json = json.dumps(library, ensure_ascii=False)

    leads = fetch_leads()
    print(f"Found {len(leads)} V1/V2 Tresyv leads in pending_approval.\n")

    matched = []
    for i, lead in enumerate(leads, 1):
        result = match_one(lib_json, lead)
        if result.get("matches"):
            names = [m["name"] for m in result["matches"]]
            print(f"[{i}/{len(leads)}] ✓ {lead['company']} → {', '.join(names)}  (conf={result.get('confidence', 0):.2f})")
            for m in result["matches"]:
                print(f"     · {m['name']}: {m.get('reason','')}")
            matched.append((lead, result))
        else:
            print(f"[{i}/{len(leads)}] — {lead['company']}  ({result.get('rationale', '')[:80]})")

    print(f"\n=== {len(matched)}/{len(leads)} would get a name-drop ===\n")
    for lead, result in matched:
        names = [m["name"] for m in result["matches"]]
        print(f"  {lead['company']} ({lead['variant']}) → {', '.join(names)}")


if __name__ == "__main__":
    main()
