#!/usr/bin/env python3
"""Enrich a SendPilot extracted-leads CSV with company websites by reading
each lead's LinkedIn company page via Jina Reader, and POST the results
into a destination SendPilot campaign with customFields.website populated.

Env vars required:
  SENDPILOT_API_KEY

Usage:
  python3 enrich_li.py --csv <path> --campaign <id> [--sample N] [--post]
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
from concurrent.futures import ThreadPoolExecutor, as_completed

SENDPILOT_KEY = os.environ.get("SENDPILOT_API_KEY") or sys.exit(
    "SENDPILOT_API_KEY not set"
)
SENDPILOT_BASE = "https://api.sendpilot.ai/v1"
WEBSITE_RE = re.compile(r"Website\s*\[([^\]]+)\]\(([^)]+)\)")


def normalize_company_link(link):
    if not link:
        return ""
    p = urllib.parse.urlparse(link)
    m = re.match(r"(/company/[^/]+)", p.path.rstrip("/"))
    return f"https://www.linkedin.com{m.group(1)}" if m else ""


def fetch_website(company_linkedin_url, retries=3):
    jina = f"https://r.jina.ai/{company_linkedin_url}"
    for attempt in range(retries):
        try:
            req = urllib.request.Request(jina, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=45) as f:
                body = f.read().decode("utf-8", errors="ignore")
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries - 1:
                time.sleep(3 * (attempt + 1))
                continue
            return ""
        except Exception:
            if attempt < retries - 1:
                time.sleep(2)
                continue
            return ""
        m = WEBSITE_RE.search(body)
        if not m:
            return ""
        label = m.group(1).strip()
        if label.startswith("http"):
            return label
        real = re.search(r"url=(https?%3A[^&]+)", m.group(2))
        return urllib.parse.unquote(real.group(1)) if real else ""
    return ""


def process_row(row):
    first = (row.get("firstName") or "").strip()
    last = (row.get("lastName") or "").strip()
    linkedin_url = (row.get("linkedinUrl") or "").strip()
    company = (row.get("currentCompany") or "").strip()
    headline = (row.get("headline") or "").strip()
    if len(headline) > 200:
        headline = headline[:197] + "..."
    co_link = normalize_company_link((row.get("currentCompanyLink") or "").strip())
    website = fetch_website(co_link) if co_link else ""
    item = {
        "linkedinUrl": linkedin_url,
        "firstName": first,
        "lastName": last,
        "company": company,
        "title": headline,
    }
    if website:
        item["customFields"] = {"website": website}
    return {
        "name": f"{first} {last}".strip(),
        "company": company,
        "website": website,
        "item": item,
    }


def load_csv(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def load_progress(progress_path):
    done = {}
    if not os.path.exists(progress_path):
        return done
    with open(progress_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
                done[o["item"]["linkedinUrl"]] = o
            except Exception:
                continue
    return done


def sp_post_leads(campaign_id, items):
    payload = json.dumps({"campaignId": campaign_id, "leads": items}).encode()
    req = urllib.request.Request(
        f"{SENDPILOT_BASE}/leads",
        data=payload,
        headers={
            "X-API-Key": SENDPILOT_KEY,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as f:
            return f.read().decode()
    except urllib.error.HTTPError as e:
        return f"HTTP {e.code}: {e.read().decode()[:800]}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--campaign", required=True)
    ap.add_argument("--sample", type=int, default=0)
    ap.add_argument("--workers", type=int, default=5)
    ap.add_argument("--post", action="store_true")
    ap.add_argument("--progress", default="data/progress_li.jsonl")
    args = ap.parse_args()

    rows = load_csv(args.csv)
    if args.sample:
        rows = rows[: args.sample]
    print(f"Loaded {len(rows)} rows")

    done_by_url = load_progress(args.progress)
    print(f"Resumed {len(done_by_url)} leads from progress")
    todo = [r for r in rows
            if (r.get("linkedinUrl") or "").strip() not in done_by_url]
    print(f"{len(todo)} to process")

    os.makedirs(os.path.dirname(args.progress), exist_ok=True)
    progress_f = open(args.progress, "a")
    processed = hits = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(process_row, r): r for r in todo}
        for fut in as_completed(futures):
            try:
                res = fut.result()
            except Exception as e:
                print(f"worker error: {e}", file=sys.stderr)
                continue
            processed += 1
            if res.get("website"):
                hits += 1
            status = res.get("website") or "(no website on LinkedIn page)"
            print(f"[{processed}/{len(todo)}] {res['name']} @ {res['company']!r} → {status}")
            progress_f.write(json.dumps(res, ensure_ascii=False) + "\n")
            progress_f.flush()
    progress_f.close()

    done_by_url = load_progress(args.progress)
    all_items = [d["item"] for d in done_by_url.values() if d.get("item")]
    with_website = sum(1 for it in all_items if "customFields" in it)
    print(f"\nEnriched: {len(all_items)}  with website: {with_website} "
          f"({with_website / max(len(all_items), 1) * 100:.1f}%)")

    if not args.post:
        print("Dry run — pass --post to upload to SendPilot.")
        return

    print(f"\nPosting {len(all_items)} leads to campaign {args.campaign}…")
    for i in range(0, len(all_items), 100):
        batch = all_items[i:i + 100]
        resp = sp_post_leads(args.campaign, batch)
        print(f"  batch {i//100 + 1}: {resp}")
    print("Done.")


if __name__ == "__main__":
    main()
