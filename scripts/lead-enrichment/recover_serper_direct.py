#!/usr/bin/env python3
"""Direct-Serper website recovery for misses where the LI company page didn't
yield a Website field but a company NAME is known.

Strategy: Serper search '"{company}"', pick the first organic result that's a
real homepage (not LinkedIn / social / aggregator), then Haiku-verify the
domain plausibly belongs to the company.

Reads `--master` (data/master.csv), processes rows with no website but a
non-empty company. Resumable via `data/progress_serper_direct.jsonl`.
On finish, patches the master CSV in place: sets `website`,
`website_source='serper_direct'`, clears `miss_reason`.

Env vars required: SERPER_API_KEY, ANTHROPIC_API_KEY

Usage:
  python3 recover_serper_direct.py --master data/master.csv [--limit N]
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

SERPER_KEY = os.environ.get("SERPER_API_KEY") or sys.exit("SERPER_API_KEY not set")
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY") or sys.exit(
    "ANTHROPIC_API_KEY not set"
)
PROGRESS = "data/progress_serper_direct.jsonl"

SOCIAL_HOSTS = {
    "linkedin.com", "www.linkedin.com",
    "facebook.com", "www.facebook.com", "m.facebook.com",
    "instagram.com", "www.instagram.com",
    "twitter.com", "x.com", "www.twitter.com",
    "youtube.com", "www.youtube.com",
    "tiktok.com", "www.tiktok.com",
    "pinterest.com", "www.pinterest.com",
    "wikipedia.org", "en.wikipedia.org", "da.wikipedia.org",
    "crunchbase.com", "www.crunchbase.com",
    "bloomberg.com", "www.bloomberg.com",
    "trustpilot.com", "dk.trustpilot.com", "www.trustpilot.com",
    "indeed.com", "dk.indeed.com", "www.indeed.com",
    "glassdoor.com", "www.glassdoor.com",
    "google.com", "www.google.com", "maps.google.com",
    "apollo.io", "www.apollo.io",
    "rocketreach.co", "www.rocketreach.co",
    "zoominfo.com", "www.zoominfo.com",
    "proff.dk", "www.proff.dk",
    "cvr.dk", "www.cvr.dk", "datacvr.virk.dk",
}


def serper_search(query, num=10):
    data = json.dumps({"q": query, "num": num}).encode()
    req = urllib.request.Request(
        "https://google.serper.dev/search",
        data=data,
        headers={"X-API-KEY": SERPER_KEY, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as f:
        return json.loads(f.read().decode())


def root_domain(url):
    try:
        host = urllib.parse.urlparse(url).hostname or ""
    except Exception:
        return ""
    return host.lower()


def homepage_url(url):
    p = urllib.parse.urlparse(url)
    return f"{p.scheme}://{p.netloc}/"


def haiku_verify(company, domain, snippet):
    prompt = (
        f"A Google search for a company returned this top result. Decide if "
        f"the domain is plausibly the company's official website.\n\n"
        f"Company name: {company!r}\n"
        f"Domain: {domain!r}\n"
        f"Result snippet (first 400 chars): {snippet[:400]!r}\n\n"
        f"Reply with one word: YES if the domain is plausibly the company's "
        f"own official site (not a directory, not a competitor, not a news "
        f"article ABOUT them), otherwise NO."
    )
    body = json.dumps({
        "model": "claude-haiku-4-5",
        "max_tokens": 5,
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
        txt = d.get("content", [{}])[0].get("text", "").strip().upper()
        return txt.startswith("YES")
    except Exception as e:
        print(f"  haiku err: {e}", file=sys.stderr)
        return False


def find_website(company):
    try:
        res = serper_search(f'"{company}"')
    except Exception as e:
        return "", f"serper_error: {e}"
    organic = res.get("organic", [])
    for hit in organic:
        link = hit.get("link", "")
        host = root_domain(link)
        if not host or host in SOCIAL_HOSTS:
            continue
        # ignore obvious non-homepage URLs that are deep articles
        snippet = hit.get("snippet", "") + " " + hit.get("title", "")
        if haiku_verify(company, host, snippet):
            return homepage_url(link), ""
    return "", "no_plausible_site"


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
    ap.add_argument("--master", required=True)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()

    rows = list(csv.DictReader(open(args.master)))
    fieldnames = list(rows[0].keys())
    todo = [r for r in rows if not r["website"] and r["company"].strip()]
    done = load_progress()
    pending = [r for r in todo if r["linkedinUrl"] not in done]
    print(f"Eligible (no website + has company): {len(todo)}")
    print(f"Already in progress file:           {len(done)}")
    print(f"To process this run:                {len(pending)}")
    if args.limit:
        pending = pending[: args.limit]

    os.makedirs(os.path.dirname(PROGRESS), exist_ok=True)
    pf = open(PROGRESS, "a")
    hits = 0
    processed = 0

    def worker(r):
        site, note = find_website(r["company"])
        return r, site, note

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(worker, r): r for r in pending}
        for fut in as_completed(futures):
            try:
                r, site, note = fut.result()
            except Exception as e:
                print(f"worker error: {e}", file=sys.stderr)
                continue
            processed += 1
            if site:
                hits += 1
            rec = {
                "linkedinUrl": r["linkedinUrl"],
                "company": r["company"],
                "website": site,
                "note": note,
            }
            pf.write(json.dumps(rec, ensure_ascii=False) + "\n")
            pf.flush()
            tag = site or f"({note})"
            print(f"[{processed}/{len(pending)}] {r['company'][:40]!r} -> {tag}")
    pf.close()

    print(f"\nHits this run: {hits}/{processed}")

    # Patch master in place
    done = load_progress()
    patched = 0
    for r in rows:
        rec = done.get(r["linkedinUrl"])
        if rec and rec.get("website") and not r["website"]:
            r["website"] = rec["website"]
            r["website_source"] = "serper_direct"
            r["miss_reason"] = ""
            patched += 1

    with open(args.master, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)
    print(f"Patched {patched} rows in {args.master}")


if __name__ == "__main__":
    main()
