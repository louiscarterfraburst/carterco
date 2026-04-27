#!/usr/bin/env python3
"""Remove query-string parameters and fragments from website URLs in a CSV."""
import argparse
import csv
import urllib.parse


def clean_url(url):
    value = (url or "").strip()
    if not value:
        return value
    had_scheme = "://" in value
    parsed = urllib.parse.urlparse(value if had_scheme else f"https://{value}")
    cleaned = parsed._replace(query="", fragment="").geturl()
    if not had_scheme:
        cleaned = cleaned.removeprefix("https://")
    return cleaned


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="in_csv", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--changes-out", required=True)
    args = ap.parse_args()

    with open(args.in_csv, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
        fieldnames = list(rows[0].keys()) if rows else []

    changes = []
    for index, row in enumerate(rows, start=2):
        old = row.get("website", "")
        new = clean_url(old)
        if old != new:
            changes.append({
                "line": index,
                "linkedinUrl": row.get("linkedinUrl", ""),
                "company": row.get("company", ""),
                "old_website": old,
                "new_website": new,
            })
            row["website"] = new

    with open(args.out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)

    with open(args.changes_out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=[
            "line", "linkedinUrl", "company", "old_website", "new_website",
        ])
        w.writeheader()
        w.writerows(changes)

    print(f"Input rows: {len(rows)}")
    print(f"URLs changed: {len(changes)}")
    print(f"Written: {args.out}")
    print(f"Change log: {args.changes_out}")


if __name__ == "__main__":
    main()
