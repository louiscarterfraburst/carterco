#!/usr/bin/env python3
"""Discover real company domains for the IG-ad brand list, via Jina Search.

The brand names are mostly IG handles (e.g. `creaocreao`, `vincentgraphicdk`,
`centrum_service_aps`) that don't map cleanly to domain names. Stringmashing
gives ~30% wrong guesses. Real lookup via Jina Search is much better.

Strategy:
  1. For each brand, hit Jina Search with "<brand> denmark"
  2. Walk results, skipping directory/review sites
  3. First clean company-shaped result wins
  4. If brand-name slug appears in path of a directory site (e.g.
     trustpilot.com/review/<domain>), extract the reviewed domain
  5. Write enriched CSV with the original brand + discovered domain

Usage:
  set -a; source .env.local; set +a
  python3 scripts/lead-enrichment/discover_brand_domains.py \\
    --in clients/carterco/data/brands_to_mine_clean.csv \\
    --out clients/carterco/data/brands_with_domains.csv \\
    [--throttle 1] [--limit N]
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

KEY = os.environ.get("JINA_API_KEY") or sys.exit("JINA_API_KEY required")

# Skip these hosts — they're directories/reviews/social, not the company's own site
DIRECTORY_HOSTS = {
    # reviews & ratings
    "trustpilot.com", "yelp.com", "g2.com", "capterra.com",
    # business directories
    "tracxn.com", "northdata.com", "owler.com", "crunchbase.com",
    "thehub.io", "finder.com", "openhub.dk", "krak.dk", "proff.dk",
    "cvr.dk", "virksomhedsdata.dk", "ditcvr.dk", "skat.dk",
    "unglobalcompact.org", "cbinsights.com", "pitchbook.com",
    "zoominfo.com", "rocketreach.co", "apollo.io", "lusha.com",
    # social
    "linkedin.com", "facebook.com", "instagram.com", "twitter.com",
    "x.com", "youtube.com", "tiktok.com", "pinterest.com",
    # general / search
    "wikipedia.org", "wikiwand.com", "bing.com", "google.com",
    "google.dk", "duckduckgo.com", "reddit.com", "medium.com",
    # job boards
    "indeed.com", "glassdoor.com", "stepstone.dk", "jobindex.dk",
    # app stores
    "apple.com", "apps.apple.com", "play.google.com",
    # news
    "borsen.dk", "berlingske.dk", "dr.dk", "politiken.dk", "finans.dk",
}


def brand_tokens(brand: str) -> list[str]:
    """Extract significant tokens from a brand name for fuzzy host matching."""
    s = re.sub(r"^.+?\s+fra\s+", "", brand.lower())
    s = re.sub(r"^.+?\s+-\s+", "", s)
    s = re.sub(r"\s*(aps|a\/s|ivs|gmbh)\s*$", "", s, flags=re.I)
    # Drop common stop-words and TLD-like tails
    STOP = {"the", "and", "og", "af", "dk", "com", "as"}
    paren = re.search(r"\(([a-z0-9_]+)\)", brand)
    if paren:
        candidate = paren.group(1).replace("_", " ")
        s = s + " " + candidate
    tokens = re.findall(r"[a-zæøå0-9]+", s)
    return [t for t in tokens if len(t) >= 3 and t not in STOP]


def score_host_match(host: str, brand: str) -> tuple[int, str]:
    """Returns (score, reason). Higher = better match.
    Score: 100=any token is the host root, 60=token is substring of root,
           30=token appears in subdomain, 0=no match."""
    tokens = brand_tokens(brand)
    if not tokens or not host:
        return (0, "no_tokens_or_host")
    parts = host.split(".")
    root = parts[0] if parts else ""
    for t in tokens:
        if root == t:
            return (100, f"root_exact:{t}")
        if t in root.replace("-", "").replace("_", ""):
            # how big a fraction of root is the token?
            if len(t) >= len(root) * 0.6:
                return (80, f"root_substring:{t}")
            return (60, f"root_contains:{t}")
    # last resort: any token in any subdomain
    for t in tokens:
        if any(t in p for p in parts):
            return (30, f"subdomain:{t}")
    return (0, "no_match")


def brand_slug(brand: str) -> str:
    """Extract a comparable slug for matching against hostnames."""
    s = brand.lower().strip()
    # Drop "X fra Y" pattern → keep just Y
    s = re.sub(r"^.+?\s+fra\s+", "", s)
    # Drop "X - Y" pattern → keep just Y
    s = re.sub(r"^.+?\s+-\s+", "", s)
    # Drop legal suffix
    s = re.sub(r"\s*(aps|a\/s|ivs|gmbh)\s*$", "", s, flags=re.I)
    # Pull handle from parens if present
    paren = re.search(r"\(([a-z0-9_]+)\)", brand)
    if paren:
        s = paren.group(1).replace("_", "")
    # Final: keep only alnum + æøå
    return re.sub(r"[^a-z0-9æøå]", "", s)


def jina_search(query: str) -> list[dict]:
    url = f"https://s.jina.ai/?q={urllib.parse.quote(query)}"
    # Jina blocks the default Python-urllib User-Agent — must spoof a real one
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {KEY}",
        "Accept": "application/json",
        "X-Respond-With": "no-content",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    })
    with urllib.request.urlopen(req, timeout=45) as f:
        data = json.loads(f.read())
    return data.get("data", []) if data.get("code") == 200 else []


def extract_host(url: str) -> str:
    try:
        h = urllib.parse.urlparse(url).netloc.lower()
        return h.lstrip(".").removeprefix("www.")
    except Exception:
        return ""


def reviewed_domain(url: str) -> str:
    """If URL is a Trustpilot review like /review/<domain>, extract the domain."""
    try:
        p = urllib.parse.urlparse(url)
        if p.netloc.lower().endswith("trustpilot.com"):
            m = re.match(r"/review/([^/?#]+)", p.path)
            if m:
                return m.group(1).lower()
    except Exception:
        pass
    return ""


def discover_domain(brand: str, country: str) -> tuple[str, str, str]:
    """Returns (domain, source_url, method).
    Scores every non-directory result + Trustpilot-extracted domains, then
    picks the highest-scoring match. Drops the binary direct/direct_loose
    distinction in favor of a confidence score in the method string."""
    query = f"{brand} {'denmark' if country == 'DK' else ''}".strip()
    try:
        results = jina_search(query)
    except Exception as e:
        return ("", "", f"error:{str(e)[:40]}")
    if not results:
        return ("", "", "no_results")

    candidates: list[tuple[int, str, str, str]] = []  # (score, domain, url, reason)
    for r in results:
        url = r.get("url", "")
        host = extract_host(url)
        if not host:
            continue

        # Trustpilot review URLs are gold — extract the reviewed domain
        if host == "trustpilot.com" or host.endswith(".trustpilot.com"):
            rd = reviewed_domain(url)
            if rd:
                score, reason = score_host_match(rd, brand)
                candidates.append((score + 5, rd, url, f"trustpilot:{reason}"))
            continue

        # Skip other directory sites entirely
        if any(host == d or host.endswith("." + d) for d in DIRECTORY_HOSTS):
            continue

        score, reason = score_host_match(host, brand)
        candidates.append((score, host, url, f"host:{reason}"))

    if not candidates:
        return ("", "", "no_clean_domain")

    candidates.sort(key=lambda x: -x[0])
    score, domain, url, reason = candidates[0]
    # Hard cutoff: anything scoring under 60 is too likely a wrong match.
    # Better to leave domain blank than pollute Prospeo with junk lookups.
    if score < 60:
        return ("", url, f"low_confidence_skipped:best_was:{reason}")
    if score >= 80:
        return (domain, url, f"high:{reason}")
    return (domain, url, f"medium:{reason}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", dest="out", required=True)
    ap.add_argument("--throttle", type=float, default=1.0)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    brands = list(csv.DictReader(open(args.inp, encoding="utf-8")))
    if args.limit:
        brands = brands[: args.limit]
    print(f"loaded {len(brands)} brands")

    out_rows: list[dict] = []
    by_method = {"direct": 0, "direct_loose": 0, "trustpilot_extracted": 0, "no_results": 0, "no_clean_domain": 0, "error": 0}
    for i, b in enumerate(brands, 1):
        brand = b["brand"]
        country = b.get("country", "DK")
        domain, source_url, method = discover_domain(brand, country)
        mkey = method.split(":")[0] if ":" in method else method
        by_method[mkey] = by_method.get(mkey, 0) + 1
        marker = "✓" if method in ("direct", "trustpilot_extracted") else "~" if method == "direct_loose" else "✗"
        print(f"  [{i}/{len(brands)}] {marker} {brand:35s} → {domain:35s} [{method}]")
        out_rows.append({
            **b,
            "domain": domain,
            "domain_source_url": source_url,
            "domain_method": method,
        })
        time.sleep(args.throttle)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    fields = list(brands[0].keys()) + ["domain", "domain_source_url", "domain_method"]
    # Dedupe (we kept all original keys + added 3)
    seen = set(); ordered = []
    for f in fields:
        if f not in seen:
            seen.add(f); ordered.append(f)
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=ordered)
        w.writeheader()
        w.writerows(out_rows)
    print()
    print(f"=== SUMMARY ===")
    for k, v in sorted(by_method.items(), key=lambda x: -x[1]):
        print(f"  {k:25s}  {v}")
    print(f"  → {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
