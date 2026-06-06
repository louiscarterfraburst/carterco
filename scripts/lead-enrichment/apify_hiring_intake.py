#!/usr/bin/env python3
"""Stage 0 of the hiring-signal intake: discover DK companies hiring sales roles.

A sales job posting is the richest cold-outbound trigger there is — it's a
timed, public, self-declared "we need more leads" with budget attached. This
script fires the harvestapi LinkedIn job-search actor (same vendor as the
profile/employee/posts actors, same APIFY_API_TOKEN, ~$1 per 1k jobs, no
cookies), searching DK for sales/SDR roles posted recently.

Each posting is five inputs in one document:
  - trigger    → postedDate (+ --posted-limit recency window)
  - pain spec  → descriptionText (the JD = the spec, in their words)
  - ICP hint   → descriptionText (target vertical they sell into)
  - budget     → salary (price comp: a seat vs. the system)
  - contact    → company.name + company.linkedinUrl

The actor hands back `company.linkedinUrl` already in the exact format
apify_enrich_brands.py wants, so the --companies-out file pipes straight into
the employee-scrape stage with no Jina/find_linkedin_companies bridge.

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

# API enum values (the actor's UI shows "Past Week" etc., but the API wants these).
POSTED_LIMITS = ["1h", "24h", "week", "month"]

# LinkedIn keyword search is loose — "business developer" pulls in engineers,
# supply planners, even a French gastroenterologist. Mirror the decision-maker
# title-regex trick from apify_enrich_brands.py: keep a posting only if its
# title is genuinely a B2B sales / outbound seat (the thing the machine
# replaces), and drop retail "sales associate"-type roles even when they match.
SALES_ROLE_KEEP = [
    re.compile(r"\b(sdr|bdr)\b", re.I),
    re.compile(r"sales develop", re.I),
    re.compile(r"business develop|forretningsudvikl", re.I),
    re.compile(r"account (executive|manager|director)|key account|kundeansvarlig|kundechef", re.I),
    re.compile(r"\bsælger\b|salgskonsulent|salgsrepræsentant|salgschef|salgsdirektør|salgsudvikl", re.I),
    re.compile(r"inside sales|field sales|outbound|territory manager", re.I),
    re.compile(r"\bsales\b.*\b(rep|representative|consultant|specialist|executive|manager|lead|director)\b", re.I),
    re.compile(r"commercial (manager|director|lead)|kommerciel", re.I),
    re.compile(r"new business|demand generation", re.I),
    re.compile(r"cold call|koldkald|telefonsælg|telesælg|telemarketing", re.I),
    re.compile(r"salgstrainee|salgselev", re.I),
    re.compile(r"partner manager|partnerchef|partnerships? manager", re.I),
]
SALES_ROLE_DROP = [
    re.compile(r"sales associate|sales assistant|part[- ]?time sales|retail|\bshop\b|\bstore\b|butik|ekspedient|kassemedarbejder", re.I),
    re.compile(r"\bengineer\b|developer\b|\btechnician\b|udvikler\b", re.I),  # not "business developer" (caught by KEEP first)
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


# ICP gate on the COMPANY (not the role). The foot-in-the-door play targets
# mid-market B2B building an outbound function — not the giants who ARE the
# outbound machine (Salesforce, Google, IFS) nor retailers hiring floor staff
# (STARK). employee_count + industries are already on every row.
ICP_EXCLUDE_INDUSTRY = re.compile(
    r"retail|apparel|fashion|supermarket|grocer|restaurant|hospitality|"
    r"food.*beverage|consumer goods|leisure", re.I)


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


def fire_actor(actor_id: str, roles: list[str], location: str, posted_limit: str,
               sort_by: str, max_items: int, under10: bool) -> tuple[str, str]:
    """POST one run searching all role queries at once. Returns (runId, datasetId).

    The job actor takes searchQueries as an array, so a single run covers every
    role — no chunking needed (unlike the employee actor's free-tier 10/run cap).
    """
    url = f"{BASE}/acts/{actor_id}/runs?token={TOKEN}"
    body: dict = {
        "searchQueries": roles,
        "locations": [location],
        "postedLimit": posted_limit,
        "sortBy": sort_by,
        "maxItems": max_items,
    }
    if under10:
        body["under10Applicants"] = True
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


def fmt_salary(s: object) -> str:
    """salary = {min,max,currency,payPeriod} → '40000-55000 DKK/MONTH' or ''."""
    if not isinstance(s, dict):
        return ""
    mn, mx = s.get("min"), s.get("max")
    cur = s.get("currency") or ""
    per = s.get("payPeriod") or ""
    if mn is None and mx is None:
        return (s.get("text") or "").strip()  # actor sometimes gives free-text only
    rng = f"{mn}-{mx}" if (mn is not None and mx is not None) else str(mn if mn is not None else mx)
    tail = f" {cur}/{per}".rstrip("/").rstrip()
    return f"{rng}{tail}".strip()


def clean_domain(url: str) -> str:
    """http://www.cej.dk/ → cej.dk (bare domain for the Firecrawl B6 stage)."""
    u = (url or "").strip().lower()
    u = re.sub(r"^https?://", "", u)
    u = re.sub(r"^www\.", "", u)
    return u.split("/")[0].rstrip("/")


def loc_text(loc: object) -> str:
    """location = {parsed:{text}, linkedinText, ...} → 'Copenhagen, Denmark'."""
    if isinstance(loc, dict):
        parsed = loc.get("parsed") or {}
        return parsed.get("text") or loc.get("linkedinText") or parsed.get("city") or ""
    return loc or ""


def industries_text(company: dict) -> str:
    """company.industries = [{name,...}] → 'Real Estate; Software Development'."""
    inds = company.get("industries") or []
    names = [i.get("name") if isinstance(i, dict) else str(i) for i in inds]
    return "; ".join(n for n in names if n)


def hiring_contact(job: dict) -> str:
    """hiringTeam (when present) = the person who posted the role → 'Name <url>'."""
    team = job.get("hiringTeam") or []
    if team and isinstance(team[0], dict):
        m = team[0]
        name = (m.get("name") or "").strip()
        url = (m.get("linkedinUrl") or "").strip()
        if name or url:
            return f"{name} <{url}>".strip()
    return ""


def flatten(job: dict) -> dict:
    """Map one harvestapi job item → flat intake row."""
    company = job.get("company") or {}
    apply_method = job.get("applyMethod") or {}
    jd = (job.get("descriptionText") or "").strip()
    # Collapse runaway whitespace, cap for CSV sanity (full JDs are <4k chars).
    jd = " ".join(jd.split())[:6000]
    return {
        "company": company.get("name") or "",
        "company_linkedin_url": normalize_li_company(company.get("linkedinUrl") or ""),
        "domain": clean_domain(company.get("website") or ""),
        "role_title": job.get("title") or "",
        "salary": fmt_salary(job.get("salary")),
        "posted_date": job.get("postedDate") or "",
        "location": loc_text(job.get("location")),
        "employee_count": company.get("employeeCount") or "",
        "industries": industries_text(company),
        "applicants": job.get("applicants") if job.get("applicants") is not None else "",
        "employment_type": job.get("employmentType") or "",
        "workplace_type": job.get("workplaceType") or "",
        "hiring_contact": hiring_contact(job),
        "job_url": job.get("linkedinUrl") or "",
        "apply_url": apply_method.get("companyApplyUrl") or job.get("easyApplyUrl") or "",
        "jd_text": jd,
    }


POSTING_FIELDS = [
    "company", "company_linkedin_url", "domain", "role_title", "salary",
    "posted_date", "location", "employee_count", "industries", "applicants",
    "employment_type", "workplace_type", "hiring_contact", "job_url",
    "apply_url", "jd_text",
]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, help="postings CSV (one row per job)")
    ap.add_argument("--companies-out", help="deduped companies CSV, shaped for apify_enrich_brands.py")
    ap.add_argument("--actor", default="harvestapi~linkedin-job-search")
    ap.add_argument("--location", default="Denmark")
    ap.add_argument("--roles", nargs="+", default=DEFAULT_ROLES,
                    help="search queries (job titles); boolean operators supported")
    ap.add_argument("--posted-limit", default="week", choices=POSTED_LIMITS)
    ap.add_argument("--sort-by", default="date", choices=["date", "relevance"])
    ap.add_argument("--max-items", type=int, default=50,
                    help="results per query (0 = all pages, up to 40 ~ 1000/query)")
    ap.add_argument("--under10", action="store_true",
                    help="only postings with <10 applicants (fresh, role not yet filled)")
    ap.add_argument("--strict", action=argparse.BooleanOptionalAction, default=True,
                    help="keep only genuine B2B sales/SDR titles (drop engineers/retail/ops). --no-strict to disable")
    ap.add_argument("--icp", action=argparse.BooleanOptionalAction, default=True,
                    help="ICP gate on the company: drop giants/retail. --no-icp to disable")
    ap.add_argument("--min-employees", type=int, default=10)
    ap.add_argument("--max-employees", type=int, default=1000,
                    help="drop companies bigger than this (they ARE the outbound machine)")
    ap.add_argument("--poll-interval", type=float, default=10.0)
    ap.add_argument("--poll-timeout", type=float, default=900.0)
    ap.add_argument("--dump-raw", help="write raw dataset JSON here for debugging")
    args = ap.parse_args()

    est_jobs = (args.max_items or 1000) * len(args.roles)
    print(f"actor: {args.actor}")
    print(f"roles ({len(args.roles)}): {', '.join(args.roles)}")
    print(f"location: {args.location} | posted: {args.posted_limit} | sort: {args.sort_by}"
          f"{' | <10 applicants' if args.under10 else ''}")
    print(f"max-items/query: {args.max_items} | est ceiling: ~{est_jobs} jobs (~${est_jobs/1000:.2f})")
    print()

    run_id, dataset_id = fire_actor(args.actor, args.roles, args.location,
                                    args.posted_limit, args.sort_by, args.max_items, args.under10)
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

    dropped_role = dropped_icp = 0
    if args.strict:
        kept = [r for r in rows if is_sales_role(r["role_title"])]
        dropped_role = len(rows) - len(kept)
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
    if args.strict:
        print(f"  dropped (non-sales titles):      {dropped_role}")
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
