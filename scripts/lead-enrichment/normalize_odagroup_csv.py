#!/usr/bin/env python3
"""Normalize and audit the OdaGroup leads CSV (Apify/Phantombuster export)
into the lean shape our pipeline needs: linkedin_url, first_name, last_name,
title, company, country.

Detects and reports:
  - duplicates by canonical LinkedIn slug (same person, multiple country
    subdomain URLs — jp.linkedin.com vs www.linkedin.com vs cl.linkedin.com)
  - URL-encoded LinkedIn URLs (%E9%9A%86… patterns) — decodes them
  - non-Latin firstName (Japanese kanji, Korean hangul, etc.) — flags for
    manual review since "Hi 田中隆博" reads weird culturally
  - multi-word firstName ("Brenda Dauer" → just "Brenda")
  - missing critical fields (firstName, company, country)
  - Novo Nordisk employees (will be blocklisted by sendpilot-webhook anyway,
    but worth knowing the count up-front)
  - country distribution → language routing impact
  - title distribution → strategy match against the 4 OdaGroup strategies

Usage:
  python3 scripts/lead-enrichment/normalize_odagroup_csv.py \\
    --in /Users/louiscarter/Downloads/Odagroup-leads.csv \\
    --out clients/odagroup/data/leads_clean.csv

  # add --dry-run to skip writing the output
"""
from __future__ import annotations

import argparse
import csv
import re
import sys
import urllib.parse
from collections import Counter
from pathlib import Path

csv.field_size_limit(sys.maxsize)

# Latin block (incl. accented), digits, hyphen, apostrophe, space, dot.
# Allowlist used for "is this name addressable in a Latin greeting?".
LATIN_NAME_OK = re.compile(r"^[A-Za-zÀ-ÖØ-öø-ÿ0-9\-\.\'\s]+$")
# Emoji block (matches CarterCo's clean_names.py)
EMOJI_RE = re.compile(
    r"[\U0001F300-\U0001FAFF☀-➿⌀-⏿⬀-⯿"
    r"■-◿←-⇿⬅-⬇➡➠☛-☞]"
)
# Title prefixes — case-insensitive, anchored at start. "Dr.", "Dr ", "Prof.",
# "Mr.", "Ms.", "Mrs.", "Sir", "Dame", "Hon.". Stripped before tokenising so
# "Dr. René Alexander Staikowski" → "René Alexander Staikowski" → "René".
TITLE_PREFIX_RE = re.compile(
    r"^(?:dr\.?|prof\.?|mr\.?|ms\.?|mrs\.?|sir|dame|hon\.?)\s+", re.I)
# Suffix credentials in firstName/lastName ("Brenda Dauer Ries, MD, PhD",
# "Cristina Tomás, PhD, ISMPP, CMPP", "Natalia Rodríguez Gómez Hidalgo, MD, PhD").
# Strip everything from the first comma-credential onward.
CREDENTIAL_SUFFIX_RE = re.compile(
    r",\s*(?:M\.?D\.?|Ph\.?D\.?|M\.?Sc\.?|B\.?Sc\.?|MBA|DDS|DMD|RN|"
    r"ISMPP|CMPP|FRCP|FACC|MRCP|MRPharmS|RPh|PharmD|"
    r"Esq\.?|J\.?D\.?|LL\.?M\.?).*$", re.I)
# Parenthesised credentials ("(M.D.)", "(Ph.D., MBA)") — drop them entirely.
PAREN_CRED_RE = re.compile(r"\s*\([^)]*\)\s*$")

# Strategy → title-keyword regex. ORDER MATTERS — most specific first so
# overlapping titles ("Medical CRM Lead") map to the more specific strategy.
# Patterns expanded based on no_match analysis (digital, data analytics, etc).
STRATEGY_PATTERNS = {
    "medical_affairs": re.compile(
        r"\b(medical excellence|medical affairs|medical director|msl|"
        r"scientific engagement|medical operations|medical insights|"
        r"field medical|medical lead)\b", re.I),
    "crm_platform": re.compile(
        r"\b(veeva|salesforce|crm |crm$| crm|crm transformation|"
        r"crm product owner|customer engagement technology|"
        r"enterprise architect|engagement platform|"
        r"data platform|commercial platform|digital platform)\b", re.I),
    "ai_innovation": re.compile(
        r"\b(ai lead|ai director|ai &|ai and|genai|gen ai|"
        r"data analytics|data science|big data|ml lead|machine learning|"
        r"digital innovation|innovation director|innovation lead|"
        r"transformation lead|transformation director|"
        r"emerging technology|copilot|digital technology)\b", re.I),
    "commercial_excellence": re.compile(
        r"\b(commercial excellence|commercial effectiveness|"
        r"field excellence|customer engagement|omnichannel|"
        r"sales force effectiveness|business excellence|"
        r"field force effectiveness|head of commercial|"
        r"digital excellence|digital engagement)\b", re.I),
}


def linkedin_slug(url: str) -> str:
    """Extract the canonical /in/<slug> identifier, lowercased, decoded.
    Robust to country subdomains (jp./cl./www.), URL encoding, trailing slashes.
    Returns "" for non-/in/ URLs (/company/, /pub/, /school/) so they don't
    collide with personal profile slugs in the dedup map."""
    if not url:
        return ""
    try:
        # Decode percent-encoding (handles double-encoded too: %25E9 → %E9 → 隆)
        decoded = urllib.parse.unquote(urllib.parse.unquote(url))
        path = urllib.parse.urlparse(decoded).path.rstrip("/")
        # Reject anything that isn't a personal-profile path.
        if "/in/" not in path:
            return ""
        slug = path.rsplit("/", 1)[-1]
        return slug.lower()
    except Exception:
        return ""


def canonical_linkedin_url(url: str) -> str:
    """Return https://www.linkedin.com/in/<slug>/ canonical form.
    Strips country subdomains so we dedupe a person who appears under multiple
    country LinkedIn surfaces (jp.linkedin.com/in/X and cl.linkedin.com/in/X
    are the same person)."""
    slug = linkedin_slug(url)
    if not slug:
        return ""
    return f"https://www.linkedin.com/in/{slug}/"


def first_name_for_greeting(raw: str) -> tuple[str, str]:
    """Return (cleaned_first_name, issue_tag).
    issue_tag: '' (clean), 'non_latin', 'emoji_stripped', 'multi_word', 'empty'.

    Cleaning order:
      1. Strip emojis (flag if anything was stripped, even if name remains)
      2. Strip parenthesised credentials at end ("(M.D.)")
      3. Strip comma-credential suffixes ("Brenda Dauer, MD, PhD")
      4. Strip honorific prefix ("Dr. René" → "René")
      5. Reject if non-Latin (Latin allowlist; CJK/Cyrillic/Arabic etc. flagged)
      6. Take first whitespace token (still flag multi_word for LLM follow-up)
    """
    s = (raw or "").strip()
    if not s:
        return "", "empty"

    # 1. Strip emojis. Flag if anything was stripped, even if remainder is intact.
    had_emoji = bool(EMOJI_RE.search(s))
    if had_emoji:
        s = EMOJI_RE.sub("", s).strip()
        if not s:
            return "", "empty"

    # 2. Drop parenthesised credentials.
    s = PAREN_CRED_RE.sub("", s).strip()
    # 3. Drop comma-credential suffixes.
    s = CREDENTIAL_SUFFIX_RE.sub("", s).strip()
    # 4. Drop honorific prefix ("Dr.", "Prof.", "Mr.", "Ms.").
    s = TITLE_PREFIX_RE.sub("", s).strip()

    if not s:
        return "", "empty"

    # 5. Latin allowlist — flag CJK / Cyrillic / Arabic / Devanagari / etc.
    # These need cultural-context handling, not naive first-token.
    if not LATIN_NAME_OK.match(s):
        return s, "non_latin"

    # 6. Take first whitespace-separated token. Compound names ("Anne Marie")
    # still get flagged via multi_word so the LLM pass can recover them.
    tokens = s.split()
    if not tokens:
        return "", "empty"
    issue = ""
    if had_emoji:
        issue = "emoji_stripped"
    elif len(tokens) > 1:
        issue = "multi_word"
    return tokens[0], issue


def detect_strategy(title: str) -> str:
    """Best-fit strategy by keyword. Returns '' if no match (will fall back
    to commercial_excellence at AI-time, but we want to know the distribution)."""
    if not title:
        return ""
    for strategy, pat in STRATEGY_PATTERNS.items():
        if pat.search(title):
            return strategy
    return ""


def is_novo(company: str) -> bool:
    if not company:
        return False
    c = company.lower()
    return "novo nordisk" in c or "novonordisk" in c


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="inp", required=True, help="raw enrichment CSV")
    ap.add_argument("--out", dest="out", required=True, help="cleaned CSV path")
    ap.add_argument("--dry-run", action="store_true",
                    help="print audit only, don't write output CSV")
    args = ap.parse_args()

    src = Path(args.inp)
    if not src.exists():
        sys.exit(f"input not found: {src}")

    with open(src, encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))

    print(f"loaded {len(rows)} rows from {src.name}")
    print()

    # First pass: dedupe by canonical slug.
    by_slug: dict[str, dict] = {}
    dup_count = 0
    for r in rows:
        slug = linkedin_slug(r.get("linkedinUrl", ""))
        if not slug:
            continue
        if slug in by_slug:
            dup_count += 1
            continue
        by_slug[slug] = r

    print(f"=== DEDUPLICATION ===")
    print(f"  unique people (by linkedin slug): {len(by_slug)}")
    print(f"  duplicates removed: {dup_count}")
    print()

    # Second pass: normalize each unique row + collect audit data.
    cleaned: list[dict] = []
    issues = Counter()
    countries = Counter()
    strategies = Counter()
    novo_employees: list[str] = []
    rows_missing_critical: list[str] = []  # firstName, company, or title missing

    for slug, r in by_slug.items():
        first_raw = r.get("firstName", "") or ""
        last_raw = r.get("lastName", "") or ""
        # Title: jobPosition is the cleaner field when populated; fall back to headline
        title = (r.get("jobPosition") or r.get("headline") or "").strip()
        # Company: currentCompany is the human-readable form
        company = (r.get("currentCompany") or r.get("current_company_name") or "").strip()
        # Country: countryCode > country_code (both populated inconsistently)
        country = (r.get("countryCode") or r.get("country_code") or "").strip().upper()

        first_clean, name_issue = first_name_for_greeting(first_raw)
        if name_issue:
            issues[f"first_name_{name_issue}"] += 1

        if not first_clean:
            rows_missing_critical.append(f"{slug} (no first_name)")
        if not company:
            rows_missing_critical.append(f"{slug} (no company)")
        if not title:
            rows_missing_critical.append(f"{slug} (no title)")
        if not country:
            issues["country_missing"] += 1

        countries[country or "?"] += 1
        strategy = detect_strategy(title)
        strategies[strategy or "no_match"] += 1

        if is_novo(company):
            novo_employees.append(f"{first_clean} {last_raw} ({title}) — slug={slug}")

        cleaned.append({
            "linkedin_url": canonical_linkedin_url(r.get("linkedinUrl", "")),
            "linkedin_url_original": (r.get("linkedinUrl") or "").strip(),
            "first_name": first_clean,
            "first_name_original": first_raw,
            "first_name_issue": name_issue,
            "last_name": last_raw,
            "title": title[:200],
            "company": company,
            "country": country,
            "detected_strategy": strategy,
            "city": r.get("city", ""),
        })

    print(f"=== FIRST NAME ISSUES ===")
    if issues:
        for k, v in issues.most_common():
            print(f"  {k}: {v}")
    else:
        print(f"  none")
    print()

    print(f"=== COUNTRY DISTRIBUTION (top 15) ===")
    for cc, n in countries.most_common(15):
        # Language routing impact: DK/SE/NO → Danish, else English
        lang = "DA" if cc in ("DK", "SE", "NO") else "EN" if cc != "?" else "?"
        print(f"  {cc:4s}  n={n:4d}   → {lang}")
    da_total = sum(n for cc, n in countries.items() if cc in ("DK", "SE", "NO"))
    en_total = sum(n for cc, n in countries.items() if cc not in ("DK", "SE", "NO", "?"))
    unk_total = countries.get("?", 0)
    print(f"  -----")
    print(f"  Danish DM:   {da_total}")
    print(f"  English DM:  {en_total}")
    print(f"  Unknown:     {unk_total} (defaults to English)")
    print()

    print(f"=== STRATEGY MATCH (by title keyword) ===")
    for strat, n in strategies.most_common():
        marker = "  " if strat else "⚠️"
        print(f"  {marker} {strat or 'no_match (→ commercial_excellence fallback)':50s}  n={n}")
    print()

    print(f"=== NOVO NORDISK EMPLOYEES (will be auto-blocked) ===")
    if novo_employees:
        print(f"  count: {len(novo_employees)}")
        for e in novo_employees[:10]:
            print(f"    - {e}")
        if len(novo_employees) > 10:
            print(f"    ... and {len(novo_employees) - 10} more")
    else:
        print(f"  none ✓")
    print()

    print(f"=== MISSING CRITICAL FIELDS ===")
    if rows_missing_critical:
        print(f"  rows with missing first_name/company/title: {len(rows_missing_critical)}")
        for s in rows_missing_critical[:10]:
            print(f"    - {s}")
        if len(rows_missing_critical) > 10:
            print(f"    ... and {len(rows_missing_critical) - 10} more")
    else:
        print(f"  none ✓")
    print()

    print(f"=== SUMMARY ===")
    non_latin = issues.get("first_name_non_latin", 0)
    multi_word = issues.get("first_name_multi_word", 0)
    sendable = (
        len(cleaned)
        - non_latin
        - len(novo_employees)
    )
    print(f"  total raw rows:           {len(rows)}")
    print(f"  unique people:            {len(by_slug)}")
    print(f"  non-Latin names (manual): {non_latin}")
    print(f"  multi-word (LLM follow):  {multi_word}")
    print(f"  Novo Nordisk (block):     {len(novo_employees)}")
    print(f"  No country (defaults EN): {issues.get('country_missing', 0)}")
    print(f"  Sendable estimate:        ~{sendable}")
    print()

    if args.dry_run:
        print("(--dry-run: no output written)")
        return 0

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        "linkedin_url", "first_name", "last_name", "title", "company",
        "country", "detected_strategy", "city", "first_name_issue",
        "first_name_original", "linkedin_url_original",
    ]
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for row in cleaned:
            w.writerow(row)
    print(f"wrote {len(cleaned)} rows → {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
