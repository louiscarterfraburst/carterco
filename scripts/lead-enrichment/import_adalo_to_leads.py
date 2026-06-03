#!/usr/bin/env python3
"""Import mined Adalo leads into public.leads for the CarterCo workspace.

Reads the four non-reject bucket CSVs from clients/carterco/data/adalo_mined/
produced by mine_carterco_leads.py and upserts each row into public.leads with:

  workspace_id = CarterCo
  source       = 'adalo_legacy_2026-05-19'
  notes        = bucket | verticals | adalo_id | scores | reasons
  next_action_at = NULL (does NOT queue into I dag automatically — Louis picks)

Dedup: skips rows whose normalized phone OR lowercased email already exists in
the workspace's leads table.

Defaults to --dry-run. Use --apply to write.

Usage:
  set -a; source .env.local; set +a
  python3 scripts/lead-enrichment/import_adalo_to_leads.py            # dry-run
  python3 scripts/lead-enrichment/import_adalo_to_leads.py --apply    # write
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

CARTERCO_WORKSPACE_ID = "1e067f9a-d453-41a7-8bc4-9fdb5644a5fa"
SOURCE_TAG = "adalo_legacy_2026-05-19"

BUCKETS_TO_IMPORT = [
    "tier_a_reengage",
    "tier_b_icp_new",
    "needs_llm_review_high_prio",
    "needs_llm_review",
]


def env(key: str, *fallbacks: str) -> str:
    for k in (key,) + fallbacks:
        v = os.environ.get(k)
        if v:
            return v
    sys.exit(f"required env var: {key}" +
             (f" (or one of: {fallbacks})" if fallbacks else ""))


def normalize_phone(raw: str) -> str:
    """Return E.164-ish DK number where possible; else digits-only fallback.
    +4512345678 from '+4512345678' or '12345678' (8 DK digits)."""
    digits = re.sub(r"\D", "", raw or "")
    if not digits:
        return ""
    if digits.startswith("45") and len(digits) == 10:
        return "+" + digits
    if len(digits) == 8 and not digits.startswith(("0", "1")):
        return "+45" + digits
    return digits


def normalize_email(raw: str) -> str:
    return (raw or "").strip().lower()


def fetch_existing(sb_url: str, sb_key: str) -> tuple[set[str], set[str]]:
    """Pull all existing leads for the CarterCo workspace and return
    (phones_set, emails_set), normalized for dedup."""
    headers = {"apikey": sb_key, "Authorization": f"Bearer {sb_key}"}
    phones: set[str] = set()
    emails: set[str] = set()
    offset = 0
    page = 1000
    while True:
        q = urllib.parse.urlencode({
            "workspace_id": f"eq.{CARTERCO_WORKSPACE_ID}",
            "select": "phone,email",
            "limit": page,
            "offset": offset,
        })
        req = urllib.request.Request(f"{sb_url}/rest/v1/leads?{q}",
                                     headers=headers)
        with urllib.request.urlopen(req, timeout=30) as r:
            rows = json.loads(r.read())
        if not rows:
            break
        for r in rows:
            p = normalize_phone(r.get("phone") or "")
            e = normalize_email(r.get("email") or "")
            if p:
                phones.add(p)
            if e:
                emails.add(e)
        if len(rows) < page:
            break
        offset += page
    return phones, emails


def upsert_batch(sb_url: str, sb_key: str, rows: list[dict]) -> tuple[int, int]:
    body = json.dumps(rows).encode()
    req = urllib.request.Request(
        f"{sb_url}/rest/v1/leads",
        data=body,
        method="POST",
        headers={
            "apikey": sb_key,
            "Authorization": f"Bearer {sb_key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
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


def build_lead(adalo_row: dict, bucket: str) -> dict:
    name = (adalo_row.get("First name") or "").strip() or None
    company = (adalo_row.get("mined_company") or "").strip() or None
    email = normalize_email(adalo_row.get("Email") or "")
    phone = normalize_phone(adalo_row.get("Phone number") or "")
    verticals = (adalo_row.get("verticals") or "").strip()
    reasons = (adalo_row.get("reasons") or "").strip()
    scores = (f"r={adalo_row.get('realness_score')} "
              f"e={adalo_row.get('engagement_score')} "
              f"i={adalo_row.get('icp_score')}")
    funnel = ",".join(k for k in (
        "Contacted", "Booked meeting", "Converted", "Onboarding",
        "Snitcher lead", "Old lead"
    ) if (adalo_row.get(k) or "").strip().lower() == "true")
    notes = (f"[adalo_import:{SOURCE_TAG}]\n"
             f"bucket: {bucket}\n"
             f"adalo_id: {adalo_row.get('ID')}\n"
             f"verticals: {verticals or '(none)'}\n"
             f"scores: {scores}\n"
             f"adalo_funnel: {funnel or '(none)'}\n"
             f"reasons: {reasons}")
    return {
        "workspace_id": CARTERCO_WORKSPACE_ID,
        "source": SOURCE_TAG,
        "name": name,
        "company": company,
        "email": email or None,
        "phone": phone or None,
        "notes": notes,
        "is_draft": False,
        "next_action_at": None,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--indir", default="clients/carterco/data/adalo_mined")
    ap.add_argument("--apply", action="store_true",
                    help="write to Supabase (default is dry-run)")
    ap.add_argument("--batch-size", type=int, default=200)
    ap.add_argument("--bucket", action="append", default=None,
                    help="restrict to specific bucket(s). Defaults to all four "
                    "non-reject buckets.")
    ap.add_argument("--skip-dedup", action="store_true",
                    help="skip workspace dedup fetch (local preview only — does "
                    "NOT need SUPABASE creds; will still error on --apply)")
    args = ap.parse_args()

    indir = Path(args.indir)
    buckets = args.bucket or BUCKETS_TO_IMPORT

    if args.skip_dedup and not args.apply:
        sb_url = ""
        sb_key = ""
    else:
        sb_url = env("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL")
        sb_key = env("SUPABASE_SERVICE_ROLE_KEY")

    # Load all candidate rows
    candidates: list[tuple[str, dict]] = []
    for b in buckets:
        f = indir / f"{b}.csv"
        if not f.exists():
            print(f"  (skip) {f} not found", file=sys.stderr)
            continue
        rows = list(csv.DictReader(open(f, encoding="utf-8")))
        print(f"  loaded {len(rows):4d} from {b}")
        for r in rows:
            candidates.append((b, r))

    if not candidates:
        sys.exit("no candidates found")
    print(f"  total candidates: {len(candidates)}")
    print()

    # Build leads + dedup within candidate set (same phone/email appearing twice)
    seen_phone: set[str] = set()
    seen_email: set[str] = set()
    in_candidate_dups = 0
    no_contact = 0
    prepared: list[dict] = []
    for bucket, r in candidates:
        lead = build_lead(r, bucket)
        p = lead["phone"] or ""
        e = lead["email"] or ""
        if not p and not e:
            no_contact += 1
            continue
        key_dup = (p and p in seen_phone) or (e and e in seen_email)
        if key_dup:
            in_candidate_dups += 1
            continue
        if p:
            seen_phone.add(p)
        if e:
            seen_email.add(e)
        prepared.append(lead)

    print(f"  in-candidate dups (same phone/email twice): {in_candidate_dups}")
    print(f"  no contact info (skipped):                   {no_contact}")
    print(f"  prepared (before workspace dedup):           {len(prepared)}")
    print()

    # Workspace dedup: pull existing public.leads phones/emails for CarterCo
    if args.skip_dedup:
        print(f"  (--skip-dedup: skipping workspace dedup)")
        to_insert = prepared
    else:
        print(f"  fetching existing CarterCo leads for dedup ...")
        try:
            existing_phones, existing_emails = fetch_existing(sb_url, sb_key)
        except Exception as e:
            sys.exit(f"failed to fetch existing leads: {e}")
        print(f"  existing in workspace: {len(existing_phones)} phones, "
              f"{len(existing_emails)} emails")

        to_insert = []
        workspace_dups = 0
        for lead in prepared:
            p = lead["phone"] or ""
            e = lead["email"] or ""
            if (p and p in existing_phones) or (e and e in existing_emails):
                workspace_dups += 1
                continue
            to_insert.append(lead)
        print(f"  workspace dups (already in public.leads): {workspace_dups}")

    print(f"  to insert:                                {len(to_insert)}")
    print()

    # Show sample
    print("=== sample to insert (first 5) ===")
    for lead in to_insert[:5]:
        print(f"  {lead['company']!r:40s} | {lead['name']!r:25s} | "
              f"{lead['phone']!r:18s} | {lead['email']!r}")
    print()

    if not args.apply:
        print(f"(dry-run — pass --apply to insert {len(to_insert)} rows)")
        return 0

    if not to_insert:
        print("nothing to insert.")
        return 0

    print(f"=== INSERTING {len(to_insert)} rows into public.leads ===")
    total_ok = total_err = 0
    for i in range(0, len(to_insert), args.batch_size):
        batch = to_insert[i:i + args.batch_size]
        ok, err = upsert_batch(sb_url, sb_key, batch)
        total_ok += ok
        total_err += err
        print(f"  batch {i//args.batch_size + 1}: {ok} ok, {err} err  "
              f"({i+len(batch)}/{len(to_insert)})")
    print()
    print(f"=== DONE ===")
    print(f"  inserted: {total_ok}")
    if total_err:
        print(f"  errors:   {total_err}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
