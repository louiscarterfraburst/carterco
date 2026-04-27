#!/usr/bin/env python3
"""Resumable, rate-limited Haiku cleanup of multi-word firstName rows.
Normalizes firstName for use as "Hi {{firstName}}," greeting.

Env var required:
  ANTHROPIC_API_KEY

Usage:
  python3 clean_multi_first.py --in <csv> --out <csv>
"""
import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY") or sys.exit(
    "ANTHROPIC_API_KEY not set"
)
PROGRESS = "data/name_progress.jsonl"

PROMPT = """You are normalizing a contact record's name fields for cold outreach.
The outreach template is: "Hi {firstName}," — so firstName should be ONE given
name the person would be addressed by in a casual first-name greeting.

Judge the input. Common patterns:
- Compound first names people actually go by ("Anne Marie", "Marie Louise",
  "Jean Claude") → KEEP the compound.
- Merged firstName + middleName ("Thomas Sehested Skovshoved") → KEEP only
  the first given name as firstName; move the rest to the START of lastName.
- Title prefix ("Dr. Suren", "Mr. John") → STRIP the title; firstName is the
  real given name.
- Middle initial ("Charlotte I.") → KEEP firstName as-is (initial is common).
- Ambiguous South/East Asian compound names ("Maria Bahar", "Shamoona Rani")
  → If unsure, KEEP the compound (safer for that culture).

Respond with ONLY a JSON object on ONE line:
{"firstName": "...", "lastName": "...", "note": "short reason"}

Input:
firstName: %s
lastName:  %s
headline:  %s"""


def haiku(first, last, title, retries=5):
    body = json.dumps({
        "model": "claude-haiku-4-5",
        "max_tokens": 200,
        "messages": [{
            "role": "user",
            "content": PROMPT % (json.dumps(first), json.dumps(last),
                                 json.dumps((title or "")[:200])),
        }],
    }).encode()
    for attempt in range(retries):
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
            with urllib.request.urlopen(req, timeout=30) as f:
                d = json.loads(f.read().decode())
            txt = d["content"][0]["text"].strip()
            m = re.search(r"\{.*\}", txt, re.DOTALL)
            if not m:
                raise ValueError("no JSON")
            return json.loads(m.group(0))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(2 ** attempt * 3)
                continue
            raise
    raise RuntimeError("retries exhausted")


def load_progress():
    done = {}
    if os.path.exists(PROGRESS):
        with open(PROGRESS) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    o = json.loads(line)
                    done[o["linkedinUrl"]] = o
                except Exception:
                    continue
    return done


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="in_csv", required=True)
    ap.add_argument("--out", dest="out_csv", required=True)
    args = ap.parse_args()

    rows = list(csv.DictReader(open(args.in_csv)))
    targets = [(i, r) for i, r in enumerate(rows)
               if len(r["firstName"].split()) > 1]
    done = load_progress()
    todo = [(i, r) for i, r in targets if r["linkedinUrl"] not in done]
    print(f"Targets: {len(targets)}  done: {len(done)}  todo: {len(todo)}")

    os.makedirs(os.path.dirname(PROGRESS), exist_ok=True)
    pf = open(PROGRESS, "a")
    # Stay under 50 RPM → ~1.3s between calls
    DELAY = 1.3
    start = time.time()
    for k, (i, r) in enumerate(todo, 1):
        try:
            out = haiku(r["firstName"], r["lastName"], r.get("title", ""))
            nf = (out.get("firstName") or "").strip()
            nl = (out.get("lastName") or "").strip()
            rec = {"linkedinUrl": r["linkedinUrl"],
                   "old_first": r["firstName"], "old_last": r["lastName"],
                   "new_first": nf, "new_last": nl,
                   "note": out.get("note", "")}
        except Exception as e:
            rec = {"linkedinUrl": r["linkedinUrl"],
                   "old_first": r["firstName"], "old_last": r["lastName"],
                   "new_first": r["firstName"], "new_last": r["lastName"],
                   "error": str(e)}
        pf.write(json.dumps(rec, ensure_ascii=False) + "\n"); pf.flush()
        if k <= 10 or k % 25 == 0:
            elapsed = time.time() - start
            print(f"[{k}/{len(todo)}] {rec['old_first']!r} → {rec.get('new_first')!r}  ({elapsed:.0f}s)")
        time.sleep(DELAY)
    pf.close()

    done = load_progress()
    applied = 0
    for r in rows:
        if r["linkedinUrl"] in done:
            rec = done[r["linkedinUrl"]]
            nf = rec.get("new_first", r["firstName"])
            nl = rec.get("new_last", r["lastName"])
            if (nf, nl) != (r["firstName"], r["lastName"]):
                r["firstName"] = nf
                r["lastName"] = nl
                if "fullName" in r:
                    r["fullName"] = f"{nf} {nl}".strip()
                applied += 1

    with open(args.out_csv, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=rows[0].keys())
        w.writeheader()
        w.writerows(rows)
    print(f"\nApplied {applied} changes. Written: {args.out_csv}")


if __name__ == "__main__":
    main()
