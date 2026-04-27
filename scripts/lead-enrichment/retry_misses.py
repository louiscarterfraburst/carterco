#!/usr/bin/env python3
"""Retry LinkedIn-website extraction for companies we missed the first time.
Dedupes by company LinkedIn URL so each company page is fetched only once.
Slow pace (2 workers, longer backoff) to avoid Jina flakiness.

Run:
  python3 retry_misses.py --csv <source> --progress data/progress_li.jsonl
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

WEBSITE_RE = re.compile(r"Website\s*\[([^\]]+)\]\(([^)]+)\)")


def normalize_company_link(link):
    if not link:
        return ""
    p = urllib.parse.urlparse(link)
    m = re.match(r"(/company/[^/]+)", p.path.rstrip("/"))
    return f"https://www.linkedin.com{m.group(1)}" if m else ""


def fetch_website(company_linkedin_url, retries=5):
    jina = f"https://r.jina.ai/{company_linkedin_url}"
    for attempt in range(retries):
        try:
            req = urllib.request.Request(jina, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=60) as f:
                body = f.read().decode("utf-8", errors="ignore")
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < retries - 1:
                time.sleep(5 * (attempt + 1))
                continue
            return ""
        except Exception:
            if attempt < retries - 1:
                time.sleep(3 * (attempt + 1))
                continue
            return ""
        m = WEBSITE_RE.search(body)
        if not m:
            if len(body) < 5000 and attempt < retries - 1:
                time.sleep(5 * (attempt + 1))
                continue
            return ""
        label = m.group(1).strip()
        if label.startswith("http"):
            return label
        real = re.search(r"url=(https?%3A[^&]+)", m.group(2))
        return urllib.parse.unquote(real.group(1)) if real else ""
    return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--progress", required=True)
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--out", default="data/recovered.json")
    args = ap.parse_args()

    missed_urls = set()
    with open(args.progress) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if not obj.get("website"):
                missed_urls.add(obj["item"]["linkedinUrl"])

    co_link_by_lead = {}
    with open(args.csv, newline="", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            lead_url = (r.get("linkedinUrl") or "").strip()
            if lead_url in missed_urls:
                co_link = normalize_company_link(
                    (r.get("currentCompanyLink") or "").strip()
                )
                if co_link:
                    co_link_by_lead[lead_url] = {
                        "co_link": co_link,
                        "company": (r.get("currentCompany") or "").strip(),
                    }

    unique_co_links = {}
    for v in co_link_by_lead.values():
        unique_co_links.setdefault(v["co_link"], v["company"])

    print(f"Misses: {len(missed_urls)}, retryable: {len(co_link_by_lead)}, unique cos: {len(unique_co_links)}")

    website_by_co = {}

    def worker(co_link):
        return co_link, fetch_website(co_link)

    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(worker, c): c for c in unique_co_links}
        for fut in as_completed(futures):
            co_link, website = fut.result()
            done += 1
            company = unique_co_links.get(co_link, "")
            status = website or "(still no website)"
            print(f"[{done}/{len(unique_co_links)}] {company!r} → {status}")
            if website:
                website_by_co[co_link] = website
            time.sleep(0.3)

    recovered = []
    for lead_url, meta in co_link_by_lead.items():
        w = website_by_co.get(meta["co_link"])
        if w:
            recovered.append({
                "linkedinUrl": lead_url,
                "company": meta["company"],
                "website": w,
            })

    print(f"\nUnique companies recovered: {len(website_by_co)}/{len(unique_co_links)}")
    print(f"Lead rows that now have a website: {len(recovered)}")

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump({"website_by_co": website_by_co, "recovered_leads": recovered},
                  f, indent=2, ensure_ascii=False)
    print(f"Written: {args.out}")


if __name__ == "__main__":
    main()
