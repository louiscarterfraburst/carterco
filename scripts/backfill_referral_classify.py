#!/usr/bin/env python3
"""One-shot backfill: classify historical inbound replies that the webhook
missed (intent IS NULL), and fire the title-search path for referrals where
the prospect named a role but no person (e.g. "kontakt vores COO").

What it does for each unclassified row:
  1. Call Anthropic Haiku 4.5 with the same classifier prompt the edge
     function uses (kept inline to avoid coupling to the deployed version).
  2. Update outreach_replies.intent / referral_target_* / classified_at.
  3. If intent=referral + name: insert outreach_alt_contacts (linkedin_url=null
     — matches sendpilot-webhook's reply_referral hint behavior).
  4. If intent=referral + title-only: fire SendPilot lead-database search at
     the same company filtered by [title], stamp outreach_pipeline.
  5. If intent=question/interested: call Claude to draft a reply, write to
     outreach_replies.suggested_reply.

Run once. Idempotent on already-classified rows (skips them).

Env:
  ANTHROPIC_API_KEY, SENDPILOT_API_KEY, SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL).

Usage:
  set -a; source .env.local; set +a
  python3 scripts/backfill_referral_classify.py [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

SB_URL = (
    os.environ.get("SUPABASE_URL")
    or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    or sys.exit("SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL required")
)
SB_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or sys.exit(
    "SUPABASE_SERVICE_ROLE_KEY required"
)
AN_KEY = os.environ.get("ANTHROPIC_API_KEY") or sys.exit("ANTHROPIC_API_KEY required")
SP_KEY = os.environ.get("SENDPILOT_API_KEY") or sys.exit("SENDPILOT_API_KEY required")

SB_HEADERS = {
    "apikey": SB_KEY,
    "Authorization": f"Bearer {SB_KEY}",
    "Content-Type": "application/json",
}

# Mirror of the prompt in supabase/functions/outreach-ai/index.ts:classifyReply
# (with the same "right person" guard the deployed prompt now has). Kept
# inline so a stale deploy doesn't quietly change backfill behavior.
CLASSIFY_PROMPT = """Classify a LinkedIn reply to a cold outreach message.

Choose ONE intent from this enum:
- interested: shows positive engagement, wants more info, asks for a meeting, says 'sounds good'.
- question: asks a clarifying question about the offer or sender, no clear yes/no yet.
- decline: not interested, says no, asks to be removed, currently happy with provider.
- ooo: out-of-office auto-reply or temporary unavailability.
- referral: says you should talk to someone else (a colleague, the owner, another department).
            Examples: 'wrong person — try our owner', 'tal med min kollega Bjarne', 'reach out to marketing'.
- other: small talk, thanks-only, off-topic, unclassifiable.

If intent=referral, ALSO extract whatever target info is in the reply:
- name:    the referred person's name if mentioned, else null. Use the form they wrote it (don't invent surnames).
- title:   the referred person's role/title if mentioned (e.g. 'owner', 'CMO', 'marketing manager', 'COO', 'salgschef'), else null.
           Only set title if it's an ACTUAL job role. DO NOT extract generic referential phrases like 'right person', 'rette person', 'someone', 'anyone' as a title — those mean we don't know and should be null.
           If the reply names multiple roles (e.g. 'COO eller marketingschef', 'CMO or marketing manager'), join them with ' or ' in title.
- company: only if they referred us to a different company than theirs; usually null.
Leave fields null when unknown rather than guessing. If intent != referral, omit referralTarget entirely.

Output ONLY valid JSON, no preamble:
{"intent":"<enum>", "confidence":<0..1>, "reasoning":"<10 words max>", "referralTarget":{"name":"<or null>","title":"<or null>","company":"<or null>"}}

Lead context (the original recipient of our message):
  firstName: %s
  company:   %s

Reply text:
%s"""

TITLE_BLOCKLIST = {
    "right person", "rette person", "rigtige person", "den rette",
    "someone", "anyone", "person", "the right person",
}

# Mirror of splitTitles in _shared/referral-search.ts. Prospects name multiple
# titles in one breath ("COO eller marketingschef") — pass each as a distinct
# jobTitles[] entry so SendPilot ORs them in the same search.
TITLE_SPLIT_RE = re.compile(r"\s*(?:,|/|\bor\b|\beller\b|\bog\b|\band\b|&)\s*", re.IGNORECASE)


def split_titles(raw: str) -> list[str]:
    return [
        t for t in (s.strip() for s in TITLE_SPLIT_RE.split(raw))
        if t and t.lower() not in TITLE_BLOCKLIST
    ]


def http_get(url: str) -> dict | list:
    req = urllib.request.Request(url, headers=SB_HEADERS, method="GET")
    with urllib.request.urlopen(req, timeout=30) as f:
        return json.loads(f.read().decode())


def http_patch(path: str, where: dict, payload: dict) -> None:
    q = "&".join(f"{k}=eq.{urllib.parse.quote(str(v))}" for k, v in where.items())
    url = f"{SB_URL}/rest/v1/{path}?{q}"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={**SB_HEADERS, "Prefer": "return=minimal"},
        method="PATCH",
    )
    with urllib.request.urlopen(req, timeout=30) as f:
        f.read()


def http_post(path: str, payload: dict) -> None:
    req = urllib.request.Request(
        f"{SB_URL}/rest/v1/{path}",
        data=json.dumps(payload).encode(),
        headers={**SB_HEADERS, "Prefer": "return=minimal"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as f:
        f.read()


def claude_json(prompt: str, max_tokens: int = 200) -> dict:
    body = json.dumps({
        "model": "claude-haiku-4-5",
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "x-api-key": AN_KEY,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=45) as f:
                d = json.loads(f.read().decode())
            txt = (d.get("content") or [{}])[0].get("text", "")
            m = re.search(r"\{[\s\S]*\}", txt)
            if not m:
                raise ValueError(f"no JSON in response: {txt[:200]}")
            return json.loads(m.group(0))
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 3:
                time.sleep(2 ** attempt)
                continue
            raise


def fire_sendpilot_search(company: str, titles: list[str]) -> str | None:
    body = json.dumps({
        "name": f"carterco-backfill-{int(time.time())}",
        "limit": 5,
        "filters": {"companies": [company], "jobTitles": titles, "locations": []},
    }).encode()
    req = urllib.request.Request(
        "https://api.sendpilot.ai/v1/lead-database/searches",
        data=body,
        headers={"X-API-Key": SP_KEY, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as f:
            return json.loads(f.read().decode()).get("id")
    except urllib.error.HTTPError as e:
        print(f"  sendpilot HTTP {e.code}: {e.read().decode()[:200]}", file=sys.stderr)
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    # Pull unclassified inbound replies. Re-classify is idempotent on intent IS NULL,
    # so this is safe to re-run.
    rows = http_get(
        f"{SB_URL}/rest/v1/outreach_replies"
        f"?select=id,sendpilot_lead_id,message,workspace_id"
        f"&direction=eq.inbound&intent=is.null&order=received_at.desc"
    )
    print(f"Found {len(rows)} unclassified inbound replies.")

    for r in rows:
        msg = (r.get("message") or "").strip()
        if not msg:
            continue
        print(f"\n— {r['id'][:8]} lead={r['sendpilot_lead_id'][:10]}…")
        print(f"  msg: {msg[:120]!r}")

        # Pull lead context for prompt.
        pipe_rows = http_get(
            f"{SB_URL}/rest/v1/outreach_pipeline"
            f"?select=contact_email&sendpilot_lead_id=eq.{r['sendpilot_lead_id']}&limit=1"
        )
        contact_email = (pipe_rows[0] or {}).get("contact_email") if pipe_rows else None
        lead = None
        if contact_email:
            ll = http_get(
                f"{SB_URL}/rest/v1/outreach_leads"
                f"?select=first_name,company&contact_email=eq.{urllib.parse.quote(contact_email)}&limit=1"
            )
            lead = ll[0] if ll else None
        first_name = (lead or {}).get("first_name") or "?"
        company = (lead or {}).get("company") or "?"

        prompt = CLASSIFY_PROMPT % (
            json.dumps(first_name), json.dumps(company), msg,
        )

        try:
            parsed = claude_json(prompt, max_tokens=200)
        except Exception as e:
            print(f"  classify failed: {e}", file=sys.stderr)
            continue

        intent = (parsed.get("intent") or "").lower()
        if intent not in {"interested", "question", "decline", "ooo", "referral", "other"}:
            print(f"  bad intent: {intent}", file=sys.stderr)
            continue
        target = parsed.get("referralTarget") or {} if intent == "referral" else {}

        def clean(v):
            s = (v or "").strip() if isinstance(v, str) else ""
            return s if s and s.lower() != "null" else None

        t_name = clean(target.get("name"))
        t_title = clean(target.get("title"))
        t_company = clean(target.get("company"))

        print(f"  → intent={intent} name={t_name!r} title={t_title!r}")

        update = {
            "intent": intent,
            "confidence": float(parsed.get("confidence") or 0.5),
            "reasoning": (parsed.get("reasoning") or "")[:200],
            "classified_at": datetime.now(timezone.utc).isoformat(),
            "referral_target_name": t_name if intent == "referral" else None,
            "referral_target_title": t_title if intent == "referral" else None,
            "referral_target_company": t_company if intent == "referral" else None,
        }
        if args.dry_run:
            print(f"  [dry-run] would update outreach_replies: {update}")
        else:
            http_patch("outreach_replies", {"id": r["id"]}, update)

        # Post-classify actions ----------------------------------------------
        if intent == "referral" and t_name:
            # Mirror sendpilot-webhook's reply_referral alt_contact insert.
            payload = {
                "pipeline_lead_id": r["sendpilot_lead_id"],
                "workspace_id": r["workspace_id"],
                "name": t_name,
                "title": t_title,
                "company": t_company or company if company != "?" else None,
                "linkedin_url": None,
                "source": "reply_referral",
                "surfaced_at": datetime.now(timezone.utc).isoformat(),
            }
            if args.dry_run:
                print(f"  [dry-run] would insert alt_contact: {payload}")
            else:
                try:
                    http_post("outreach_alt_contacts", payload)
                    print(f"  + alt_contact inserted (name={t_name})")
                except urllib.error.HTTPError as e:
                    body = e.read().decode()[:300]
                    if "duplicate" not in body:
                        print(f"  alt_contact insert HTTP {e.code}: {body}", file=sys.stderr)

        elif intent == "referral" and t_title:
            titles = split_titles(t_title)
            if not titles:
                print(f"  skip title-search (no actionable titles in {t_title!r})")
            elif not company or company == "?":
                print(f"  skip title-search (no company on lead)")
            else:
                if args.dry_run:
                    print(f"  [dry-run] would fire SendPilot search company={company!r} titles={titles!r}")
                else:
                    sid = fire_sendpilot_search(company, titles)
                    if sid:
                        http_patch(
                            "outreach_pipeline",
                            {"sendpilot_lead_id": r["sendpilot_lead_id"]},
                            {"alt_search_id": sid, "alt_search_status": "pending"},
                        )
                        print(f"  + SendPilot search fired ({sid[:10]}…) titles={titles} — poll cron will surface candidates")

        elif intent in {"question", "interested"}:
            # Draft reply via outreach-ai's deployed draft_reply op. Keep that
            # path centralised — its prompt is workspace-aware.
            draft_url = f"{SB_URL}/functions/v1/outreach-ai?op=draft_reply"
            draft_body = json.dumps({"replyId": r["id"]}).encode()
            draft_req = urllib.request.Request(
                draft_url,
                data=draft_body,
                headers={
                    "Authorization": f"Bearer {SB_KEY}",
                    "Content-Type": "application/json",
                },
                method="POST",
            )
            if args.dry_run:
                print(f"  [dry-run] would call draft_reply for replyId={r['id'][:8]}")
            else:
                try:
                    with urllib.request.urlopen(draft_req, timeout=60) as f:
                        dj = json.loads(f.read().decode())
                    if dj.get("draft"):
                        http_patch(
                            "outreach_replies",
                            {"id": r["id"]},
                            {
                                "suggested_reply": dj["draft"],
                                "suggested_reply_generated_at": datetime.now(timezone.utc).isoformat(),
                            },
                        )
                        print(f"  + draft generated ({len(dj['draft'])} chars)")
                except urllib.error.HTTPError as e:
                    print(f"  draft_reply HTTP {e.code}: {e.read().decode()[:200]}", file=sys.stderr)

    print("\nDone.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
