#!/usr/bin/env python3
"""DK-filter + CVR-enrich the CarterCo hot list.

Steps:
  1. Filter FINAL_hot_list.csv to DK-only rows (phone starts +45 / 8-digit DK,
     OR email domain ends .dk).
  2. For each surviving row, query cvrapi.dk by company name to fetch:
       vat (CVR number), industry_code, industry_desc, employees, address,
       city, zipcode, status (active/closed), startdate
  3. Write FINAL_hot_list_dk_enriched.csv.

CVR API: https://cvrapi.dk/documentation — free, ~50/hour without key. Sets
User-Agent per their TOS. Caches results to /tmp/cvr_cache.json to avoid
re-fetching on reruns.

Usage:
  python3 scripts/lead-enrichment/enrich_dk_hot_list.py
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

CVR_URL = "https://cvrapi.dk/api"
USER_AGENT = "carterco-lead-enrichment/1.0 (louis@carterco.dk)"
CACHE_PATH = Path("/tmp/cvr_cache.json")
RATE_LIMIT_SLEEP = 1.5  # cvrapi.dk is rate-limited ~50/hour; pace ourselves


def is_dk(row: dict) -> tuple[bool, str]:
    """Reasonable DK indicators: +45 phone, .dk email domain, or 8-digit DK
    phone format. Returns (is_dk, why)."""
    phone = (row.get("Phone number") or "").strip()
    email = (row.get("Email") or "").strip().lower()
    edom = (row.get("email_domain") or "").strip().lower()
    digits = re.sub(r"\D", "", phone)
    if digits.startswith("45") and len(digits) == 10:
        return True, "phone+45"
    if (edom.endswith(".dk") or "@" in email and email.split("@")[1].endswith(".dk")):
        return True, "email.dk"
    if len(digits) == 8 and not digits.startswith(("0", "1")):
        return True, "phone8dk"
    return False, ""


def load_cache() -> dict:
    if CACHE_PATH.exists():
        try:
            return json.loads(CACHE_PATH.read_text())
        except Exception:
            return {}
    return {}


def save_cache(cache: dict) -> None:
    CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False, indent=2))


def query_cvr(name: str, cache: dict) -> dict | None:
    """Look up a company by name via cvrapi.dk. Returns the JSON dict or None."""
    key = name.strip().lower()
    if key in cache:
        return cache[key]
    qs = urllib.parse.urlencode({"search": name, "country": "dk"})
    req = urllib.request.Request(f"{CVR_URL}?{qs}",
                                 headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read())
        cache[key] = data
        return data
    except urllib.error.HTTPError as e:
        if e.code == 404:
            cache[key] = {"error": "not_found"}
            return None
        print(f"  [cvr] HTTP {e.code} for {name!r}", file=sys.stderr)
        cache[key] = {"error": f"http_{e.code}"}
        return None
    except Exception as e:
        print(f"  [cvr] error for {name!r}: {e}", file=sys.stderr)
        return None


def clean_company_for_cvr(name: str) -> str:
    """CVR API does fuzzy search — strip junk like 'Ring på WhatsApp', trailing
    suffix variations, and other noise that confuses lookups."""
    n = re.sub(r"\s*-\s*Ring\s+på\s+WhatsApp.*$", "", name, flags=re.I)
    n = re.sub(r"\s+", " ", n).strip()
    return n


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", default="clients/carterco/data/adalo_mined/FINAL_hot_list.csv",
                    dest="in_path")
    ap.add_argument("--out", default="clients/carterco/data/adalo_mined/FINAL_hot_list_dk_enriched.csv")
    ap.add_argument("--non-dk-out",
                    default="clients/carterco/data/adalo_mined/FINAL_hot_list_non_dk.csv")
    args = ap.parse_args()

    src = Path(args.in_path)
    if not src.exists():
        sys.exit(f"input not found: {src}")

    rows = list(csv.DictReader(open(src, encoding="utf-8")))
    print(f"  loaded {len(rows)} rows")

    dk_rows = []
    non_dk = []
    for r in rows:
        ok, why = is_dk(r)
        if ok:
            r["dk_signal"] = why
            dk_rows.append(r)
        else:
            r["dk_signal"] = "none"
            non_dk.append(r)
    print(f"  DK rows: {len(dk_rows)}  /  non-DK: {len(non_dk)}")
    if non_dk:
        print(f"  Filtered out:")
        for r in non_dk:
            print(f"    - {r.get('mined_company')!r}  "
                  f"phone={r.get('Phone number')!r}  "
                  f"email={r.get('Email')!r}")
    print()

    # Save non-DK separately for transparency
    if non_dk:
        Path(args.non_dk_out).parent.mkdir(parents=True, exist_ok=True)
        non_dk_fields = sorted({k for r in non_dk for k in r.keys()})
        with open(args.non_dk_out, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=non_dk_fields, extrasaction='ignore')
            w.writeheader()
            for r in non_dk:
                w.writerow(r)
        print(f"  wrote {len(non_dk)} → {args.non_dk_out}")
        print()

    # CVR enrich the DK survivors
    print(f"  CVR-enriching {len(dk_rows)} DK rows ...")
    cache = load_cache()
    enriched = []
    for i, r in enumerate(dk_rows, 1):
        name = clean_company_for_cvr(r.get("mined_company") or "")
        if not name:
            r["cvr_status"] = "no_name"
            enriched.append(r)
            continue
        if (r.get("mined_company") or "").strip().lower() not in cache:
            time.sleep(RATE_LIMIT_SLEEP)
        data = query_cvr(name, cache)
        if data is None or data.get("error"):
            r["cvr_status"] = "not_found"
            r["cvr_vat"] = ""
            r["cvr_industry_code"] = ""
            r["cvr_industry_desc"] = ""
            r["cvr_employees"] = ""
            r["cvr_address"] = ""
            r["cvr_city"] = ""
            r["cvr_zipcode"] = ""
            r["cvr_company_status"] = ""
            r["cvr_startdate"] = ""
            r["cvr_name"] = ""
            print(f"  [{i:2d}/{len(dk_rows)}] {name!r:38s} → NOT FOUND")
        else:
            r["cvr_status"] = "found"
            r["cvr_vat"] = str(data.get("vat") or "")
            r["cvr_industry_code"] = str(data.get("industrycode") or "")
            r["cvr_industry_desc"] = data.get("industrydesc") or ""
            r["cvr_employees"] = str(data.get("employees") or "")
            r["cvr_address"] = data.get("address") or ""
            r["cvr_city"] = data.get("city") or ""
            r["cvr_zipcode"] = str(data.get("zipcode") or "")
            r["cvr_company_status"] = "active" if not data.get("enddate") else "closed"
            r["cvr_startdate"] = data.get("startdate") or ""
            r["cvr_name"] = data.get("name") or ""
            emp = r["cvr_employees"] or "?"
            print(f"  [{i:2d}/{len(dk_rows)}] {name!r:38s} → CVR {r['cvr_vat']}  "
                  f"{r['cvr_industry_desc'][:40]:40s} emp={emp}")
        enriched.append(r)
    save_cache(cache)

    # Write
    fields = sorted({k for r in enriched for k in r.keys()})
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore')
        w.writeheader()
        for r in enriched:
            w.writerow(r)
    print()
    print(f"  wrote {len(enriched)} → {out}")
    print()

    # Final readable summary
    found = [r for r in enriched if r.get("cvr_status") == "found"]
    print(f"  CVR found: {len(found)}/{len(enriched)}")
    print()
    print("=" * 90)
    print(f"  CARTERCO HOT LIST — DK-only, CVR-enriched")
    print("=" * 90)
    for r in enriched:
        co = (r.get("mined_company") or "")[:30]
        name = (r.get("First name") or "")[:18]
        phone = (r.get("Phone number") or "")[:14]
        cvr_desc = (r.get("cvr_industry_desc") or "")[:30]
        cvr_emp = r.get("cvr_employees") or "?"
        cvr_city = (r.get("cvr_city") or "")[:15]
        cvr_vat = (r.get("cvr_vat") or "")[:9]
        print(f"  {co:30s} {name:18s} {phone:14s} | CVR={cvr_vat:9s} {cvr_city:15s} emp={cvr_emp:>4s} | {cvr_desc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
