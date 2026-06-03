#!/usr/bin/env python3
"""Dedupe SendPilot + Apify enriched outputs into a single CarterCo leads CSV.

Inputs:
  - clients/carterco/data/sendpilot_enriched.csv  (status=found rows)
  - clients/carterco/data/apify_enriched.csv      (status=found rows)

Output:
  - clients/carterco/data/leads_clean.csv
    Columns: linkedin_url, first_name, last_name, title, company, country,
             vertical, detected_strategy, source, confidence, brand

Dedupe key: normalized LinkedIn profile URL (lowercase, no trailing slash).
On conflict: prefer the row with higher confidence (high > medium > low),
then prefer Apify (it scraped the actual employee list vs SendPilot's fuzzy
match). Final tiebreaker: SendPilot (older/more battle-tested).

For CarterCo, detected_strategy is always 'ad_funnel_leak' — that's the
only strategy in clients/carterco/agent-brief.md.

Usage:
  python3 scripts/lead-enrichment/merge_carterco_leads.py \\
    --sendpilot clients/carterco/data/sendpilot_enriched.csv \\
    --apify clients/carterco/data/apify_enriched.csv \\
    --out clients/carterco/data/leads_clean.csv
"""
from __future__ import annotations

import argparse
import csv
import re
import sys
import urllib.parse
from pathlib import Path

CONF_RANK = {"high": 3, "medium": 2, "low": 1, "": 0}


def normalize_li(url: str) -> str:
    """Trim + strip trailing slash + decode + canonical host.

    Preserve case in the /in/<slug> portion: LinkedIn's obfuscated profile
    IDs (e.g. /in/ACwAAEOt...) are case-sensitive — lowering breaks the
    URL. The /company/ and /in/ literals are case-insensitive on LinkedIn's
    side, but slugs after them must keep original case.
    """
    if not url:
        return ""
    try:
        decoded = urllib.parse.unquote(urllib.parse.unquote(url.strip()))
        p = urllib.parse.urlparse(decoded)
        path = p.path.rstrip("/")
        if "/in/" not in path.lower():
            return ""
        # Normalize the "/in/" prefix lowercase but keep slug as-is
        m = re.search(r"(/[Ii][Nn]/)(.+)$", path)
        if m:
            path = path[: m.start(1)] + "/in/" + m.group(2)
        return f"https://www.linkedin.com{path}"
    except Exception:
        return ""


# Match any pictograph / symbol / emoji code blocks LinkedIn users put in
# their display name. Used to clean names before sending to SendPilot.
_EMOJI_RE = re.compile(
    r"[\U0001F300-\U0001F9FF\U0001FA00-\U0001FAFF☀-➿⌀-⏿️]+"
)


def clean_name(name: str) -> str:
    if not name:
        return name
    cleaned = _EMOJI_RE.sub("", name)
    return re.sub(r"\s+", " ", cleaned).strip()


def row_strength(r: dict) -> int:
    """Higher = better candidate to keep on dedupe collision.
    - Confidence dominates (high=30, medium=20, low=10).
    - Apify edges out SendPilot at same confidence (it actually scraped the
      employee list vs SendPilot's fuzzy company-name search).
    - Readable slug URLs (/in/karsten-leed) beat obfuscated IDs (/in/ACwAAA...)
      because the latter require auth to render in some contexts.
    """
    base = CONF_RANK.get((r.get("confidence") or "").lower(), 0) * 10
    if r.get("source") == "apify":
        base += 2
    url = r.get("linkedin_url", "")
    # Penalize ACw... obfuscated slugs (LinkedIn auth-locked IDs)
    if re.search(r"/in/[A-Z][a-zA-Z0-9_-]{20,}", url):
        base -= 1
    return base


def is_known_noise(r: dict) -> tuple[bool, str]:
    """Filter out leads we've already identified as fuzzy-match noise.

    - Morten Lund as "Chairman CoFounder" appeared as top hit for 12 different
      brands in the SendPilot run. He's a serial DK board member; the fuzzy
      company search returned him whenever the company name didn't anchor.
    - Norwegian results from DK searches (Daglig Leder Eierleder
      Sivilingeniør pattern — wrong country, wrong company).
    """
    name = f"{r.get('first_name','')} {r.get('last_name','')}".strip().lower()
    title = (r.get("title") or "").lower()
    if name == "morten lund" and "chairman cofounder" in title:
        return (True, "morten_lund_spam")
    if "eierleder" in title or "sivilingeniør" in title:
        return (True, "norwegian_match")
    return (False, "")


def load_source(path: Path, source: str, linkedin_col: str) -> list[dict]:
    """Read enriched CSV, keep only status=found rows, normalize fields."""
    rows = list(csv.DictReader(open(path, encoding="utf-8")))
    out = []
    for r in rows:
        if (r.get("status") or "").lower() != "found":
            continue
        url = normalize_li(r.get(linkedin_col, ""))
        if not url:
            continue
        out.append({
            "linkedin_url": url,
            "first_name": clean_name(r.get("first_name", "")),
            "last_name": clean_name(r.get("last_name", "")),
            "title": r.get("title", "").strip(),
            "company": (r.get("brand_clean") or r.get("brand") or "").strip(),
            "country": (r.get("country") or "DK").strip(),
            "vertical": r.get("vertical", "").strip(),
            "detected_strategy": "ad_funnel_leak",
            "source": source,
            "confidence": (r.get("confidence") or "").lower(),
            "brand": r.get("brand", "").strip(),
        })
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sendpilot", required=True)
    ap.add_argument("--apify", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    sp = load_source(Path(args.sendpilot), "sendpilot", linkedin_col="linkedin_url")
    ap_rows = load_source(Path(args.apify), "apify", linkedin_col="linkedin_profile_url")
    print(f"sendpilot found rows: {len(sp)}")
    print(f"apify     found rows: {len(ap_rows)}")

    def _person_key(r: dict) -> str:
        """Same-person dedup key: brand + first + last-token-of-last-name.

        Using the LAST token of the last name catches "Martin Nielsen" vs
        "Martin Assenholm Nielsen" — both blackbird CEO, just one with middle
        name. The canonical family-name token ("Nielsen") matches both.
        """
        first = (r.get("first_name") or "").lower().strip()
        last = (r.get("last_name") or "").lower().strip()
        last_surname_token = last.rsplit(maxsplit=1)[-1] if last else ""
        return "|".join([(r.get("brand") or "").lower().strip(), first, last_surname_token])

    # Two-key dedup: (1) by normalized LinkedIn URL, (2) by (brand, first, last).
    # Same person can show up under two different URLs across sources.
    by_url: dict[str, dict] = {}
    by_person: dict[str, dict] = {}
    dropped_noise = 0
    for r in sp + ap_rows:
        is_noise, reason = is_known_noise(r)
        if is_noise:
            dropped_noise += 1
            continue
        url_key = r["linkedin_url"]
        person_key = _person_key(r)
        # Find existing winner via either key
        existing = by_url.get(url_key) or by_person.get(person_key)
        if existing and row_strength(existing) >= row_strength(r):
            continue
        # If we're replacing, clean up the old keys
        if existing:
            by_url.pop(existing["linkedin_url"], None)
            by_person.pop(_person_key(existing), None)
        by_url[url_key] = r
        by_person[person_key] = r

    rows = sorted(by_url.values(), key=lambda r: (r["company"], r["brand"]))
    print(f"dropped as noise:  {dropped_noise}")
    print(f"deduped total:     {len(rows)}")
    print()
    print(f"=== leads ===")
    for r in rows:
        print(f"  {r['brand']:30s} | {r['first_name']} {r['last_name']:15s} | "
              f"{r['title'][:45]:45s} | {r['source']:10s} | {r['confidence']}")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    fields = ["linkedin_url", "first_name", "last_name", "title", "company",
              "country", "vertical", "detected_strategy", "source",
              "confidence", "brand"]
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    print()
    print(f"wrote {len(rows)} → {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
