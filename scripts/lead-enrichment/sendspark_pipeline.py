#!/usr/bin/env python3
"""End-to-end SendSpark dynamic-video pipeline.

For each lead in `--csv`:
  1) POST a prospect to SendSpark with a synthesized contactEmail derived from
     the lead's linkedinUrl (so we can match the webhook callback back).
  2) Wait for SendSpark to render and fire its webhook to webhook.site.
  3) Drain captured webhooks from webhook.site (delete after capture so we stay
     under their inbox cap), and write a JSONL of (linkedinUrl, videoLink).
  4) When all leads are accounted for (or `--max-wait` elapses), write a CSV
     copying the input plus a `videoLink` column.

Resumable: keeps a `--posted` JSONL log (linkedinUrl, contactEmail, _id, ts) and
a `--rendered` JSONL log (linkedinUrl, videoLink, contactEmail, ts). Reruns
skip already-posted leads.

Env vars required: SENDSPARK_API_KEY, SENDSPARK_API_SECRET, WEBHOOK_SITE_TOKEN
                   (also: SENDSPARK_WORKSPACE, SENDSPARK_DYNAMIC)
"""
import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API_KEY = os.environ.get("SENDSPARK_API_KEY") or sys.exit("SENDSPARK_API_KEY not set")
API_SECRET = os.environ.get("SENDSPARK_API_SECRET") or sys.exit("SENDSPARK_API_SECRET not set")
WS = os.environ.get("SENDSPARK_WORKSPACE") or sys.exit("SENDSPARK_WORKSPACE not set")
DYN = os.environ.get("SENDSPARK_DYNAMIC") or sys.exit("SENDSPARK_DYNAMIC not set")
WH_TOKEN = os.environ.get("WEBHOOK_SITE_TOKEN") or sys.exit("WEBHOOK_SITE_TOKEN not set")

SS_BASE = "https://api-gw.sendspark.com/v1"
WH_BASE = f"https://webhook.site/token/{WH_TOKEN}"


EMAIL_BASE = os.environ.get("SYNTH_EMAIL_BASE", "haugefrom+li-{tag}@haugefrom.com")


def synth_email(linkedin_url):
    """Stable, decode-able email from a LinkedIn URL.
    Uses +tag on a real domain to satisfy strict email validators."""
    import hashlib
    slug = (urllib.parse.urlparse(linkedin_url).path or "").rstrip("/").split("/")[-1]
    slug = re.sub(r"[^a-z0-9-]+", "-", slug.lower())[:30] or "lead"
    h = hashlib.sha1(linkedin_url.encode()).hexdigest()[:6]
    return EMAIL_BASE.format(tag=f"{slug}-{h}")


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


def ss_post_prospect(lead):
    payload = {
        "processAndAuthorizeCharge": True,
        "prospect": {
            "contactName": ((lead.get("firstName") or "").strip().split() or [""])[0],
            "contactEmail": synth_email(lead["linkedinUrl"]),
            "company": lead["company"][:80],
            "jobTitle": (lead.get("title") or "")[:120],
            "backgroundUrl": lead["website"] if lead.get("website") else "",
        },
    }
    code, body = http(
        f"{SS_BASE}/workspaces/{WS}/dynamics/{DYN}/prospect",
        "POST",
        payload,
        {"x-api-key": API_KEY, "x-api-secret": API_SECRET},
    )
    if code != 200:
        return None, code, body[:300]
    d = json.loads(body)
    p = next(
        (x for x in d.get("prospectList", []) if x.get("contactEmail") == payload["prospect"]["contactEmail"]),
        None,
    )
    return p, code, body


def webhook_drain():
    """Pull all queued webhooks from webhook.site, return list, then DELETE each.
    Returns list of parsed payloads."""
    code, body = http(f"{WH_BASE}/requests?sorting=newest&per_page=100", headers={"Accept": "application/json"})
    if code != 200:
        print(f"  webhook.site list error: {code}", file=sys.stderr)
        return []
    j = json.loads(body)
    out = []
    for r in j.get("data", []):
        try:
            out.append({"uuid": r["uuid"], "ts": r.get("created_at"), "body": json.loads(r.get("content") or "{}")})
        except Exception:
            continue
    return out


def webhook_delete(uuid):
    http(f"{WH_BASE}/request/{uuid}", "DELETE")


def load_jsonl(path):
    out = []
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except Exception:
                    continue
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True, help="input CSV (master_sendable_*.csv)")
    ap.add_argument("--out", required=True, help="output CSV with videoLink column")
    ap.add_argument("--posted", default="data/sendspark_posted.jsonl")
    ap.add_argument("--rendered", default="data/sendspark_rendered.jsonl")
    ap.add_argument("--limit", type=int, default=0, help="limit prospects to POST this run")
    ap.add_argument("--rate", type=float, default=2.5, help="seconds between POSTs (~30/min budget)")
    ap.add_argument("--poll-every", type=float, default=15.0, help="seconds between webhook drains")
    ap.add_argument("--max-wait", type=int, default=1800, help="max seconds to wait for renders after last POST")
    ap.add_argument("--post-only", action="store_true", help="only POST prospects, don't poll")
    ap.add_argument("--collect-only", action="store_true", help="only drain webhooks, don't POST")
    args = ap.parse_args()

    rows = list(csv.DictReader(open(args.csv)))
    fields = list(rows[0].keys()) + (["videoLink"] if "videoLink" not in rows[0].keys() else [])

    posted = {p["linkedinUrl"]: p for p in load_jsonl(args.posted)}
    rendered = {r["linkedinUrl"]: r for r in load_jsonl(args.rendered)}
    rendered_by_email = {r["contactEmail"]: r for r in rendered.values()}

    print(f"input rows:           {len(rows)}")
    print(f"already posted:       {len(posted)}")
    print(f"already rendered:     {len(rendered)}")

    os.makedirs(os.path.dirname(args.posted) or ".", exist_ok=True)
    posted_f = open(args.posted, "a")
    rendered_f = open(args.rendered, "a")

    todo = [r for r in rows if r["linkedinUrl"] not in posted]
    if args.limit:
        todo = todo[: args.limit]
    print(f"to POST this run:     {len(todo)}\n")

    last_post_ts = time.time()

    if not args.collect_only:
        for i, r in enumerate(todo, 1):
            email = synth_email(r["linkedinUrl"])
            p, code, body = ss_post_prospect(r)
            if not p:
                print(f"  [{i}/{len(todo)}] FAIL  {r['linkedinUrl']}  http={code}  body={body[:200]}")
                continue
            rec = {
                "linkedinUrl": r["linkedinUrl"],
                "contactEmail": email,
                "_id": p["_id"],
                "ts": time.time(),
            }
            posted_f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            posted_f.flush()
            posted[r["linkedinUrl"]] = rec
            print(f"  [{i}/{len(todo)}] posted  {r['firstName']:15} {r['company'][:25]:25}  email={email}")
            last_post_ts = time.time()
            time.sleep(args.rate)

    if args.post_only:
        return

    # Drain webhooks until all posted leads have a videoLink (or max-wait elapses)
    waited_after_last_post = 0
    while True:
        captured = webhook_drain()
        new_count = 0
        for w in captured:
            body = w["body"]
            email = body.get("contactEmail")
            if not email:
                continue
            posted_rec = next(
                (v for v in posted.values() if v["contactEmail"] == email), None
            )
            if not posted_rec:
                # Not from this batch — leave on webhook.site
                continue
            video_link = body.get("videoLink") or ""
            event = body.get("eventType")
            if event == "video_generated_dv" and video_link:
                if posted_rec["linkedinUrl"] not in rendered:
                    out = {
                        "linkedinUrl": posted_rec["linkedinUrl"],
                        "contactEmail": email,
                        "videoLink": video_link,
                        "embedLink": body.get("embedLink"),
                        "thumbnailUrl": body.get("thumbnailUrl"),
                        "ts": time.time(),
                    }
                    rendered_f.write(json.dumps(out, ensure_ascii=False) + "\n")
                    rendered_f.flush()
                    rendered[posted_rec["linkedinUrl"]] = out
                    new_count += 1
                    print(
                        f"    ✓ rendered  {posted_rec['linkedinUrl'][:60]}  →  {video_link}"
                    )
                webhook_delete(w["uuid"])
            elif event == "video_failed_dv":
                print(f"    ✗ FAILED render for {email}")
                webhook_delete(w["uuid"])
            else:
                # Unknown / engagement event for our prospects — clean up
                webhook_delete(w["uuid"])

        outstanding = len(posted) - len(rendered)
        if outstanding == 0:
            print("\nAll posted leads have a rendered videoLink.")
            break

        now = time.time()
        if not args.collect_only:
            waited_after_last_post = now - last_post_ts
            if waited_after_last_post > args.max_wait:
                print(
                    f"\nGiving up after {args.max_wait}s without progress. "
                    f"{outstanding} leads still missing videoLink."
                )
                break
        else:
            # Collect-only: bail when no new captures in 3 polls
            if new_count == 0:
                # one strike — bail after a couple
                pass
        if new_count:
            print(f"  outstanding: {outstanding}")
        time.sleep(args.poll_every)

    posted_f.close()
    rendered_f.close()

    # Build output CSV
    for r in rows:
        rec = rendered.get(r["linkedinUrl"], {})
        r["videoLink"] = rec.get("videoLink", "")

    with open(args.out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)

    have = sum(1 for r in rows if r.get("videoLink"))
    print(f"\nWritten: {args.out}  ({have}/{len(rows)} have videoLink)")


if __name__ == "__main__":
    main()
