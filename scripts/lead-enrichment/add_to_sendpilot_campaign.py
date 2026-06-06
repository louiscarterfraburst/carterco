#!/usr/bin/env python3
"""Stage 4 of the hiring-signal play: push enriched leads into a SendPilot campaign.

The final hop. apify_hiring_intake → apify_enrich_brands gave us the decision-
makers; this POSTs them into a SendPilot campaign via the public API, so the
campaign runs the cadence (blank invite → on accept → DM with {{role}} +
{{videoLink}}). Confirmed working 2026-06-06: POST /v1/leads, leadsAdded:1.

  apify_hiring_intake → apify_enrich_brands → THIS → SendPilot campaign

The campaign is set up ONCE in the SendPilot UI:
  - connect step = blank invite (no note — see feedback: CarterCo sends blank invites)
  - message step = the DM template, referencing {{role}} and {{videoLink}}
Then every batch (manual or the daily cron) just gets POSTed in. Duplicates are
skipped by LinkedIn URL, so re-runs are safe.

API (docs.sendpilot.ai): POST https://api.sendpilot.ai/v1/leads
  body: {"campaignId": "...", "leads": [{linkedinUrl, firstName, lastName,
         company, title, role, ...custom fields}]}  — max 100 leads/request.
  Custom fields (like `role`) merge in the campaign template as {{role}}.

Usage:
  set -a; source .env.local; set +a
  python3 scripts/lead-enrichment/add_to_sendpilot_campaign.py \\
    --campaign-id <SendPilot campaign id> \\
    [--enriched clients/carterco/data/hiring_enriched_dk.csv] \\
    [--companies clients/carterco/data/hiring_companies_dk.csv] \\
    [--send]      # omit = preview only (safe default); --max guards oversized files

Get the campaign id from: GET https://api.sendpilot.ai/v1/campaigns
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import urllib.error
import urllib.request

KEY = os.environ.get("SENDPILOT_API_KEY") or sys.exit("SENDPILOT_API_KEY required")
BASE = "https://api.sendpilot.ai"
BATCH = 100  # API cap per request


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9æøå]", "", (s or "").lower())


def clean_role(title: str) -> str:
    """Posted role title → short label for the {{role}} merge field.
    'Sales Development Representative – Benelux' → 'SDR'."""
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
    # No keyword match: echo the raw title only if it actually looks like a title
    # (short), never a full job-ad sentence — that would garble {{role}} in the DM.
    raw = (title or "").strip()
    return raw if (raw and len(raw) <= 30 and raw.count(" ") <= 3) else "sælger"


def post_leads(campaign_id: str, leads: list[dict]) -> dict:
    body = json.dumps({"campaignId": campaign_id, "leads": leads}).encode()
    req = urllib.request.Request(
        f"{BASE}/v1/leads", data=body, method="POST",
        headers={"X-API-Key": KEY, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as f:
            return json.loads(f.read())
    except urllib.error.HTTPError as e:
        return {"error": f"{e.code}: {e.read().decode()[:300]}"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--campaign-id", required=True, help="SendPilot campaign id")
    ap.add_argument("--enriched", default="clients/carterco/data/hiring_enriched_dk.csv",
                    help="apify_enrich_brands output (the decision-makers)")
    ap.add_argument("--companies", default="clients/carterco/data/hiring_companies_dk.csv",
                    help="intake companies file (carries trigger_role for the {{role}} merge)")
    ap.add_argument("--send", action="store_true",
                    help="actually POST to the campaign. Omit = preview only (safe default).")
    ap.add_argument("--max", type=int, default=50,
                    help="abort if more than this many leads — guard against a wrong/huge input file")
    args = ap.parse_args()

    # trigger_role per company, for the {{role}} merge field
    role_by_co: dict[str, str] = {}
    try:
        for c in csv.DictReader(open(args.companies, encoding="utf-8")):
            role_by_co[_norm(c.get("brand", ""))] = c.get("trigger_role", "")
    except FileNotFoundError:
        print(f"note: {args.companies} not found — role merge will fall back to person title")

    try:
        enriched_rows = list(csv.DictReader(open(args.enriched, encoding="utf-8")))
    except FileNotFoundError:
        sys.exit(f"enriched file not found: {args.enriched} — run apify_enrich_brands first")

    leads: list[dict] = []
    for r in enriched_rows:
        if r.get("status") != "found":
            continue
        url = (r.get("linkedin_profile_url") or "").strip()
        if not url.startswith("http"):
            continue
        company = (r.get("brand") or "").strip()
        trigger = role_by_co.get(_norm(company)) or r.get("title") or ""
        leads.append({
            "linkedinUrl": url,
            "firstName": (r.get("first_name") or "").strip(),
            "lastName": (r.get("last_name") or "").strip(),
            "company": company,
            "title": (r.get("title") or "").strip(),
            "role": clean_role(trigger),     # custom field → {{role}} in the template
        })

    print(f"{len(leads)} leads ready for campaign {args.campaign_id}")
    for l in leads:
        print(f"  {l['firstName']:12} {l['company'][:20]:22} role={l['role']:18} {l['linkedinUrl']}")

    if not leads:
        print("nothing to post")
        return 1
    if len(leads) > args.max:
        print(f"\nABORT: {len(leads)} leads exceeds --max {args.max}. "
              f"Wrong/oversized input file? Raise --max to override.")
        return 1
    if not args.send:
        print(f"\nPreview only — pass --send to POST these {len(leads)} to campaign {args.campaign_id}.")
        return 0

    added = dupes = invalid = 0
    for i in range(0, len(leads), BATCH):
        resp = post_leads(args.campaign_id, leads[i:i + BATCH])
        if resp.get("error"):
            print(f"  ERROR after {added} added (batch at offset {i}): {resp['error']}")
            return 1
        added += resp.get("leadsAdded", 0)
        dupes += resp.get("duplicatesSkipped", 0)
        invalid += resp.get("invalidEntries", 0)
    print(f"\n=== added {added} | skipped {dupes} dupes | {invalid} invalid → campaign {args.campaign_id} ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
