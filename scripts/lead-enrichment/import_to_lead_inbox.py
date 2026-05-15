#!/usr/bin/env python3
"""Stage cleaned OdaGroup leads in the `lead_inbox` Supabase table.

Reads `clients/odagroup/data/leads_clean.csv` (the post-normalize, post-LLM
output) and upserts each row into `public.lead_inbox` with workspace_id =
OdaGroup. Idempotent on (workspace_id, linkedin_url) so re-runs are safe.

Also produces a slim SendPilot-importable CSV (linkedinUrl, firstName,
lastName, title, company) that Niels imports into his SendPilot campaign.
SendPilot only needs the bare LinkedIn URL + name to send the connection
request — title/company are nice-to-have for personalization tokens but
not required.

Usage:
  set -a; source .env.local; set +a
  python3 scripts/lead-enrichment/import_to_lead_inbox.py \\
    --csv clients/odagroup/data/leads_clean.csv \\
    --sendpilot-out clients/odagroup/data/sendpilot_import.csv \\
    [--dry-run] [--limit N] [--skip-non-latin] [--skip-no-title]
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ODAGROUP_WORKSPACE_ID = "cdfd80d8-33bb-4b64-b778-0a2c5ab78cc6"

SB_URL = (
    os.environ.get("SUPABASE_URL")
    or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    or sys.exit("SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL required")
)
SB_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or sys.exit(
    "SUPABASE_SERVICE_ROLE_KEY required"
)


def linkedin_slug(url: str) -> str:
    """Same slug logic as sendpilot-webhook lookupLead. Last /in/<slug> segment,
    lowercased, decoded. Empty for non-/in/ URLs."""
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


def upsert_batch(rows: list[dict]) -> tuple[int, int]:
    """Bulk upsert via PostgREST. Returns (inserted_or_updated, errors)."""
    body = json.dumps(rows).encode()
    req = urllib.request.Request(
        f"{SB_URL}/rest/v1/lead_inbox",
        data=body,
        method="POST",
        headers={
            "apikey": SB_KEY,
            "Authorization": f"Bearer {SB_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as f:
            f.read()
        return len(rows), 0
    except urllib.error.HTTPError as e:
        body_txt = e.read().decode()[:500]
        print(f"  ERROR HTTP {e.code}: {body_txt}", file=sys.stderr)
        return 0, len(rows)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", required=True, help="cleaned CSV (post-normalize)")
    ap.add_argument("--sendpilot-out", required=True,
                    help="SendPilot-importable slim CSV output path")
    ap.add_argument("--source-csv", default="Odagroup-leads.csv",
                    help="filename to record in lead_inbox.source_csv (audit)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print plan, don't upsert or write")
    ap.add_argument("--limit", type=int, default=0,
                    help="only process first N rows (0 = all)")
    ap.add_argument("--skip-non-latin", action="store_true",
                    help="exclude rows whose first_name_issue is non_latin "
                    "(e.g. Japanese kanji — would generate awkward greetings)")
    ap.add_argument("--skip-no-title", action="store_true",
                    help="exclude rows with no title — AI message can't pick a strategy")
    ap.add_argument("--batch-size", type=int, default=200,
                    help="rows per upsert batch (PostgREST handles ~1000 cleanly)")
    args = ap.parse_args()

    src = Path(args.csv)
    if not src.exists():
        sys.exit(f"input not found: {src}")

    rows = list(csv.DictReader(open(src, encoding="utf-8")))
    print(f"loaded {len(rows)} rows from {src.name}")

    inbox_rows: list[dict] = []
    sendpilot_rows: list[dict] = []
    skipped = {"no_slug": 0, "non_latin": 0, "no_title": 0, "no_first_name": 0}

    for r in rows:
        url = r.get("linkedin_url", "").strip()
        slug = linkedin_slug(url)
        if not slug:
            skipped["no_slug"] += 1
            continue
        first = r.get("first_name", "").strip()
        if not first:
            skipped["no_first_name"] += 1
            continue
        if args.skip_non_latin and r.get("first_name_issue") == "non_latin":
            skipped["non_latin"] += 1
            continue
        title = r.get("title", "").strip()
        if args.skip_no_title and not title:
            skipped["no_title"] += 1
            continue

        inbox_rows.append({
            "workspace_id": ODAGROUP_WORKSPACE_ID,
            "linkedin_url": url,
            "linkedin_slug": slug,
            "first_name": first,
            "last_name": r.get("last_name", "").strip() or None,
            "title": title or None,
            "company": r.get("company", "").strip() or None,
            "country": (r.get("country", "").strip() or None),
            "detected_strategy": r.get("detected_strategy", "").strip() or None,
            "city": r.get("city", "").strip() or None,
            "source_csv": args.source_csv,
        })
        # SendPilot import: bare minimum it needs.
        sendpilot_rows.append({
            "linkedinUrl": url,
            "firstName": first,
            "lastName": r.get("last_name", "").strip(),
            "company": r.get("company", "").strip(),
            "title": title,
        })

        if args.limit and len(inbox_rows) >= args.limit:
            break

    print()
    print(f"=== PLAN ===")
    print(f"  rows to insert into lead_inbox: {len(inbox_rows)}")
    print(f"  rows to write to SendPilot CSV: {len(sendpilot_rows)}")
    if any(skipped.values()):
        print(f"  skipped:")
        for k, v in skipped.items():
            if v:
                print(f"    {k}: {v}")
    print()

    if args.dry_run:
        print("(--dry-run: no DB writes, no SendPilot CSV)")
        return 0

    # Write SendPilot CSV first — cheap, local, lets you upload while DB upsert runs.
    sp_path = Path(args.sendpilot_out)
    sp_path.parent.mkdir(parents=True, exist_ok=True)
    with open(sp_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["linkedinUrl", "firstName", "lastName",
                                          "company", "title"])
        w.writeheader()
        w.writerows(sendpilot_rows)
    print(f"wrote {len(sendpilot_rows)} rows → {sp_path}")
    print()

    # Upsert in batches.
    total_ok = 0
    total_err = 0
    for i in range(0, len(inbox_rows), args.batch_size):
        batch = inbox_rows[i:i + args.batch_size]
        ok, err = upsert_batch(batch)
        total_ok += ok
        total_err += err
        print(f"  batch {i//args.batch_size + 1}: {ok} ok, {err} err  ({i+len(batch)}/{len(inbox_rows)})")

    print()
    print(f"=== DONE ===")
    print(f"  upserted: {total_ok}")
    if total_err:
        print(f"  errors:   {total_err}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
