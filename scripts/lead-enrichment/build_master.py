#!/usr/bin/env python3
"""Merge enrichment data from all passes into a master CSV.
Combines:
  - data/progress_li.jsonl        (first LinkedIn enrichment)
  - data/recovered.json           (retry pass)
  - data/progress_find_co.jsonl   (Serper + AI fallback)
into a single master.csv with `website` and `website_source` columns.

Usage:
  python3 build_master.py --csv <source> --out <master CSV>
"""
import argparse
import csv
import json
import os


def clean_title(s):
    s = (s or "").strip()
    return s[:197] + "..." if len(s) > 200 else s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    websites = {}

    # Pass 1
    p = "data/progress_li.jsonl"
    if os.path.exists(p):
        with open(p) as f:
            for line in f:
                o = json.loads(line)
                if o.get("website"):
                    websites[o["item"]["linkedinUrl"]] = {
                        "website": o["website"],
                        "source": "linkedin_pass1",
                    }

    # Pass 2
    p = "data/recovered.json"
    if os.path.exists(p):
        rec = json.load(open(p))
        for r in rec.get("recovered_leads", []):
            if r["linkedinUrl"] not in websites:
                websites[r["linkedinUrl"]] = {
                    "website": r["website"],
                    "source": "linkedin_retry",
                }

    # Pass 3
    p = "data/progress_find_co.jsonl"
    miss_notes = {}
    if os.path.exists(p):
        with open(p) as f:
            for line in f:
                o = json.loads(line)
                if o.get("website") and o["linkedinUrl"] not in websites:
                    websites[o["linkedinUrl"]] = {
                        "website": o["website"],
                        "source": "serper_verified",
                    }
                elif not o.get("website"):
                    miss_notes[o["linkedinUrl"]] = o.get("note", "")

    with open(args.csv, encoding="utf-8-sig") as f, open(args.out, "w", newline="") as w:
        reader = csv.DictReader(f)
        writer = csv.DictWriter(w, fieldnames=[
            "linkedinUrl","firstName","lastName","fullName",
            "company","title","location","country",
            "website","website_source","miss_reason",
        ])
        writer.writeheader()
        total = filled = 0
        by_source = {}
        for r in reader:
            total += 1
            url = (r.get("linkedinUrl") or "").strip()
            info = websites.get(url)
            website = info["website"] if info else ""
            src = info["source"] if info else ""
            if website:
                filled += 1
                by_source[src] = by_source.get(src, 0) + 1
            miss_reason = "" if website else (
                miss_notes.get(url) or
                ("no_company_in_source" if not r.get("currentCompany")
                 else "not_attempted_or_exhausted")
            )
            writer.writerow({
                "linkedinUrl": url,
                "firstName": (r.get("firstName") or "").strip(),
                "lastName": (r.get("lastName") or "").strip(),
                "fullName": f"{(r.get('firstName') or '').strip()} "
                            f"{(r.get('lastName') or '').strip()}".strip(),
                "company": (r.get("currentCompany") or "").strip(),
                "title": clean_title(r.get("headline")),
                "location": (r.get("location") or "").strip(),
                "country": (r.get("countryCode") or "").strip(),
                "website": website,
                "website_source": src,
                "miss_reason": miss_reason,
            })
    print(f"{filled}/{total} ({filled/total*100:.1f}%) with website. By source:")
    for s, n in sorted(by_source.items(), key=lambda x: -x[1]):
        print(f"  {s}: {n}")
    print(f"Written: {args.out}")


if __name__ == "__main__":
    main()
