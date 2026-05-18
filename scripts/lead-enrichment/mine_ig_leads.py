"""Mine LinkedIn decision-makers for IG-ad brands.

Source: data/ig_ads_extracted.csv (74 rows -> ~50 unique brands after filter).
Output: data/mined_leads.csv (appended row-by-row for crash safety).

Uses Brave Search API (BRAVE_SEARCH_API_KEY in .env.local). Task asked for
Serper but the project only has Brave configured, and Brave returns the same
shape (title/url/description snippet) so the search-then-pick-LinkedIn-result
strategy is identical.

Cap: ~4 search queries per brand. Resumable: skips brands already in output.
"""
from __future__ import annotations

import csv
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path("/Users/louiscarter/carterco")
SRC_CSV = ROOT / "clients/carterco/data/ig_ads_extracted.csv"
OUT_CSV = ROOT / "clients/carterco/data/mined_leads.csv"
ENV_FILE = ROOT / ".env.local"

FIELDS = [
    "source_filename", "brand", "vertical", "linkedin_company_url",
    "first_name", "last_name", "title", "linkedin_url", "country",
    "confidence", "notes",
]


def load_env() -> dict:
    env = {}
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


ENV = load_env()
BRAVE_KEY = ENV.get("BRAVE_SEARCH_API_KEY") or sys.exit("BRAVE_SEARCH_API_KEY not set")


# Simple in-memory cache so retries within a brand don't re-bill queries
_SEARCH_CACHE: dict[str, list[dict]] = {}


def brave_search(query: str, count: int = 10, country: str = "dk") -> list[dict]:
    """Return a list of {title, url, description} for the query."""
    cache_key = f"{country}|{count}|{query}"
    if cache_key in _SEARCH_CACHE:
        return _SEARCH_CACHE[cache_key]

    url = "https://api.search.brave.com/res/v1/web/search?" + urllib.parse.urlencode({
        "q": query, "country": country, "count": count, "search_lang": "da",
    })
    req = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "X-Subscription-Token": BRAVE_KEY,
    })
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                data = json.loads(r.read())
            results = data.get("web", {}).get("results", []) or []
            out = [{"title": x.get("title", ""), "url": x.get("url", ""),
                    "description": x.get("description", "")} for x in results]
            _SEARCH_CACHE[cache_key] = out
            time.sleep(0.4)  # Brave free tier: 1 req/sec ceiling
            return out
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(2 + attempt * 2)
                continue
            print(f"  search HTTPError {e.code} on '{query[:50]}'", file=sys.stderr)
            _SEARCH_CACHE[cache_key] = []
            return []
        except Exception as e:
            print(f"  search err on '{query[:60]}': {e}", file=sys.stderr)
            time.sleep(1)
    _SEARCH_CACHE[cache_key] = []
    return []


# ---------- Brand normalization ----------

BRAND_OVERRIDES = {
    "profilmatch": "ProfilMatch",
    "menetoregnskab": "Meneto Regnskab",
    "creaocreao": "Creao",
    "revimark_aps": "Revimark",
    "lukas fra aluva (aluvadk)": "Aluva",
    "jesper skalshøi - samic": "Samic",
    "srsmultiservice": "SRS Multiservice",
    "surveygauge": "SurveyGauge",
    "mick_c_fynbo": "Mick C. Fynbo",
    "nordic_gulvservice": "Nordic Gulvservice",
    "businesswithofficial": "Business With",
    "vikingflyt": "Viking Flyt",
    "logistik.dk": "Logistik.dk",
    "hjulster": "Hjulster",
    "danskefterisolering": "Dansk Efterisolering",
    "intopit_as": "Intopit",
    "scancoffeegroupt": "Scan Coffee Group",
    "vincentgraphicdk": "Vincent Graphic",
    "stadsrevisionen": "Stadsrevisionen",
    "valentin regnskab": "Valentin Regnskab",
    "kollek.dk": "Kollek",
    "frantz fra revitotal": "Revitotal",
    "zebraejendomsservice": "Zebra Ejendomsservice",
    "smvdanmark": "SMVdanmark",
    "årsregnskabet aps": "Årsregnskabet",
    "minetilbuddk": "MineTilbud",
    "fk distribution": "FK Distribution",
    "remisen_net": "Remisen",
    "hjornekontoret": "Hjørnekontoret",
    "mxney finance": "Mxney Finance",
    "edc erhverv poul erik bech": "EDC Erhverv Poul Erik Bech",
    "bramidan": "Bramidan",
    "la_oficina_kbh": "La Oficina KBH",
    "konsulenthusetld": "Konsulenthuset LD",
    "still danmark": "STILL Danmark",
    "mæglr.dk": "Mæglr",
    "byggecentrum": "Byggecentrum",
    "ilost": "iLost",
    "stape.io": "Stape",
    "restaurantmægleren": "Restaurantmægleren",
    "actas": "ACTAS",
    "centrum_service_aps": "Centrum Service",
    "boardinstitute": "Board Institute",
    "landfolk_com": "Landfolk",
    "lokalboligfredericia": "LokalBolig Fredericia",
    "jydsk-flytteforretning": "Jydsk Flytteforretning",
    "bettrday_": "Bettrday",
    "blackbirdcoffeeaps": "Blackbird Coffee",
}

# Likely .dk domain guess for each brand (helps with website-based searches)
DOMAIN_HINTS = {
    "aluva": "aluva.dk",
    "creao": "creao.dk",
    "meneto regnskab": "meneto.dk",
    "revimark": "revimark.dk",
    "samic": "samic.dk",
    "viking flyt": "vikingflyt.dk",
    "logistik.dk": "logistik.dk",
    "hjulster": "hjulster.dk",
    "dansk efterisolering": "danskefterisolering.dk",
    "intopit": "intopit.dk",
    "scan coffee group": "scancoffeegroup.dk",
    "vincent graphic": "vincentgraphic.dk",
    "stadsrevisionen": "stadsrevisionen.dk",
    "valentin regnskab": "valentinregnskab.dk",
    "kollek": "kollek.dk",
    "revitotal": "revitotal.dk",
    "zebra ejendomsservice": "zebra-ejendomsservice.dk",
    "smvdanmark": "smvdanmark.dk",
    "årsregnskabet": "aarsregnskabet.dk",
    "minetilbud": "minetilbud.dk",
    "fk distribution": "fk.dk",
    "remisen": "remisen.net",
    "hjørnekontoret": "hjornekontoret.dk",
    "mxney finance": "mxney.dk",
    "edc erhverv poul erik bech": "edc.dk",
    "bramidan": "bramidan.com",
    "la oficina kbh": "laoficina.dk",
    "konsulenthuset ld": "konsulenthusetld.dk",
    "still danmark": "still.dk",
    "mæglr": "maeglr.dk",
    "byggecentrum": "byggecentrum.dk",
    "ilost": "ilost.com",
    "stape": "stape.io",
    "restaurantmægleren": "restaurantmaegleren.dk",
    "actas": "actas.dk",
    "centrum service": "centrumservice.dk",
    "board institute": "boardinstitute.dk",
    "landfolk": "landfolk.com",
    "lokalbolig fredericia": "lokalbolig.dk",
    "jydsk flytteforretning": "jydsk-flytteforretning.dk",
    "bettrday": "bettrday.dk",
    "blackbird coffee": "blackbirdcoffee.dk",
    "holm facility service": "holmfacility.dk",
    "dansk miljø": "danskmiljo.dk",
    "profilmatch": "profilmatch.dk",
    "srs multiservice": "srsmultiservice.dk",
    "surveygauge": "surveygauge.com",
    "mick c. fynbo": "fynbo.dk",
    "nordic gulvservice": "nordicgulvservice.dk",
    "business with": "businesswith.com",
    "landfolk": "landfolk.com",
}

FOUNDER_PATTERNS = [
    re.compile(r"^([A-ZÆØÅ][\wæøåÆØÅ\-]+(?:\s+[A-ZÆØÅ][\wæøåÆØÅ\-]+)?)\s+fra\s+", re.IGNORECASE),
    re.compile(r"^([A-ZÆØÅ][\wæøåÆØÅ\-]+(?:\s+[A-ZÆØÅ][\wæøåÆØÅ\-]+)?)\s+-\s+", re.IGNORECASE),
]


def extract_founder_hint(raw: str) -> str | None:
    for pat in FOUNDER_PATTERNS:
        m = pat.match(raw.strip())
        if m:
            return m.group(1).strip()
    return None


def normalize_brand(raw: str) -> str:
    key = raw.lower().strip()
    if key in BRAND_OVERRIDES:
        return BRAND_OVERRIDES[key]
    s = re.sub(r"\s*\(.*?\)\s*$", "", raw).strip()
    s = re.sub(r"\s+(ApS|A/S|IVS|I/S)$", "", s, flags=re.IGNORECASE).strip()
    return s


# ---------- LinkedIn URL helpers ----------

LI_COMPANY = re.compile(r"(?:dk\.|www\.)?linkedin\.com/(?:[a-z]{2}/)?company/([a-z0-9\-_%]+)/?", re.IGNORECASE)
LI_PROFILE = re.compile(r"(?:dk\.|www\.)?linkedin\.com/(?:[a-z]{2}/)?in/([a-z0-9\-_%]+)/?", re.IGNORECASE)

# Hosts that are almost certainly NOT the DK target (different country LinkedIn).
# Bare `linkedin.com` and `dk.linkedin.com` are fine; the foreign-country subdomains
# are the dangerous ones for DK-brand searches.
FOREIGN_LI_HOSTS = (
    "us.linkedin.com", "in.linkedin.com", "ca.linkedin.com", "uk.linkedin.com",
    "au.linkedin.com", "ie.linkedin.com", "nz.linkedin.com", "za.linkedin.com",
    "br.linkedin.com", "mx.linkedin.com", "ar.linkedin.com", "es.linkedin.com",
    "pt.linkedin.com", "it.linkedin.com", "fr.linkedin.com", "be.linkedin.com",
    "ch.linkedin.com", "at.linkedin.com", "pl.linkedin.com", "ru.linkedin.com",
    "tr.linkedin.com", "jp.linkedin.com", "kr.linkedin.com", "sg.linkedin.com",
    "hk.linkedin.com", "ph.linkedin.com", "id.linkedin.com", "my.linkedin.com",
    "th.linkedin.com", "ae.linkedin.com", "sa.linkedin.com", "il.linkedin.com",
    "ng.linkedin.com", "ke.linkedin.com", "ro.linkedin.com", "cz.linkedin.com",
    "hu.linkedin.com", "gr.linkedin.com", "bg.linkedin.com", "ua.linkedin.com",
    "ve.linkedin.com", "co.linkedin.com", "pe.linkedin.com", "cl.linkedin.com",
    "ec.linkedin.com", "py.linkedin.com",
)

# Per-brand blacklist of substrings in title/desc/url that signal "wrong company
# with the same name" — applied to BOTH company and profile searches.
BAD_MATCH_KEYWORDS: dict[str, tuple[str, ...]] = {
    "creao": ("creao ai", "creao-ai", "y combinator", "ycombinator", "san francisco",
              "california", "yc s2", "yc w2", "yc f2"),
    "aluva": ("kerala", "kochi", "india", "aluva (kerala)", "aluva, india",
              "v4u jobs", "v4u-jobs", "jobs aluva", "jobs-aluva", "v4u",
              "sreekala"),
    "samic": ("medical", "south africa", "hospital", "pharma",
              "samic sas", "samic s.a.s", "italia", "italy", "presso samic",
              "s.r.l", "s.r.l."),
    "actas": ("actas inc", "actas ag", "germany", "switzerland"),
    "kollek": ("israel", "tel aviv"),
    "remisen": ("sweden", "stockholm", "norway"),
    "stadsrevisionen": (),  # placeholder
    "centrum service": ("netherlands", "amsterdam", "polska", "poland"),
    "intopit": ("united states", "florida", "texas"),
}


def has_bad_match(brand: str, text: str, url: str) -> bool:
    bl = brand.lower()
    haystack = (text + " " + url).lower()
    for key, patterns in BAD_MATCH_KEYWORDS.items():
        if key in bl:
            for p in patterns:
                if p in haystack:
                    return True
    return False


def is_foreign_li(url: str) -> bool:
    ul = url.lower()
    return any(h in ul for h in FOREIGN_LI_HOSTS)


def canonical_company_url(url: str) -> str | None:
    m = LI_COMPANY.search(url)
    if not m:
        return None
    slug = m.group(1).rstrip("/")
    # Preserve dk. host signal in canonical for downstream use
    host = "dk.linkedin.com" if "dk.linkedin.com" in url else "www.linkedin.com"
    return f"https://{host}/company/{slug}/"


def canonical_profile_url(url: str) -> str | None:
    m = LI_PROFILE.search(url)
    if not m:
        return None
    slug = m.group(1).rstrip("/")
    host = "dk.linkedin.com" if "dk.linkedin.com" in url else "www.linkedin.com"
    return f"https://{host}/in/{slug}/"


# ---------- Title classification ----------

TITLE_PRIORITY = [
    (1, ["co-founder", "cofounder", "founder", "owner", "stifter", "medstifter",
         "indehaver", "ejer", "co-owner", "grundlægger", "iværksætter"]),
    (2, ["ceo", "adm. direktør", "adm direktør", "administrerende direktør",
         "managing director", "managing partner", "direktør"]),
    (3, ["head of sales", "vp sales", "vp of sales", "salgsdirektør",
         "salgschef", "sales director", "chief revenue officer", "cro",
         "kommerciel direktør", "commercial director"]),
    (4, ["cmo", "head of marketing", "marketingchef", "marketing director",
         "vp marketing", "vp of marketing", "marketing manager",
         "marketingdirektør"]),
]


def classify_title(text: str) -> tuple[int | None, str | None]:
    t = text.lower()
    for prio, phrases in TITLE_PRIORITY:
        for p in phrases:
            if p in t:
                return prio, p
    return None, None


def extract_title_snippet(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    parts = re.split(r"\s+[·\|\-–—•]\s+|\s•\s|\s·\s", text)
    for part in parts:
        p, _ = classify_title(part)
        if p is not None:
            return part.strip()[:120]
    return (parts[0] if parts else text)[:120]


def split_person_name(li_title: str) -> tuple[str, str]:
    s = li_title
    s = re.sub(r"\s*[\|\-]\s*LinkedIn.*$", "", s, flags=re.IGNORECASE).strip()
    head = re.split(r"\s+[\-–—\|]\s+", s, maxsplit=1)[0].strip()
    head = re.sub(r"\s+", " ", head)
    parts = head.split(" ")
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], " ".join(parts[1:])


# ---------- Slug / brand alignment ----------

def slug_aligns_with_brand(slug: str, brand: str) -> tuple[bool, int]:
    """Returns (looks-like-brand, penalty).

    Penalty 0 = great match (slug == brand or brand-with-dk-suffix).
    Penalty 1 = brand appears as a prefix but with extra context (e.g. brand-aps).
    Penalty 5 = brand-with-foreign-suffix that suggests a different company.
    Penalty 9 = doesn't really look like the brand at all.
    """
    slug_norm = slug.lower().replace("_", "-")
    brand_norm = brand.lower().replace(" ", "-").replace("_", "-")
    brand_compact = brand.lower().replace(" ", "").replace("_", "").replace("-", "")
    slug_compact = slug.lower().replace("-", "").replace("_", "")

    if slug_norm == brand_norm or slug_compact == brand_compact:
        return True, 0

    dk_ok_suffixes = ("-dk", "dk", "-danmark", "-aps", "-a-s", "-as", "-group", "-gruppen")
    if any(slug_norm == brand_norm + s for s in dk_ok_suffixes):
        return True, 0
    if any(slug_compact == brand_compact + s.replace("-", "") for s in dk_ok_suffixes):
        return True, 0

    # Suspicious foreign suffixes
    bad_suffixes = ("-global", "-ai", "-inc", "-india", "-pvt", "-usa", "-uk", "-us",
                    "-llc", "-international", "-motors", "-scientific")
    if any(slug_norm.endswith(s) for s in bad_suffixes):
        return False, 9

    # Prefix match
    if slug_compact.startswith(brand_compact) and len(brand_compact) >= 4:
        return True, 2

    # Brand is multi-word and the slug has all the words
    bw = brand.lower().split()
    if len(bw) >= 2 and all(w in slug_norm for w in bw):
        return True, 1

    return False, 9


def is_dk_host(url: str) -> bool:
    return "dk.linkedin.com" in url


# ---------- Per-brand pipeline ----------

def find_company_url(brand: str, domain_hint: str | None,
                     country: str = "DK") -> tuple[str | None, str]:
    """Find LinkedIn company URL.

    Returns (url|None, why). For DK brands we require a DK-host LinkedIn result
    OR a strong domain-hint match — otherwise we'd fall back to mismatched
    foreign companies that happen to share a name (Aluva Kerala, Creao AI, etc.).
    """
    dk_queries = [
        f'"{brand}" site:dk.linkedin.com/company',
    ]
    if domain_hint:
        dk_queries.insert(0, f'"{domain_hint}" site:linkedin.com/company')
    generic_queries = [
        f'"{brand}" site:linkedin.com/company',
    ]

    # First pass: DK-targeted queries
    candidates: list[tuple[int, str, str]] = []
    for q in dk_queries:
        results = brave_search(q, count=10)
        for r in results:
            url = r.get("url", "")
            canon = canonical_company_url(url)
            if not canon:
                continue
            slug = canon.rstrip("/").split("/")[-1]
            haystack_text = r.get("title", "") + " " + r.get("description", "")
            # Brand-specific bad-match blacklist (Creao AI / Aluva Kerala / etc.)
            if has_bad_match(brand, haystack_text, url):
                continue
            ok, penalty = slug_aligns_with_brand(slug, brand)
            haystack = haystack_text.lower()
            dk_bonus = -3 if is_dk_host(url) else 0
            brand_in = 0 if brand.lower() in haystack else 1
            score = penalty + dk_bonus + brand_in
            if not ok and score > 4:
                continue
            candidates.append((score, canon, f"dk_q slug='{slug}' dk={is_dk_host(url)}"))
        if candidates and min(c[0] for c in candidates) <= 0:
            candidates.sort(key=lambda x: x[0])
            return candidates[0][1], candidates[0][2]

    # Second pass: generic. For DK brands, only accept if the result is a DK
    # host OR matches the domain hint, to avoid foreign brand collisions.
    for q in generic_queries:
        results = brave_search(q, count=10)
        for r in results:
            url = r.get("url", "")
            canon = canonical_company_url(url)
            if not canon:
                continue
            slug = canon.rstrip("/").split("/")[-1]
            haystack_text = r.get("title", "") + " " + r.get("description", "")
            if has_bad_match(brand, haystack_text, url):
                continue
            ok, penalty = slug_aligns_with_brand(slug, brand)
            if not ok:
                continue
            haystack = haystack_text.lower()
            domain_in = bool(domain_hint and domain_hint.lower() in haystack)
            dk_match = is_dk_host(url) or domain_in
            if country == "DK" and not dk_match:
                # Strict: don't take a foreign company match for a DK brand
                continue
            dk_bonus = -3 if is_dk_host(url) else 0
            brand_in = 0 if brand.lower() in haystack else 1
            score = penalty + dk_bonus + brand_in
            candidates.append((score, canon, f"generic_q slug='{slug}' dk={is_dk_host(url)} dom={domain_in}"))

    if candidates:
        candidates.sort(key=lambda x: x[0])
        return candidates[0][1], candidates[0][2]
    return None, "no DK-host company match found"


def find_person(brand: str, founder_hint: str | None, company_url: str | None,
                domain_hint: str | None, country: str = "DK"
                ) -> tuple[dict | None, list[str], int]:
    """Find best decision-maker. Returns (record|None, tried_queries, query_count).

    Brave parses parenthesized ORs poorly. We issue one keyword-narrowed query
    that catches founder-class titles ("founder"), one that catches CEO-class
    titles, and a broad fallback. Hard cap: 4 queries.
    """
    tried: list[str] = []
    queries: list[str] = []

    if founder_hint:
        queries.append(f'"{founder_hint}" "{brand}" site:linkedin.com/in')
    # Per-title narrow queries (CEO → founder → DK-language). One query each.
    queries.append(f'"{brand}" CEO site:linkedin.com/in')
    queries.append(f'"{brand}" founder site:linkedin.com/in')
    queries.append(f'"{brand}" direktør site:linkedin.com/in')
    queries.append(f'"{brand}" stifter site:linkedin.com/in')
    # Broad fallback if all the title-narrowed ones miss
    queries.append(f'"{brand}" site:linkedin.com/in')

    best: dict | None = None
    for q in queries[:4]:  # Hard cap at 4 person-search queries
        tried.append(q)
        results = brave_search(q, count=10)
        for r in results:
            url = r.get("url", "")
            prof = canonical_profile_url(url)
            if not prof:
                continue
            title = r.get("title", "")
            desc = r.get("description", "")
            combined = title + " | " + desc
            # Strict DK-host enforcement: reject foreign-country LinkedIn hosts
            # for DK brands. dk.linkedin.com and bare linkedin.com are fine.
            if country == "DK" and is_foreign_li(url):
                continue
            # Brand-specific bad-match blacklist (Creao AI / Aluva Kerala / etc.)
            if has_bad_match(brand, combined, url):
                continue
            cl = combined.lower()
            bl = brand.lower()
            hint_match = founder_hint and founder_hint.lower().split()[0] in cl
            brand_match = bl in cl
            # Privacy-blocked snippet: LinkedIn says "We cannot provide a
            # description". Treat title-only as the truth.
            blocked = "we cannot provide a description" in desc.lower() or len(desc) < 20
            # Also: brand keywords often appear in the LinkedIn page title via
            # the "Name - Title - Brand" pattern, so we treat title alone too.
            title_brand_match = bl in title.lower()
            # CRITICAL: when the IG ad explicitly named a founder, ANY decision-
            # maker we accept must match that founder's name. Brand-only matches
            # without the hint name are almost always a different person at a
            # foreign company with the same name (e.g. Samic Italy, Aluva
            # Kerala). Same goes if the URL slug clearly contains the hint name.
            hint_in_url = founder_hint and founder_hint.lower().split()[0] in url.lower()
            if founder_hint:
                # Hint name must appear somewhere (snippet or url slug) to accept
                if not (hint_match or hint_in_url):
                    continue
            # Accept if: brand in snippet, OR founder-hint name in snippet (must
            # match the query that named the founder), OR brand is in the title
            # which is the most reliable LinkedIn search-result field.
            if not (brand_match or hint_match or title_brand_match):
                # Only accept fully-blocked snippets when the query itself was
                # founder-hint-based (so we know the search was scoped)
                if not (blocked and founder_hint and founder_hint.lower() in q.lower()):
                    continue
            # ANTI-FALSE-POSITIVE: when no founder hint is available and the
            # brand only appears in the *description* (not the LinkedIn page
            # title and not the URL slug), we're at very high risk of matching
            # a stranger who happens to mention the brand in their bio. Require
            # the brand to appear in either the LinkedIn page title or the URL
            # slug — those are tied to the actual profile identity.
            if not founder_hint:
                brand_tokens = [t for t in re.split(r"[\s\-_.]+", bl) if len(t) >= 4]
                slug = url.rsplit("/", 2)[-1] if url.endswith("/") else url.rsplit("/", 1)[-1]
                slug_l = slug.lower()
                slug_has_brand = any(t in slug_l for t in brand_tokens) if brand_tokens else False
                if not (title_brand_match or slug_has_brand):
                    continue
            prio, _ = classify_title(combined)
            if prio is None:
                prio = 99
            # Prefer DK host slightly
            dk = is_dk_host(url)
            score = prio - (1 if dk else 0)
            # Hint-match results beat no-hint when present
            if hint_match:
                score -= 1
            cand = {
                "priority": prio,
                "score": score,
                "linkedin_url": prof,
                "raw_title": title,
                "description": desc,
                "brand_in_snippet": brand_match or title_brand_match,
                "via_founder_hint": bool(hint_match),
            }
            if best is None or cand["score"] < best["score"]:
                best = cand
        if best and best["priority"] <= 2:
            break  # Founder/CEO found, stop early
    return best, tried, len(tried)


def confidence_for(priority: int | None, brand_in_snippet: bool, company_url: str | None) -> str:
    if priority is None:
        return "low"
    if priority <= 2 and brand_in_snippet:
        return "high"
    if priority <= 2:
        return "medium"
    if priority <= 3:
        return "medium"
    if priority == 4:
        return "medium"
    return "low"


def country_for(brand: str) -> str:
    bl = brand.lower()
    if "ilost" in bl:
        return "NL"  # iLost is Amsterdam-based
    if "stape" in bl:
        return "US"
    return "DK"


# ---------- Main ----------

def load_unique_brands() -> list[dict]:
    rows = list(csv.DictReader(open(SRC_CSV)))
    keep = [r for r in rows if r["vertical"] != "agency_growth"
            and r["pitch_fit_for_carterco"] != "no"]
    seen, unique = set(), []
    for r in keep:
        n = r["advertiser"].lower().strip()
        if n in seen:
            continue
        seen.add(n)
        unique.append(r)
    return unique


def already_processed() -> set[str]:
    if not OUT_CSV.exists():
        return set()
    done = set()
    for r in csv.DictReader(open(OUT_CSV)):
        done.add(r["source_filename"])
    return done


def write_row(row: dict) -> None:
    new_file = not OUT_CSV.exists()
    with open(OUT_CSV, "a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        if new_file:
            w.writeheader()
        w.writerow(row)


def process_brand(src_row: dict) -> dict:
    raw_adv = src_row["advertiser"]
    brand = normalize_brand(raw_adv)
    founder_hint = extract_founder_hint(raw_adv)
    domain_hint = DOMAIN_HINTS.get(brand.lower())
    notes_parts: list[str] = []
    if founder_hint:
        notes_parts.append(f"founder-hint='{founder_hint}'")

    country = country_for(brand)
    company_url, company_why = find_company_url(brand, domain_hint, country)
    person, tried, q_count = find_person(brand, founder_hint, company_url, domain_hint)
    total_queries = q_count + (3 if domain_hint else 2)  # rough estimate
    notes_parts.append(f"person_queries={q_count}")

    out = {
        "source_filename": src_row["filename"],
        "brand": brand,
        "vertical": src_row["vertical"],
        "linkedin_company_url": company_url or "",
        "first_name": "",
        "last_name": "",
        "title": "",
        "linkedin_url": "",
        "country": country,
        "confidence": "low",
        "notes": "",
    }

    if person:
        fn, ln = split_person_name(person["raw_title"])
        title_text = extract_title_snippet(person["raw_title"] + " | " + person["description"])
        prio, _ = classify_title(title_text)
        out["first_name"] = fn
        out["last_name"] = ln
        out["title"] = title_text
        out["linkedin_url"] = person["linkedin_url"]
        out["confidence"] = confidence_for(prio, person["brand_in_snippet"], company_url)
        if person["priority"] == 99:
            notes_parts.append("no title keyword in snippet; manual review")
        if not person["brand_in_snippet"]:
            notes_parts.append("matched via founder hint not brand-in-snippet")
    else:
        if company_url:
            notes_parts.append("company page found; no decision-maker LinkedIn result")
        else:
            notes_parts.append("no LinkedIn results")

    out["notes"] = "; ".join(notes_parts)
    return out


def main():
    unique = load_unique_brands()
    done = already_processed()
    print(f"Total unique brands: {len(unique)}; already done: {len(done)}")

    for i, src in enumerate(unique, 1):
        if src["filename"] in done:
            continue
        brand = normalize_brand(src["advertiser"])
        print(f"[{i:02d}/{len(unique)}] {brand}  (raw='{src['advertiser']}')")
        try:
            row = process_brand(src)
        except Exception as e:
            row = {k: "" for k in FIELDS}
            row.update({
                "source_filename": src["filename"],
                "brand": brand,
                "vertical": src["vertical"],
                "country": "DK",
                "confidence": "low",
                "notes": f"ERROR: {e}",
            })
        write_row(row)
        person = f"{row['first_name']} {row['last_name']}".strip() or "—"
        print(f"        -> {row['confidence']:6s} | {person:30s} | {row['title'][:50]}")

    print(f"\nDone. Output: {OUT_CSV}")


if __name__ == "__main__":
    main()
