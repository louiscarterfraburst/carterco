#!/usr/bin/env python3
"""Import a SendPilot LinkedIn-extract CSV into `leads_to_enrich`.

Reads only the columns we care about, normalizes LinkedIn URLs, and
upserts on `linkedin_url` so re-runs are idempotent.

Usage:
  python3 import_csv.py --csv ~/Downloads/leads.csv [--limit N]
"""
from __future__ import annotations
import argparse
import csv
import re
import sys
from urllib.parse import unquote, urlparse

from _supabase import upsert, count


def normalize_linkedin_url(raw: str) -> str:
    """Canonicalize: drop country prefix, drop query/fragment, lowercase host."""
    if not raw:
        return ""
    s = raw.strip()
    # Force https
    if s.startswith("http://"):
        s = "https://" + s[len("http://") :]
    elif not s.startswith("http"):
        s = "https://" + s
    p = urlparse(s)
    host = (p.netloc or "").lower()
    # Strip ru./ar./bd. country mirrors → www.linkedin.com
    if host.endswith("linkedin.com"):
        host = "www.linkedin.com"
    # Decode percent-escapes in path so the slug is stable
    path = unquote(p.path).rstrip("/")
    return f"https://{host}{path}"


def normalize_company_link(raw: str) -> str:
    """LinkedIn company page → canonical https://www.linkedin.com/company/<slug>"""
    if not raw:
        return ""
    p = urlparse(raw.strip())
    m = re.match(r"(/company/[^/]+)", p.path.rstrip("/"))
    return f"https://www.linkedin.com{m.group(1)}" if m else ""


def truncate(s: str, n: int) -> str:
    s = (s or "").strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def row_to_lead(row: dict) -> dict | None:
    url = normalize_linkedin_url(row.get("linkedinUrl") or "")
    if not url:
        return None
    return {
        "linkedin_url": url,
        "first_name": (row.get("firstName") or "").strip() or None,
        "last_name": (row.get("lastName") or "").strip() or None,
        "full_name": (row.get("fullName") or "").strip() or None,
        "company": (row.get("currentCompany") or "").strip() or None,
        "current_company_link": normalize_company_link(row.get("currentCompanyLink") or "")
        or None,
        "title": truncate(row.get("headline") or row.get("jobPosition") or "", 280) or None,
        "industry": (row.get("currentPositionIndustry") or "").strip() or None,
        "city": (row.get("city") or "").strip() or None,
        "country": (row.get("country") or "").strip() or None,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--limit", type=int, default=0, help="Only import the first N rows")
    args = ap.parse_args()

    with open(args.csv, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))

    if args.limit:
        rows = rows[: args.limit]

    leads: list[dict] = []
    seen: set[str] = set()
    skipped = 0
    for r in rows:
        lead = row_to_lead(r)
        if not lead:
            skipped += 1
            continue
        if lead["linkedin_url"] in seen:
            continue
        seen.add(lead["linkedin_url"])
        leads.append(lead)

    print(
        f"Read {len(rows)} rows · {len(leads)} unique LinkedIn URLs · {skipped} skipped (no URL)",
        file=sys.stderr,
    )

    if not leads:
        return

    print(f"Upserting into leads_to_enrich…", file=sys.stderr)
    upsert("leads_to_enrich", leads, on_conflict="linkedin_url")

    total = count("leads_to_enrich")
    print(f"Done. leads_to_enrich now has {total} rows.")


if __name__ == "__main__":
    main()
