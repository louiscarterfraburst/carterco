#!/usr/bin/env python3
"""IMAP poller for the persona Gmail inbox.

Connects via IMAP/SSL using an app password (no OAuth dance). Pulls new
messages, attributes each to a test_submission via:
  1. Sender domain matches submission.domain
  2. Ref code (RX-XXXXXX) found in subject or body — wins over (1) on conflict
  3. None of the above → unmatched, surfaces in admin UI

Idempotent: dedups on the IMAP Message-ID header (UNIQUE column).

Run modes:
  python3 poll_inbox.py              # one-shot pass
  python3 poll_inbox.py --watch      # poll forever every 60s
  python3 poll_inbox.py --since 7    # only mail from last N days

Required env:
  PERSONA_GMAIL_ADDRESS    e.g. you.persona@gmail.com
  PERSONA_GMAIL_APP_PWD    16-char app password from myaccount.google.com/apppasswords
  NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
"""
from __future__ import annotations
import argparse
import email
import email.policy
import imaplib
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from email.utils import parseaddr, parsedate_to_datetime

from _supabase import select_paged, insert, update


GMAIL_HOST = "imap.gmail.com"
GMAIL_PORT = 993

REF_CODE_RE = re.compile(r"\bRX-[A-Z0-9]{6}\b")
EMAIL_DOMAIN_RE = re.compile(r"^[^@]+@(.+)$")
GENERIC_DOMAINS = {
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "yahoo.com",
    "live.com", "icloud.com", "me.com", "mac.com", "protonmail.com",
    "msn.com", "aol.com",
}
# Ignore obvious system mail
SYSTEM_FROM_RE = re.compile(
    r"(noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|notifications?)@",
    re.IGNORECASE,
)


def env_or_die(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        sys.exit(f"{name} must be set")
    return v


def domain_of(address: str) -> str | None:
    m = EMAIL_DOMAIN_RE.match(address.strip().lower())
    if not m:
        return None
    host = m.group(1)
    # Strip subdomains down to the registrable bit, naive: keep last 2 labels
    # for .com, last 3 for .co.uk-style — good enough for first-pass match.
    parts = host.split(".")
    if len(parts) >= 3 and parts[-2] in {"co", "ac", "gov", "org"} and len(parts[-1]) == 2:
        return ".".join(parts[-3:])
    if len(parts) >= 2:
        return ".".join(parts[-2:])
    return host


def load_submissions_index() -> tuple[dict[str, dict], dict[str, dict]]:
    """Return (by_domain, by_ref_code) maps. Only loads submitted ones."""
    rows = select_paged(
        "test_submissions",
        query="status=eq.submitted&select=id,domain,ref_code,company,first_response_at",
    )
    by_domain: dict[str, dict] = {}
    by_ref: dict[str, dict] = {}
    for r in rows:
        if r.get("domain"):
            by_domain.setdefault(r["domain"], r)  # first wins on dup-domain (rare)
        if r.get("ref_code"):
            by_ref[r["ref_code"]] = r
    return by_domain, by_ref


def existing_message_ids() -> set[str]:
    rows = select_paged("test_responses", query="select=message_id")
    return {r["message_id"] for r in rows if r.get("message_id")}


def extract_text(msg: email.message.EmailMessage) -> str:
    """Pull the first text/plain part, fall back to text/html stripped."""
    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            if ctype == "text/plain":
                try:
                    return part.get_content()
                except Exception:
                    return part.get_payload(decode=True).decode("utf-8", errors="ignore")
        for part in msg.walk():
            if part.get_content_type() == "text/html":
                try:
                    html = part.get_content()
                except Exception:
                    html = part.get_payload(decode=True).decode("utf-8", errors="ignore")
                return re.sub(r"<[^>]+>", " ", html)
    else:
        try:
            return msg.get_content()
        except Exception:
            return msg.get_payload(decode=True).decode("utf-8", errors="ignore") if msg.get_payload() else ""
    return ""


EMAIL_TAG_RE = re.compile(r"\+(RX-[A-Z0-9]{6})@", re.IGNORECASE)


def extract_email_tag_ref(addr: str) -> str | None:
    """Pull the ref out of an email +tag, e.g.
    'louis.sustmann.carter+RX-EEVSW4@gmail.com' → 'RX-EEVSW4'."""
    if not addr:
        return None
    m = EMAIL_TAG_RE.search(addr)
    return m.group(1).upper() if m else None


def attribute(
    from_addr: str, subject: str, body: str, to_addr: str,
    by_domain: dict[str, dict], by_ref: dict[str, dict],
) -> tuple[dict | None, str | None, float]:
    """Return (matched_submission, matched_via, confidence)."""
    # 1. Email +tag in To/Delivered-To — most reliable, survives even when
    # the prospect replies without quoting the original. Doesn't depend on
    # message body (which we no longer include the ref in).
    tag_ref = extract_email_tag_ref(to_addr)
    if tag_ref and tag_ref in by_ref:
        return by_ref[tag_ref], "email_tag", 1.0

    # 2. Ref code in subject or body (legacy — for old submissions that
    # included "Ref: RX-XXXXXX" in the message body).
    for blob in (subject or "", body or ""):
        m = REF_CODE_RE.search(blob)
        if m and m.group(0) in by_ref:
            return by_ref[m.group(0)], "ref_code", 1.0

    # 3. Sender domain
    addr_dom = domain_of(from_addr)
    if addr_dom and addr_dom not in GENERIC_DOMAINS and addr_dom in by_domain:
        return by_domain[addr_dom], "domain", 0.85

    return None, None, 0.0


def fetch_new(
    imap: imaplib.IMAP4_SSL,
    since: datetime,
    seen_ids: set[str],
) -> list[dict]:
    imap.select("INBOX", readonly=True)
    date_str = since.strftime("%d-%b-%Y")
    typ, data = imap.search(None, f'(SINCE "{date_str}")')
    if typ != "OK":
        return []
    out: list[dict] = []
    for num in data[0].split():
        typ, msg_data = imap.fetch(num, "(RFC822)")
        if typ != "OK" or not msg_data or not msg_data[0]:
            continue
        raw = msg_data[0][1]
        msg = email.message_from_bytes(raw, policy=email.policy.default)
        msgid = (msg.get("Message-ID") or "").strip()
        if not msgid or msgid in seen_ids:
            continue
        from_raw = msg.get("From") or ""
        from_name, from_addr = parseaddr(from_raw)
        if SYSTEM_FROM_RE.search(from_addr or ""):
            continue
        # Capture ALL recipient addresses so we can look for +tags. Gmail
        # preserves +tags in To: of a reply, but in some cases the original
        # tag is only visible in Delivered-To: (server-side header), so we
        # check both. parseaddr handles the "Name <addr>" form.
        to_addrs = []
        for hdr_name in ("To", "Delivered-To", "X-Original-To", "Cc"):
            for raw in msg.get_all(hdr_name) or []:
                _, a = parseaddr(raw)
                if a:
                    to_addrs.append(a.lower())
        to_combined = " ".join(to_addrs)
        try:
            received = parsedate_to_datetime(msg.get("Date") or "")
            if received and not received.tzinfo:
                received = received.replace(tzinfo=timezone.utc)
        except Exception:
            received = datetime.now(timezone.utc)
        body = extract_text(msg)
        out.append({
            "message_id": msgid,
            "from_address": (from_addr or "").lower(),
            "from_name": from_name or None,
            "from_domain": domain_of(from_addr or ""),
            "subject": msg.get("Subject") or "",
            "body": body,
            "to_address": to_combined,
            "received_at": received.isoformat() if received else None,
        })
    return out


def run_once(args) -> int:
    user = env_or_die("PERSONA_GMAIL_ADDRESS")
    pwd = env_or_die("PERSONA_GMAIL_APP_PWD")

    print(f"Connecting to {GMAIL_HOST} as {user}…", file=sys.stderr)
    imap = imaplib.IMAP4_SSL(GMAIL_HOST, GMAIL_PORT)
    imap.login(user, pwd)
    try:
        since = datetime.now(timezone.utc) - timedelta(days=args.since)
        seen_ids = existing_message_ids()
        by_domain, by_ref = load_submissions_index()

        msgs = fetch_new(imap, since, seen_ids)
        print(f"  {len(msgs)} new messages since {since:%Y-%m-%d}", file=sys.stderr)

        rows: list[dict] = []
        attributed = 0
        for m in msgs:
            sub, via, conf = attribute(
                m["from_address"], m["subject"], m["body"],
                m.get("to_address") or "", by_domain, by_ref,
            )
            rows.append({
                "submission_id": sub["id"] if sub else None,
                "channel": "email",
                "received_at": m["received_at"],
                "from_address": m["from_address"],
                "from_name": m["from_name"],
                "from_domain": m["from_domain"],
                "subject": m["subject"][:500] if m["subject"] else None,
                "body_excerpt": (m["body"] or "")[:2000] or None,
                "message_id": m["message_id"],
                "matched_via": via,
                "match_confidence": conf if conf else None,
            })
            if sub:
                attributed += 1
                print(
                    f"  ✓ {via:8s} {m['from_address']:40s} → {sub['company']}",
                    file=sys.stderr,
                )
            else:
                print(
                    f"  ? unmatched {m['from_address']:40s} {m['subject'][:60]}",
                    file=sys.stderr,
                )

        if rows:
            insert("test_responses", rows)
        print(
            f"Inserted {len(rows)} responses, {attributed} attributed",
            file=sys.stderr,
        )
        return len(rows)
    finally:
        try:
            imap.logout()
        except Exception:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", type=int, default=14, help="Days back to scan (default 14)")
    ap.add_argument("--watch", action="store_true", help="Loop forever, polling every 60s")
    ap.add_argument("--interval", type=int, default=60)
    args = ap.parse_args()

    if args.watch:
        while True:
            try:
                run_once(args)
            except Exception as e:
                print(f"poll error: {e}", file=sys.stderr)
            time.sleep(args.interval)
    else:
        run_once(args)


if __name__ == "__main__":
    main()
