#!/usr/bin/env python3
"""Detect rows where firstName/lastName has been polluted with emojis, job
titles, or taglines (from LinkedIn scrape noise). Use Claude Haiku to clean
the affected rows. Writes a new CSV with cleaned names.

Env var required:
  ANTHROPIC_API_KEY

Usage:
  python3 clean_names.py --in <csv> --out <csv> [--dry-run]
"""
import argparse
import csv
import json
import os
import re
import sys
import urllib.request

ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY") or sys.exit(
    "ANTHROPIC_API_KEY not set"
)

EMOJI_RE = re.compile(
    r"[\U0001F300-\U0001FAFF\u2600-\u27BF\u2300-\u23FF\u2B00-\u2BFF\u25A0-\u25FF"
    r"\u2190-\u21FF\u2B05-\u2B07\u27A1\u27A0\u261B-\u261E]"
)
TITLE_WORDS = re.compile(
    r"\b(marketing|marketingchef|head of|ceo|cto|cfo|coo|cmo|cio|"
    r"manager|director|leder|chef|founder|owner|consultant|specialist|"
    r"expert|officer|advisor|sælger|medejer|partner|freelancer|"
    r"entrepreneur|iværksætter|kommunikation|kommunikations|"
    r"digital|ekspert|analyst|strateg|leader|agency|agent"
    r")\b",
    re.IGNORECASE,
)
WEIRD_CHARS = re.compile(r"[|►▶⭐🚀💡🎯•⏰❓]")


def is_polluted(first, last):
    if EMOJI_RE.search(first) or EMOJI_RE.search(last):
        return "emoji"
    if WEIRD_CHARS.search(first) or WEIRD_CHARS.search(last):
        return "special_chars"
    if len(last) > 35:
        return "long_lastname"
    if TITLE_WORDS.search(last):
        return "title_in_lastname"
    if re.search(r"\(.{5,}\)", last):
        return "parenthetical_lastname"
    return None


def haiku_clean(first, last, title, company):
    prompt = (
        "You are cleaning up a name record. The firstName and lastName fields "
        "have been polluted with taglines, job titles, or emojis from the "
        "source (LinkedIn scrape). Return the person's real firstName and "
        "lastName only. Do not invent information.\n\n"
        f"Polluted firstName: {first!r}\n"
        f"Polluted lastName:  {last!r}\n"
        f"Their job title / headline: {title!r}\n"
        f"Their company: {company!r}\n\n"
        "Respond with ONLY a JSON object on one line:\n"
        '{"firstName": "...", "lastName": "..."}\n'
        "If the lastName is genuinely missing (e.g. only initial like 'K.'), "
        "keep it as-is. If firstName is obviously not a person name "
        "(e.g. 'Marketing'), set both to empty string."
    )
    body = json.dumps({
        "model": "claude-haiku-4-5",
        "max_tokens": 150,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "x-api-key": ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as f:
            d = json.loads(f.read().decode())
        txt = d["content"][0]["text"].strip()
        m = re.search(r"\{.*\}", txt, re.DOTALL)
        if not m:
            return None
        return json.loads(m.group(0))
    except Exception as e:
        print(f"  haiku err: {e}", file=sys.stderr)
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="in_csv", required=True)
    ap.add_argument("--out", dest="out_csv", required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    rows = list(csv.DictReader(open(args.in_csv)))

    flagged = [(i, r, is_polluted(r["firstName"], r["lastName"]))
               for i, r in enumerate(rows)
               if is_polluted(r["firstName"], r["lastName"])]
    print(f"Flagged {len(flagged)} rows for cleanup")
    for _, r, reason in flagged:
        print(f"  [{reason}] {r['firstName']!r} / {r['lastName']!r}")

    if args.dry_run:
        print("\nDry run — not calling Haiku or writing CSV.")
        return

    changes = []
    for i, r, _ in flagged:
        cleaned = haiku_clean(r["firstName"], r["lastName"],
                              r.get("title", ""), r.get("company", ""))
        if not cleaned:
            continue
        nf = cleaned.get("firstName", r["firstName"]).strip()
        nl = cleaned.get("lastName", r["lastName"]).strip()
        if (nf, nl) == (r["firstName"], r["lastName"]):
            continue
        changes.append((i, r["firstName"], r["lastName"], nf, nl))
        r["firstName"] = nf
        r["lastName"] = nl
        if "fullName" in r:
            r["fullName"] = f"{nf} {nl}".strip()

    print(f"\nCleaned {len(changes)} rows")

    with open(args.out_csv, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=rows[0].keys())
        w.writeheader()
        w.writerows(rows)
    print(f"Written: {args.out_csv}")


if __name__ == "__main__":
    main()
