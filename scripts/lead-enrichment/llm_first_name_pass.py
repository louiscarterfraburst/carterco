#!/usr/bin/env python3
"""LLM second pass on the OdaGroup cleaned CSV.

Reads `clients/odagroup/data/leads_clean.csv`, finds rows where
`first_name_issue` is `multi_word`, and asks Claude Haiku to decide whether
the multi-word string is one given name people go by ("Anne Marie",
"Maria Jose") or a merged firstName+middleName that should be split.

Updates `first_name` in place; sets `first_name_issue` to '' if the LLM
resolved it. Resumable via a JSONL progress log so re-runs skip already-
processed rows.

Why we need this even after the deterministic pass:
  - Compound first names (Anne Marie, Jean Luc, Maria Jose) shouldn't be
    split — current code returns just "Anne".
  - Some "Dr." victims slipped through the regex (e.g. "Prof. Dr. med." or
    foreign-language honorifics).
  - This is a small batch (~80 rows), 1.3s rate limit per row → ~2 min total,
    cents in API cost.

Usage:
  ANTHROPIC_API_KEY=... python3 scripts/lead-enrichment/llm_first_name_pass.py \\
    --csv clients/odagroup/data/leads_clean.csv \\
    --progress clients/odagroup/data/llm_pass_progress.jsonl
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
from pathlib import Path

API_KEY = os.environ.get("ANTHROPIC_API_KEY") or sys.exit("ANTHROPIC_API_KEY not set")
MODEL = "claude-haiku-4-5"

PROMPT = """Normalize a name for cold outreach. The greeting template is "Hi {first_name}," — so first_name should be ONE given name the person would actually be addressed by.

Rules:
- Compound first names people go by ("Anne Marie", "Marie Louise", "Jean Luc", "Maria Jose", "Yang Hee") → KEEP the compound as first_name.
- Merged firstName + middleName ("Thomas Sehested Skovshoved") → KEEP just the first given name; the rest belongs in last_name.
- Title prefix that snuck through ("Dr. med. Suren", "Prof. Hans") → STRIP the title; first_name is the real given name.
- Middle initial ("Charlotte I.") → KEEP first_name as-is.
- Hyphenated single name ("Mary-Anne") → KEEP as-is, single token.
- Ambiguous South/East Asian compound names → if unsure, KEEP the compound.

Output ONLY a JSON object, no preamble:
{"first_name": "...", "last_name": "...", "note": "<≤8 words why>"}

Input:
  first_name (raw): %s
  last_name  (raw): %s
  title (context):  %s
"""


def call_anthropic(first: str, last: str, title: str, retries: int = 5) -> dict | None:
    body = json.dumps({
        "model": MODEL,
        "max_tokens": 200,
        "messages": [{"role": "user", "content": PROMPT % (first, last, title)}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        method="POST",
        headers={
            "x-api-key": API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=30) as f:
                data = json.loads(f.read())
            txt = data.get("content", [{}])[0].get("text", "").strip()
            # Find first {...} block
            start = txt.find("{")
            end = txt.rfind("}")
            if start == -1 or end == -1:
                return None
            return json.loads(txt[start:end + 1])
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            return None
        except Exception:
            return None
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", required=True, help="cleaned CSV (modified in place)")
    ap.add_argument("--progress", required=True, help="JSONL progress log (resumable)")
    ap.add_argument("--rate", type=float, default=1.3,
                    help="seconds between API calls (Haiku 50 RPM = 1.2s safe)")
    ap.add_argument("--limit", type=int, default=0,
                    help="only process first N multi-word rows (0 = all)")
    args = ap.parse_args()

    csv_path = Path(args.csv)
    if not csv_path.exists():
        sys.exit(f"CSV not found: {csv_path}")

    rows = list(csv.DictReader(open(csv_path, encoding="utf-8")))
    print(f"loaded {len(rows)} rows")

    targets = [r for r in rows if r.get("first_name_issue") == "multi_word"]
    print(f"multi_word rows to process: {len(targets)}")
    if args.limit and len(targets) > args.limit:
        targets = targets[: args.limit]
        print(f"  (limit applied: {len(targets)})")

    progress_path = Path(args.progress)
    progress_path.parent.mkdir(parents=True, exist_ok=True)
    seen: dict[str, dict] = {}
    if progress_path.exists():
        for line in open(progress_path):
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
                seen[rec["linkedin_url"]] = rec
            except Exception:
                pass
    print(f"resuming: {len(seen)} already processed")

    todo = [r for r in targets if r["linkedin_url"] not in seen]
    print(f"to do: {len(todo)} fresh API calls")
    print()

    if not todo and not seen:
        print("nothing to do — all multi_word rows already processed or none found")
        return 0

    pf = open(progress_path, "a")
    for i, r in enumerate(todo, 1):
        result = call_anthropic(r["first_name_original"], r["last_name"], r["title"])
        if not result or "first_name" not in result:
            print(f"  [{i}/{len(todo)}] FAIL  {r['first_name_original']!r} → no usable response")
            time.sleep(args.rate)
            continue
        new_first = (result.get("first_name") or "").strip()
        new_last = (result.get("last_name") or "").strip() or r["last_name"]
        note = result.get("note", "")
        rec = {
            "linkedin_url": r["linkedin_url"],
            "old_first": r["first_name"],
            "new_first": new_first,
            "old_last": r["last_name"],
            "new_last": new_last,
            "note": note,
        }
        pf.write(json.dumps(rec, ensure_ascii=False) + "\n")
        pf.flush()
        seen[r["linkedin_url"]] = rec
        marker = "✓" if new_first != r["first_name"] else " "
        print(f"  [{i}/{len(todo)}] {marker} {r['first_name_original']!r:30s} → {new_first!r:20s}  ({note})")
        time.sleep(args.rate)
    pf.close()

    # Apply progress to rows in memory.
    changed = 0
    for r in rows:
        rec = seen.get(r["linkedin_url"])
        if not rec:
            continue
        if rec["new_first"] and rec["new_first"] != r["first_name"]:
            r["first_name"] = rec["new_first"]
            r["first_name_issue"] = ""  # resolved
            changed += 1
        if rec["new_last"] and rec["new_last"] != r["last_name"]:
            r["last_name"] = rec["new_last"]

    print()
    print(f"=== APPLIED ===")
    print(f"  rows changed: {changed}")

    # Rewrite CSV with same column order.
    if changed:
        with open(csv_path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=rows[0].keys())
            w.writeheader()
            w.writerows(rows)
        print(f"  rewrote {csv_path}")
    else:
        print(f"  no changes to write")

    return 0


if __name__ == "__main__":
    sys.exit(main())
