#!/usr/bin/env python3
"""Export enriched leads to a SendPilot-importable CSV and seed outreach_leads
with synthesized contact_emails.

Two outputs:
  1. CSV file (--out) ready to upload to SendPilot's UI campaign import.
  2. Rows upserted into the public.outreach_leads table with a synthesized
     contact_email per lead, so when SendPilot fires connection.accepted
     webhooks our existing pipeline can resolve them via linkedin_url
     and pull the email forward into outreach_pipeline.contact_email.

The synthesized email format matches what was already in the DB from the
v1 import:
  carterco+li-{slug-truncated-to-30-chars}-{sha1(url)[:6]}@carterco.dk
where slug = lower(last path segment of linkedin_url, alnum-or-dash).
This is a catchall on a domain we own; replies bounce back to our inbox
for poll_inbox.py to attribute.

Usage:
  set -a; source ../../.env.local; set +a
  python3 export_for_sendpilot.py --out /tmp/carterco_followup.csv [--limit N] [--dry-run]
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import re
import sys
from typing import Any

from _supabase import select, upsert

# Hard-coded carterco workspace UUID. Same value present on every existing
# outreach_leads / outreach_pipeline row.
WORKSPACE_ID = "2740ba1f-d5d5-4008-bf43-b45367c73134"

SLUG_NORMALIZE_RE = re.compile(r"[^a-z0-9-]+")


def slug_of(url: str) -> str:
    """Last path segment of a LinkedIn URL, normalised. Mirrors the SQL
    trigger public.outreach_leads_set_slug() in supabase/outreach.sql."""
    if not url:
        return ""
    seg = url.rstrip("/").split("/")[-1]
    return SLUG_NORMALIZE_RE.sub("-", seg.lower())


def synth_email(linkedin_url: str) -> str:
    """Deterministic synthesized email matching the v1 format. Reverse-
    engineered from existing rows in outreach_pipeline (sha1 of url-without-
    trailing-slash, first 6 hex chars; slug truncated to 30 chars)."""
    if not linkedin_url:
        return ""
    s = slug_of(linkedin_url)[:30]
    h = hashlib.sha1(linkedin_url.rstrip("/").encode()).hexdigest()[:6]
    return f"carterco+li-{s}-{h}@carterco.dk"


def fetch_all_enriched() -> list[dict[str, Any]]:
    """Paginated fetch of every leads_to_enrich row with a website."""
    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        chunk = select(
            "leads_to_enrich",
            "website=not.is.null"
            "&select=linkedin_url,first_name,last_name,full_name,company,"
            "title,industry,city,country,website,website_pass"
            f"&order=imported_at.asc&offset={offset}&limit=1000",
        )
        if not chunk:
            break
        rows.extend(chunk)
        if len(chunk) < 1000:
            break
        offset += 1000
    return rows


def build_csv_row(lead: dict[str, Any]) -> dict[str, str]:
    """Map our enriched-lead schema to the SendPilot CSV columns the user's
    previous v1 imports used (matched by sample CSVs in
    scripts/lead-enrichment/data/master_sendable_*.csv)."""
    city = (lead.get("city") or "").strip()
    country = (lead.get("country") or "").strip()
    location = ", ".join(p for p in (city, country) if p)
    return {
        "linkedinUrl":     lead.get("linkedin_url") or "",
        "firstName":       lead.get("first_name") or "",
        "lastName":        lead.get("last_name") or "",
        "fullName":        lead.get("full_name") or "",
        "company":         lead.get("company") or "",
        "title":           lead.get("title") or "",
        "location":        location,
        "country":         country,
        "website":         lead.get("website") or "",
        "website_source":  lead.get("website_pass") or "",
        "miss_reason":     "",
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="Output CSV path")
    ap.add_argument("--limit", type=int, default=0, help="Cap rows (0 = all)")
    ap.add_argument("--dry-run", action="store_true",
                    help="Write CSV only — skip the outreach_leads upsert")
    args = ap.parse_args()

    print("Fetching enriched leads…", file=sys.stderr)
    leads = fetch_all_enriched()
    if args.limit:
        leads = leads[: args.limit]
    print(f"  {len(leads)} leads with website", file=sys.stderr)

    # 1. Write the CSV
    fields = [
        "linkedinUrl", "firstName", "lastName", "fullName", "company",
        "title", "location", "country", "website", "website_source",
        "miss_reason",
    ]
    with open(args.out, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for lead in leads:
            w.writerow(build_csv_row(lead))
    print(f"Wrote {len(leads)} rows to {args.out}", file=sys.stderr)

    if args.dry_run:
        print("--dry-run: skipping outreach_leads upsert.", file=sys.stderr)
        return 0

    # 2. Upsert outreach_leads with synthesized contact_emails so the
    # SendPilot webhook chain can resolve them when accepts come in.
    rows = []
    for lead in leads:
        url = lead.get("linkedin_url") or ""
        if not url:
            continue
        rows.append({
            "linkedin_url":  url,
            "first_name":    lead.get("first_name"),
            "last_name":     lead.get("last_name"),
            "full_name":     lead.get("full_name"),
            "company":       lead.get("company"),
            "title":         lead.get("title"),
            "website":       lead.get("website"),
            "contact_email": synth_email(url),
            "workspace_id":  WORKSPACE_ID,
            # `slug` is set by the public.outreach_leads_set_slug trigger.
        })
    print(f"Upserting {len(rows)} rows into outreach_leads…", file=sys.stderr)
    upsert("outreach_leads", rows, on_conflict="linkedin_url")
    print("Done.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
