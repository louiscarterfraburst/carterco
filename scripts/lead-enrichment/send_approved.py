#!/usr/bin/env python3
"""Process the approval queue.

Reads `data/pending_approvals.csv` (written by acceptance_responder for
already-connected leads), and for each row marked `Y` in the `approved`
column, POST `/v1/inbox/send` to deliver the personalised message via
SendPilot. Writes the result back to a `result` column and timestamps it.

Workflow:
  1. acceptance_responder.py queues already-connected acceptances into the CSV.
  2. Open data/pending_approvals.csv in Numbers / Excel, review each row.
  3. Set `approved` = Y (yes, send) or N (no, skip) — leave blank to defer.
  4. Save and run this script. Y rows are sent; N rows are marked rejected;
     blank rows are left for next time.

Env: SENDPILOT_API_KEY
"""
import argparse
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.request

KEY = os.environ.get("SENDPILOT_API_KEY") or sys.exit("SENDPILOT_API_KEY not set")


def send(lead_id, message):
    req = urllib.request.Request(
        "https://api.sendpilot.ai/v1/inbox/send",
        data=json.dumps({"leadId": lead_id, "message": message}).encode(),
        headers={"X-API-Key": KEY, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as f:
            return f.status, f.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default="data/pending_approvals.csv")
    ap.add_argument("--responded-log", default="data/responded.jsonl")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(args.csv):
        sys.exit(f"no approval queue at {args.csv}")
    rows = list(csv.DictReader(open(args.csv)))
    if not rows:
        print("queue is empty"); return

    fields = list(rows[0].keys())
    if "result" not in fields:
        fields.append("result")
    if "resultAt" not in fields:
        fields.append("resultAt")

    rsf = open(args.responded_log, "a")

    counts = {"sent": 0, "rejected": 0, "skipped": 0, "error": 0}
    for r in rows:
        if r.get("result"):
            counts["skipped"] += 1; continue
        approved = (r.get("approved") or "").strip().upper()
        if approved == "Y":
            if args.dry_run:
                code, body = 200, '{"dryRun":true}'
                print(f"  DRY  {r['firstName']} {r['lastName']} @ {r['company']}")
            else:
                code, body = send(r["leadId"], r["message"])
                print(f"  SEND {r['firstName']} {r['lastName']} @ {r['company']}  → HTTP {code}")
            r["result"] = f"sent_{code}" if code in (200, 201) else f"error_{code}"
            r["resultAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
            counts["sent" if code in (200, 201) else "error"] += 1
            rsf.write(json.dumps({
                "leadId": r["leadId"], "linkedinUrl": r.get("linkedinUrl",""),
                "videoLink": r.get("videoLink",""), "status": code,
                "response": body[:300], "approved_via": "manual_csv",
                "ts": time.time(),
            }, ensure_ascii=False) + "\n"); rsf.flush()
        elif approved == "N":
            r["result"] = "rejected"
            r["resultAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
            counts["rejected"] += 1
            print(f"  SKIP {r['firstName']} {r['lastName']} @ {r['company']}  (rejected)")
        else:
            counts["skipped"] += 1

    with open(args.csv, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader(); w.writerows(rows)

    print(f"\nsent: {counts['sent']}  rejected: {counts['rejected']}  "
          f"deferred: {counts['skipped']}  errors: {counts['error']}")


if __name__ == "__main__":
    main()
