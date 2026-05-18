#!/usr/bin/env python3
"""LLM-clean the IG-ad brand names so domain discovery has a fighting chance.

IG handles are noisy (`creaocreao`, `revimark_aps`, `vincentgraphicdk`) and
Jina Search returns garbage for them. Claude Haiku takes the raw handle +
the ad's vertical + offer as context and returns the actual company name.

Cost: 42 calls × ~150 tokens each = ~$0.01 total.

Usage:
  ANTHROPIC_API_KEY=... python3 scripts/lead-enrichment/clean_brand_names.py \\
    --in clients/carterco/data/brands_to_mine_clean.csv \\
    --out clients/carterco/data/brands_cleaned.csv
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.request

API_KEY = os.environ.get("ANTHROPIC_API_KEY") or sys.exit("ANTHROPIC_API_KEY required")
MODEL = "claude-haiku-4-5"

PROMPT = """Clean an Instagram handle / scraped brand string into the actual company name people would use to find them.

Context: this brand was extracted from an Instagram ad screenshot. The handle is often garbled, lowercase, may have suffix like "_aps", "_as", "dk", or include the founder's name.

Examples:
  Input:  "creaocreao" | vertical=b2b_accounting | offer=CFO services
  Output: {"clean": "Creao", "confidence": "high"}

  Input:  "Jesper fra Samic" | vertical=b2b_services_misc | offer=outsource production to China
  Output: {"clean": "Samic", "confidence": "high"}

  Input:  "revimark_aps" | vertical=b2b_accounting | offer=proper revisor follow up
  Output: {"clean": "Revimark", "confidence": "high"}

  Input:  "vincentgraphicdk" | vertical=b2b_services_misc | offer=car wrapping and signage
  Output: {"clean": "Vincent Graphic", "confidence": "high"}

  Input:  "mick_c_fynbo" | vertical=b2b_services_misc | offer=konsulent og multiservice
  Output: {"clean": "Mick C. Fynbo", "confidence": "medium"}

Rules:
- Use proper Danish capitalization and spacing
- Drop "_aps", "_as", "dk" suffixes that are clearly noise (NOT actual brand parts)
- For "X fra Y" or "X - Y" patterns, the company is Y (X is the founder's name)
- If the raw handle is already a clean company name, return it unchanged with confidence "high"
- If genuinely ambiguous, mark confidence "low" and pick best guess

Now clean this:
  Input:  "%s" | vertical=%s | offer=%s
Output JSON only, no preamble:
"""


def clean(brand: str, vertical: str, offer: str) -> dict | None:
    body = json.dumps({
        "model": MODEL,
        "max_tokens": 100,
        "messages": [{"role": "user", "content": PROMPT % (brand, vertical, offer)}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body, method="POST",
        headers={"x-api-key": API_KEY, "anthropic-version": "2023-06-01",
                 "content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as f:
            data = json.loads(f.read())
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code}: {e.read().decode()[:200]}", file=sys.stderr)
        return None
    txt = data.get("content", [{}])[0].get("text", "").strip()
    start = txt.find("{")
    end = txt.rfind("}")
    if start == -1 or end == -1:
        return None
    try:
        return json.loads(txt[start:end + 1])
    except Exception:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", dest="out", required=True)
    ap.add_argument("--throttle", type=float, default=1.3)
    args = ap.parse_args()

    rows = list(csv.DictReader(open(args.inp, encoding="utf-8")))
    print(f"loaded {len(rows)} brands")

    for i, r in enumerate(rows, 1):
        original = r["brand"]
        result = clean(original, r.get("vertical", ""), r.get("offer", ""))
        if not result:
            print(f"  [{i}/{len(rows)}] ! {original:35s} → FAIL")
            r["brand_clean"] = original
            r["brand_clean_confidence"] = "fail"
            continue
        cleaned = result.get("clean", original).strip()
        conf = result.get("confidence", "?")
        marker = "✓" if cleaned != original else " "
        print(f"  [{i}/{len(rows)}] {marker} {original:35s} → {cleaned:35s} ({conf})")
        r["brand_clean"] = cleaned
        r["brand_clean_confidence"] = conf
        time.sleep(args.throttle)

    fields = list(rows[0].keys())
    with open(args.out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    print(f"\nwrote {len(rows)} rows → {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
