#!/usr/bin/env python3
"""Live-check websites in the audited sendable lead CSV.

The goal is not to scrape deeply. It validates basic reachability and whether
the final URL/page content plausibly matches the company in the row.
"""
import argparse
import csv
import html
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

from audit_sendable import company_tokens, host_for, registrable_ish


UA = "Mozilla/5.0 (compatible; CarterCoLeadAudit/1.0)"
TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)
TAG_RE = re.compile(r"<[^>]+>")


def normalize_url(url):
    url = (url or "").strip()
    if not url:
        return ""
    return url if "://" in url else f"https://{url}"


def token_match_score(company, host, title, body):
    tokens = company_tokens(company)
    if not tokens:
        return 0
    haystacks = [
        registrable_ish(host).lower(),
        (title or "").lower(),
        (body or "").lower()[:50000],
    ]
    score = 0
    for token in tokens:
        if any(token in h for h in haystacks):
            score += 1
    return score / len(tokens)


def fetch(row, timeout):
    url = normalize_url(row.get("website", ""))
    company = row.get("company", "")
    if not url:
        return {"live_status": "missing_website"}

    req = urllib.request.Request(url, headers={"User-Agent": UA})
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            final_url = resp.geturl()
            status = getattr(resp, "status", 0)
            content_type = resp.headers.get("Content-Type", "")
            raw = resp.read(200000)
    except urllib.error.HTTPError as e:
        final_url = e.geturl()
        status = e.code
        content_type = e.headers.get("Content-Type", "") if e.headers else ""
        raw = e.read(80000)
    except Exception as e:
        return {
            "live_status": "fetch_error",
            "live_http_status": "",
            "live_final_url": "",
            "live_final_host": "",
            "live_title": "",
            "live_company_match_score": "0.00",
            "live_notes": str(e)[:160],
        }

    text = raw.decode("utf-8", errors="ignore")
    title_m = TITLE_RE.search(text)
    title = html.unescape(TAG_RE.sub(" ", title_m.group(1))).strip() if title_m else ""
    plain = html.unescape(TAG_RE.sub(" ", text))
    final_host = host_for(final_url)
    score = token_match_score(company, final_host, title, plain)
    notes = []
    if status >= 400:
        notes.append("http_error")
    if "text/html" not in content_type.lower() and title == "":
        notes.append("non_html_or_empty")
    if score < 0.34:
        notes.append("company_not_found_on_page")
    live_status = "ok" if not notes else "review"
    return {
        "live_status": live_status,
        "live_http_status": str(status),
        "live_final_url": final_url,
        "live_final_host": final_host,
        "live_title": title[:180],
        "live_company_match_score": f"{score:.2f}",
        "live_notes": ";".join(notes),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="in_csv", default="data/master_sendable_audit.csv")
    ap.add_argument("--out", default="data/master_sendable_live_website_audit.csv")
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--timeout", type=float, default=8.0)
    args = ap.parse_args()

    with open(args.in_csv, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
        fieldnames = list(rows[0].keys()) if rows else []

    live_fields = [
        "live_status", "live_http_status", "live_final_url", "live_final_host",
        "live_title", "live_company_match_score", "live_notes",
    ]
    started = time.time()
    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(fetch, r, args.timeout): i for i, r in enumerate(rows)}
        for fut in as_completed(futures):
            i = futures[fut]
            rows[i].update(fut.result())
            done += 1
            if done <= 20 or done % 100 == 0:
                print(f"[{done}/{len(rows)}] checked")

    with open(args.out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames + live_fields)
        w.writeheader()
        w.writerows(rows)

    ok = sum(1 for r in rows if r.get("live_status") == "ok")
    review = len(rows) - ok
    print(f"Checked: {len(rows)} in {time.time() - started:.0f}s")
    print(f"Live OK: {ok}")
    print(f"Live review: {review}")
    print(f"Written: {args.out}")


if __name__ == "__main__":
    main()
