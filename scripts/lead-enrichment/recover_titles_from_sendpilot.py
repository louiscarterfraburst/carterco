#!/usr/bin/env python3
"""Recover missing titles for OdaGroup lead_inbox rows by pulling from SendPilot.

Apify's first-pass scrape returned empty title/headline for ~95 of the 1817
OdaGroup leads. SendPilot's own lead extractor scrapes those same profiles
on its server-side IPs (which LinkedIn doesn't block as aggressively as
free-tier Jina), so once Niels imports the CSV into a SendPilot campaign,
SendPilot has the title data we're missing.

This script:
  1. Calls SendPilot's /v1/leads API for the given campaign(s)
  2. Matches each SendPilot lead to a lead_inbox row by LinkedIn slug
  3. Updates lead_inbox.title for rows where title is NULL and SendPilot has one

Run AFTER Niels has imported the CSV into SendPilot AND given SendPilot a
few minutes to enrich (titles populate within seconds, but waiting 5–10 min
after import gives the safest read).

Usage:
  set -a; source .env.local; set +a
  python3 scripts/lead-enrichment/recover_titles_from_sendpilot.py \\
    --campaign <campaignId> [--campaign <id2> ...] [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

ODAGROUP_WORKSPACE_ID = "cdfd80d8-33bb-4b64-b778-0a2c5ab78cc6"

SP_API_KEY = os.environ.get("SENDPILOT_API_KEY") or sys.exit("SENDPILOT_API_KEY required")
SB_URL = (
    os.environ.get("SUPABASE_URL")
    or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    or sys.exit("SUPABASE_URL required")
)
SB_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or sys.exit(
    "SUPABASE_SERVICE_ROLE_KEY required"
)


def linkedin_slug(url: str) -> str:
    """Same slug logic as the rest of the pipeline."""
    if not url:
        return ""
    try:
        decoded = urllib.parse.unquote(urllib.parse.unquote(url))
        path = urllib.parse.urlparse(decoded).path.rstrip("/")
        if "/in/" not in path:
            return ""
        return path.rsplit("/", 1)[-1].lower()
    except Exception:
        return ""


def fetch_sendpilot_leads(campaign_id: str) -> list[dict]:
    """Pull all leads from a SendPilot campaign, paginated."""
    out: list[dict] = []
    page = 1
    while page <= 50:  # safety cap
        url = (
            f"https://api.sendpilot.ai/v1/leads"
            f"?campaignId={urllib.parse.quote(campaign_id)}"
            f"&page={page}&limit=100"
        )
        req = urllib.request.Request(url, headers={"X-API-Key": SP_API_KEY})
        try:
            with urllib.request.urlopen(req, timeout=30) as f:
                data = json.loads(f.read())
        except urllib.error.HTTPError as e:
            sys.exit(f"SendPilot API {e.code}: {e.read().decode()[:200]}")
        leads = data.get("leads", [])
        out.extend(leads)
        total_pages = (data.get("pagination") or {}).get("totalPages", 1)
        if page >= total_pages:
            break
        page += 1
    return out


def fetch_inbox_missing_titles() -> list[dict]:
    """Get all lead_inbox rows for OdaGroup where title is NULL."""
    url = (
        f"{SB_URL}/rest/v1/lead_inbox"
        f"?workspace_id=eq.{ODAGROUP_WORKSPACE_ID}"
        f"&title=is.null"
        f"&select=linkedin_url,linkedin_slug,first_name,company"
        f"&limit=1000"
    )
    req = urllib.request.Request(url, headers={
        "apikey": SB_KEY,
        "Authorization": f"Bearer {SB_KEY}",
    })
    with urllib.request.urlopen(req, timeout=30) as f:
        return json.loads(f.read())


def update_inbox_title(workspace_id: str, linkedin_url: str, title: str) -> bool:
    """Set lead_inbox.title for one row. Returns True on success."""
    url = (
        f"{SB_URL}/rest/v1/lead_inbox"
        f"?workspace_id=eq.{workspace_id}"
        f"&linkedin_url=eq.{urllib.parse.quote(linkedin_url, safe='')}"
    )
    req = urllib.request.Request(
        url,
        data=json.dumps({"title": title}).encode(),
        method="PATCH",
        headers={
            "apikey": SB_KEY,
            "Authorization": f"Bearer {SB_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as f:
            f.read()
        return True
    except urllib.error.HTTPError as e:
        print(f"  PATCH error {e.code}: {e.read().decode()[:200]}", file=sys.stderr)
        return False


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--campaign", action="append", required=True,
                    help="SendPilot campaign ID (repeat for multiple)")
    ap.add_argument("--dry-run", action="store_true",
                    help="show what would be updated, don't write")
    args = ap.parse_args()

    print(f"=== Pulling lead_inbox rows missing title (workspace = OdaGroup) ===")
    inbox = fetch_inbox_missing_titles()
    print(f"  rows missing title: {len(inbox)}")
    by_slug = {r["linkedin_slug"]: r for r in inbox if r.get("linkedin_slug")}
    print(f"  unique slugs:       {len(by_slug)}")
    print()

    print(f"=== Pulling SendPilot leads from {len(args.campaign)} campaign(s) ===")
    sp_leads: list[dict] = []
    for cid in args.campaign:
        leads = fetch_sendpilot_leads(cid)
        print(f"  campaign {cid}: {len(leads)} leads")
        sp_leads.extend(leads)
    print(f"  total fetched: {len(sp_leads)}")
    print()

    # Match SendPilot leads against missing-title inbox rows.
    matches: list[tuple[dict, str]] = []
    sp_no_match = 0
    sp_no_title = 0
    for sp in sp_leads:
        slug = linkedin_slug(sp.get("linkedinUrl", ""))
        if slug not in by_slug:
            sp_no_match += 1
            continue
        sp_title = (sp.get("title") or "").strip()
        if not sp_title:
            sp_no_title += 1
            continue
        matches.append((by_slug[slug], sp_title))

    print(f"=== MATCH REPORT ===")
    print(f"  SP leads matching a missing-title row:  {len(matches)}")
    print(f"  SP leads where SP also had no title:    {sp_no_title}")
    print(f"  SP leads not in inbox (already had title or different campaign): {sp_no_match}")
    print()

    if not matches:
        print("no titles to recover")
        return 0

    print(f"=== SAMPLE (first 10) ===")
    for inbox_row, title in matches[:10]:
        first = inbox_row.get("first_name", "?")
        company = inbox_row.get("company", "?")
        print(f"  {first} @ {company:30s}  →  {title[:80]!r}")
    if len(matches) > 10:
        print(f"  ... and {len(matches) - 10} more")
    print()

    if args.dry_run:
        print("(--dry-run: no DB writes)")
        return 0

    print(f"=== APPLYING ===")
    ok = 0
    err = 0
    for inbox_row, title in matches:
        if update_inbox_title(ODAGROUP_WORKSPACE_ID, inbox_row["linkedin_url"], title):
            ok += 1
        else:
            err += 1
    print(f"  updated: {ok}")
    if err:
        print(f"  errors:  {err}")
        return 1
    print()
    print(f"now {len(inbox) - ok} lead_inbox rows still have no title")
    return 0


if __name__ == "__main__":
    sys.exit(main())
