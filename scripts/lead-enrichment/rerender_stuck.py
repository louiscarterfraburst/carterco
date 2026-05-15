#!/usr/bin/env python3
"""One-off: re-POST already-rendered outreach_pipeline leads to SendSpark with
the correct backgroundUrl from outreach_leads.

Why this exists: acceptance_responder.py historically loaded leads from a CSV
snapshot at script startup. If a lead's website got enriched in Supabase AFTER
the CSV was generated, SendSpark received backgroundUrl="" and fell back to the
workspace default (e.g. tresyv.dk). The video shows the wrong background.

This script fixes it by reading the current website from outreach_leads and
POSTing each affected lead's prospect record to SendSpark again. SendSpark
re-renders with the correct background and fires its webhook; the existing
sendspark-webhook edge function (or acceptance_responder.py drain) updates
outreach_pipeline with the new video_link / rendered_message.

Usage:
  SUPABASE_URL=...
  SUPABASE_SERVICE_ROLE_KEY=...
  SENDSPARK_API_KEY=...
  SENDSPARK_API_SECRET=...
  SENDSPARK_WORKSPACE=...
  SENDSPARK_DYNAMIC=...
  SYNTH_EMAIL_BASE='haugefrom+li-{tag}@haugefrom.com'   # match the one used originally
  python3 rerender_stuck.py \\
    --workspace 2740ba1f-d5d5-4008-bf43-b45367c73134 \\
    --status pending_approval \\
    [--dry-run]
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def env(name, required=True):
    v = os.environ.get(name)
    if required and not v:
        sys.exit(f"{name} not set")
    return v


SB_URL = env("SUPABASE_URL", required=False) or env("NEXT_PUBLIC_SUPABASE_URL")
SB_KEY = env("SUPABASE_SERVICE_ROLE_KEY")
SS_KEY = env("SENDSPARK_API_KEY")
SS_SECRET = env("SENDSPARK_API_SECRET")
SS_WS = env("SENDSPARK_WORKSPACE")
SS_DYN = env("SENDSPARK_DYNAMIC")

SS_BASE = "https://api-gw.sendspark.com/v1"
SYNTH_EMAIL_BASE = os.environ.get("SYNTH_EMAIL_BASE", "haugefrom+li-{tag}@haugefrom.com")


def http(url, method="GET", payload=None, headers=None, timeout=30):
    data = json.dumps(payload).encode() if payload else None
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as f:
            return f.status, f.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def synth_email(linkedin_url):
    slug = (urllib.parse.urlparse(linkedin_url).path or "").rstrip("/").split("/")[-1]
    slug = re.sub(r"[^a-z0-9-]+", "-", slug.lower())[:30] or "lead"
    h = hashlib.sha1(linkedin_url.encode()).hexdigest()[:6]
    return SYNTH_EMAIL_BASE.format(tag=f"{slug}-{h}")


def fetch_affected_leads(workspace_id, status):
    """Pull rows from outreach_pipeline + outreach_leads where the pipeline is
    in `status` for `workspace_id`, joined to lead's current website."""
    headers = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}", "Accept": "application/json"}
    # Use PostgREST embedded join: outreach_pipeline -> outreach_leads via sendpilot_lead_id.
    # PostgREST needs an FK to embed; we don't know if it's declared, so query both
    # separately and join in Python.
    url = (
        f"{SB_URL}/rest/v1/outreach_pipeline"
        f"?workspace_id=eq.{workspace_id}"
        f"&status=eq.{status}"
        f"&select=sendpilot_lead_id,linkedin_url,contact_email,video_link,rendered_at"
    )
    code, body = http(url, headers=headers)
    if code != 200:
        sys.exit(f"Supabase pipeline query failed: {code} {body[:300]}")
    pipeline = json.loads(body or "[]")
    if not pipeline:
        return []
    ids = [p["sendpilot_lead_id"] for p in pipeline if p.get("sendpilot_lead_id")]
    id_filter = ",".join(f'"{i}"' for i in ids)
    url = (
        f"{SB_URL}/rest/v1/outreach_leads"
        f"?sendpilot_lead_id=in.({id_filter})"
        f"&select=sendpilot_lead_id,linkedin_url,first_name,last_name,company,title,website"
    )
    code, body = http(url, headers=headers)
    if code != 200:
        sys.exit(f"Supabase leads query failed: {code} {body[:300]}")
    leads = {l["sendpilot_lead_id"]: l for l in json.loads(body or "[]")}
    out = []
    for p in pipeline:
        l = leads.get(p["sendpilot_lead_id"])
        if not l:
            print(f"  ! no outreach_leads row for sendpilot_lead_id={p['sendpilot_lead_id']}")
            continue
        out.append({
            "sendpilot_lead_id": p["sendpilot_lead_id"],
            "linkedin_url": l.get("linkedin_url") or p.get("linkedin_url"),
            "first_name": l.get("first_name") or "",
            "last_name": l.get("last_name") or "",
            "company": l.get("company") or "",
            "title": l.get("title") or "",
            "website": l.get("website") or "",
            "current_video_link": p.get("video_link") or "",
        })
    return out


def post_prospect(lead, dry_run=False):
    email = synth_email(lead["linkedin_url"])
    payload = {
        "processAndAuthorizeCharge": True,
        "prospect": {
            "contactName": (lead.get("first_name") or "").strip().split()[0] if lead.get("first_name") else "",
            "contactEmail": email,
            "company": (lead.get("company") or "")[:80],
            "jobTitle": (lead.get("title") or "")[:120],
            "backgroundUrl": lead.get("website") or "",
        },
    }
    if dry_run:
        print(f"  DRY  {lead['first_name']} {lead['last_name']} @ {lead['company']}  bg={payload['prospect']['backgroundUrl']!r}  email={email}")
        return 200, '{"dryRun":true}'
    url = f"{SS_BASE}/workspaces/{SS_WS}/dynamics/{SS_DYN}/prospect"
    code, body = http(url, "POST", payload, {"x-api-key": SS_KEY, "x-api-secret": SS_SECRET})
    return code, body


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True, help="workspace_id (uuid)")
    ap.add_argument("--status", default="pending_approval", help="pipeline status to re-render (default: pending_approval)")
    ap.add_argument("--dry-run", action="store_true", help="print what would be POSTed without calling SendSpark")
    ap.add_argument("--sleep", type=float, default=1.0, help="seconds to pause between SendSpark POSTs (rate-limit guard)")
    args = ap.parse_args()

    print(f"Workspace: {args.workspace}")
    print(f"Status filter: {args.status}")
    print(f"Dry run: {args.dry_run}")
    print()

    leads = fetch_affected_leads(args.workspace, args.status)
    print(f"Found {len(leads)} affected leads")
    print()

    missing_website = [l for l in leads if not l.get("website")]
    if missing_website:
        print(f"WARNING: {len(missing_website)} leads still have empty website in outreach_leads — skipping:")
        for l in missing_website:
            print(f"  - {l['first_name']} {l['last_name']} @ {l['company']}  ({l['linkedin_url']})")
        print()

    actionable = [l for l in leads if l.get("website")]
    print(f"Re-rendering {len(actionable)} leads with valid websites:")
    print()

    ok = 0
    fail = 0
    for lead in actionable:
        code, body = post_prospect(lead, dry_run=args.dry_run)
        if 200 <= code < 300:
            ok += 1
            print(f"  OK   {lead['first_name']} {lead['last_name']} @ {lead['company']}  bg={lead['website']}  code={code}")
        else:
            fail += 1
            print(f"  FAIL {lead['first_name']} {lead['last_name']} @ {lead['company']}  code={code}  body={body[:200]}")
        if not args.dry_run and args.sleep > 0:
            time.sleep(args.sleep)

    print()
    print(f"Done. OK={ok}  FAIL={fail}  SKIPPED_NO_WEBSITE={len(missing_website)}")
    print()
    print("Next: SendSpark will fire video_generated_dv webhooks. The new")
    print("rendered_message + video_link should land in outreach_pipeline")
    print("within a few minutes via sendspark-webhook (or webhook.site drain).")


if __name__ == "__main__":
    main()
