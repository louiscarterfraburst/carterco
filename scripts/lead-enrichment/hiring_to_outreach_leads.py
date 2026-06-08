#!/usr/bin/env python3
"""Bridge the hiring-signal play into /outreach.

Stage 3 of the hiring intake. Takes the decision-makers found by
apify_enrich_brands.py and seeds them into the live pipeline as a tagged play:

  apify_hiring_intake.py  →  apify_enrich_brands.py  →  THIS  →  SendPilot

Two outputs, mirroring scripts/lead-enrichment-v2/export_for_sendpilot.py:
  1. Upserts public.outreach_leads with a synthesized contact_email AND
     play='hiring_signal'. When SendPilot fires connection.accepted, the
     existing webhook chain resolves the lead by linkedin_url, and
     outreach_record_invite reads `play` onto outreach_pipeline.play (verified
     2026-06-06) — so the lead lands in the cockpit tagged as a hiring lead.
  2. A SendPilot-importable CSV (--sendpilot-out) to upload to a SendPilot
     campaign, which is what actually fires the LinkedIn invites.

We pre-seed outreach_leads (CarterCo's pattern) rather than lead_inbox, because
the lead_inbox→outreach_leads promotion does not yet carry `play`.

synth_email / slug_of are copied byte-for-byte from export_for_sendpilot.py so
the synthesized join key matches what the rest of the pipeline expects.

Usage:
  set -a; source .env.local; set +a
  python3 scripts/lead-enrichment/hiring_to_outreach_leads.py \\
    --in clients/carterco/data/hiring_enriched_dk.csv \\
    --sendpilot-out clients/carterco/data/hiring_sendpilot_import.csv \\
    [--play hiring_signal] [--limit N] [--dry-run]

Input = apify_enrich_brands.py output (columns: brand, domain, first_name,
last_name, title, linkedin_profile_url, status, country, ...). Only rows with
status='found' and a real linkedin_profile_url are staged.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# CarterCo workspace UUID (louis@carterco.dk). DO NOT confuse with Tresyv
# (2740ba1f-…). The hiring play is CarterCo's own outbound.
WORKSPACE_ID = "1e067f9a-d453-41a7-8bc4-9fdb5644a5fa"

SB_URL = (
    os.environ.get("SUPABASE_URL")
    or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    or sys.exit("SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL required")
)
SB_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or sys.exit(
    "SUPABASE_SERVICE_ROLE_KEY required"
)

SLUG_NORMALIZE_RE = re.compile(r"[^a-z0-9-]+")


def slug_of(url: str) -> str:
    """Last path segment of a LinkedIn URL, normalised. Mirrors the SQL trigger
    public.outreach_leads_set_slug(). Copied from export_for_sendpilot.py."""
    if not url:
        return ""
    seg = url.rstrip("/").split("/")[-1]
    return SLUG_NORMALIZE_RE.sub("-", seg.lower())


def synth_email(linkedin_url: str) -> str:
    """Deterministic synthesized email matching the v1 format. Copied from
    export_for_sendpilot.py so the join key is identical across the pipeline."""
    if not linkedin_url:
        return ""
    s = slug_of(linkedin_url)[:30]
    h = hashlib.sha1(linkedin_url.rstrip("/").encode()).hexdigest()[:6]
    return f"carterco+li-{s}-{h}@carterco.dk"


def clean_website(url: str | None) -> str:
    """Site origin only — drop paths/params/fragments. From export_for_sendpilot."""
    raw = (url or "").strip()
    if not raw:
        return ""
    candidate = raw if "://" in raw else "https://" + raw
    try:
        parsed = urllib.parse.urlparse(candidate)
    except Exception:
        return raw
    if not parsed.netloc:
        return raw
    return f"{(parsed.scheme or 'https').lower()}://{parsed.netloc.lower()}"


def upsert_outreach_leads(rows: list[dict]) -> None:
    """PostgREST bulk upsert on linkedin_url (matches import_to_lead_inbox.py)."""
    body = json.dumps(rows).encode()
    req = urllib.request.Request(
        f"{SB_URL}/rest/v1/outreach_leads?on_conflict=linkedin_url",
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
        urllib.request.urlopen(req, timeout=60)
    except urllib.error.HTTPError as e:
        sys.exit(f"outreach_leads upsert failed: {e.code} {e.read().decode()[:300]}")


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9æøå]", "", (s or "").lower())


def clean_role(title: str) -> str:
    """Posted role title -> short {role} label (mirrors add_to_sendpilot_campaign)."""
    t = (title or "").lower()
    if "sdr" in t or "sales development" in t:
        return "SDR"
    if "bdr" in t:
        return "BDR"
    if "account executive" in t or re.search(r"\bae\b", t):
        return "Account Executive"
    if "business develop" in t or "forretningsudvikl" in t:
        return "Business Developer"
    if "salgskonsulent" in t:
        return "salgskonsulent"
    if "sælger" in t or "saelger" in t:
        return "sælger"
    raw = (title or "").strip()
    return raw if (raw and len(raw) <= 30 and raw.count(" ") <= 3) else "sælger"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="inp", required=True, help="apify_enrich_brands output CSV")
    ap.add_argument("--sendpilot-out", required=True, help="SendPilot-importable CSV")
    ap.add_argument("--play", default="hiring_signal", help="play tag (default hiring_signal)")
    ap.add_argument("--companies", default="clients/carterco/data/hiring_companies_dk.csv",
                    help="intake companies file (carries trigger_role for the {role} merge)")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true", help="write CSV only, skip the upsert")
    args = ap.parse_args()

    enriched = list(csv.DictReader(open(args.inp, encoding="utf-8")))
    # trigger_role per company → the {role} merge field downstream
    role_by_co: dict[str, str] = {}
    try:
        for c in csv.DictReader(open(args.companies, encoding="utf-8")):
            role_by_co[_norm(c.get("brand", ""))] = c.get("trigger_role", "")
    except FileNotFoundError:
        print(f"note: {args.companies} not found — role will fall back to title")
    found = [r for r in enriched
             if (r.get("status") == "found")
             and (r.get("linkedin_profile_url") or "").strip().startswith("http")]
    # Dedupe by linkedin_url, preserve order.
    seen: set[str] = set()
    leads = []
    for r in found:
        url = r["linkedin_profile_url"].strip()
        if url in seen:
            continue
        seen.add(url)
        leads.append(r)
    if args.limit:
        leads = leads[: args.limit]
    print(f"{len(enriched)} enriched rows → {len(leads)} found decision-makers to stage "
          f"(play={args.play})")

    # 1. SendPilot import CSV.
    sp = Path(args.sendpilot_out)
    sp.parent.mkdir(parents=True, exist_ok=True)
    no_website = 0
    with open(sp, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["linkedinUrl", "firstName", "lastName",
                                          "company", "title", "website"])
        w.writeheader()
        for r in leads:
            website = clean_website(r.get("domain"))
            if not website:
                no_website += 1
            w.writerow({
                "linkedinUrl": r["linkedin_profile_url"].strip(),
                "firstName": (r.get("first_name") or "").strip(),
                "lastName": (r.get("last_name") or "").strip(),
                "company": (r.get("brand") or "").strip(),
                "title": (r.get("title") or "").strip(),
                "website": website,
            })
    print(f"wrote {len(leads)} rows → {sp}")
    if no_website:
        print(f"  WARNING: {no_website} rows have no website (SendSpark render gate will fail)")

    if args.dry_run:
        print("--dry-run: skipping outreach_leads upsert")
        return 0

    # 2. Seed outreach_leads tagged with the play.
    rows = []
    for r in leads:
        url = r["linkedin_profile_url"].strip()
        first = (r.get("first_name") or "").strip()
        last = (r.get("last_name") or "").strip()
        rows.append({
            "linkedin_url": url,
            "first_name": first or None,
            "last_name": last or None,
            "full_name": f"{first} {last}".strip() or None,
            "company": (r.get("brand") or "").strip() or None,
            "title": (r.get("title") or "").strip() or None,
            "website": clean_website(r.get("domain")) or None,
            "contact_email": synth_email(url),
            "workspace_id": WORKSPACE_ID,
            "play": args.play,
            "role": clean_role(role_by_co.get(_norm(r.get("brand") or ""), "")),
            # `slug` is set by the outreach_leads_set_slug trigger.
        })
    print(f"upserting {len(rows)} rows into outreach_leads (play={args.play})…")
    upsert_outreach_leads(rows)
    print("done. Next: upload the SendPilot CSV to a campaign; accepts land in "
          f"/outreach tagged play={args.play}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
