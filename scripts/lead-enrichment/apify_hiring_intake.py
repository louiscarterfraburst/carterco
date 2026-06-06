#!/usr/bin/env python3
"""Stage 0 of the hiring-signal intake: discover DK companies hiring sales roles.

A sales job posting is the richest cold-outbound trigger there is — it's a
timed, public, self-declared "we need more leads" with budget attached. This
script fires the `fantastic-jobs/advanced-linkedin-job-search-api` Apify actor
(same APIFY_API_TOKEN, ~$1.50 per 1k jobs), searching DK for sales/SDR roles.

Why this actor: it actually FILTERS by title. The earlier harvestapi job-search
actor ignored the keyword and returned every recent DK job (blacksmiths, nurses),
so we sampled blind. fantastic-jobs does titleSearch + titleExclusionSearch +
organizationEmployeesLte + datePostedAfter server-side, so the role/size/recency
filtering happens at the source — the client-side gates below are just safety.

Each posting is five inputs in one document:
  - trigger    → date_posted (+ --days recency window)
  - pain spec  → description_text (the JD = the spec, in their words)
  - ICP hint   → description_text + linkedin_org_industry/size
  - budget     → ai_salary_* (price comp: a seat vs. the system)
  - contact    → organization + organization_url (company LinkedIn)

The actor hands back `organization_url` (company LinkedIn) in the exact format
apify_enrich_brands.py wants, plus `linkedin_org_url` (domain), so --companies-out
pipes straight into the employee-scrape stage with no Jina bridge.

Pipeline:
  apify_hiring_intake.py  →  (companies-out)  →  apify_enrich_brands.py  →  hooks

Endpoint flow (identical to apify_enrich_brands.py):
  1. POST /v2/acts/{actor}/runs?token=...      → runId + defaultDatasetId
  2. GET  /v2/actor-runs/{runId}?token=...      → poll until SUCCEEDED
  3. GET  /v2/datasets/{datasetId}/items?...    → array of job objects

Usage:
  set -a; source .env.local; set +a
  python3 scripts/lead-enrichment/apify_hiring_intake.py \\
    --out clients/carterco/data/hiring_intake_dk.csv \\
    --companies-out clients/carterco/data/hiring_companies_dk.csv \\
    [--posted-limit "Past Week"] [--max-items 50] [--under10]
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta
import urllib.error
import urllib.request
from pathlib import Path

TOKEN = os.environ.get("APIFY_API_TOKEN") or sys.exit("APIFY_API_TOKEN required")
BASE = "https://api.apify.com/v2"

# DK sales / outbound IC roles — the seats whose job IS the thing the outbound
# machine replaces. Danish + English. Override with --roles. We deliberately
# skip "Head of Sales / salgschef" by default: that's a team-build signal, a
# different pitch than "replace the seat with a system."
DEFAULT_ROLES = [
    "SDR",
    "BDR",
    "Sales Development Representative",
    "sælger",
    "salgskonsulent",
    "business developer",
    "forretningsudvikler",
]

# titleExclusionSearch — farming / management / partnerships / junior roles that
# are NOT an outbound-prospecting seat. The API drops these server-side.
DEFAULT_TITLE_EXCLUDE = [
    "manager", "partner", "partnership", "key account", "trainee",
    "head of", "salgschef", "director",
]

# LinkedIn keyword search is loose — "business developer" pulls in engineers,
# supply planners, even a French gastroenterologist. Mirror the decision-maker
# title-regex trick from apify_enrich_brands.py: keep a posting only if its
# title is genuinely a B2B sales / outbound seat (the thing the machine
# replaces), and drop retail "sales associate"-type roles even when they match.
# HUNTERS ONLY. The play premise is "they just posted a role whose job IS the
# outbound prospecting we automate." That's an SDR/BDR/biz-dev/AE/sælger seat —
# NOT account-manager / key-account / partnerships (farming existing relationships),
# NOT salgschef / head-of-sales (team-build), NOT trainee (junior). Those farming
# roles were what contaminated the first batch (Eneba partnerships, OOONO key
# account, Nobel partner manager, TDC salgstrainee) — they're in DROP below.
SALES_ROLE_KEEP = [
    re.compile(r"\b(sdr|bdr)\b", re.I),
    re.compile(r"sales develop", re.I),
    re.compile(r"business develop|forretningsudvikl", re.I),
    re.compile(r"\baccount executive\b", re.I),                 # AE = hunter; account MANAGER is not
    re.compile(r"\bsælger\b|salgskonsulent|salgsrepræsentant", re.I),
    re.compile(r"inside sales|outbound", re.I),
    re.compile(r"\bsales (rep|representative|consultant|specialist|executive)\b", re.I),
    re.compile(r"new business|demand generation", re.I),
    re.compile(r"cold call|koldkald|telefonsælg|telesælg|telemarketing", re.I),
]
SALES_ROLE_DROP = [
    re.compile(r"sales associate|sales assistant|part[- ]?time sales|retail|\bshop\b|\bstore\b|butik|ekspedient|kassemedarbejder", re.I),
    re.compile(r"\bengineer\b|developer\b|\btechnician\b|udvikler\b", re.I),  # not "business developer" (caught by KEEP first)
    # farming / management / partnerships / junior — not an outbound-prospecting seat
    re.compile(r"account manager|key account|kundeansvarlig|kundechef|partner\s*manager|partnerchef|partnership|trainee|\belev\b|head of|salgschef|salgsdirektør", re.I),
]


def is_sales_role(title: str) -> bool:
    t = title or ""
    if not any(p.search(t) for p in SALES_ROLE_KEEP):
        return False  # not a sales seat at all
    if any(p.search(t) for p in SALES_ROLE_DROP):
        # "business developer" matches both KEEP and the generic "developer" DROP
        # — KEEP wins for it; everything else matching DROP is rejected.
        return bool(re.search(r"business develop|forretningsudvikl", t, re.I))
    return True


# DK gate. The actor's location filter is loose — searching "Denmark" still
# returns "European Union" / "EMEA" / remote postings (Eneba's was EU-wide).
# Keep only postings whose location text actually names Denmark or a DK city.
DK_LOC = re.compile(
    r"denmark|danmark|copenhagen|k[øo]benhavn|aarhus|[åa]rhus|odense|aalborg|"
    r"esbjerg|kolding|vejle|horsens|randers|roskilde|herning|silkeborg|\bdk\b", re.I)


def is_dk_location(loc: str) -> bool:
    return bool(DK_LOC.search(loc or ""))


# ICP gate on the COMPANY (not the role). The foot-in-the-door play targets
# mid-market B2B building an outbound function — not the giants who ARE the
# outbound machine (Salesforce, Google, IFS) nor retailers hiring floor staff
# (STARK). employee_count + industries are already on every row.
ICP_EXCLUDE_INDUSTRY = re.compile(
    r"retail|apparel|fashion|supermarket|grocer|restaurant|hospitality|"
    r"food.*beverage|consumer goods|leisure|"
    r"building material|byggemarked|byggecenter|trælast|home improvement", re.I)


def is_icp_company(row: dict, min_emp: int, max_emp: int) -> tuple[bool, str]:
    """Return (keep, reason-if-dropped). Missing employee_count → keep (don't
    punish missing data), but flag it."""
    inds = row.get("industries") or ""
    if ICP_EXCLUDE_INDUSTRY.search(inds):
        return (False, f"industry:{inds[:30]}")
    ec = row.get("employee_count")
    try:
        n = int(ec)
    except (TypeError, ValueError):
        return (True, "")  # unknown size — keep
    if n > max_emp:
        return (False, f"too-big:{n}")
    if n < min_emp:
        return (False, f"too-small:{n}")
    return (True, "")


def http_json(method: str, url: str, body: dict | None = None, timeout: int = 60) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                  headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as f:
        return json.loads(f.read())


def fire_actor(actor_id: str, titles: list[str], title_excludes: list[str],
               location: str, posted_after: str, max_emp: int, max_items: int) -> tuple[str, str]:
    """POST one run. Returns (runId, datasetId).

    fantastic-jobs filters server-side: titleSearch + titleExclusionSearch do the
    role include/exclude, organizationEmployeesLte does the ICP size gate,
    datePostedAfter does recency — work the old actor ignored. Unlike harvestapi,
    the keyword search is actually applied.
    """
    url = f"{BASE}/acts/{actor_id}/runs?token={TOKEN}"
    body: dict = {
        "titleSearch": titles,
        "locationSearch": [location],
        "maxItems": max_items,
    }
    if title_excludes:
        body["titleExclusionSearch"] = title_excludes
    if posted_after:
        body["datePostedAfter"] = posted_after
    if max_emp:
        body["organizationEmployeesLte"] = max_emp
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
    """Drop trailing slash + lower for stable joins (matches apify_enrich_brands)."""
    return (url or "").rstrip("/").lower().replace("http://", "https://")


def clean_domain(url: str) -> str:
    """http://www.cej.dk/ → cej.dk (bare domain for the Firecrawl B6 stage)."""
    u = (url or "").strip().lower()
    u = re.sub(r"^https?://", "", u)
    u = re.sub(r"^www\.", "", u)
    return u.split("/")[0].rstrip("/")


def flatten(job: dict) -> dict:
    """Map one fantastic-jobs (Advanced LinkedIn Job Search API) item → flat row.

    organization_url is the company LinkedIn URL (→ enrich handoff);
    linkedin_org_url is the company website (→ domain, Firecrawl B6).
    """
    jd = " ".join((job.get("description_text") or "").split())[:6000]
    locs = job.get("locations_derived") or []
    cities = job.get("cities_derived") or []
    location = ((cities[0] + ", ") if cities else "") + (locs[0] if locs else "")
    location = location.strip().strip(",").strip() or (job.get("countries_derived") or [""])[0]
    # salary from the ai_* fields, when present
    smin, smax = job.get("ai_salary_minvalue"), job.get("ai_salary_maxvalue")
    salary = ""
    if smin or smax:
        rng = f"{smin}-{smax}" if (smin and smax) else str(smin or smax)
        salary = f"{rng} {job.get('ai_salary_currency') or ''}/{job.get('ai_salary_unittext') or ''}".strip().rstrip("/").strip()
    # contact: the recruiter who posted, else the AI-extracted hiring manager
    rec_name = (job.get("recruiter_name") or "").strip()
    rec_url = (job.get("recruiter_url") or "").strip()
    contact = f"{rec_name} <{rec_url}>".strip() if (rec_name or rec_url) else (job.get("ai_hiring_manager_name") or "").strip()
    emp_type = job.get("employment_type")
    if isinstance(emp_type, list):
        emp_type = emp_type[0] if emp_type else ""
    ec = job.get("linkedin_org_employees")
    return {
        "company": job.get("organization") or "",
        "company_linkedin_url": normalize_li_company(job.get("organization_url") or ""),
        "domain": clean_domain(job.get("linkedin_org_url") or ""),
        "role_title": job.get("title") or "",
        "salary": salary,
        "posted_date": job.get("date_posted") or job.get("date_created") or "",
        "location": location,
        "employee_count": ec if ec is not None else "",
        "industries": job.get("linkedin_org_industry") or "",
        "applicants": "",
        "employment_type": emp_type or "",
        "workplace_type": job.get("ai_work_arrangement") or "",
        "hiring_contact": contact,
        "recruiter_agency": "yes" if job.get("linkedin_org_recruitment_agency_derived") else "",
        "job_url": job.get("url") or "",
        "apply_url": job.get("external_apply_url") or job.get("url") or "",
        "jd_text": jd,
    }


POSTING_FIELDS = [
    "company", "company_linkedin_url", "domain", "role_title", "salary",
    "posted_date", "location", "employee_count", "industries", "applicants",
    "employment_type", "workplace_type", "hiring_contact", "recruiter_agency",
    "job_url", "apply_url", "jd_text",
]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, help="postings CSV (one row per job)")
    ap.add_argument("--companies-out", help="deduped companies CSV, shaped for apify_enrich_brands.py")
    ap.add_argument("--actor", default="fantastic-jobs~advanced-linkedin-job-search-api")
    ap.add_argument("--location", default="Denmark")
    ap.add_argument("--roles", nargs="+", default=DEFAULT_ROLES,
                    help="titleSearch terms (hunter roles) — the API actually filters by these")
    ap.add_argument("--title-exclude", nargs="+", default=DEFAULT_TITLE_EXCLUDE,
                    help="titleExclusionSearch terms (farming/mgmt dropped at source)")
    ap.add_argument("--days", type=int, default=7,
                    help="only postings newer than N days (datePostedAfter)")
    ap.add_argument("--max-items", type=int, default=100)
    ap.add_argument("--strict", action=argparse.BooleanOptionalAction, default=True,
                    help="client-side safety: also drop non-hunter titles the API let through")
    ap.add_argument("--dk", action=argparse.BooleanOptionalAction, default=True,
                    help="client-side safety: drop any non-DK location")
    ap.add_argument("--icp", action=argparse.BooleanOptionalAction, default=True,
                    help="ICP gate: drop retail/building-materials + out-of-band sizes")
    ap.add_argument("--recruiters", action=argparse.BooleanOptionalAction, default=False,
                    help="include recruiter-agency-posted roles (default: drop them)")
    ap.add_argument("--min-employees", type=int, default=5)
    ap.add_argument("--max-employees", type=int, default=1000,
                    help="server-side organizationEmployeesLte + client-side gate")
    ap.add_argument("--poll-interval", type=float, default=10.0)
    ap.add_argument("--poll-timeout", type=float, default=900.0)
    ap.add_argument("--dump-raw", help="write raw dataset JSON here for debugging")
    args = ap.parse_args()

    posted_after = (datetime.utcnow() - timedelta(days=args.days)).strftime("%Y-%m-%d") if args.days else ""
    print(f"actor: {args.actor}")
    print(f"titleSearch ({len(args.roles)}): {', '.join(args.roles)}")
    print(f"titleExclude: {', '.join(args.title_exclude)}")
    print(f"location: {args.location} | posted after: {posted_after or 'any'} | max-emp: {args.max_employees}")
    print(f"max-items: {args.max_items} (~${args.max_items/1000:.2f})")
    print()

    run_id, dataset_id = fire_actor(args.actor, args.roles, args.title_exclude, args.location,
                                    posted_after, args.max_employees, args.max_items)
    if not run_id:
        print("ERROR: failed to start actor run")
        return 1
    print(f"runId: {run_id}")
    status = poll_run(run_id, args.poll_interval, args.poll_timeout)
    print(f"status: {status}")
    jobs = fetch_dataset(dataset_id)
    print(f"→ {len(jobs)} job postings\n")

    if args.dump_raw:
        Path(args.dump_raw).write_text(json.dumps(jobs, indent=2, ensure_ascii=False))
        print(f"wrote raw items → {args.dump_raw}")

    rows = [flatten(j) for j in jobs]
    rows = [r for r in rows if r["company_linkedin_url"]]  # need the URL to act on it

    dropped_role = dropped_icp = dropped_loc = dropped_rec = 0
    if not args.recruiters:
        kept = []
        for r in rows:
            if r.get("recruiter_agency") == "yes":
                dropped_rec += 1
                print(f"  ⊘ recruiter: {r['company'][:22].ljust(24)} ({r['role_title'][:28]})")
            else:
                kept.append(r)
        rows = kept
    if args.strict:
        kept = [r for r in rows if is_sales_role(r["role_title"])]
        dropped_role = len(rows) - len(kept)
        rows = kept
    if args.dk:
        kept = []
        for r in rows:
            if is_dk_location(r["location"]):
                kept.append(r)
            else:
                dropped_loc += 1
                print(f"  ⊘ non-DK: {r['company'][:22].ljust(24)} ({r['location'][:24]})")
        rows = kept
    if args.icp:
        kept = []
        for r in rows:
            ok, reason = is_icp_company(r, args.min_employees, args.max_employees)
            if ok:
                kept.append(r)
            else:
                dropped_icp += 1
                print(f"  ⊘ icp-drop: {r['company'][:24].ljust(26)} ({reason})")
        rows = kept

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=POSTING_FIELDS)
        w.writeheader()
        w.writerows(rows)

    # Deduped companies file, shaped for apify_enrich_brands.py (needs `brand` +
    # `linkedin_url`). One company can post several roles — keep the first seen,
    # carry the triggering role/salary/date so the hook has context downstream.
    companies_written = 0
    if args.companies_out:
        seen: dict[str, dict] = {}
        for r in rows:
            key = r["company_linkedin_url"]
            if key in seen:
                continue
            seen[key] = {
                "brand": r["company"],
                "brand_clean": r["company"],
                "vertical": r["industries"],
                "country": "DK",
                "domain": r["domain"],
                "linkedin_url": r["company_linkedin_url"],
                "trigger_role": r["role_title"],
                "trigger_salary": r["salary"],
                "trigger_posted": r["posted_date"],
                "trigger_contact": r["hiring_contact"],
                "trigger_job_url": r["job_url"],
            }
        cfields = ["brand", "brand_clean", "vertical", "country", "domain",
                   "linkedin_url", "trigger_role", "trigger_salary",
                   "trigger_posted", "trigger_contact", "trigger_job_url"]
        cout = Path(args.companies_out)
        cout.parent.mkdir(parents=True, exist_ok=True)
        with open(cout, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=cfields)
            w.writeheader()
            w.writerows(seen.values())
        companies_written = len(seen)

    print("=== SUMMARY ===")
    if not args.recruiters:
        print(f"  dropped (recruiter-posted):      {dropped_rec}")
    if args.strict:
        print(f"  dropped (non-hunter titles):     {dropped_role}")
    if args.dk:
        print(f"  dropped (non-DK location):       {dropped_loc}")
    if args.icp:
        print(f"  dropped (wrong-ICP company):     {dropped_icp}")
    print(f"  job postings (with company URL): {len(rows)}")
    print(f"  unique hiring companies:         {companies_written}")
    print(f"  with salary disclosed:           {sum(1 for r in rows if r['salary'])}")
    print(f"  postings out:                    {out}")
    if args.companies_out:
        print(f"  companies out:                   {args.companies_out}")
        print(f"  → next: apify_enrich_brands.py --in {args.companies_out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
