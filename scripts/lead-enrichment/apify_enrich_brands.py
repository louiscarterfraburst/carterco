#!/usr/bin/env python3
"""Stage 2 of Apify enrichment: pull employees from LinkedIn via harvestapi actor.

Takes the output of find_linkedin_companies.py and fires ONE batched Apify run
that scrapes all companies' employees in a single actor execution. Pricing:
~$0.0015/profile (Short mode). 42 companies × 5 employees ≈ $0.32 total.

Why batched (vs one run per company): polling overhead. One run polled once
is 30s; 42 runs polled = 30 min. Apify charges per-event regardless.

Endpoint flow:
  1. POST /v2/acts/{actor-id}/runs?token=... → returns runId + datasetId
  2. GET /v2/actor-runs/{runId}?token=... → poll until status=SUCCEEDED
  3. GET /v2/datasets/{datasetId}/items?token=... → array of profile objects

Usage:
  set -a; source .env.local; set +a
  python3 scripts/lead-enrichment/apify_enrich_brands.py \\
    --in clients/carterco/data/brands_with_linkedin.csv \\
    --out clients/carterco/data/apify_enriched.csv \\
    [--actor harvestapi~linkedin-company-employees] \\
    [--max-per-company 5] [--mode Short]
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

TOKEN = os.environ.get("APIFY_API_TOKEN") or sys.exit("APIFY_API_TOKEN required")
BASE = "https://api.apify.com/v2"

DECISION_MAKER_PATTERNS = [
    re.compile(r"\b(co-?founder|stifter|grundlægger|gründer)\b", re.I),
    re.compile(r"\b(founder|owner|ejer|indehaver)\b", re.I),
    re.compile(r"\b(ceo|chief executive|adm\.?\s*direktør|administrerende\s*direktør|managing director|md|daglig leder)\b", re.I),
    re.compile(r"\b(cro|cco|cso|chief revenue|chief commercial|chief sales)\b", re.I),
    # "partner" = a firm Partner, NOT "Partner Marketing" / "Partnerships Mgr"
    re.compile(r"\b(partner(?!\s+(marketing|manager))|chairman|formand|president)\b", re.I),
    re.compile(r"\b(director|direktør|vp|vice president)\b", re.I),
    re.compile(r"\b(head of (sales|growth|commercial|marketing|business|outreach|revenue|gtm))\b", re.I),
    re.compile(r"\b(salgschef|salgsdirektør|kommerciel chef)\b", re.I),
]

DM_JOB_TITLES = [
    "Founder", "Co-Founder", "Owner", "CEO", "Stifter", "Grundlægger",
    "Managing Director", "Adm. Direktør", "Administrerende Direktør",
    "Daglig Leder", "Partner", "Director", "Direktør",
    "Head of Sales", "Head of Growth", "Head of Commercial",
    "Salgschef", "Salgsdirektør", "Indehaver", "Ejer",
]


# Function awareness for the hiring-signal play. The buyer of an outbound
# REVENUE system is the COMMERCIAL owner — so a sales/commercial title floats to
# the top, and a purely TECHNICAL leader (even a co-founder — see Weply, whose
# CTO co-founder out-ranked the CEO under the old founder-first scoring) sinks
# below any commercial alternative at the same company.
# Sales/commercial markers get the promotion. NB: "marketing" is deliberately
# NOT here — for an SDR/outbound-hire pitch the buyer is sales leadership; a
# marketing IC/head shouldn't out-rank a CEO. It still matches "head of
# marketing" as a low-priority fallback via DECISION_MAKER_PATTERNS.
COMMERCIAL_RE = re.compile(
    r"\b(cro|cso|chief revenue|chief commercial|cco|commercial|sales|salg\w*|"
    r"revenue|outreach|go.?to.?market|gtm|growth)\b", re.I)
TECHNICAL_RE = re.compile(
    r"\b(cto|cpo|cio|ciso|chief technolog|chief product|chief information|"
    r"engineer|engineering|technical|teknisk|udvikler|developer|architect|"
    r"devops|data scien|machine learning)\b", re.I)
# Recruiter / talent markers — used to decide whether a job's posted contact is
# the hiring MANAGER (usable) or just the agency/TA who posted it (ignore).
RECRUITER_RE = re.compile(
    r"recruit|rekrut|talent|staffing|bemanding|headhunt|executive search|"
    r"search\s*&\s*selection|\bhr\b|human resources|people\s*(&|and)?\s*culture|"
    r"people ops|peopleops|people business partner|hr business partner|\bpeople\b|"
    r"employee experience|employer brand|building (global )?teams", re.I)


def score_person(title: str) -> tuple[int, str]:
    """Lower score = better fit. Base rank comes from DECISION_MAKER_PATTERNS;
    then we make it function-aware for a SALES-hire pitch: commercial titles get
    promoted, technical-only leaders get demoted below any commercial peer."""
    t = title or ""
    base, label = 99, ""
    for i, pat in enumerate(DECISION_MAKER_PATTERNS):
        m = pat.search(t)
        if m:
            base, label = i, (m.group(1) or m.group(0))
            break
    if base == 99:
        return (99, "")  # not a leader at all — no commercial/technical nudge
    is_comm = bool(COMMERCIAL_RE.search(t))
    is_tech = bool(TECHNICAL_RE.search(t))
    score = base
    if is_comm:
        score -= 10           # commercial owner — strongest fit, floats to top
    if is_tech and not is_comm:
        score += 50           # technical-only — sinks below any commercial peer
    return (score, label)


def parse_contact(raw: str) -> tuple[str, str]:
    """'Name <url>' or 'Name' → (name, url). Empty parts when absent."""
    raw = (raw or "").strip()
    if not raw:
        return ("", "")
    m = re.match(r"^(.*?)\s*<([^>]*)>\s*$", raw)
    return (m.group(1).strip(), m.group(2).strip()) if m else (raw, "")


def contact_is_recruiter(name: str, url: str, title: str = "") -> bool:
    """True if the job's posted contact is a recruiter/TA rather than the buyer."""
    return bool(RECRUITER_RE.search(name) or RECRUITER_RE.search(url)
                or RECRUITER_RE.search(title))


def poster_as_buyer(contact: str, contact_title: str):
    """If the job's LinkedIn poster is the COMMERCIAL buyer — a sales/commercial
    leader or owner who posted their own hire — return them as a contact dict.
    That's the strongest signal there is: they self-identified as owning this
    hire. Returns None for recruiters/TA/headhunters and technical/non-leader
    posters, so the caller falls back to the function-aware company scrape."""
    name, url = parse_contact(contact)
    if not name:
        return None
    title = (contact_title or "").strip()
    if contact_is_recruiter(name, url, title):
        return None
    rank, label = score_person(title)
    if rank >= 99:
        return None                       # title isn't a decision-maker (or absent)
    if TECHNICAL_RE.search(title) and not COMMERCIAL_RE.search(title):
        return None                       # technical poster — scrape the company
    # Normalise the country subdomain (dk./lv.linkedin.com → www.) for consistency
    # with resolved vanity URLs downstream.
    url = re.sub(r"://[a-z]{2}\.linkedin\.com", "://www.linkedin.com", url, flags=re.I)
    first, last = _split(name)
    return {"name": name, "url": url, "title": title, "label": label,
            "first": first, "last": last, "rank": rank}


def http_json(method: str, url: str, body: dict | None = None, timeout: int = 60) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                  headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as f:
        return json.loads(f.read())


def fire_actor(actor_id: str, companies: list[str], max_per: int, mode: str,
               total_cap: int) -> tuple[str, str]:
    """POST a new run for one batch of companies. Returns (runId, datasetId).

    Filter strategy: jobTitles + locations:["Denmark"] together return 0 for
    most small DK companies (LinkedIn's index is sparse for SMBs that match
    ALL three filters). Cleaner to pull top-N employees per company and score
    by title client-side. LinkedIn ranks employees by relevance so founders/
    CEOs typically surface in the first few hits anyway.

    Free-tier limits the actor enforces:
      - Max 25 items per run
      - Max 10 companies per run in all_at_once mode
    Caller is responsible for chunking; this fn fires ONE batch.
    """
    url = f"{BASE}/acts/{actor_id}/runs?token={TOKEN}"
    body = {
        "companies": companies,
        "profileScraperMode": mode,
        "maxItemsPerCompany": max_per,
        # all_at_once needs an explicit maxItems total; maxItemsPerCompany is
        # ignored without it. Cap at total_cap to respect free-tier 25-per-run.
        "maxItems": total_cap,
        "companyBatchMode": "all_at_once",
    }
    r = http_json("POST", url, body=body, timeout=30)
    data = r.get("data", {})
    return (data.get("id"), data.get("defaultDatasetId"))


def poll_run(run_id: str, interval: float, timeout: float) -> str:
    """Poll run status until terminal. Returns final status."""
    url = f"{BASE}/actor-runs/{run_id}?token={TOKEN}"
    deadline = time.time() + timeout
    last_status = ""
    while time.time() < deadline:
        try:
            r = http_json("GET", url, timeout=15)
            status = (r.get("data", {}).get("status") or "").upper()
            if status != last_status:
                print(f"    status: {status}")
                last_status = status
            if status in ("SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"):
                return status
        except Exception as e:
            print(f"    poll err: {str(e)[:80]}")
        time.sleep(interval)
    return "TIMEOUT"


def fetch_dataset(dataset_id: str) -> list[dict]:
    url = f"{BASE}/datasets/{dataset_id}/items?token={TOKEN}&format=json&clean=true"
    try:
        return http_json("GET", url, timeout=60)
    except Exception as e:
        print(f"    dataset fetch err: {e}")
        return []


def normalize_li_company(url: str) -> str:
    """Drop trailing slash + lower for stable joins."""
    return (url or "").rstrip("/").lower().replace("http://", "https://")


def extract_company_url(item: dict) -> str:
    """Map a profile back to its origin company URL.

    harvestapi puts the person's CURRENT employer LinkedIn URL on
    currentPositions[0].companyLinkedinUrl — which equals the queried company
    URL (it's why this person showed up in the search). _meta.query lists the
    whole batch's companies, not the specific match, so use currentPositions
    instead.
    """
    positions = item.get("currentPositions") or []
    if positions and isinstance(positions[0], dict):
        url = positions[0].get("companyLinkedinUrl")
        if url and "linkedin.com/company" in url:
            return normalize_li_company(url)
    # Legacy fallbacks
    cp = item.get("currentPosition") or item.get("current_position")
    if isinstance(cp, dict):
        url = cp.get("companyLinkedinUrl") or cp.get("companyUrl") or cp.get("company_url")
        if url and "linkedin.com/company" in url:
            return normalize_li_company(url)
    return ""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="inp", required=True, help="brands_with_linkedin.csv")
    ap.add_argument("--out", required=True)
    ap.add_argument("--actor", default="harvestapi~linkedin-company-employees")
    ap.add_argument("--max-per-company", type=int, default=5)
    ap.add_argument("--mode",
                    default="Short ($4 per 1k)",
                    choices=["Short ($4 per 1k)", "Full ($8 per 1k)", "Full + email search ($12 per 1k)"])
    ap.add_argument("--poll-interval", type=float, default=10.0)
    ap.add_argument("--poll-timeout", type=float, default=900.0)
    ap.add_argument("--companies-per-run", type=int, default=10, help="batch cap (free tier: 10)")
    ap.add_argument("--items-per-run", type=int, default=25, help="items cap per batch (free tier: 25)")
    ap.add_argument("--reuse-dump", action="store_true", help="skip API calls and re-parse from --dump-raw file")
    ap.add_argument("--dump-raw", help="Write raw dataset JSON here for debugging")
    args = ap.parse_args()

    brands = list(csv.DictReader(open(args.inp, encoding="utf-8")))
    with_li = [b for b in brands if (b.get("linkedin_url") or "").strip()]
    print(f"loaded {len(brands)} brands ({len(with_li)} with LinkedIn URL)")

    companies = [b["linkedin_url"].strip() for b in with_li]
    if not companies:
        print("no LinkedIn URLs to enrich — run find_linkedin_companies.py first")
        return 1

    # Free-tier limits: 10 companies/run, 25 items/run. Chunk to respect both:
    # ceil(items_per_run / max_per_company) gives us companies per chunk where
    # every company can hit max_per_company without breaching the items cap.
    items_cap = args.items_per_run
    chunk_size = min(args.companies_per_run, max(1, items_cap // max(1, args.max_per_company)))
    chunks = [companies[i:i + chunk_size] for i in range(0, len(companies), chunk_size)]
    print(f"chunking {len(companies)} companies → {len(chunks)} runs × ≤{chunk_size} companies × ≤{items_cap} items")
    print(f"actor: {args.actor} | mode: {args.mode} | est cost: ${len(chunks)*0.02 + len(companies)*args.max_per_company*0.003:.2f}")
    print()

    all_items: list[dict] = []
    if args.reuse_dump and args.dump_raw and Path(args.dump_raw).exists():
        all_items = json.loads(Path(args.dump_raw).read_text())
        print(f"reusing cached dump: {len(all_items)} items from {args.dump_raw}")
    else:
        for idx, chunk in enumerate(chunks, 1):
            print(f"[batch {idx}/{len(chunks)}] {len(chunk)} companies, maxItems={items_cap}")
            run_id, dataset_id = fire_actor(args.actor, chunk, args.max_per_company, args.mode, items_cap)
            if not run_id:
                print(f"  ERROR: failed to start actor run for batch {idx}")
                continue
            print(f"  runId: {run_id}")
            status = poll_run(run_id, args.poll_interval, args.poll_timeout)
            print(f"  status: {status}")
            items = fetch_dataset(dataset_id)
            print(f"  → {len(items)} profile items")
            all_items.extend(items)
        print(f"\ntotal items across all batches: {len(all_items)}\n")

        if args.dump_raw:
            Path(args.dump_raw).write_text(json.dumps(all_items, indent=2, ensure_ascii=False))
            print(f"  wrote raw items → {args.dump_raw}")
    items = all_items

    # Build name → brand index. Apify returns companyLinkedinUrl as numeric
    # ID (/company/12345) not slug, so URL-based mapping fails. Match by
    # companyName instead. Use fuzzy "is one a substring of other after
    # normalization" — handles "Stadsrevisionen ApS" → "Stadsrevisionen".
    def _norm(s: str) -> str:
        return re.sub(r"[^a-z0-9æøå]", "", (s or "").lower())

    # Known brand → LinkedIn-displayed-name aliases. For companies that have
    # been renamed/rebranded so the LinkedIn company name no longer matches
    # the IG-ad handle. Add aliases here as we discover them.
    BRAND_ALIASES: dict[str, list[str]] = {
        "byggecentrum": ["molio"],  # renamed 2020 → Molio - Byggeriets Videnscenter
    }

    name_to_brand: dict[str, dict] = {}
    for b in with_li:
        candidates = [b.get("brand_clean", ""), b.get("brand", "")]
        # Pull in aliases keyed by the original brand handle
        for alias in BRAND_ALIASES.get(_norm(b.get("brand", "")), []):
            candidates.append(alias)
        for candidate in candidates:
            n = _norm(candidate)
            if n:
                name_to_brand[n] = b

    # Group items by canonical brand key. When an item's company name matches
    # either a brand's own name OR an alias, we still group it under the
    # brand's canonical key (so lookup `by_brand_key[brand_norm]` works
    # regardless of which alias matched).
    by_brand_key: dict[str, list[dict]] = {}
    unmatched = 0
    for item in items:
        co_name = _co_name(item)
        if not co_name:
            unmatched += 1
            continue
        co_norm = _norm(co_name)
        matched_brand = None
        # 1. Exact match
        if co_norm in name_to_brand:
            matched_brand = name_to_brand[co_norm]
        else:
            # 2. Substring match either way (Stadsrevisionen ApS vs Stadsrevisionen)
            for key, brand_row in name_to_brand.items():
                if not key:
                    continue
                if key in co_norm or co_norm in key:
                    matched_brand = brand_row
                    break
        if matched_brand:
            canon = _norm(matched_brand.get("brand", ""))
            by_brand_key.setdefault(canon, []).append(item)
        else:
            unmatched += 1

    print(f"  items grouped into {len(by_brand_key)} brands (unmatched: {unmatched})\n")

    out_rows: list[dict] = []
    found = no_dm = empty = 0
    for b in brands:
        raw = b["brand"]
        li_url = normalize_li_company(b.get("linkedin_url", ""))
        if not li_url:
            out_rows.append(_empty(b, "no_linkedin_url"))
            continue
        # Look up using same canonical key (`raw` brand) we grouped under.
        # NOT brand_clean — Apify items grouped under `_norm(brand_row["brand"])`
        # so brand_clean would mismatch (e.g. "scancoffeegroupt" vs "scancoffee").
        brand_norm = _norm(raw)
        people = by_brand_key.get(brand_norm, [])

        # PREFER THE JOB POSTER when they're the commercial buyer — they posted
        # their own hire, the strongest signal there is (e.g. Sprii's CSO,
        # Clerk.io's Head of Outreach). Works even if the employee scrape came
        # back empty. Recruiters/TA/headhunters/technical posters → None, and we
        # fall back to the scraped, function-aware pick below.
        poster = poster_as_buyer(b.get("trigger_contact", ""),
                                 b.get("trigger_contact_title", ""))
        if poster:
            found += 1
            print(f"  ✓ {raw:30s} | POSTER | high   | {poster['name']} → {poster['title'][:46]}")
            out_rows.append({
                "brand": raw, "brand_clean": b.get("brand_clean", ""),
                "vertical": b.get("vertical", ""), "country": b.get("country", "DK"),
                "domain": b.get("domain", ""), "linkedin_company_url": b.get("linkedin_url", ""),
                "first_name": poster["first"], "last_name": poster["last"],
                "title": poster["title"], "linkedin_profile_url": poster["url"],
                "matched_role_pattern": poster["label"], "confidence": "high",
                "status": "found", "source": "poster",
                "company_returned": raw, "total_in_company": len(people),
            })
            continue

        if not people:
            empty += 1
            print(f"  ⊘ {raw:30s} | no employees returned")
            out_rows.append(_empty(b, "no_employees"))
            continue
        scored = sorted([(score_person(_title(p)), p) for p in people], key=lambda x: x[0][0])
        best_rank, best_label = scored[0][0]
        best = scored[0][1]
        title = _title(best)
        name = _name(best)
        prof_url = best.get("publicIdentifier") or best.get("profileUrl") or best.get("linkedinUrl") or ""
        if isinstance(prof_url, str) and not prof_url.startswith("http") and prof_url:
            prof_url = f"https://www.linkedin.com/in/{prof_url}"

        if best_rank < 99:
            found += 1
            conf = "high" if best_rank <= 2 else "medium" if best_rank <= 4 else "low"
            print(f"  ✓ {raw:30s} | {len(people)} hits | {conf:6s} | {name} → {title[:50]}")
            status = "found"
        else:
            no_dm += 1
            conf = "low"
            status = "no_decision_maker"
            print(f"  ~ {raw:30s} | {len(people)} hits | no_dm | top: {name} → {title[:40]}")

        out_rows.append({
            "brand": raw,
            "brand_clean": b.get("brand_clean", ""),
            "vertical": b.get("vertical", ""),
            "country": b.get("country", "DK"),
            "domain": b.get("domain", ""),
            "linkedin_company_url": b.get("linkedin_url", ""),
            "first_name": best.get("firstName") or _split(name)[0],
            "last_name": best.get("lastName") or _split(name)[1],
            "title": title,
            "linkedin_profile_url": prof_url,
            "matched_role_pattern": best_label,
            "confidence": conf,
            "status": status,
            "source": "scrape",
            "company_returned": _co_name(best),
            "total_in_company": len(people),
        })

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    fields = ["brand", "brand_clean", "vertical", "country", "domain",
              "linkedin_company_url", "first_name", "last_name", "title",
              "linkedin_profile_url", "matched_role_pattern", "confidence",
              "status", "source", "company_returned", "total_in_company"]
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(out_rows)
    print()
    print("=== SUMMARY ===")
    print(f"  brands in input:      {len(brands)}")
    print(f"  with LinkedIn URL:    {len(with_li)}")
    print(f"  decision-maker found: {found}")
    print(f"  no DM, person found:  {no_dm}")
    print(f"  empty (no employees): {empty}")
    print(f"  output:               {out}")
    return 0


def _title(p: dict) -> str:
    # harvestapi puts title on currentPositions[0].title
    positions = p.get("currentPositions") or []
    if positions and isinstance(positions[0], dict):
        t = positions[0].get("title")
        if t:
            return t
    return (p.get("jobTitle") or p.get("headline") or p.get("title") or "")


def _name(p: dict) -> str:
    return (p.get("fullName") or p.get("full_name") or
            f"{p.get('firstName','')} {p.get('lastName','')}".strip())


def _co_name(p: dict) -> str:
    positions = p.get("currentPositions") or []
    if positions and isinstance(positions[0], dict):
        return positions[0].get("companyName") or ""
    cp = p.get("currentPosition")
    if isinstance(cp, dict):
        return cp.get("companyName") or cp.get("company") or ""
    return p.get("company") or ""


def _split(name: str) -> tuple[str, str]:
    parts = (name or "").split(" ", 1)
    return (parts[0] if parts else "", parts[1] if len(parts) > 1 else "")


def _empty(b: dict, status: str) -> dict:
    return {
        "brand": b.get("brand", ""), "brand_clean": b.get("brand_clean", ""),
        "vertical": b.get("vertical", ""), "country": b.get("country", "DK"),
        "domain": b.get("domain", ""),
        "linkedin_company_url": b.get("linkedin_url", ""),
        "first_name": "", "last_name": "", "title": "",
        "linkedin_profile_url": "", "matched_role_pattern": "",
        "confidence": "", "status": status,
        "company_returned": "", "total_in_company": 0,
    }


if __name__ == "__main__":
    sys.exit(main())
