#!/usr/bin/env python3
"""Convert leads_clean.csv → SendPilot import CSV.

Shape SendPilot expects on manual upload (and via API):
  linkedinUrl, firstName, lastName, company, title, website

Website is required downstream: the SendSpark render gate fails leads without
one (carterco.dk fallback would render generic videos). Pass through the
`website` column from input when present; otherwise emit empty so the operator
sees it as a known gap rather than silently shipping a broken render.

Usage:
  python3 scripts/lead-enrichment/to_sendpilot_csv.py \\
    --in  clients/carterco/data/leads_clean.csv \\
    --out clients/carterco/data/sendpilot_import.csv
"""
import argparse
import csv
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    rows = list(csv.DictReader(open(args.inp, encoding="utf-8")))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    no_website = 0
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["linkedinUrl", "firstName", "lastName", "company", "title", "website"])
        w.writeheader()
        for r in rows:
            website = (r.get("website") or "").strip()
            if website and not website.startswith("http"):
                website = f"https://{website}"
            if not website:
                no_website += 1
            w.writerow({
                "linkedinUrl": r["linkedin_url"],
                "firstName": r["first_name"],
                "lastName": r["last_name"],
                "company": r["company"],
                "title": r["title"],
                "website": website,
            })
    print(f"wrote {len(rows)} rows → {out}")
    if no_website:
        print(f"  WARNING: {no_website} rows have no website "
              f"(render gate will fail). Add a `website` column to the "
              f"input CSV or use import_to_lead_inbox.py --brands.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
