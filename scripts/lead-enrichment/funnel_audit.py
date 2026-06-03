#!/usr/bin/env python3
"""Per-brand audit: trace each of the 42 IG-ad brands through the pipeline.

For each brand show:
  - Had domain discovered?
  - Had LinkedIn company URL found?
  - SendPilot enrichment result (status + person if found)
  - Apify enrichment result (status + person if found)
  - Made it to final leads_clean.csv?

This is the answer to "why didn't brand X make it through?".

Usage:
  python3 scripts/lead-enrichment/funnel_audit.py
"""
import csv
from pathlib import Path

BASE = Path("clients/carterco/data")


def load(name: str, key: str = "brand") -> dict[str, dict]:
    p = BASE / name
    if not p.exists():
        return {}
    return {r[key]: r for r in csv.DictReader(open(p, encoding="utf-8")) if r.get(key)}


def main() -> int:
    brands = list(csv.DictReader(open(BASE / "brands_with_domains_merged.csv", encoding="utf-8")))
    with_li = load("brands_with_linkedin.csv")
    sp = load("sendpilot_enriched.csv")
    ap = load("apify_enriched.csv")
    clean = load("leads_clean.csv", key="brand")

    print(f"{'BRAND':30} {'DOM':3} {'LI':3} {'SP':18} {'APIFY':18} {'SHIP':5}  REASON")
    print("-" * 130)

    bucket = {"shipped": 0, "dropped_noise": 0, "no_match": 0, "no_linkedin": 0,
              "no_domain": 0, "wrong_li_url": 0, "empty_results": 0}
    for b in brands:
        name = b["brand"][:30]
        dom = "✓" if b.get("domain") else "✗"
        li_row = with_li.get(b["brand"], {})
        li_url = li_row.get("linkedin_url", "")
        li = "✓" if li_url else "✗"

        sp_row = sp.get(b["brand"], {})
        sp_status = sp_row.get("status", "—")
        sp_person = ""
        if sp_status == "found":
            sp_person = f"✓ {sp_row.get('first_name','')[:1]}.{sp_row.get('last_name','')[:8]}"
        elif sp_status == "no_decision_maker":
            sp_person = "~ no DM"
        else:
            sp_person = sp_status[:14]

        ap_row = ap.get(b["brand"], {})
        ap_status = ap_row.get("status", "—")
        ap_person = ""
        if ap_status == "found":
            ap_person = f"✓ {ap_row.get('first_name','')[:1]}.{ap_row.get('last_name','')[:8]}"
        elif ap_status == "no_decision_maker":
            ap_person = "~ no DM"
        else:
            ap_person = ap_status[:14]

        shipped = b["brand"] in clean
        ship_mark = "✓" if shipped else " "

        # Diagnose reason for drop
        if shipped:
            reason = "in leads_clean.csv"
            bucket["shipped"] += 1
        elif not b.get("domain"):
            reason = "no domain found via Jina"
            bucket["no_domain"] += 1
        elif not li_url:
            reason = "no LinkedIn company URL from Jina"
            bucket["no_linkedin"] += 1
        elif sp_status == "found" or ap_status == "found":
            # Found by a source but didn't ship → noise filter or name mismatch
            reason = "dropped by noise filter (Morten Lund / Norwegian)"
            bucket["dropped_noise"] += 1
        elif sp_status in ("empty_results", "no_employees") and ap_status in ("empty_results", "no_employees"):
            reason = "both sources returned 0 employees (LinkedIn-indexing gap)"
            bucket["empty_results"] += 1
        elif "ZEBRA" in (ap_row.get("company_returned", "") or "").upper() or \
             "VIKING Life" in (ap_row.get("company_returned", "") or "") or \
             "Inc" in (ap_row.get("company_returned", "") or ""):
            reason = f"wrong LI URL from Jina → returned {ap_row.get('company_returned','')[:30]}"
            bucket["wrong_li_url"] += 1
        else:
            reason = "no match in either source"
            bucket["no_match"] += 1

        print(f"{name:30} {dom:^3} {li:^3} {sp_person:18} {ap_person:18} {ship_mark:^5}  {reason}")

    print()
    print("=== SUMMARY ===")
    total = len(brands)
    for k, v in bucket.items():
        pct = (v / total * 100) if total else 0
        print(f"  {k:20s} {v:3d}  ({pct:4.1f}%)")
    print(f"  {'TOTAL':20s} {total:3d}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
