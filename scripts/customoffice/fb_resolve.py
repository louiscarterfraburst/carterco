"""Resolve a candidate Facebook page per lead via Brave Search, with NAME-TOKEN
scoring so we don't attach an unrelated page (no steakhouses for hauliers).
A candidate is only kept if a distinctive token of the company/owner name appears
in the FB result title or URL slug. Survivors are verified later by the FB scrape.
"""
import json, re, time, urllib.parse, urllib.request

KEY = next(l.split("=", 1)[1].strip() for l in open(".env.local") if l.startswith("BRAVE_SEARCH_API_KEY="))
LEADS = json.load(open("scripts/customoffice/data/leads.json"))

GENERIC = {"vognmand", "vognmandsforretning", "vognmandsfirmaet", "transport", "logistics",
           "logistik", "fragt", "aps", "a/s", "i/s", "is", "as", "og", "søn", "sønner",
           "den", "danmark", "service", "autotransport", "dyretransport", "trætransport"}
SKIP = re.compile(r"facebook\.com/(groups|events|login|sharer|watch|marketplace|hashtag|public|search|bookmarks|pg/?$)", re.I)


def deaccent(s):
    return (s or "").lower().replace("æ", "ae").replace("ø", "oe").replace("å", "aa")


def name_tokens(*parts):
    toks = set()
    for p in parts:
        for t in re.findall(r"[a-zæøå]{3,}", (p or "").lower()):
            if t not in GENERIC and len(t) >= 4:
                toks.add(t)
    return toks


def parse_fb(u):
    u = u.split("?")[0]
    m = re.search(r"facebook\.com/(p|people|pages)/(.+)$", u, re.I)
    if m:
        return f"https://www.facebook.com/{m.group(1)}/{m.group(2)}".rstrip("/")
    m = re.search(r"facebook\.com/([A-Za-z0-9.\-]+)/?$", u)
    if m and m.group(1).lower() not in ("p", "pages", "people", "pg"):
        return f"https://www.facebook.com/{m.group(1)}"
    return None


def brave(q):
    url = "https://api.search.brave.com/res/v1/web/search?" + urllib.parse.urlencode(
        {"q": q, "count": 10, "country": "dk", "search_lang": "da"})
    req = urllib.request.Request(url, headers={"X-Subscription-Token": KEY, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode())
    except Exception:
        return {}


def resolve(lead):
    toks = name_tokens(lead["company"], lead.get("owner"))
    if not toks:
        return None
    town = deaccent(lead.get("town"))
    q = f'{lead["company"]} {lead.get("town") or ""} facebook'.strip()
    res = (brave(q).get("web", {}) or {}).get("results", []) or []
    best, best_score = None, 0
    for r in res:
        u = r.get("url", "")
        if "facebook.com" not in u or SKIP.search(u):
            continue
        fb = parse_fb(u)
        if not fb:
            continue
        hay = deaccent(r.get("title", "") + " " + r.get("description", "") + " " + fb)
        overlap = sum(1 for t in toks if deaccent(t) in hay)
        if overlap == 0:
            continue                      # no distinctive name token -> reject
        score = overlap * 10 + (5 if town and town in hay else 0)
        if score > best_score:
            best, best_score = fb, score
    return best


hits = 0
for i, l in enumerate(LEADS):
    l["fb_url"] = resolve(l)
    if l["fb_url"]:
        hits += 1
    print(f"  {i+1:2d}/50 {'OK ' if l['fb_url'] else '-- '} {l['company'][:36]:36s} {l['fb_url'] or ''}")
    time.sleep(1.1)

json.dump(LEADS, open("scripts/customoffice/data/leads.json", "w"), ensure_ascii=False, indent=1)
print(f"\nscored FB candidates: {hits}/50 (verified next via FB scrape)")
