#!/usr/bin/env python3
"""Remove marketing-agency leads from a sendable CSV.

The detector intentionally uses a reviewed set of agency company/domain/title
signals rather than removing every title that mentions marketing, SEO, PPC, or
media. Many normal target companies have in-house marketing people.
"""
import argparse
import csv
import re


AGENCY_COMPANIES = {
    "adwise media a/s",
    "auxo",
    "geelmuyden kiese danmark",
    "green.click a/s",
    "group online a/s",
    "gut copenhagen",
    "johnsen graphic agency",
    "lead agency",
    "searchmind",
    "simple agency group a/s",
    "sonic minds",
    "texta",
    "traffic lab",
    "web2media",
}

AGENCY_HOSTS = {
    "adwise.dk",
    "alphaagency.dk",
    "auxo.dk",
    "gknordic.com",
    "greenclick.dk",
    "grouponline.dk",
    "gut.agency",
    "johnsen.dk",
    "leadagency.dk",
    "pl-partners.dk",
    "searchmind.dk",
    "simplegroup.dk",
    "sonicmindsagency.com",
    "texta.dk",
    "trafficlab.dk",
    "web2media.dk",
}

TITLE_AGENCY = re.compile(
    r"\b("
    r"alpha agency|pl & partners|linie19 reklamebureau|"
    r"reklamebureau|marketingbureau|webbureau|kommunikationsbureau|"
    r"digitalt marketing bureau|digital marketing bureau|"
    r"seo bureau|ppc bureau|creative agency|branding agency"
    r")\b",
    re.IGNORECASE,
)


def host(url):
    value = (url or "").strip().lower()
    value = re.sub(r"^[a-z]+://", "", value)
    value = value.split("/", 1)[0].split(":", 1)[0]
    return value[4:] if value.startswith("www.") else value


def removal_reason(row):
    company = (row.get("company") or "").strip().lower()
    website_host = host(row.get("website", ""))
    title = row.get("title") or ""
    if company in AGENCY_COMPANIES:
        return "marketing_agency_company"
    if website_host in AGENCY_HOSTS:
        return "marketing_agency_website"
    if TITLE_AGENCY.search(title):
        return "marketing_agency_title"
    return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="in_csv", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--removed-out", required=True)
    args = ap.parse_args()

    with open(args.in_csv, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
        fieldnames = list(rows[0].keys()) if rows else []

    kept = []
    removed = []
    for row in rows:
        reason = removal_reason(row)
        if reason:
            removed_row = dict(row)
            removed_row["agency_removal_reason"] = reason
            removed.append(removed_row)
        else:
            kept.append(row)

    with open(args.out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(kept)

    with open(args.removed_out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames + ["agency_removal_reason"])
        w.writeheader()
        w.writerows(removed)

    print(f"Input rows: {len(rows)}")
    print(f"Removed agency rows: {len(removed)}")
    print(f"Kept rows: {len(kept)}")
    print(f"Written: {args.out}")
    print(f"Removed list: {args.removed_out}")


if __name__ == "__main__":
    main()
