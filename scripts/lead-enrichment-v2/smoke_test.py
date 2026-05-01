#!/usr/bin/env python3
"""Smoke test: run Pass A on N leads from the CSV, no DB writes.

Just proves Jina (anonymous) still works and shows coverage %.
Output is JSONL on stdout (one result per line) + a summary on stderr.

Usage:
  python3 smoke_test.py --csv <path> [--n 30]
"""
import argparse
import csv
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

WEBSITE_RE = re.compile(r"Website\s*\[([^\]]+)\]\(([^)]+)\)", re.IGNORECASE)
PROFILE_COMPANY_LINK_RE = re.compile(
    r"\((https?://[^)]*linkedin\.com/company/[^)]+)\)"
)


def jina_read(url: str, timeout: int = 45) -> str:
    target = f"https://r.jina.ai/{url}"
    req = urllib.request.Request(
        target,
        headers={"User-Agent": "Mozilla/5.0", "Accept": "text/plain"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as f:
        return f.read().decode("utf-8", errors="ignore")


def jina_with_retry(url: str, retries: int = 3) -> str:
    for attempt in range(retries):
        try:
            return jina_read(url)
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries - 1:
                time.sleep(5 * (attempt + 1))
                continue
            raise
        except Exception:
            if attempt < retries - 1:
                time.sleep(2)
                continue
            raise
    return ""


def extract_website(body: str) -> str:
    m = WEBSITE_RE.search(body)
    if not m:
        return ""
    label = m.group(1).strip()
    if label.lower().startswith("http"):
        return label
    real = re.search(r"url=(https?%3A[^&]+)", m.group(2))
    return urllib.parse.unquote(real.group(1)) if real else ""


def normalize_company_link(raw: str) -> str:
    if not raw:
        return ""
    p = urllib.parse.urlparse(raw.strip())
    m = re.match(r"(/company/[^/]+)", p.path.rstrip("/"))
    return f"https://www.linkedin.com{m.group(1)}" if m else ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--n", type=int, default=30)
    args = ap.parse_args()

    with open(args.csv, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))

    # Prefer rows with currentCompanyLink (the fast path) so we measure
    # the *good* case first
    rows_with_link = [r for r in rows if (r.get("currentCompanyLink") or "").strip()]
    sample = rows_with_link[: args.n]

    hits = 0
    elapsed_total = 0.0
    print(f"\nSmoke-testing Pass A on {len(sample)} leads (anonymous Jina)…", file=sys.stderr)

    for i, row in enumerate(sample, 1):
        co_link = normalize_company_link(row.get("currentCompanyLink") or "")
        company = (row.get("currentCompany") or "").strip() or "?"
        name = (row.get("fullName") or "?").strip()

        t0 = time.time()
        website = ""
        err = ""
        try:
            body = jina_with_retry(co_link)
            website = extract_website(body)
        except Exception as e:
            err = str(e)[:200]
        dt = time.time() - t0
        elapsed_total += dt

        if website:
            hits += 1

        result = {
            "linkedin_url": row.get("linkedinUrl"),
            "company": company,
            "company_link": co_link,
            "website": website,
            "error": err,
            "elapsed_s": round(dt, 1),
        }
        print(json.dumps(result, ensure_ascii=False))
        sys.stdout.flush()

        mark = "✓" if website else ("✗" if err else "·")
        out = website or err or "(no Website on page)"
        print(f"  [{i}/{len(sample)}] {mark} {dt:>4.1f}s  {name} @ {company!r} → {out[:80]}", file=sys.stderr)

    pct = 100.0 * hits / max(len(sample), 1)
    rpm = 60.0 * len(sample) / max(elapsed_total, 1)
    print(
        f"\nHit rate: {hits}/{len(sample)} ({pct:.0f}%)  ·  "
        f"throughput: ~{rpm:.1f} req/min",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
