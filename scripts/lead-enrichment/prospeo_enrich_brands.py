#!/usr/bin/env python3
"""Enrich the ad-spending brand list via Prospeo's search-person API.

Strategy: for each brand we have a Meta-ad screenshot of, look up the company
in Prospeo's B2B database by domain. Pull people, filter to decision-maker
titles (founder, owner, CEO, director, head of), output a clean CSV that's
ready to push into the lead_inbox table.

Prospeo's `search-person` endpoint:
  - 1 credit per request that returns at least one result
  - NO_RESULTS doesn't burn a credit
  - Identical request within 30d is cached (free)
  - Returns up to 25 results per page

Domain resolution:
  - First, use cta_url from the IG ad if present
  - Else, normalize brand name → guess <brand>.dk (or .com for non-DK)
  - Misses can be retried with hand-entered domains by editing the input CSV

Throttle: 3s sleep between requests (free tier rate-limits ~hard at 1 req/2s).

Usage:
  set -a; source .env.local; set +a
  python3 scripts/lead-enrichment/prospeo_enrich_brands.py \\
    --in clients/carterco/data/brands_to_mine_clean.csv \\
    --out clients/carterco/data/prospeo_enriched.csv \\
    [--dry-run] [--limit N] [--throttle 3]
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
import urllib.parse
import urllib.request
from pathlib import Path

KEY = os.environ.get("PROSPEO_API_KEY") or sys.exit("PROSPEO_API_KEY required")

# Decision-maker title patterns (case-insensitive, applied to headline/title).
# Priority order: closer to the top = higher confidence.
DECISION_MAKER_PATTERNS = [
    re.compile(r"\b(co-?founder|stifter|grundlægger|gründer)\b", re.I),
    re.compile(r"\b(founder|owner|ejer|indehaver)\b", re.I),
    re.compile(r"\b(ceo|adm\.?\s*direktør|administrerende\s*direktør|managing director|md|administrator)\b", re.I),
    re.compile(r"\b(partner|chairman|formand|president)\b", re.I),
    re.compile(r"\b(director|direktør|vp|vice president)\b", re.I),
    re.compile(r"\b(head of (sales|growth|commercial|marketing|business))\b", re.I),
    re.compile(r"\b(salgschef|salgsdirektør|kommerciel chef)\b", re.I),
]


def resolve_domain(row: dict) -> str:
    """Prefer the discovered `domain` column (from discover_brand_domains.py).
    Fall back to CTA URL, then brand-name guess as last resort."""
    if (row.get("domain") or "").strip():
        return row["domain"].strip().lower()
    return guess_domain(row["brand"], row.get("cta_url", ""), row.get("country", ""))


def guess_domain(brand: str, cta_url: str, country: str) -> str:
    """Last-resort: CTA URL hostname if present, else brand-name slug + TLD."""
    if cta_url:
        try:
            host = urllib.parse.urlparse(
                cta_url if cta_url.startswith("http") else f"https://{cta_url}"
            ).netloc.lower()
            host = host.replace("www.", "")
            # Strip campaign tracker subdomains
            if host and not any(b in host for b in ("facebook.com", "instagram.com", "bit.ly", "lnk.")):
                return host
        except Exception:
            pass
    # Normalize brand: lowercase, strip non-alnum, drop common stop-words
    s = brand.lower().strip()
    # Pull a clean root if "Founder fra Brand" / "Brand ApS" patterns
    s = re.sub(r"\s+fra\s+", " ", s)
    s = re.sub(r"\s+aps$|\s+a\/s$|\s+ivs$|\s+gmbh$", "", s)
    s = re.sub(r"\s*-\s*samic", "samic", s)  # special case from IG handle
    # Take first 'word' for handles like "lukas fra aluva (aluvadk)" → "lukas"
    # ... but that's wrong. Better: extract anything in parens as the handle if present
    paren = re.search(r"\(([a-z0-9_]+)\)", brand)
    if paren:
        s = paren.group(1).replace("_", "")
    else:
        s = re.sub(r"[^a-z0-9æøå]+", "", s)
    tld = "com" if country in ("US", "GB", "GLOBAL", "") else "dk"
    return f"{s}.{tld}"


def search_prospeo(domain: str) -> tuple[dict, int]:
    body = json.dumps({
        "page": 1,
        "filters": {"company": {"websites": {"include": [domain]}}}
    }).encode()
    req = urllib.request.Request(
        "https://api.prospeo.io/search-person",
        data=body, method="POST",
        headers={"X-KEY": KEY, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as f:
            return json.loads(f.read()), 200
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read()), e.code
        except Exception:
            return {"error": True, "error_code": f"HTTP_{e.code}"}, e.code
    except Exception as e:
        return {"error": True, "error_code": str(e)[:60]}, 0


def score_person(p: dict) -> tuple[int, str]:
    """Returns (priority_rank, matched_label). Lower rank = better."""
    headline = (p.get("headline") or p.get("title") or "")
    for i, pat in enumerate(DECISION_MAKER_PATTERNS):
        m = pat.search(headline)
        if m:
            return (i, m.group(1) or m.group(0))
    return (99, "")


def get_credits() -> int:
    req = urllib.request.Request(
        "https://api.prospeo.io/account-information",
        headers={"X-KEY": KEY, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as f:
        return json.loads(f.read())["response"]["remaining_credits"]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="inp", required=True, help="brands_to_mine_clean.csv path")
    ap.add_argument("--out", dest="out", required=True, help="output enriched CSV path")
    ap.add_argument("--throttle", type=float, default=3.0, help="seconds between requests")
    ap.add_argument("--limit", type=int, default=0, help="cap brands processed (0 = all)")
    ap.add_argument("--dry-run", action="store_true", help="print plan, no API calls")
    args = ap.parse_args()

    brands = list(csv.DictReader(open(args.inp, encoding="utf-8")))
    if args.limit:
        brands = brands[: args.limit]
    print(f"loaded {len(brands)} brands from {args.inp}")
    if not args.dry_run:
        start_credits = get_credits()
        print(f"credits before run: {start_credits} / 100")
    print()

    out_rows: list[dict] = []
    found_count = 0
    no_result_count = 0
    error_count = 0

    for i, b in enumerate(brands, 1):
        brand = b["brand"]
        country = b.get("country", "DK")
        domain = resolve_domain(b)
        if not domain:
            print(f"  [{i}/{len(brands)}] ⊘ {brand:30s} | no domain — skip (run discover_brand_domains.py first)")
            out_rows.append({
                "brand": brand, "vertical": b.get("vertical", ""),
                "country": country, "domain": "",
                "first_name": "", "last_name": "", "title": "", "linkedin_url": "",
                "email": "", "matched_role_pattern": "", "confidence": "",
                "company_id": "", "total_in_company": 0, "status": "no_domain",
            })
            continue

        if args.dry_run:
            print(f"  [{i}/{len(brands)}] {brand:35s} → would query {domain}")
            continue

        r, code = search_prospeo(domain)
        if code == 200 and not r.get("error"):
            results = r.get("results", [])
            total = r.get("pagination", {}).get("total_count", 0)
            # Score every result, take the best decision-maker
            scored = sorted([(score_person(h["person"]), h) for h in results], key=lambda x: x[0][0])
            best_rank, best_label = scored[0][0] if scored else (99, "")
            best_hit = scored[0][1] if scored else None
            cached = "(cached)" if r.get("free") else "(1 cr)"
            if best_hit and best_rank < 99:
                p = best_hit["person"]
                name = f"{p.get('first_name','')} {p.get('last_name','')}".strip()
                title = p.get("headline") or p.get("title") or ""
                li = p.get("linkedin_url") or ""
                email = p.get("email") or ""
                marker = "✓"
                found_count += 1
                conf = "high" if best_rank <= 2 else "medium" if best_rank <= 4 else "low"
                print(f"  [{i}/{len(brands)}] {marker} {brand:30s} | {total} hits {cached} | {conf:6s} | {name} → {title[:50]}")
                out_rows.append({
                    "brand": brand, "vertical": b.get("vertical", ""),
                    "country": country, "domain": domain,
                    "first_name": p.get("first_name", ""), "last_name": p.get("last_name", ""),
                    "title": title, "linkedin_url": li, "email": email,
                    "matched_role_pattern": best_label, "confidence": conf,
                    "company_id": (best_hit.get("company") or {}).get("name", ""),
                    "total_in_company": total, "status": "found",
                })
            elif total > 0:
                # Has people but none matched decision-maker patterns
                p = results[0]["person"]
                name = f"{p.get('first_name','')} {p.get('last_name','')}".strip()
                title = p.get("headline") or ""
                print(f"  [{i}/{len(brands)}] ~ {brand:30s} | {total} hits {cached} | no_dm  | top: {name} → {title[:40]}")
                out_rows.append({
                    "brand": brand, "vertical": b.get("vertical", ""),
                    "country": country, "domain": domain,
                    "first_name": p.get("first_name", ""), "last_name": p.get("last_name", ""),
                    "title": title, "linkedin_url": p.get("linkedin_url", ""),
                    "email": p.get("email", ""),
                    "matched_role_pattern": "", "confidence": "low",
                    "company_id": (results[0].get("company") or {}).get("name", ""),
                    "total_in_company": total, "status": "no_decision_maker",
                })
        else:
            ec = r.get("error_code", code)
            if ec == "NO_RESULTS":
                no_result_count += 1
                print(f"  [{i}/{len(brands)}] ✗ {brand:30s} | not in DB ({domain})")
                out_rows.append({
                    "brand": brand, "vertical": b.get("vertical", ""),
                    "country": country, "domain": domain,
                    "first_name": "", "last_name": "", "title": "", "linkedin_url": "",
                    "email": "", "matched_role_pattern": "", "confidence": "",
                    "company_id": "", "total_in_company": 0, "status": "not_in_db",
                })
            else:
                error_count += 1
                print(f"  [{i}/{len(brands)}] ! {brand:30s} | ERROR: {ec}")
                out_rows.append({
                    "brand": brand, "vertical": b.get("vertical", ""),
                    "country": country, "domain": domain,
                    "first_name": "", "last_name": "", "title": "", "linkedin_url": "",
                    "email": "", "matched_role_pattern": "", "confidence": "",
                    "company_id": "", "total_in_company": 0, "status": f"error:{ec}",
                })
        time.sleep(args.throttle)

    if args.dry_run:
        return 0

    # Write CSV
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    fields = ["brand", "vertical", "country", "domain", "first_name", "last_name",
              "title", "linkedin_url", "email", "matched_role_pattern",
              "confidence", "status", "company_id", "total_in_company"]
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(out_rows)
    end_credits = get_credits()
    print()
    print(f"=== SUMMARY ===")
    print(f"  total brands:       {len(brands)}")
    print(f"  decision-maker found: {found_count}")
    print(f"  no DM, person found:  {sum(1 for r in out_rows if r['status']=='no_decision_maker')}")
    print(f"  not in DB:            {no_result_count}")
    print(f"  errors:               {error_count}")
    print(f"  credits used:         {start_credits - end_credits} ({end_credits} / 100 remaining)")
    print(f"  output:               {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
