#!/usr/bin/env python3
"""Seed `test_submissions` from `leads_to_enrich`.

For each enriched lead with a website:
  - Extract a normalized domain (acme.dk)
  - Generate a unique short ref code (e.g. RX-7K3J)
  - Insert into test_submissions with status='pending'

Re-runs are idempotent: skips companies (by domain) we've already added.

Usage:
  python3 seed_submissions.py [--limit N] [--dry-run]
"""
from __future__ import annotations
import argparse
import random
import re
import string
import sys
from urllib.parse import urlparse

from _supabase import select_paged, upsert, select


REF_ALPHABET = string.ascii_uppercase + string.digits  # no lowercase to avoid l/1, etc
# Skip ambiguous chars
REF_ALPHABET = "".join(c for c in REF_ALPHABET if c not in "0O1I")


def gen_ref_code(rng: random.Random) -> str:
    """RX-XXXXXX, e.g. RX-7K3JM2. ~32^6 ≈ 1B values."""
    body = "".join(rng.choice(REF_ALPHABET) for _ in range(6))
    return f"RX-{body}"


def extract_domain(url: str | None) -> str | None:
    if not url:
        return None
    u = url.strip()
    if not u.lower().startswith(("http://", "https://")):
        u = "https://" + u
    try:
        host = urlparse(u).hostname
    except Exception:
        return None
    if not host:
        return None
    host = host.lower()
    # Strip leading www.
    if host.startswith("www."):
        host = host[4:]
    return host or None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0,
                    help="Cap at N submissions (0 = all enriched)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    print("Fetching enriched leads…", file=sys.stderr)
    enriched = select_paged(
        "leads_to_enrich",
        query="website=not.is.null&select=linkedin_url,company,website,industry,city",
    )
    print(f"  {len(enriched)} enriched leads", file=sys.stderr)

    print("Fetching existing test_submissions to dedupe…", file=sys.stderr)
    existing = select_paged("test_submissions", query="select=domain,ref_code")
    seen_domains = {row["domain"] for row in existing if row.get("domain")}
    seen_codes = {row["ref_code"] for row in existing if row.get("ref_code")}
    print(f"  {len(seen_domains)} existing domains skipped, "
          f"{len(seen_codes)} existing ref_codes", file=sys.stderr)

    rng = random.Random()
    rows: list[dict] = []
    skipped_no_domain = skipped_dup = 0

    for lead in enriched:
        domain = extract_domain(lead.get("website"))
        if not domain:
            skipped_no_domain += 1
            continue
        if domain in seen_domains:
            skipped_dup += 1
            continue

        # Generate a unique ref code (cheap retry on collision; near-impossible)
        for _ in range(8):
            code = gen_ref_code(rng)
            if code not in seen_codes:
                seen_codes.add(code)
                break
        else:
            print(f"  WARN: ref_code collisions for {domain}, skipping", file=sys.stderr)
            continue

        seen_domains.add(domain)
        rows.append({
            "ref_code": code,
            "linkedin_url": lead.get("linkedin_url"),
            "company": lead.get("company"),
            "website": lead.get("website"),
            "domain": domain,
            "industry": lead.get("industry"),
            "city": lead.get("city"),
            "status": "pending",
        })
        if args.limit and len(rows) >= args.limit:
            break

    print(
        f"\nPlan: insert {len(rows)} new test_submissions  "
        f"(skipped {skipped_no_domain} no-domain, {skipped_dup} duplicates)",
        file=sys.stderr,
    )
    if args.dry_run:
        for r in rows[:5]:
            print(f"  {r['ref_code']}  {r['domain']:30s}  {r['company']}", file=sys.stderr)
        return

    if not rows:
        print("Nothing to insert.", file=sys.stderr)
        return

    upsert("test_submissions", rows, on_conflict="ref_code")
    total = select("test_submissions", "select=count")
    print(
        f"Done. test_submissions has "
        f"{total[0]['count'] if total else '?'} rows.",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
