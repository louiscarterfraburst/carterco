"""Maximize FB coverage for the 50, honestly.
Pass 1: Brave token-scored candidate. Pass 2 (for the rest): powerai FB page-search
(searches FB's own index -> better recall). Every candidate is verified by the
facebook-pages-scraper (category must be haulier-ish + name must match) before it's
attached. Wrong/irrelevant pages are dropped, never shipped.
"""
import json, re, time, urllib.parse, urllib.request

ENV = {k: v.strip() for k, v in (l.split("=", 1) for l in open(".env.local") if "=" in l and not l.startswith("#"))}
TOKEN = ENV["APIFY_API_TOKEN"]
BRAVE = ENV["BRAVE_SEARCH_API_KEY"]
L = json.load(open("scripts/customoffice/data/leads_v3.json"))

GENERIC = {"vognmand", "vognmandsforretning", "vognmandsfirmaet", "transport", "logistics",
           "logistik", "fragt", "aps", "og", "søn", "sønner", "danmark", "service", "autotransport"}
SKIP = re.compile(r"facebook\.com/(groups|events|login|sharer|watch|marketplace|hashtag|public|search|bookmarks)", re.I)
HAULIER = re.compile(r"transport|cargo|freight|moving|logistic|vognmand|truck|lastbil|local business|"
                     r"local service|community|recruiter|building material|product/service|maskinstation|entrepren", re.I)
REJECT = re.compile(r"hair|salon|restaurant|cafe|spejder|scout|sport|beauty|church|\bvvs\b|plumb|fitness|musician|artist", re.I)


def deacc(s):
    return (s or "").lower().replace("æ", "ae").replace("ø", "oe").replace("å", "aa")


def toks(*p):
    out = set()
    for x in p:
        for t in re.findall(r"[a-zæøå]{4,}", (x or "").lower()):
            if t not in GENERIC:
                out.add(deacc(t))
    return out


def parse_fb(u):
    u = (u or "").split("?")[0]
    m = re.search(r"facebook\.com/(p|people|pages)/(.+)$", u, re.I)
    if m:
        return f"https://www.facebook.com/{m.group(1)}/{m.group(2)}".rstrip("/")
    m = re.search(r"facebook\.com/([A-Za-z0-9.\-]+)/?$", u)
    if m and m.group(1).lower() not in ("p", "pages", "people", "pg"):
        return f"https://www.facebook.com/{m.group(1)}"
    return None


def run_actor(actor, payload, wait=300):
    r = urllib.request.urlopen(urllib.request.Request(
        f"https://api.apify.com/v2/acts/{actor}/runs?token={TOKEN}",
        data=json.dumps(payload).encode(), headers={"content-type": "application/json"}), timeout=40)
    d = json.loads(r.read())["data"]
    rid, dsid = d["id"], d["defaultDatasetId"]
    for _ in range(wait // 6):
        st = json.loads(urllib.request.urlopen(
            f"https://api.apify.com/v2/actor-runs/{rid}?token={TOKEN}", timeout=20).read())["data"]["status"]
        if st in ("SUCCEEDED", "FAILED", "ABORTED"):
            break
        time.sleep(6)
    items = json.loads(urllib.request.urlopen(
        f"https://api.apify.com/v2/datasets/{dsid}/items?clean=true&format=json&token={TOKEN}", timeout=40).read())
    return items


def brave(q):
    try:
        req = urllib.request.Request("https://api.search.brave.com/res/v1/web/search?" + urllib.parse.urlencode(
            {"q": q, "count": 10, "country": "dk", "search_lang": "da"}),
            headers={"X-Subscription-Token": BRAVE, "Accept": "application/json"})
        return json.loads(urllib.request.urlopen(req, timeout=20).read())
    except Exception:
        return {}


def brave_candidate(l):
    t = toks(l["company"], l.get("owner"))
    if not t:
        return None
    town = deacc(l.get("town"))
    res = (brave(f'{l["company"]} {l.get("town") or ""} facebook').get("web", {}) or {}).get("results", []) or []
    best, bs = None, 0
    for r in res:
        u = r.get("url", "")
        if "facebook.com" not in u or SKIP.search(u):
            continue
        fb = parse_fb(u)
        if not fb:
            continue
        hay = deacc(r.get("title", "") + " " + r.get("description", "") + " " + fb)
        ov = sum(1 for x in t if x in hay)
        if ov:
            sc = ov * 10 + (5 if town and town in hay else 0)
            if sc > bs:
                best, bs = fb, sc
    return best


def keyid(u):
    m = re.search(r"(\d{6,})", u or "")
    if m:
        return m.group(1)
    m = re.search(r"facebook\.com/(?:p/|people/|pages/)?([^/?#]+)", u or "", re.I)
    return deacc(m.group(1)) if m else (u or "")


def verify_and_attach(candidates):
    """candidates: list of (lead, url). Scrape once, attach confirmed. Returns #confirmed."""
    urls, seen = [], set()
    for _, u in candidates:
        if u and u not in seen:
            seen.add(u)
            urls.append({"url": u})
    if not urls:
        return 0
    recs = run_actor("apify~facebook-pages-scraper", {"startUrls": urls})
    by_key = {}
    for x in recs:
        if x.get("error"):
            continue
        for u in (x.get("facebookUrl"), x.get("pageUrl")):
            if u:
                by_key[keyid(u)] = x
    n = 0
    for l, u in candidates:
        if l.get("fb_status") == "confirmed":
            continue
        rec = by_key.get(keyid(u))
        if not rec:
            continue
        cats = " ".join(rec.get("categories") or []) + " " + (rec.get("title") or "")
        if REJECT.search(cats) or not HAULIER.search(cats):
            continue
        if not (toks(l["company"], l.get("owner")) & toks(rec.get("title"))):
            continue
        n += 1
        l["fb_url"] = rec.get("pageUrl") or u
        l["fb_status"] = "confirmed"
        l["fb_category"] = (rec.get("categories") or [None])[-1]
        l["fb_likes"] = rec.get("likes")
        l["fb_intro"] = rec.get("intro")
        l["fb_messenger"] = rec.get("messenger")
        if (rec.get("websites") or rec.get("website")) and not l.get("website"):
            l["website"] = (rec.get("websites") or [rec.get("website")])[0]
        if not l.get("phone"):
            l["phone"] = rec.get("phone")
    return n


# ---- Pass 1: Brave ----
print("Pass 1 (Brave)...")
cand1 = [(l, brave_candidate(l)) for l in L]
time.sleep(0.5)
c1 = verify_and_attach([(l, u) for l, u in cand1 if u])
print(f"  confirmed after Brave: {c1}")

# ---- Pass 2: powerai FB page-search on the unconfirmed ----
print("Pass 2 (powerai FB page-search on misses)...")
cand2 = []
misses = [l for l in L if l.get("fb_status") != "confirmed"]
for i, l in enumerate(misses):
    q = f'{l["company"]} {l.get("town") or ""}'.strip()
    try:
        items = run_actor("powerai~facebook-page-search-scraper", {"query": q, "maxResults": 4}, wait=120)
    except Exception as e:
        items = []
    # pick best candidate by name-token overlap with returned page name
    t = toks(l["company"], l.get("owner"))
    best, bs = None, 0
    for it in items or []:
        nm = it.get("name", "")
        ov = len(t & toks(nm))
        if ov > bs:
            best, bs = (it.get("url") or it.get("profile_url")), ov
    if best:
        cand2.append((l, best))
    print(f"  {i+1}/{len(misses)} {l['company'][:30]:30s} -> {best or '(none)'}")
c2 = verify_and_attach(cand2)
print(f"  confirmed after powerai: +{c2}")

json.dump(L, open("scripts/customoffice/data/leads_v3.json", "w"), ensure_ascii=False, indent=1)
print(f"\nTOTAL confirmed FB pages: {sum(1 for l in L if l.get('fb_status')=='confirmed')}/50")