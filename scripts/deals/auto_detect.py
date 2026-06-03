#!/usr/bin/env python3
"""Auto-detect deal stage/value drift from Gmail signals.

Reads `public.deals` from Supabase, pulls recent Gmail threads with each
contact, asks Claude to classify what changed, and (with --apply) writes
updates back to Supabase. The existing Postgres trigger then pushes the
changes to Attio.

This is the "always up to date" half of the deals stack:
  - A (supabase/functions/attio-sync-deal)   : deals -> Attio
  - C (supabase/functions/attio-webhook-deal): Attio -> deals
  - B (this script)                          : Gmail -> deals

Setup (one time):

    pip install google-auth google-auth-oauthlib google-api-python-client anthropic

    # 1. Create a Google Cloud OAuth client (Desktop app):
    #    https://console.cloud.google.com/apis/credentials
    #    Enable Gmail API, scope = https://www.googleapis.com/auth/gmail.readonly
    # 2. Download credentials.json -> ~/.config/carterco/gmail-credentials.json
    # 3. First run does browser auth; refresh token cached at
    #    ~/.config/carterco/gmail-token.json

Usage:

    set -a; source .env.local; set +a   # SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
    python3 scripts/deals/auto_detect.py          # dry-run: print proposed changes
    python3 scripts/deals/auto_detect.py --apply  # write updates to deals
    python3 scripts/deals/auto_detect.py --slug cleanstep --apply
    python3 scripts/deals/auto_detect.py --since-days 14
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Deferred imports so --help works without deps installed
def _lazy_imports():
    global GoogleCreds, google_request, build, anthropic
    from google.oauth2.credentials import Credentials as GoogleCreds  # type: ignore
    from google.auth.transport.requests import Request as google_request  # type: ignore
    from google_auth_oauthlib.flow import InstalledAppFlow  # type: ignore  # noqa: F401
    from googleapiclient.discovery import build  # type: ignore
    import anthropic  # type: ignore
    return InstalledAppFlow

CONFIG_DIR = Path.home() / ".config" / "carterco"
CREDENTIALS_FILE = CONFIG_DIR / "gmail-credentials.json"
TOKEN_FILE = CONFIG_DIR / "gmail-token.json"
GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]

STAGES = ("lead", "meeting_booked", "in_progress", "won", "lost")

SB_URL = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SB_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")

CLASSIFIER_PROMPT = """You are auditing CRM deal state for Carter & Co (CarterCo), a Danish solo-operator B2B service that builds and runs LinkedIn+email outbound systems for clients.

The deal "{slug}" with contact {person_name} <{person_email}> at {company_name} is currently in state:
  stage   : {stage}
  value   : {value_amount} {value_currency}
  last_contact_at: {last_contact_at}
  notes   : {notes}

Below are the {n_threads} most recent Gmail thread(s) involving that contact, with most recent message first. Each message shows date, sender, subject, snippet, and (if available) plain text body.

```
{threads_block}
```

Today's date: {today}

Analyze what the messages reveal about the deal's true current state. Stages mean:
- lead             : no real conversation yet, just an intro / accepted connection
- meeting_booked   : meeting scheduled OR proposal sent and awaiting response
- in_progress      : active back-and-forth, scoping, blockers being worked through
- won              : verbal/written yes confirmed, work has begun OR fastpris signed
- lost             : explicit no, OR 30+ days silence after a follow-up nudge

Respond as STRICT JSON with this shape (no other text):

{{
  "proposed_stage": "<one of: lead|meeting_booked|in_progress|won|lost>" or null,
  "proposed_value_amount": <number or null>,
  "proposed_last_contact_at": "<ISO 8601 date>" or null,
  "confidence": <0.0 to 1.0>,
  "rationale": "<one short Danish sentence>",
  "suggested_action": "<one short action sentence for Louis: nudge, escalate, leave alone, etc.>"
}}

Only propose a stage change you're confident about (>= 0.75 confidence). If nothing has changed, set proposed_stage = current stage and confidence reflects how sure you are nothing's moved.
"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true",
                    help="write proposed changes to public.deals (defaults to dry-run)")
    ap.add_argument("--confidence-threshold", type=float, default=0.85,
                    help="only auto-apply changes >= this confidence (default 0.85)")
    ap.add_argument("--slug", help="audit only this deal slug")
    ap.add_argument("--since-days", type=int, default=10,
                    help="Gmail search window in days (default 10)")
    ap.add_argument("--auth", action="store_true",
                    help="run Gmail OAuth flow (browser) to create/refresh token")
    args = ap.parse_args()

    flow_cls = _lazy_imports()

    if args.auth:
        run_oauth_flow(flow_cls)
        print(f"token saved -> {TOKEN_FILE}")
        return 0

    for var, name in [(SB_URL, "SUPABASE_URL"), (SB_KEY, "SUPABASE_SERVICE_ROLE_KEY"),
                      (ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY")]:
        if not var:
            sys.exit(f"{name} not set")

    gmail = build_gmail_client(flow_cls)
    deals = fetch_deals(args.slug)
    if not deals:
        print("no deals found (slug filter?)")
        return 0

    today = datetime.now(timezone.utc).date().isoformat()
    print(f"auditing {len(deals)} deal(s) — today {today}, "
          f"window {args.since_days}d, mode={'APPLY' if args.apply else 'dry-run'}")
    print()

    for eng in deals:
        print(f"== {eng['slug']:18}  current: {eng['stage']:14}  value: {eng.get('value_amount') or '-'} {eng.get('value_currency') or ''}")
        threads = pull_gmail_threads(gmail, eng["person_email"], args.since_days)
        if not threads:
            print(f"   no Gmail threads in last {args.since_days}d — skipping")
            print()
            continue

        proposal = classify_with_claude(eng, threads, today)
        if not proposal:
            print("   (Claude returned no proposal)")
            print()
            continue

        print(f"   proposed: stage={proposal.get('proposed_stage')}  "
              f"value={proposal.get('proposed_value_amount')}  "
              f"confidence={proposal.get('confidence')}")
        print(f"   rationale: {proposal.get('rationale')}")
        print(f"   action:    {proposal.get('suggested_action')}")

        if args.apply and changes_warrant_update(eng, proposal, args.confidence_threshold):
            apply_deal_update(eng["slug"], proposal)
            print("   APPLIED -> deals (trigger will push to Attio)")
        elif args.apply:
            print("   skipped (no material change or below confidence threshold)")
        print()

    return 0


def changes_warrant_update(eng: dict, proposal: dict, threshold: float) -> bool:
    if (proposal.get("confidence") or 0) < threshold:
        return False
    new_stage = proposal.get("proposed_stage")
    new_value = proposal.get("proposed_value_amount")
    stage_changed = new_stage and new_stage != eng["stage"]
    value_changed = new_value is not None and new_value != (eng.get("value_amount") or None)
    return bool(stage_changed or value_changed)


def apply_deal_update(slug: str, proposal: dict) -> None:
    import urllib.request
    payload: dict = {}
    if proposal.get("proposed_stage"): payload["stage"] = proposal["proposed_stage"]
    if proposal.get("proposed_value_amount") is not None:
        payload["value_amount"] = proposal["proposed_value_amount"]
    if proposal.get("proposed_last_contact_at"):
        payload["last_contact_at"] = proposal["proposed_last_contact_at"]
    if not payload:
        return
    req = urllib.request.Request(
        f"{SB_URL}/rest/v1/deals?slug=eq.{slug}",
        data=json.dumps(payload).encode(),
        method="PATCH",
        headers={
            "apikey": SB_KEY,
            "Authorization": f"Bearer {SB_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
    )
    urllib.request.urlopen(req, timeout=15).read()


def fetch_deals(slug: str | None) -> list[dict]:
    import urllib.request, urllib.parse
    qs = "select=*"
    if slug:
        qs += f"&slug=eq.{urllib.parse.quote(slug)}"
    req = urllib.request.Request(
        f"{SB_URL}/rest/v1/deals?{qs}",
        headers={"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"},
    )
    with urllib.request.urlopen(req, timeout=15) as f:
        return json.loads(f.read())


def build_gmail_client(flow_cls):
    creds = None
    if TOKEN_FILE.exists():
        creds = GoogleCreds.from_authorized_user_file(str(TOKEN_FILE), GMAIL_SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(google_request())
            TOKEN_FILE.write_text(creds.to_json())
        else:
            sys.exit("No valid Gmail token. Run: python3 scripts/deals/auto_detect.py --auth")
    return build("gmail", "v1", credentials=creds, cache_discovery=False)


def run_oauth_flow(flow_cls):
    if not CREDENTIALS_FILE.exists():
        sys.exit(f"Place Google OAuth client JSON at {CREDENTIALS_FILE} first.\n"
                 "See setup section in this file's docstring.")
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    flow = flow_cls.from_client_secrets_file(str(CREDENTIALS_FILE), GMAIL_SCOPES)
    creds = flow.run_local_server(port=0)
    TOKEN_FILE.write_text(creds.to_json())


def pull_gmail_threads(gmail, email: str, days: int) -> list[dict]:
    """Return last ~5 threads involving `email` in the last N days, with snippets + bodies."""
    after = (datetime.now() - timedelta(days=days)).strftime("%Y/%m/%d")
    q = f"(from:{email} OR to:{email}) after:{after}"
    res = gmail.users().threads().list(userId="me", q=q, maxResults=8).execute()
    thread_ids = [t["id"] for t in res.get("threads", [])]

    out = []
    for tid in thread_ids[:5]:
        full = gmail.users().threads().get(userId="me", id=tid, format="full").execute()
        msgs = []
        for m in full.get("messages", [])[-3:]:  # last 3 messages per thread
            headers = {h["name"].lower(): h["value"] for h in m["payload"].get("headers", [])}
            msgs.append({
                "date": headers.get("date", ""),
                "from": headers.get("from", ""),
                "to": headers.get("to", ""),
                "subject": headers.get("subject", ""),
                "snippet": m.get("snippet", ""),
                "body": _extract_plain_body(m["payload"])[:1500],
            })
        out.append({"thread_id": tid, "messages": msgs})
    return out


def _extract_plain_body(payload) -> str:
    import base64
    mime = payload.get("mimeType", "")
    body = payload.get("body", {})
    data = body.get("data", "")
    if mime == "text/plain" and data:
        return base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")
    for part in payload.get("parts", []) or []:
        if (txt := _extract_plain_body(part)):
            return txt
    return ""


def classify_with_claude(eng: dict, threads: list[dict], today: str) -> dict | None:
    threads_block = []
    for t in threads:
        for m in t["messages"]:
            threads_block.append(
                f"-- {m['date']} | from {m['from']} | re: {m['subject']}\n"
                f"   snippet: {m['snippet']}\n"
                f"   body: {m['body'][:800]}"
            )
    prompt = CLASSIFIER_PROMPT.format(
        slug=eng["slug"],
        person_name=eng.get("person_name") or "?",
        person_email=eng["person_email"],
        company_name=eng["company_name"],
        stage=eng["stage"],
        value_amount=eng.get("value_amount") or "—",
        value_currency=eng.get("value_currency") or "—",
        last_contact_at=eng.get("last_contact_at") or "—",
        notes=(eng.get("notes") or "")[:500],
        n_threads=len(threads),
        threads_block="\n\n".join(threads_block) or "(no thread bodies)",
        today=today,
    )
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    resp = client.messages.create(
        model="claude-opus-4-7",
        max_tokens=600,
        messages=[{"role": "user", "content": prompt}],
    )
    text = resp.content[0].text.strip()
    # Strip ```json fences if Claude wrapped it
    if text.startswith("```"):
        text = text.split("```", 2)[1]
        if text.startswith("json"):
            text = text[4:]
        text = text.strip("` \n")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        print(f"   ! Claude returned non-JSON:\n{text[:200]}")
        return None


if __name__ == "__main__":
    sys.exit(main())
