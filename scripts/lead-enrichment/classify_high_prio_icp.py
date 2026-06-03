#!/usr/bin/env python3
"""LLM-classify high-prio Adalo leads for CarterCo ICP fit.

Reads needs_llm_review_high_prio.csv (192 real+engaged rows where the regex
couldn't pin a vertical), asks Claude Haiku 4.5 whether each company is a
DK B2B SMB that fits CarterCo's `ad_funnel_leak` strategy, and splits into:

  high_prio_b2b_smb_fit.csv      - keep, import to public.leads
  high_prio_b2c_or_other.csv     - reject (Louis spot-checks)

Batched 10 companies per call. Cheap, ~20 calls total. Adds two columns:
  icp_llm_verdict   - 'fit' | 'reject' | 'unclear'
  icp_llm_reason    - one-line reason

Usage:
  set -a; source .env.local; set +a
  python3 scripts/lead-enrichment/classify_high_prio_icp.py
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

MODEL = "claude-haiku-4-5"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"

SYSTEM_PROMPT = """You are an ICP classifier for Carter & Co (carterco.dk).

Carter & Co builds AI/automation systems for DK SMB owner-operators whose lead funnels leak. ICP = DK service B2B with founders running ads or relying on inbound: cleaning, accounting, real estate, home services (trades), B2B services misc (logistics, recycling, wholesale, industri), office supply/fitout, signage/print, AV/event-technical, IT-services-for-SMB, security/alarm, facility/catering, landscaping.

EXCLUDE: B2C/D2C ecommerce, retail, fashion, food/beverage consumer brands, cosmetics, jewelry, restaurants/cafes, fitness/coaching, music/entertainment, travel-booking, marketing agencies, influencers, individuals, non-DK companies.

You classify based on company name + email domain + any vertical hints. Be strict — if it smells consumer/retail/agency, reject.

Return ONLY a JSON array. No prose, no code fences. For each input row:
  {"id": N, "verdict": "fit"|"reject"|"unclear", "vertical": "<best ICP vertical or 'unknown'>", "reason": "<<=15 words>"}

Rules:
- "fit" = clear DK B2B SMB service business in one of the listed verticals.
- "reject" = clear B2C/D2C/retail/agency/non-DK/individual.
- "unclear" = can't tell from name+domain alone (vague names like 'NOBLIS', 'IR', 'DJ').
- Use ONLY information given. Do NOT invent industry knowledge unless name strongly implies it (e.g. 'Tomrermester X' = home_services trades).
"""


def env(key: str) -> str:
    v = os.environ.get(key)
    if not v:
        sys.exit(f"required env var: {key}")
    return v


def call_anthropic(api_key: str, batch_prompt: str, max_retries: int = 3) -> list[dict]:
    body = json.dumps({
        "model": MODEL,
        "max_tokens": 2000,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": batch_prompt}],
    }).encode()
    req = urllib.request.Request(
        ANTHROPIC_URL,
        data=body,
        method="POST",
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    for attempt in range(max_retries):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                resp = json.loads(r.read())
            text = resp["content"][0]["text"].strip()
            # Strip code fences if model added them
            text = re.sub(r"^```(?:json)?\s*", "", text)
            text = re.sub(r"\s*```$", "", text)
            return json.loads(text)
        except urllib.error.HTTPError as e:
            if e.code in (429, 529, 500, 502, 503) and attempt < max_retries - 1:
                wait = 2 ** attempt
                print(f"  retry in {wait}s (HTTP {e.code})", file=sys.stderr)
                time.sleep(wait)
                continue
            sys.exit(f"  HTTP {e.code}: {e.read().decode()[:300]}")
        except json.JSONDecodeError as e:
            if attempt < max_retries - 1:
                print(f"  bad JSON, retrying: {e}", file=sys.stderr)
                continue
            print(f"  bad JSON after {max_retries}: {text[:200]}", file=sys.stderr)
            return []
    return []


def build_batch_prompt(batch: list[tuple[int, dict]]) -> str:
    lines = ["Classify these companies:"]
    for idx, row in batch:
        co = (row.get("mined_company") or "").strip()
        edomain = (row.get("email_domain") or "").strip()
        verticals = (row.get("verticals") or "").strip() or "(none detected)"
        reasons = (row.get("reasons") or "").strip()
        flags = []
        for f, sym in [("Onboarding", "Onboarding"), ("Converted", "Converted"),
                       ("Booked meeting", "Booked"), ("Contacted", "Contacted"),
                       ("Old lead", "OldLead")]:
            if (row.get(f) or "").strip().lower() == "true":
                flags.append(sym)
        lines.append(
            f"\n{idx}. company={co!r} | email_domain={edomain!r} | "
            f"verticals_detected={verticals} | "
            f"funnel_flags={','.join(flags) or 'none'}"
        )
    lines.append("\nReturn JSON array, one object per id.")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in",
                    default="clients/carterco/data/adalo_mined/needs_llm_review_high_prio.csv",
                    dest="in_path")
    ap.add_argument("--outdir", default="clients/carterco/data/adalo_mined")
    ap.add_argument("--batch-size", type=int, default=10)
    ap.add_argument("--limit", type=int, default=0,
                    help="only classify first N rows (0 = all)")
    args = ap.parse_args()

    api_key = env("ANTHROPIC_API_KEY")
    src = Path(args.in_path)
    if not src.exists():
        sys.exit(f"input not found: {src}")

    rows = list(csv.DictReader(open(src, encoding="utf-8")))
    if args.limit:
        rows = rows[:args.limit]
    print(f"  loaded {len(rows)} rows from {src.name}")
    print(f"  model: {MODEL}, batch_size={args.batch_size}")
    print()

    indexed = list(enumerate(rows))
    verdicts: dict[int, dict] = {}
    n_batches = (len(indexed) + args.batch_size - 1) // args.batch_size

    for bi in range(n_batches):
        batch = indexed[bi * args.batch_size:(bi + 1) * args.batch_size]
        prompt = build_batch_prompt(batch)
        result = call_anthropic(api_key, prompt)
        print(f"  batch {bi+1}/{n_batches}: got {len(result)} verdicts")
        for v in result:
            vid = v.get("id")
            if isinstance(vid, int) and 0 <= vid < len(rows):
                verdicts[vid] = v

    print()

    out_fit = []
    out_reject = []
    out_unclear = []
    for idx, row in indexed:
        v = verdicts.get(idx, {})
        verdict = (v.get("verdict") or "unclear").lower()
        row_out = {
            **row,
            "icp_llm_verdict": verdict,
            "icp_llm_vertical": v.get("vertical") or "",
            "icp_llm_reason": v.get("reason") or "(no verdict)",
        }
        if verdict == "fit":
            out_fit.append(row_out)
        elif verdict == "reject":
            out_reject.append(row_out)
        else:
            out_unclear.append(row_out)

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    fieldnames = (list(rows[0].keys())
                  + ["icp_llm_verdict", "icp_llm_vertical", "icp_llm_reason"])

    def write_csv(name: str, recs: list[dict]) -> None:
        path = outdir / name
        with path.open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=fieldnames)
            w.writeheader()
            w.writerows(recs)
        print(f"  wrote {len(recs):3d} → {path}")

    write_csv("high_prio_b2b_smb_fit.csv", out_fit)
    write_csv("high_prio_b2c_or_other.csv", out_reject)
    write_csv("high_prio_unclear.csv", out_unclear)
    print()

    # Top fits
    out_fit.sort(key=lambda r: int(r.get("total_score") or 0), reverse=True)
    print(f"=== TOP 30 FITS (of {len(out_fit)}) ===")
    for r in out_fit[:30]:
        co = (r.get("mined_company") or "")[:35]
        name = (r.get("First name") or "")[:22]
        phone = (r.get("Phone number") or "")[:15]
        vert = (r.get("icp_llm_vertical") or "")[:22]
        reason = (r.get("icp_llm_reason") or "")[:50]
        print(f"  {co:35s} | {name:23s} | {phone:16s} | {vert:24s} | {reason}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
