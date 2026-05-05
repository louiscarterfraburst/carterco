#!/usr/bin/env python3
"""Waterfall enrichment: Jina-reads-everything + Haiku-picks-when-needed.

Pass A — direct LinkedIn route (fast, deterministic):
  if current_company_link is set:
    Jina-read it → extract Website field
  else:
    Jina-read the person's LinkedIn profile → find currentCompanyLink
    → Jina-read it → extract Website

Pass B — Google fallback (when LinkedIn yielded nothing):
  Jina-read https://www.google.com/search?q=<company>
  → Haiku picks the most likely company website link from the results
  → write it back

We trust Jina's extracted Website field. Haiku is only invoked in Pass B.

Env:
  JINA_API_KEY                authenticated tier (200+ RPM)
  ANTHROPIC_API_KEY           for Haiku in Pass B
  NEXT_PUBLIC_SUPABASE_URL    + SUPABASE_SERVICE_ROLE_KEY  for DB writes

Usage:
  python3 enrich.py [--limit N] [--workers 8] [--pass A|B|both]
"""
from __future__ import annotations
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

from _supabase import select, update

JINA_KEY = os.environ.get("JINA_API_KEY")
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY")
BRAVE_KEY = os.environ.get("BRAVE_SEARCH_API_KEY")

# Jina renders LinkedIn's Website field as a Markdown link with a tracking redirect.
# Format on a company page: "Website [https://acme.dk](https://www.linkedin.com/redir/redirect?url=...)"
WEBSITE_RE = re.compile(r"Website\s*\[([^\]]+)\]\(([^)]+)\)", re.IGNORECASE)
# When Jina reads a personal profile page, the company link looks like:
# "[Company Name](https://dk.linkedin.com/company/<slug>)"
PROFILE_COMPANY_LINK_RE = re.compile(
    r"\((https?://[^)]*linkedin\.com/company/[^)]+)\)"
)


def jina_read(url: str, timeout: int = 45) -> str:
    """Fetch URL through Jina Reader, returning Markdown-ish text."""
    # Percent-encode any non-ASCII chars (Danish ø/å/æ etc.) so urllib doesn't choke.
    safe_url = urllib.parse.quote(url, safe=":/?#[]@!$&'()*+,;=~%")
    target = f"https://r.jina.ai/{safe_url}"
    headers = {"User-Agent": "Mozilla/5.0", "Accept": "text/plain"}
    if JINA_KEY:
        headers["Authorization"] = f"Bearer {JINA_KEY}"
    req = urllib.request.Request(target, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as f:
        return f.read().decode("utf-8", errors="ignore")


def jina_read_with_retry(url: str, retries: int = 3) -> str:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            return jina_read(url)
        except urllib.error.HTTPError as e:
            last = e
            if e.code == 429 and attempt < retries - 1:
                time.sleep(3 * (attempt + 1))
                continue
            if e.code in (502, 503, 504) and attempt < retries - 1:
                time.sleep(2 * (attempt + 1))
                continue
            raise
        except Exception as e:
            last = e
            if attempt < retries - 1:
                time.sleep(2)
                continue
            raise
    if last:
        raise last
    return ""


def extract_website_from_company_page(body: str) -> str:
    m = WEBSITE_RE.search(body)
    if not m:
        return ""
    label = m.group(1).strip()
    if label.lower().startswith("http"):
        return label
    real = re.search(r"url=(https?%3A[^&]+)", m.group(2))
    return urllib.parse.unquote(real.group(1)) if real else ""


def extract_company_link_from_profile(body: str) -> str:
    m = PROFILE_COMPANY_LINK_RE.search(body)
    if not m:
        return ""
    raw = m.group(1)
    p = urllib.parse.urlparse(raw)
    sm = re.match(r"(/company/[^/]+)", p.path.rstrip("/"))
    return f"https://www.linkedin.com{sm.group(1)}" if sm else ""


# ─── Pass A ──────────────────────────────────────────────────────────────


def pass_a(lead: dict) -> dict:
    """Direct LinkedIn route. Returns {website, source_url, pass}."""
    out: dict[str, str | None] = {
        "website": None,
        "source_url": None,
        "website_pass": None,
        "error": None,
    }
    co_link = lead.get("current_company_link")
    if co_link:
        try:
            body = jina_read_with_retry(co_link)
            ws = extract_website_from_company_page(body)
            if ws:
                out.update(
                    website=ws,
                    source_url=co_link,
                    website_pass="A_csv_link",
                )
                return out
        except Exception as e:
            out["error"] = f"jina-co-link: {e}"

    # No CSV link OR CSV link didn't yield → read the person's profile to find one
    profile = lead["linkedin_url"]
    try:
        body = jina_read_with_retry(profile)
        co_link2 = extract_company_link_from_profile(body)
        if not co_link2:
            return out  # no website, no error
        body2 = jina_read_with_retry(co_link2)
        ws = extract_website_from_company_page(body2)
        if ws:
            out.update(
                website=ws,
                source_url=co_link2,
                website_pass="A_jina_profile",
                error=None,
            )
        return out
    except Exception as e:
        out["error"] = f"jina-profile: {e}"
        return out


# ─── Pass B ──────────────────────────────────────────────────────────────

HAIKU_SYSTEM = """Du hjælper med at finde en virksomheds officielle hjemmeside ud fra en Google-søgning.
Input er virksomhedsnavnet og en uddrag af Google-søgeresultater (titler + URLs + uddrag).
Returnér KUN den ene URL der mest sandsynligt er virksomhedens officielle hjemmeside.
Hvis ingen af resultaterne ser ud til at være den rigtige virksomhed, returnér NONE.
Svar i én linje uden forklaring eller markdown.
Foretræk korporatets officielle domæne (acme.dk, acme.com) over LinkedIn, Facebook, Trustpilot, Crunchbase, business directories.
"""

HAIKU_DIRECT_SYSTEM = """Du er en B2B-virksomhedsdatabase. Brugeren giver dig et dansk virksomhedsnavn (evt. med branche, by, land).
Hvis du er HØJST SIKKER på virksomhedens officielle hjemmeside-URL — svar med URL'en (én linje, intet andet).
Hvis du er det mindste i tvivl — svar UNKNOWN. Det er bedre at sige UNKNOWN end at gætte.
Svar aldrig med en LinkedIn-, Facebook-, Trustpilot-, Crunchbase- eller registry-URL.
Eksempel godt svar: https://novo-nordisk.com
Eksempel dårligt svar: https://www.linkedin.com/company/novonordisk
"""


def _haiku_call(system: str, user: str, max_tokens: int = 80, model: str = "claude-haiku-4-5-20251001") -> str:
    if not ANTHROPIC_KEY:
        raise RuntimeError("ANTHROPIC_API_KEY not set")
    payload = {
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=45) as f:
        body = json.loads(f.read().decode("utf-8"))
    blocks = body.get("content") or []
    return "".join(b.get("text", "") for b in blocks if b.get("type") == "text").strip()


def haiku_pick_url(company: str, serp_text: str) -> str:
    text = _haiku_call(
        HAIKU_SYSTEM,
        f"Virksomhed: {company}\n\nGoogle-resultater:\n{serp_text[:6000]}",
    )
    if text.upper().startswith("NONE"):
        return ""
    m = re.search(r"https?://[^\s\)\]<>\"']+", text)
    return m.group(0) if m else ""


def haiku_direct_guess(company: str, industry: str = "", city: str = "", country: str = "") -> str:
    """Ask Sonnet directly for the company website. Returns "" if Sonnet says UNKNOWN."""
    ctx_lines = [f"Virksomhed: {company}"]
    if industry: ctx_lines.append(f"Branche: {industry}")
    if city or country: ctx_lines.append(f"Lokation: {', '.join(x for x in (city, country) if x)}")
    text = _haiku_call(
        HAIKU_DIRECT_SYSTEM,
        "\n".join(ctx_lines),
        max_tokens=60,
        model="claude-sonnet-4-6",
    )
    if text.upper().startswith("UNKNOWN") or text.upper().startswith("NONE"):
        return ""
    m = re.search(r"https?://[^\s\)\]<>\"']+", text)
    return m.group(0) if m else ""


def brave_search(query: str, count: int = 5) -> list[dict]:
    """Hit Brave Search API. Returns list of {title, url, description} dicts.
    Empty list on any failure (caller decides what to do)."""
    if not BRAVE_KEY:
        raise RuntimeError("BRAVE_SEARCH_API_KEY not set")
    qs = urllib.parse.urlencode({"q": query, "count": count})
    req = urllib.request.Request(
        f"https://api.search.brave.com/res/v1/web/search?{qs}",
        headers={
            "Accept": "application/json",
            "X-Subscription-Token": BRAVE_KEY,
        },
    )
    with urllib.request.urlopen(req, timeout=20) as f:
        body = json.loads(f.read().decode("utf-8"))
    web = (body.get("web") or {}).get("results") or []
    return [
        {
            "title": r.get("title") or "",
            "url": r.get("url") or "",
            "description": r.get("description") or "",
        }
        for r in web
    ]


def head_check(url: str, timeout: int = 6) -> bool:
    """HEAD-request the URL to confirm it resolves. Treats any 2xx/3xx as live."""
    try:
        req = urllib.request.Request(
            url, method="HEAD",
            headers={"User-Agent": "Mozilla/5.0 (compatible; CarterCo/1.0)"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return 200 <= r.status < 400
    except urllib.error.HTTPError as e:
        # Many sites block HEAD or 405-it but return content on GET — accept 4xx as "exists"
        # only for codes that imply the host is real (400, 401, 403, 405, 429).
        return e.code in (400, 401, 403, 405, 429)
    except Exception:
        return False


def pass_b(lead: dict) -> dict:
    out: dict[str, str | None] = {
        "website": None,
        "source_url": None,
        "website_pass": None,
        "error": None,
    }
    company = (lead.get("company") or "").strip()
    if not company:
        out["error"] = "no company name"
        return out

    # Step 1 — Sonnet-direct: ~$0.001/lead, ~1.5s. Catches well-known names cheaply.
    try:
        guess = haiku_direct_guess(
            company,
            (lead.get("industry") or "").strip(),
            (lead.get("city") or "").strip(),
            (lead.get("country") or "").strip(),
        )
    except Exception as e:
        guess = ""
        out["error"] = f"sonnet-direct: {e}"
    if guess and head_check(guess):
        out.update(website=guess, source_url="sonnet:direct", website_pass="B_sonnet_direct")
        return out

    # Step 2 — Brave Search → Haiku reranks the top hits.
    if not BRAVE_KEY:
        # No Brave key configured; nothing more to do for this lead
        return out
    try:
        results = brave_search(company, count=5)
    except Exception as e:
        out["error"] = f"brave: {e}"
        return out
    if not results:
        return out
    serp_text = "\n".join(
        f"- {r['title']}\n  {r['url']}\n  {r['description']}" for r in results
    )
    try:
        url = haiku_pick_url(company, serp_text)
    except Exception as e:
        out["error"] = f"haiku-pick: {e}"
        return out
    if not url:
        return out
    if not head_check(url):
        out["error"] = f"head-fail: {url}"
        return out
    out.update(website=url, source_url="brave:search", website_pass="B_google")
    out["error"] = None  # clear any earlier non-fatal sonnet-direct error
    return out


# ─── Driver ──────────────────────────────────────────────────────────────


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_result(lead: dict, result: dict) -> None:
    patch = {
        "website": result.get("website"),
        "source_url": result.get("source_url"),
        "website_pass": result.get("website_pass"),
        "error": result.get("error"),
        "enriched_at": now_iso() if result.get("website") else None,
        "attempts": (lead.get("attempts") or 0) + 1,
        "updated_at": now_iso(),
    }
    where = "linkedin_url=eq." + urllib.parse.quote(lead["linkedin_url"], safe="")
    update("leads_to_enrich", where, patch)


def fetch_pending(which_pass: str, limit: int) -> list[dict]:
    """Pull pending leads for the given pass."""
    if which_pass == "A":
        # Pass A: never enriched, no error blocking
        q = "website=is.null&attempts=lt.3&select=*&order=imported_at.asc"
    elif which_pass == "B":
        # Pass B: any lead Pass A couldn't enrich (errored, capped, or no website on LI).
        q = "website=is.null&attempts=gt.0&select=*&order=imported_at.asc"
    else:
        q = "website=is.null&attempts=lt.3&select=*&order=imported_at.asc"
    # Supabase PostgREST defaults to a 1000-row cap if no explicit limit. Always set one.
    q += f"&limit={limit if limit else 100000}"
    return select("leads_to_enrich", q)


def run_pass(name: str, leads: list[dict], func, workers: int) -> tuple[int, int]:
    hits = 0
    processed = 0
    if not leads:
        return 0, 0
    print(f"\n=== {name} : {len(leads)} leads, {workers} workers ===", file=sys.stderr)
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(func, lead): lead for lead in leads}
        for fut in as_completed(futures):
            lead = futures[fut]
            try:
                res = fut.result()
            except Exception as e:
                res = {"website": None, "error": f"worker: {e}"}
            processed += 1
            try:
                write_result(lead, res)
            except Exception as e:
                print(f"  write error for {lead['linkedin_url']}: {e}", file=sys.stderr)
                continue
            mark = "✓" if res.get("website") else ("✗" if res.get("error") else "·")
            ws = res.get("website") or res.get("error") or "(no website found)"
            name_disp = lead.get("full_name") or "?"
            company_disp = lead.get("company") or "?"
            print(
                f"  [{processed}/{len(leads)}] {mark} {name_disp} @ {company_disp!r} → {ws[:120]}",
                file=sys.stderr,
            )
            if res.get("website"):
                hits += 1
    return processed, hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="Cap leads per pass (0 = all)")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--pass", dest="which", choices=("A", "B", "both"), default="both")
    args = ap.parse_args()

    if args.which in ("A", "both"):
        leads = fetch_pending("A", args.limit)
        run_pass("Pass A — Jina LinkedIn", leads, pass_a, args.workers)

    if args.which in ("B", "both"):
        leads = fetch_pending("B", args.limit)
        run_pass("Pass B — Jina Google + Haiku", leads, pass_b, max(2, args.workers // 2))

    # Summary
    total = select("leads_to_enrich", "select=count")
    enriched = select("leads_to_enrich", "website=not.is.null&select=count")
    print(
        f"\nFinal: {enriched[0]['count'] if enriched else 0}"
        f" / {total[0]['count'] if total else 0} have a website",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
