#!/usr/bin/env python3
"""For misses that have currentCompany but no currentCompanyLink:
  1) Serper-search "{company} linkedin" → first linkedin.com/company URL
  2) Jina Reader on that URL → extract the Website field
  3) Verify the LI page name matches source company (token match, then Haiku)

Env vars required:
  SERPER_API_KEY
  ANTHROPIC_API_KEY

Run:
  python3 find_co_link.py --csv <source> --misses <misses CSV> [--sample N] [--all]
"""
import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

SERPER_KEY = os.environ.get("SERPER_API_KEY") or sys.exit("SERPER_API_KEY not set")
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY") or sys.exit(
    "ANTHROPIC_API_KEY not set"
)
OUT_PATH = "data/progress_find_co.jsonl"

WEBSITE_RE = re.compile(r"Website\s*\[([^\]]+)\]\(([^)]+)\)")
LI_TITLE_RE = re.compile(r"^Title:\s*(.+?)\s*(?:\||$)", re.MULTILINE)


def serper_search(query):
    data = json.dumps({"q": query, "num": 8}).encode()
    req = urllib.request.Request(
        "https://google.serper.dev/search",
        data=data,
        headers={"X-API-KEY": SERPER_KEY, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as f:
        return json.loads(f.read().decode())


def normalize_company_link(link):
    p = urllib.parse.urlparse(link)
    m = re.match(r"(/company/[^/]+)", p.path.rstrip("/"))
    return f"https://www.linkedin.com{m.group(1)}" if m else ""


def find_company_linkedin(company_name):
    try:
        res = serper_search(f'"{company_name}" linkedin')
    except Exception:
        try:
            res = serper_search(f'{company_name} linkedin company')
        except Exception:
            return ""
    for r in res.get("organic", []):
        link = r.get("link", "")
        if re.search(r"linkedin\.com/company/[^/?]+", link):
            return normalize_company_link(link)
    return ""


def company_tokens(s):
    s = re.sub(r"[│|/]", " ", s.lower())
    s = re.sub(r"[^\w\s\-]", " ", s)
    stop = {"a/s","aps","as","ltd","llc","inc","gmbh","ab","sa","bv","group",
            "holding","holdings","company","co","corp","corporation","the",
            "og","and","&","|","-","of","for","hos"}
    return {t for t in re.split(r"\s+", s) if t and t not in stop and len(t) >= 2}


def names_match(csv_name, li_page_title, threshold=0.5):
    a = company_tokens(csv_name)
    b = company_tokens(li_page_title)
    if not a or not b:
        return False
    overlap = len(a & b)
    return overlap >= 1 and overlap / min(len(a), len(b)) >= threshold


def haiku_verify(csv_name, li_page_title, li_description=""):
    prompt = (
        f"A LinkedIn company page and a source record may refer to the same company.\n"
        f"Source company name: {csv_name!r}\n"
        f"LinkedIn page name:  {li_page_title!r}\n"
        f"LinkedIn description (first 300 chars): {li_description[:300]!r}\n\n"
        f"Answer with one word: YES if they are the same organization "
        f"(even if translated, abbreviated, or using a parent/subsidiary variant "
        f"that clearly points to the same entity), otherwise NO."
    )
    body = json.dumps({
        "model": "claude-haiku-4-5",
        "max_tokens": 5,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "x-api-key": ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as f:
            d = json.loads(f.read().decode())
        txt = d.get("content", [{}])[0].get("text", "").strip().upper()
        return txt.startswith("YES")
    except Exception as e:
        print(f"  haiku err: {e}", file=sys.stderr)
        return False


def fetch_website(company_linkedin_url, source_name, retries=3):
    jina = f"https://r.jina.ai/{company_linkedin_url}"
    for attempt in range(retries):
        try:
            req = urllib.request.Request(jina, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=45) as f:
                body = f.read().decode("utf-8", errors="ignore")
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries - 1:
                time.sleep(3 * (attempt + 1))
                continue
            return "", "fetch_error"
        except Exception:
            if attempt < retries - 1:
                time.sleep(2)
                continue
            return "", "fetch_error"

        tm = LI_TITLE_RE.search(body)
        page_title = tm.group(1).strip() if tm else ""
        desc_m = re.search(r"####\s*(.{20,300})", body)
        page_desc = desc_m.group(1).strip() if desc_m else ""

        if not names_match(source_name, page_title):
            if not page_title:
                if len(body) < 5000 and attempt < retries - 1:
                    time.sleep(3 * (attempt + 1))
                    continue
                return "", "no_page_title"
            if not haiku_verify(source_name, page_title, page_desc):
                return "", f"rejected: LI page = {page_title!r}"

        m = WEBSITE_RE.search(body)
        if not m:
            return "", "no_website_field"
        label = m.group(1).strip()
        if label.startswith("http"):
            return label, ""
        real = re.search(r"url=(https?%3A[^&]+)", m.group(2))
        return (urllib.parse.unquote(real.group(1)) if real else ""), ""
    return "", "exhausted_retries"


def process(row):
    name = f"{row['firstName']} {row['lastName']}".strip()
    company = row["company"].strip()
    if not company:
        return {"linkedinUrl": row["linkedinUrl"], "name": name, "company": "",
                "co_link": "", "website": "", "note": "no company name"}
    co_link = find_company_linkedin(company)
    website = ""
    note = ""
    if co_link:
        website, note = fetch_website(co_link, company)
    else:
        note = "no linkedin co-page found"
    return {
        "linkedinUrl": row["linkedinUrl"],
        "name": name,
        "company": company,
        "co_link": co_link,
        "website": website,
        "note": note,
    }


def load_progress():
    done = {}
    if os.path.exists(OUT_PATH):
        with open(OUT_PATH) as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        o = json.loads(line)
                        done[o["linkedinUrl"]] = o
                    except Exception:
                        pass
    return done


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--sample", type=int)
    g.add_argument("--all", action="store_true")
    ap.add_argument("--csv", required=True, help="source extractor CSV")
    ap.add_argument("--misses", required=True, help="misses CSV (per-lead)")
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()

    with open(args.csv, encoding="utf-8-sig") as f:
        src = {(r.get("linkedinUrl") or "").strip(): r for r in csv.DictReader(f)}

    rows = []
    with open(args.misses) as f:
        for r in csv.DictReader(f):
            src_row = src.get(r["linkedinUrl"], {})
            has_co_link = bool((src_row.get("currentCompanyLink") or "").strip())
            if r["company"].strip() and not has_co_link:
                rows.append(r)

    print(f"Eligible misses: {len(rows)}")
    done = load_progress()
    todo = [r for r in rows if r["linkedinUrl"] not in done]
    print(f"Already done: {len(done)}, to process: {len(todo)}")
    if args.sample:
        todo = todo[: args.sample]

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    out_f = open(OUT_PATH, "a")
    processed = hits = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(process, r): r for r in todo}
        for fut in as_completed(futures):
            try:
                res = fut.result()
            except Exception as e:
                print(f"worker error: {e}", file=sys.stderr)
                continue
            processed += 1
            if res["website"]:
                hits += 1
            status = res["website"] or f"({res['note']})"
            print(f"[{processed}/{len(todo)}] {res['name']} @ {res['company']!r} → {status}")
            out_f.write(json.dumps(res, ensure_ascii=False) + "\n")
            out_f.flush()
    out_f.close()

    print(f"\nHits: {hits}/{processed}")


if __name__ == "__main__":
    main()
