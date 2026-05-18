#!/usr/bin/env python3
"""Enrich the ad-spending brand list via SendPilot's lead-database API.

SendPilot's Lead Database is included in CarterCo's subscription and uses
LinkedIn-backed data. Same shape as Prospeo's search-person but:
  - No per-call credit cost (covered by plan)
  - No 100-credit hourly cap
  - LinkedIn URL is always populated (vs Prospeo's spotty coverage)

Endpoint flow (matches supabase/functions/_shared/sendpilot-client.ts):
  1. POST /v1/lead-database/searches → { id } (search queued)
  2. GET /v1/lead-database/searches/{id}/status → poll until 'completed'
  3. GET /v1/lead-database/searches/{id}/results → list of leads

Strategy: for each brand, search by company name + decision-maker job titles
+ Denmark location. Score results by DM title patterns. Best hit wins.

Usage:
  set -a; source .env.local; set +a
  python3 scripts/lead-enrichment/sendpilot_enrich_brands.py \\
    --brands clients/carterco/data/brands_with_domains_merged.csv \\
    --cleaned clients/carterco/data/brands_cleaned.csv \\
    --out clients/carterco/data/sendpilot_enriched.csv \\
    [--limit N] [--poll-interval 5] [--poll-timeout 120]
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

KEY = os.environ.get("SENDPILOT_API_KEY") or sys.exit("SENDPILOT_API_KEY required")
BASE = "https://api.sendpilot.ai/v1/lead-database/searches"

# Same patterns as prospeo_enrich_brands.py — keep them in sync.
DECISION_MAKER_PATTERNS = [
    re.compile(r"\b(co-?founder|stifter|grundlægger|gründer)\b", re.I),
    re.compile(r"\b(founder|owner|ejer|indehaver)\b", re.I),
    re.compile(r"\b(ceo|adm\.?\s*direktør|administrerende\s*direktør|managing director|md|daglig leder|eierleder)\b", re.I),
    re.compile(r"\b(partner|chairman|formand|president|eier)\b", re.I),
    re.compile(r"\b(director|direktør|vp|vice president|leder)\b", re.I),
    re.compile(r"\b(head of (sales|growth|commercial|marketing|business))\b", re.I),
    re.compile(r"\b(salgschef|salgsdirektør|kommerciel chef)\b", re.I),
]

# Job-title filter sent to SendPilot. Narrowing here cuts noise vs filtering
# client-side after-the-fact.
DM_JOB_TITLES = [
    "Founder", "Co-Founder", "Owner", "CEO", "Stifter", "Grundlægger",
    "Managing Director", "Adm. Direktør", "Administrerende Direktør",
    "Daglig Leder", "Partner", "Director", "Direktør",
    "Head of Sales", "Head of Growth", "Head of Commercial",
    "Salgschef", "Salgsdirektør", "Indehaver", "Ejer",
]


def fire_search(company: str, country: str) -> tuple[str | None, str]:
    """POST a new search. Returns (search_id, error_msg)."""
    location = "Denmark" if country == "DK" else country or "Denmark"
    body = json.dumps({
        "name": f"carterco-mine-{int(time.time())}",
        "limit": 5,
        "filters": {
            "companies": [company],
            "jobTitles": DM_JOB_TITLES,
            "locations": [location],
        },
    }).encode()
    req = urllib.request.Request(
        BASE, data=body, method="POST",
        headers={"X-API-Key": KEY, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as f:
            data = json.loads(f.read())
        return (data.get("id"), "")
    except urllib.error.HTTPError as e:
        return (None, f"HTTP {e.code}: {e.read().decode()[:200]}")
    except Exception as e:
        return (None, f"err: {str(e)[:120]}")


def poll_status(search_id: str, interval: float, timeout: float) -> str:
    """Poll /status until completed/failed/timeout. Returns final status."""
    url = f"{BASE}/{search_id}/status"
    req = urllib.request.Request(url, headers={"X-API-Key": KEY})
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(req, timeout=15) as f:
                data = json.loads(f.read())
            status = (data.get("status") or "").lower()
            if status in ("completed", "failed", "error"):
                return status
        except urllib.error.HTTPError as e:
            return f"poll_http_{e.code}"
        except Exception:
            pass
        time.sleep(interval)
    return "timeout"


def fetch_results(search_id: str) -> list[dict]:
    url = f"{BASE}/{search_id}/results"
    req = urllib.request.Request(url, headers={"X-API-Key": KEY})
    try:
        with urllib.request.urlopen(req, timeout=30) as f:
            data = json.loads(f.read())
        # Shape varies by SendPilot version: top-level array OR { leads: [...] }
        if isinstance(data, list):
            return data
        return data.get("leads") or data.get("results") or []
    except Exception:
        return []


def score_person(p: dict) -> tuple[int, str]:
    """(rank, matched_label). Lower rank = better."""
    title = p.get("job_title") or p.get("jobTitle") or p.get("title") or ""
    for i, pat in enumerate(DECISION_MAKER_PATTERNS):
        m = pat.search(title)
        if m:
            return (i, m.group(1) or m.group(0))
    return (99, "")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--brands", required=True, help="brands_with_domains_merged.csv")
    ap.add_argument("--cleaned", required=True, help="brands_cleaned.csv (for brand_clean)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--poll-interval", type=float, default=5.0)
    ap.add_argument("--poll-timeout", type=float, default=120.0)
    args = ap.parse_args()

    brands = list(csv.DictReader(open(args.brands, encoding="utf-8")))
    cleaned = {r["brand"]: r for r in csv.DictReader(open(args.cleaned, encoding="utf-8"))}
    if args.limit:
        brands = brands[: args.limit]
    print(f"loaded {len(brands)} brands from {args.brands}")
    print(f"loaded {len(cleaned)} clean-name lookups")
    print()

    out_rows: list[dict] = []
    found = no_dm = empty = errs = 0

    for i, b in enumerate(brands, 1):
        raw = b["brand"]
        country = b.get("country", "DK")
        clean = (cleaned.get(raw) or {}).get("brand_clean") or raw
        company = clean.strip()

        sid, err = fire_search(company, country)
        if not sid:
            errs += 1
            print(f"  [{i}/{len(brands)}] ! {raw:30s} | search fire failed: {err[:60]}")
            out_rows.append(_empty(raw, b, company, f"fire_failed:{err[:40]}"))
            continue

        status = poll_status(sid, args.poll_interval, args.poll_timeout)
        if status != "completed":
            errs += 1
            print(f"  [{i}/{len(brands)}] ! {raw:30s} | poll {status} (sid={sid[:8]})")
            out_rows.append(_empty(raw, b, company, f"poll_{status}"))
            continue

        leads = fetch_results(sid)
        if not leads:
            empty += 1
            print(f"  [{i}/{len(brands)}] ⊘ {raw:30s} | empty results for '{company}'")
            out_rows.append(_empty(raw, b, company, "empty_results"))
            continue

        scored = sorted([(score_person(p), p) for p in leads], key=lambda x: x[0][0])
        best_rank, best_label = scored[0][0]
        best = scored[0][1]
        title = best.get("job_title") or best.get("jobTitle") or best.get("title") or ""
        name = (best.get("full_name") or
                f"{best.get('first_name','')} {best.get('last_name','')}".strip())
        li = best.get("linkedin_url") or best.get("linkedinUrl") or ""

        if best_rank < 99:
            found += 1
            conf = "high" if best_rank <= 2 else "medium" if best_rank <= 4 else "low"
            print(f"  [{i}/{len(brands)}] ✓ {raw:30s} | {len(leads)} hits | {conf:6s} | {name} → {title[:50]}")
            out_rows.append({
                "brand": raw, "brand_clean": company,
                "vertical": b.get("vertical", ""), "country": country,
                "domain": b.get("domain", ""),
                "first_name": best.get("first_name", ""),
                "last_name": best.get("last_name", ""),
                "title": title, "linkedin_url": li,
                "matched_role_pattern": best_label,
                "confidence": conf,
                "company_match": best.get("company", ""),
                "total_in_company": len(leads),
                "status": "found",
            })
        else:
            no_dm += 1
            print(f"  [{i}/{len(brands)}] ~ {raw:30s} | {len(leads)} hits | no_dm | top: {name} → {title[:40]}")
            out_rows.append({
                "brand": raw, "brand_clean": company,
                "vertical": b.get("vertical", ""), "country": country,
                "domain": b.get("domain", ""),
                "first_name": best.get("first_name", ""),
                "last_name": best.get("last_name", ""),
                "title": title, "linkedin_url": li,
                "matched_role_pattern": "", "confidence": "low",
                "company_match": best.get("company", ""),
                "total_in_company": len(leads),
                "status": "no_decision_maker",
            })

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    fields = ["brand", "brand_clean", "vertical", "country", "domain",
              "first_name", "last_name", "title", "linkedin_url",
              "matched_role_pattern", "confidence", "status",
              "company_match", "total_in_company"]
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(out_rows)
    print()
    print(f"=== SUMMARY ===")
    print(f"  brands processed:     {len(brands)}")
    print(f"  decision-maker found: {found}")
    print(f"  no DM, person found:  {no_dm}")
    print(f"  empty results:        {empty}")
    print(f"  errors:               {errs}")
    print(f"  output:               {out}")
    return 0


def _empty(raw: str, b: dict, company: str, status: str) -> dict:
    return {
        "brand": raw, "brand_clean": company,
        "vertical": b.get("vertical", ""), "country": b.get("country", ""),
        "domain": b.get("domain", ""),
        "first_name": "", "last_name": "", "title": "", "linkedin_url": "",
        "matched_role_pattern": "", "confidence": "",
        "company_match": "", "total_in_company": 0,
        "status": status,
    }


if __name__ == "__main__":
    sys.exit(main())
