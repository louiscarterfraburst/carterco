#!/usr/bin/env python3
"""Stage 1 of Apify enrichment: discover LinkedIn company URLs for each brand.

Apify's `harvestapi/linkedin-company-employees` actor takes a list of LinkedIn
company URLs, not domain names. This script bridges the gap: for each brand
with a known domain, search Jina for `<brand> linkedin denmark` and extract
the linkedin.com/company URL from results.

Note: discover_brand_domains.py EXCLUDES linkedin.com as a directory host so
its domain-search doesn't return social URLs. Here we WANT linkedin.com/company
URLs specifically, so we flip the filter.

Usage:
  set -a; source .env.local; set +a
  python3 scripts/lead-enrichment/find_linkedin_companies.py \\
    --in clients/carterco/data/brands_with_domains_merged.csv \\
    --cleaned clients/carterco/data/brands_cleaned.csv \\
    --out clients/carterco/data/brands_with_linkedin.csv \\
    [--limit N] [--throttle 1.0]
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

KEY = os.environ.get("JINA_API_KEY") or sys.exit("JINA_API_KEY required")
HEADERS = {
    "Authorization": f"Bearer {KEY}",
    "Accept": "application/json",
    "X-Respond-With": "no-content",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
}

LINKEDIN_COMPANY_RE = re.compile(r"linkedin\.com/(company|school)/([a-z0-9\-_]+)/?", re.I)


def jina_search(query: str) -> list[dict]:
    url = f"https://s.jina.ai/?q={urllib.parse.quote(query)}"
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=45) as f:
            data = json.loads(f.read())
        return data.get("data", []) if data.get("code") == 200 else []
    except urllib.error.HTTPError as e:
        # 422 = "no results available" — Jina returns this instead of 200+empty
        if e.code == 422:
            return []
        raise


def extract_linkedin_company(results: list[dict], brand_slug: str) -> tuple[str, str]:
    """Walk results, return (linkedin_url, source_url) of best match.
    Prefer hits whose company slug shares characters with our brand slug."""
    candidates: list[tuple[int, str, str]] = []  # (score, linkedin_url, source_url)
    for r in results:
        url = r.get("url", "")
        m = LINKEDIN_COMPANY_RE.search(url)
        if not m:
            continue
        kind, slug = m.group(1).lower(), m.group(2).lower()
        # skool=university — usually wrong unless brand IS a school
        if kind == "school" and "academy" not in brand_slug and "school" not in brand_slug:
            continue
        # Score: exact slug match = 100, slug contains brand = 80, brand contains slug = 60
        slug_clean = re.sub(r"[^a-z0-9]", "", slug)
        score = 0
        if slug_clean == brand_slug:
            score = 100
        elif brand_slug and brand_slug in slug_clean:
            score = 80
        elif slug_clean and slug_clean in brand_slug:
            score = 60
        else:
            # last-resort: any 4-char overlap
            for i in range(len(brand_slug) - 3):
                if brand_slug[i:i+4] in slug_clean:
                    score = 30
                    break
        canonical = f"https://www.linkedin.com/company/{slug}"
        candidates.append((score, canonical, url))
    if not candidates:
        return ("", "")
    candidates.sort(key=lambda x: -x[0])
    score, linkedin_url, source_url = candidates[0]
    if score < 30:
        return ("", source_url)
    return (linkedin_url, source_url)


def brand_to_slug(brand: str, clean: str) -> str:
    """Normalize brand name to lowercase alnum for slug matching."""
    s = (clean or brand).lower()
    s = re.sub(r"^.+?\s+fra\s+", "", s)
    s = re.sub(r"\s*(aps|a\/s|ivs|gmbh)\s*$", "", s, flags=re.I)
    return re.sub(r"[^a-z0-9æøå]", "", s)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="inp", required=True, help="brands_with_domains_merged.csv")
    ap.add_argument("--cleaned", required=True, help="brands_cleaned.csv (for brand_clean)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--throttle", type=float, default=1.0)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    brands = list(csv.DictReader(open(args.inp, encoding="utf-8")))
    cleaned = {r["brand"]: r for r in csv.DictReader(open(args.cleaned, encoding="utf-8"))}
    if args.limit:
        brands = brands[: args.limit]
    print(f"loaded {len(brands)} brands\n")

    found = empty = errs = 0
    out_rows: list[dict] = []
    for i, b in enumerate(brands, 1):
        raw = b["brand"]
        clean = (cleaned.get(raw) or {}).get("brand_clean") or raw
        slug = brand_to_slug(raw, clean)
        # Query 1: strict — quoted brand + site:linkedin.com/company
        # Query 2 (fallback): loose — brand + linkedin denmark (no site: filter)
        # The strict one wins when brand has a LinkedIn presence directly indexed.
        # The loose one wins when Jina's site: filter rejects but the URL is in
        # general results.
        queries = [
            f'"{clean}" denmark site:linkedin.com/company',
            f'{clean} linkedin denmark',
        ]
        results: list[dict] = []
        last_err = ""
        for q in queries:
            try:
                results = jina_search(q)
                if results:
                    break
            except Exception as e:
                last_err = str(e)[:50]
        if last_err and not results:
            errs += 1
            print(f"  [{i}/{len(brands)}] ! {raw:30s} | jina err: {last_err}")
            out_rows.append({**b, "brand_clean": clean, "linkedin_url": "", "linkedin_source": "", "lookup_status": f"err:{last_err[:30]}"})
            continue
        li_url, source = extract_linkedin_company(results, slug)
        if li_url:
            found += 1
            print(f"  [{i}/{len(brands)}] ✓ {raw:30s} → {li_url}")
            out_rows.append({**b, "brand_clean": clean, "linkedin_url": li_url, "linkedin_source": source, "lookup_status": "found"})
        else:
            empty += 1
            print(f"  [{i}/{len(brands)}] ⊘ {raw:30s} | no linkedin/company hit")
            out_rows.append({**b, "brand_clean": clean, "linkedin_url": "", "linkedin_source": source, "lookup_status": "no_match"})
        time.sleep(args.throttle)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    base_fields = list(brands[0].keys())
    extra = ["brand_clean", "linkedin_url", "linkedin_source", "lookup_status"]
    fields = base_fields + [f for f in extra if f not in base_fields]
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(out_rows)
    print()
    print("=== SUMMARY ===")
    print(f"  brands processed:    {len(brands)}")
    print(f"  linkedin URL found:  {found}")
    print(f"  no match:            {empty}")
    print(f"  errors:              {errs}")
    print(f"  output:              {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
