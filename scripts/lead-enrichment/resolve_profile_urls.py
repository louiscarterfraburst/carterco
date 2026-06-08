#!/usr/bin/env python3
"""Stage 2.5 of the hiring-signal pipeline: resolve encoded LinkedIn URLs to
working VANITY URLs (+ clean names).

  apify_hiring_intake.py → apify_enrich_brands.py → THIS → hiring_to_outreach_leads.py

WHY THIS EXISTS (learned the hard way 2026-06-08):
The company-employees actor (stage 2) returns LinkedIn's *encoded* member URLs —
`linkedin.com/in/ACwAAABMklYB...`. Those are internal IDs: they only resolve in a
logged-in session and DO NOT open in a normal browser. Shipping them into SendPilot
means dead links and accepts that can't be matched back. This stage runs the
`harvestapi/linkedin-profile-scraper` actor on each profile, which returns the real
`publicIdentifier` → a `linkedin.com/in/<slug>` vanity URL that actually works, plus
the canonical first/last name.

JOIN: the scraper returns profiles in a DIFFERENT order than the input and the
encoded IDs don't round-trip (input ACwAAA → output ACoAAA — different encodings of
the same member), so we join results back to the enriched rows by normalised
(first+last) name, falling back to company. Rows we can't resolve keep their
original URL and are flagged (never silently shipped).

first_name is reduced to the first token here too (mirrors firstNameForGreeting in
supabase/functions/_shared/text.ts) so the staged lead is clean everywhere, not just
in the rendered DM greeting.

Usage:
  set -a; source .env.local; set +a
  python3 scripts/lead-enrichment/resolve_profile_urls.py \\
    --in clients/carterco/data/hiring_enriched_dk.csv \\
    --out clients/carterco/data/hiring_enriched_dk_resolved.csv \\
    [--mode "Profile details no email ($4 per 1k)"]
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import urllib.error
import urllib.request

TOKEN = os.environ.get("APIFY_API_TOKEN") or sys.exit("APIFY_API_TOKEN required")
ACTOR = "harvestapi~linkedin-profile-scraper"
BASE = "https://api.apify.com/v2"

# Encoded LinkedIn member URL — the form stage 2 emits, the form that doesn't
# open in a browser. The URN starts AC{w,o,q}AA then varies (ACwAAA, ACwAAB,
# ACwAAC, ACoAAA…) — an earlier `AC[wo]AAA` pattern was too narrow and let
# ACwAAB/ACwAAC dead links ship as "vanity". Vanity URLs (linkedin.com/in/
# rasmus-aadal-49…) never start AC{woq}AA, so this stays idempotent.
ENCODED_RE = re.compile(r"/in/AC[woq]AA", re.I)


def norm(s: str) -> str:
    """Lowercase, strip non-alphanumerics (keep Danish chars) for name/company join."""
    return re.sub(r"[^a-z0-9æøå]", "", (s or "").lower())


def first_token(s: str) -> str:
    s = (s or "").strip()
    return s.split()[0] if s else ""


def run_profile_scraper(urls: list[str], mode: str) -> list[dict]:
    """Run the profile actor synchronously, return dataset items."""
    body = {"queries": urls, "profileScraperMode": mode}
    url = f"{BASE}/acts/{ACTOR}/run-sync-get-dataset-items?token={TOKEN}"
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=300) as f:
            return json.loads(f.read())
    except urllib.error.HTTPError as e:
        sys.exit(f"profile-scraper failed: {e.code} {e.read().decode()[:300]}")


def company_of(item: dict) -> str:
    cp = item.get("currentPosition") or []
    cp0 = cp[0] if isinstance(cp, list) and cp else (cp if isinstance(cp, dict) else {})
    return (cp0.get("companyName") or cp0.get("company") or "").strip()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="inp", required=True, help="enriched CSV (stage 2 output)")
    ap.add_argument("--out", required=True, help="resolved CSV (vanity URLs + clean names)")
    ap.add_argument("--mode", default="Profile details no email ($4 per 1k)",
                    help="profileScraperMode (cheapest by default)")
    ap.add_argument("--url-col", default="linkedin_profile_url")
    args = ap.parse_args()

    rows = list(csv.DictReader(open(args.inp, encoding="utf-8")))
    fieldnames = rows[0].keys() if rows else []
    # Only resolve rows that have an encoded URL; vanity rows pass straight through.
    to_resolve = [r for r in rows
                  if ENCODED_RE.search(r.get(args.url_col, "") or "")]
    print(f"{len(rows)} rows | {len(to_resolve)} encoded URLs to resolve "
          f"(est ${len(to_resolve)*0.004:.2f})")
    if not to_resolve:
        print("nothing to resolve — writing input through unchanged")
        with open(args.out, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(fieldnames))
            w.writeheader(); w.writerows(rows)
        return 0

    items = run_profile_scraper([r[args.url_col].strip() for r in to_resolve], args.mode)
    print(f"scraper returned {len(items)} profiles")

    # Build name- and company-keyed lookups (results are out-of-order vs input).
    by_name: dict[str, dict] = {}
    by_company: dict[str, dict] = {}
    for it in items:
        vanity = (it.get("linkedinUrl") or "").strip()
        if not vanity:
            continue
        rec = {"url": vanity,
               "first": first_token(it.get("firstName")),
               "last": (it.get("lastName") or "").strip()}
        nm = norm((it.get("firstName") or "") + (it.get("lastName") or ""))
        if nm:
            by_name[nm] = rec
        co = norm(company_of(it))
        if co:
            by_company.setdefault(co, rec)  # first wins on company collisions

    resolved = unmatched = 0
    for r in rows:
        if not ENCODED_RE.search(r.get(args.url_col, "") or ""):
            continue  # vanity already — leave it
        key_name = norm((r.get("first_name") or "") + (r.get("last_name") or ""))
        key_co = norm(r.get("brand") or r.get("company") or "")
        hit = by_name.get(key_name) or by_company.get(key_co)
        if not hit:
            unmatched += 1
            print(f"  ⚠ UNRESOLVED: {r.get('first_name')} {r.get('last_name')} "
                  f"@ {r.get('brand') or r.get('company')} — keeping encoded URL")
            continue
        r[args.url_col] = hit["url"]
        # Clean the name fields too (first token only), but only overwrite when the
        # scraper actually returned something — never blank out good data.
        if hit["first"]:
            r["first_name"] = hit["first"]
        if hit["last"]:
            r["last_name"] = hit["last"]
        resolved += 1

    with open(args.out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(fieldnames))
        w.writeheader(); w.writerows(rows)
    print(f"\nresolved {resolved} | unresolved {unmatched} | wrote {args.out}")
    if unmatched:
        print("  NOTE: unresolved rows still carry encoded URLs — review before staging.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
