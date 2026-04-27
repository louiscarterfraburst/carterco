#!/usr/bin/env python3
"""Final SendPilot-readiness pass on the enriched master CSV.

Reads `--in` (typically data/master_v2.csv after firstName cleanup), then:
  - Drops empty-firstName rows (e.g. company profiles like MyDNA)
  - Drops STEFFCA-style company-not-person rows (firstName ALL CAPS, lastName
    'undefined' or empty)
  - Drops initials-only rows where BOTH firstName and lastName are <=2 chars
    (preserves 'Bo Andersen', 'Ib Hansen', '文盛 陈')
  - Country filter: keep only country == 'DK'
  - Dedupes by lowercase (firstName, lastName, company); keeps the row with
    a website if available, then longer linkedinUrl slug, else first seen
  - Clears polluted websites that point to linkedin.com (sets miss_reason)
  - Exports suspicious-title rows (students/retired/interns/etc.) to a
    separate CSV for manual review
  - Prints 10 random sample rows for spot-check

Usage:
  python3 finalize.py --in data/master_v2.csv --out data/master_ready.csv
"""
import argparse
import csv
import random
import re
import sys

SUSPICIOUS_TITLE = re.compile(
    r"\b(retired|pensioneret|student|studerende|intern|praktikant|"
    r"self.?employed|selvst.?ndig|freelance|seeking|looking for|"
    r"open to|job ?seeker|unemployed|p\u00e5 pension|emeritus)\b",
    re.IGNORECASE,
)
GENERIC_COMPANY = {
    "self employed", "self-employed", "selvst\u00e6ndig", "freelance",
    "freelancer", "none", "n/a", "--", "retired", "pensioneret",
}
JUNK_WEBSITE_HOSTS = (
    "hotmail.com", "hotmail-outlook", "gmail.com", "outlook.com",
    "yahoo.com", "mailto:",
)


def is_initials_only(first, last):
    f = first.strip()
    l = last.strip()
    if not f or not l:
        return False
    return len(f) <= 2 and len(l) <= 2 and not any(
        ord(c) > 127 for c in f + l
    )


def is_company_pseudoperson(first, last):
    if not first.strip():
        return True
    if first.isupper() and len(first) > 2 and last.strip().lower() in {"undefined", ""}:
        return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="in_csv", required=True)
    ap.add_argument("--out", dest="out_csv", required=True)
    ap.add_argument("--review-out", default="data/review_suspicious.csv")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    rows = list(csv.DictReader(open(args.in_csv)))
    fieldnames = list(rows[0].keys()) if rows else []
    start = len(rows)

    counters = {
        "company_pseudoperson": 0,
        "initials_only": 0,
        "non_dk": 0,
        "email_in_company": 0,
        "generic_company": 0,
        "duplicate": 0,
        "linkedin_url_cleared": 0,
        "junk_website_cleared": 0,
        "suspicious_title": 0,
    }

    kept = []
    for r in rows:
        if is_company_pseudoperson(r["firstName"], r["lastName"]):
            counters["company_pseudoperson"] += 1
            continue
        if is_initials_only(r["firstName"], r["lastName"]):
            counters["initials_only"] += 1
            continue
        if r.get("country", "").strip() != "DK":
            counters["non_dk"] += 1
            continue
        if "@" in r["company"]:
            counters["email_in_company"] += 1
            continue
        if r["company"].strip().lower() in GENERIC_COMPANY:
            counters["generic_company"] += 1
            continue
        if r["website"] and "linkedin.com/" in r["website"].lower():
            r["website"] = ""
            r["website_source"] = ""
            r["miss_reason"] = "linkedin_url_not_real_site"
            counters["linkedin_url_cleared"] += 1
        if r["website"] and any(h in r["website"].lower() for h in JUNK_WEBSITE_HOSTS):
            r["website"] = ""
            r["website_source"] = ""
            r["miss_reason"] = "junk_website_host"
            counters["junk_website_cleared"] += 1
        kept.append(r)

    by_key = {}
    for r in kept:
        key = (
            r["firstName"].strip().lower(),
            r["lastName"].strip().lower(),
            r["company"].strip().lower(),
        )
        if not all(key):
            by_key.setdefault(("__no_key__", id(r)), r)
            continue
        existing = by_key.get(key)
        if existing is None:
            by_key[key] = r
            continue
        counters["duplicate"] += 1
        challenger_score = (
            1 if r["website"] else 0,
            len(r["linkedinUrl"]),
        )
        existing_score = (
            1 if existing["website"] else 0,
            len(existing["linkedinUrl"]),
        )
        if challenger_score > existing_score:
            by_key[key] = r

    final = list(by_key.values())

    suspicious = [r for r in final if SUSPICIOUS_TITLE.search(r.get("title", ""))]
    counters["suspicious_title_dropped"] = len(suspicious)
    suspicious_urls = {r["linkedinUrl"] for r in suspicious}
    final = [r for r in final if r["linkedinUrl"] not in suspicious_urls]

    with open(args.out_csv, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(final)

    if suspicious:
        with open(args.review_out, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=fieldnames)
            w.writeheader()
            w.writerows(suspicious)

    print(f"Input rows:  {start}")
    for k, v in counters.items():
        print(f"  {k}: {v}")
    print(f"Output rows: {len(final)}")
    with_web = sum(1 for r in final if r["website"])
    print(f"  with website: {with_web} ({100*with_web/len(final):.1f}%)")
    print(f"Written: {args.out_csv}")
    if suspicious:
        print(f"Suspicious-title rows for manual review: {args.review_out} ({len(suspicious)})")

    print("\n--- 10 random sample rows for eyeball check ---")
    rng = random.Random(args.seed)
    for r in rng.sample(final, min(10, len(final))):
        print(f"  {r['firstName']:20} {r['lastName']:30} | {r['company'][:30]:30} | {r['website'][:50]}")


if __name__ == "__main__":
    main()
