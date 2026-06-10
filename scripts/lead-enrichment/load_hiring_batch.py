#!/usr/bin/env python3
"""Final stage of the hiring-signal pipeline: collision-aware staging +
optional SendPilot load + run record.

  apify_hiring_intake.py → apify_enrich_brands.py → resolve_profile_urls.py → THIS

What it does, safely enough to run unattended on a cron:
  1. Reads the resolved enriched CSV (status=found rows with vanity URLs).
  2. Drops rows whose URL is STILL encoded (unresolved) — never ships dead links.
  3. Queries outreach_leads and partitions the batch:
       - net-new            → stage + (optionally) add to SendPilot
       - already CarterCo   → skip (dedup; re-runs don't double-add)
       - other workspace    → SKIP, never clobber a client's lead. The plain
                              upsert below can't touch them because they're
                              excluded from the staged set entirely.
  4. Dialogue guard: net-new buyers whose COMPANY has an active dialogue
     (inbound reply <90d, live /leads row, or open deal) are HELD — not
     staged, not loaded. Same person twice is blocked by the URL dedupe;
     a different person at the same company is fine, but never while a
     colleague is mid-conversation.
  5. INSERTs net-new into outreach_leads (play=hiring_signal + {role} merge).
  6. Optionally POSTs net-new to a SendPilot campaign (--sendpilot-campaign).
  7. Writes one public.hiring_pipeline_runs record (counts + per-company detail)
     so /outreach can show what the run did without reading CI logs.

Usage:
  set -a; source .env.local; set +a
  python3 scripts/lead-enrichment/load_hiring_batch.py \\
    --in clients/carterco/data/hiring_enriched_dk_resolved.csv \\
    --companies clients/carterco/data/hiring_companies_dk.csv \\
    [--sendpilot-campaign cmq2p6otl0bd23a01kguv712n] [--trigger cron]
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

WORKSPACE_ID = "1e067f9a-d453-41a7-8bc4-9fdb5644a5fa"  # CarterCo (louis@carterco.dk)
ENCODED_RE = re.compile(r"/in/AC[woq]AA", re.I)
SLUG_RE = re.compile(r"[^a-z0-9-]+")
DIALOGUE_REPLY_WINDOW_DAYS = 90  # inbound replies older than this no longer block

SB = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL") \
    or sys.exit("SUPABASE_URL required")
KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or sys.exit("SUPABASE_SERVICE_ROLE_KEY required")


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9æøå]", "", (s or "").lower())


def slug_of(url: str) -> str:
    if not url:
        return ""
    return SLUG_RE.sub("-", url.rstrip("/").split("/")[-1].lower())


def synth_email(url: str) -> str:
    if not url:
        return ""
    h = hashlib.sha1(url.rstrip("/").encode()).hexdigest()[:6]
    return f"carterco+li-{slug_of(url)[:30]}-{h}@carterco.dk"


def clean_website(url: str | None) -> str:
    raw = (url or "").strip()
    if not raw:
        return ""
    cand = raw if "://" in raw else "https://" + raw
    try:
        p = urllib.parse.urlparse(cand)
        return f"{(p.scheme or 'https').lower()}://{p.netloc.lower()}" if p.netloc else raw
    except Exception:
        return raw


def clean_role(title: str) -> str:
    t = (title or "").lower()
    if "sdr" in t or "sales development" in t:
        return "SDR"
    if "bdr" in t:
        return "BDR"
    # Danish DM convention: job titles lowercase mid-sentence ("søger en
    # account executive"); only true acronyms (SDR/BDR) keep caps.
    if "account executive" in t or re.search(r"\bae\b", t):
        return "account executive"
    if "business develop" in t or "forretningsudvikl" in t:
        return "business developer"
    if "salgskonsulent" in t:
        return "salgskonsulent"
    if "sælger" in t or "saelger" in t:
        return "sælger"
    raw = (title or "").strip()
    return raw if (raw and len(raw) <= 30 and raw.count(" ") <= 3) else "sælger"


def _domain(url: str) -> str:
    raw = (url or "").strip().lower()
    if not raw:
        return ""
    netloc = urllib.parse.urlparse(raw if "://" in raw else "https://" + raw).netloc or raw
    return netloc.removeprefix("www.")


def sb(method: str, path: str, body=None, prefer=None):
    headers = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
    if prefer:
        headers["Prefer"] = prefer
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{SB}/rest/v1/{path}", data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as f:
        txt = f.read().decode()
        return json.loads(txt) if txt else []


def sb_all(path: str, page: int = 1000) -> list:
    """GET every row, paging past PostgREST's max-rows cap (default 1000).
    The dialogue guard reads MUST be complete — a silently truncated read
    means the guard stops seeing some in-dialogue companies and stages cold
    outreach into live conversations, the exact thing it exists to prevent."""
    out: list = []
    offset = 0
    sep = "&" if "?" in path else "?"
    while True:
        batch = sb("GET", f"{path}{sep}limit={page}&offset={offset}")
        out.extend(batch)
        if len(batch) < page:
            return out
        offset += page


def dialogue_companies() -> tuple[set[str], set[str]]:
    """Companies (normalized names, domains) with an ACTIVE dialogue in the
    CarterCo workspace. A company qualifies when any of:
      - someone there sent an inbound reply within DIALOGUE_REPLY_WINDOW_DAYS
      - someone there has a live /leads row (not draft, not dead outcome)
      - there's an open deal on the company
    Cold-contacting a different person at such a company is what the guard
    prevents; companies merely sitting staged/invited do NOT block.
    """
    names: set[str] = set()
    domains: set[str] = set()

    since = (datetime.now(timezone.utc) - timedelta(days=DIALOGUE_REPLY_WINDOW_DAYS)).isoformat()
    replies = sb_all(f"outreach_replies?direction=eq.inbound&workspace_id=eq.{WORKSPACE_ID}"
                     f"&received_at=gte.{urllib.parse.quote(since)}&select=linkedin_url")
    urls = sorted({r["linkedin_url"] for r in replies if r.get("linkedin_url")})
    # Chunk the in.(...) list: hundreds of ~70-char URLs in one querystring
    # would blow past gateway URL-length limits and abort the whole cron run.
    for i in range(0, len(urls), 80):
        inlist = ",".join('"%s"' % u for u in urls[i:i + 80])
        for x in sb_all(f"outreach_leads?linkedin_url=in.({urllib.parse.quote(inlist)})"
                        "&select=company,website"):
            names.add(_norm(x.get("company") or ""))
            domains.add(_domain(x.get("website") or ""))

    for x in sb_all(f"leads?workspace_id=eq.{WORKSPACE_ID}&is_draft=not.is.true"
                    "&select=company,outcome"):
        if (x.get("outcome") or "") not in ("not_interested", "unqualified"):
            names.add(_norm(x.get("company") or ""))

    for x in sb_all(f"deals?workspace_id=eq.{WORKSPACE_ID}&stage=neq.lost"
                    "&select=company_name,company_domain"):
        names.add(_norm(x.get("company_name") or ""))
        domains.add(_domain(x.get("company_domain") or ""))

    names.discard("")
    domains.discard("")
    return names, domains


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="inp", required=True, help="resolved enriched CSV")
    ap.add_argument("--companies", default="clients/carterco/data/hiring_companies_dk.csv")
    ap.add_argument("--sendpilot-campaign", help="campaign id to auto-load net-new into")
    ap.add_argument("--trigger", default="manual", choices=["manual", "cron"])
    ap.add_argument("--play", default="hiring_signal")
    ap.add_argument("--no-record", action="store_true", help="skip writing the run record")
    args = ap.parse_args()

    rows = [r for r in csv.DictReader(open(args.inp, encoding="utf-8"))
            if r.get("status") == "found" and (r.get("linkedin_profile_url") or "").startswith("http")]
    unresolved = [r for r in rows if ENCODED_RE.search(r["linkedin_profile_url"])]
    candidates = [r for r in rows if not ENCODED_RE.search(r["linkedin_profile_url"])]

    role_by_co: dict[str, str] = {}
    try:
        for c in csv.DictReader(open(args.companies, encoding="utf-8")):
            role_by_co[_norm(c.get("brand", ""))] = c.get("trigger_role", "")
    except FileNotFoundError:
        pass

    # Partition against existing outreach_leads.
    urls = [r["linkedin_profile_url"].strip() for r in candidates]
    existing: dict[str, dict] = {}
    if urls:
        inlist = ",".join('"%s"' % u for u in urls)
        q = f"outreach_leads?linkedin_url=in.({urllib.parse.quote(inlist)})&select=linkedin_url,workspace_id"
        existing = {x["linkedin_url"]: x for x in sb("GET", q)}

    netnew, skipped_cc, skipped_other = [], 0, 0
    for r in candidates:
        u = r["linkedin_profile_url"].strip()
        if u not in existing:
            netnew.append(r)
        elif existing[u]["workspace_id"] == WORKSPACE_ID:
            skipped_cc += 1
        else:
            skipped_other += 1

    # Dialogue guard (company level): hold net-new buyers whose company has an
    # active conversation going — never open a second cold thread into it.
    # FAILS CLOSED: if the guard's reads error OR come back implausibly empty
    # (carterco always has live leads — an empty set means RLS/permissions/
    # schema drift silently broke a read), abort the run instead of staging.
    # A guard that says "nothing in dialogue" on infrastructure failure is
    # worse than no guard, because the run record would look green.
    held = []
    if netnew:
        try:
            dlg_names, dlg_domains = dialogue_companies()
        except Exception as e:
            print(f"FATAL: dialogue guard could not read its sources ({e}) — "
                  f"aborting before staging anything", file=sys.stderr)
            return 1
        if not dlg_names and not dlg_domains:
            print("FATAL: dialogue guard returned ZERO companies — implausible "
                  "(live /leads rows always exist). A read is silently broken; "
                  "aborting before staging anything", file=sys.stderr)
            return 1
        clear = []
        for r in netnew:
            co, dom = _norm(r.get("brand", "")), _domain(r.get("domain", ""))
            if (co and co in dlg_names) or (dom and dom in dlg_domains):
                held.append(r)
            else:
                clear.append(r)
        netnew = clear

    # Build + stage net-new rows. Dedupe by linkedin_url WITHIN the batch: the
    # same person can be matched to two companies in one run (e.g. a buyer who
    # is the poster on one role and a commercial lead on another), which would
    # put the same conflict key twice in the on_conflict upsert and trip
    # Postgres' "ON CONFLICT DO UPDATE cannot affect row a second time". Keep
    # the first occurrence.
    staged_rows, detail = [], []
    seen_urls: set[str] = set()
    for r in netnew:
        url = r["linkedin_profile_url"].strip()
        if url in seen_urls:
            continue
        seen_urls.add(url)
        first = (r.get("first_name") or "").strip()
        last = (r.get("last_name") or "").strip()
        brand = (r.get("brand") or "").strip()
        staged_rows.append({
            "linkedin_url": url,
            "first_name": first or None, "last_name": last or None,
            "full_name": f"{first} {last}".strip() or None,
            "company": brand or None, "title": (r.get("title") or "").strip() or None,
            "website": clean_website(r.get("domain")) or None,
            "contact_email": synth_email(url),
            "workspace_id": WORKSPACE_ID, "play": args.play,
            "role": clean_role(role_by_co.get(_norm(brand), "")),
        })
        detail.append({"company": brand, "name": f"{first} {last}".strip(),
                       "title": (r.get("title") or "")[:60], "source": r.get("source", "")})
    for r in held:
        detail.append({"company": (r.get("brand") or "").strip(),
                       "name": f"{(r.get('first_name') or '').strip()} {(r.get('last_name') or '').strip()}".strip(),
                       "title": (r.get("title") or "")[:60], "source": r.get("source", ""),
                       "held": "company_in_dialogue"})
    if staged_rows:
        sb("POST", "outreach_leads?on_conflict=linkedin_url", body=staged_rows,
           prefer="resolution=merge-duplicates,return=minimal")

    # Optional SendPilot load (net-new only).
    added_sp = 0
    if args.sendpilot_campaign and netnew:
        sp_key = os.environ.get("SENDPILOT_API_KEY")
        if not sp_key:
            print("WARN: SENDPILOT_API_KEY missing — skipping SendPilot load")
        else:
            leads = [{"linkedinUrl": r["linkedin_profile_url"].strip(),
                      "firstName": (r.get("first_name") or "").strip(),
                      "lastName": (r.get("last_name") or "").strip(),
                      "company": (r.get("brand") or "").strip(),
                      "title": (r.get("title") or "").strip(),
                      "website": clean_website(r.get("domain"))} for r in netnew]
            body = json.dumps({"campaignId": args.sendpilot_campaign, "leads": leads}).encode()
            req = urllib.request.Request("https://api.sendpilot.ai/v1/leads", data=body, method="POST",
                                         headers={"Authorization": f"Bearer {sp_key}",
                                                  "Content-Type": "application/json"})
            try:
                res = json.loads(urllib.request.urlopen(req, timeout=60).read())
                added_sp = res.get("leadsAdded", 0)
            except urllib.error.HTTPError as e:
                print(f"WARN: SendPilot add failed {e.code}: {e.read().decode()[:200]}")

    companies_found = len({_norm(r.get("brand", "")) for r in rows})
    summary = {
        "trigger": args.trigger, "companies_found": companies_found,
        "decision_makers": len(rows), "leads_staged": len(staged_rows),
        "leads_added_sendpilot": added_sp, "skipped_existing": skipped_cc,
        "skipped_cross_workspace": skipped_other, "unresolved": len(unresolved),
        "held_company_dialogue": len(held),
        "status": "ok", "detail": detail,
    }
    if not args.no_record:
        sb("POST", "hiring_pipeline_runs", body=summary, prefer="return=minimal")

    print(json.dumps({k: v for k, v in summary.items() if k != "detail"}, ensure_ascii=False))
    print(f"  staged {len(staged_rows)} net-new | sendpilot +{added_sp} | "
          f"skipped {skipped_cc} dup / {skipped_other} other-ws | "
          f"held {len(held)} company-dialogue | {len(unresolved)} unresolved held")
    return 0


if __name__ == "__main__":
    sys.exit(main())
