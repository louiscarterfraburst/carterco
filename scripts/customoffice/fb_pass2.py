"""Pass 2 redo: powerai FB page-search via reliable run-sync, on the still-unconfirmed
leads. Pick best candidate by name overlap, verify all via one facebook-pages-scraper
run (category + name must match), attach confirmed. Builds on the 16 already confirmed.
"""
import json, re, time, urllib.request

ENV = {k: v.strip() for k, v in (l.split("=", 1) for l in open(".env.local") if "=" in l and not l.startswith("#"))}
TOKEN = ENV["APIFY_API_TOKEN"]
L = json.load(open("scripts/customoffice/data/leads_v3.json"))

GENERIC = {"vognmand", "vognmandsforretning", "vognmandsfirmaet", "transport", "logistics",
           "logistik", "fragt", "aps", "og", "søn", "sønner", "danmark", "service", "autotransport"}
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


def keyid(u):
    m = re.search(r"(\d{6,})", u or "")
    if m:
        return m.group(1)
    m = re.search(r"facebook\.com/(?:p/|people/|pages/)?([^/?#]+)", u or "", re.I)
    return deacc(m.group(1)) if m else (u or "")


def post_sync(actor, payload, timeout=160):
    req = urllib.request.Request(
        f"https://api.apify.com/v2/acts/{actor}/run-sync-get-dataset-items?token={TOKEN}",
        data=json.dumps(payload).encode(), headers={"content-type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read())


misses = [l for l in L if l.get("fb_status") != "confirmed"]
print(f"unconfirmed to search: {len(misses)}")
cand = []
for i, l in enumerate(misses):
    q = f'{l["company"]} {l.get("town") or ""}'.strip()
    try:
        items = post_sync("powerai~facebook-page-search-scraper", {"query": q, "maxResults": 5})
    except Exception as e:
        items = []
    t = toks(l["company"], l.get("owner"))
    best, bs = None, 0
    for it in items or []:
        ov = len(t & toks(it.get("name", "")))
        if ov > bs:
            best, bs = (it.get("url") or it.get("profile_url")), ov
    if best:
        cand.append((l, best))
    print(f"  {i+1:2d}/{len(misses)} {l['company'][:30]:30s} -> {best or '(none)'}")

# verify all powerai candidates in one facebook-pages-scraper run
urls, seen = [], set()
for _, u in cand:
    if u and u not in seen:
        seen.add(u)
        urls.append({"url": u})
print(f"\nverifying {len(urls)} candidate pages...")
recs = post_sync("apify~facebook-pages-scraper", {"startUrls": urls}, timeout=300) if urls else []
by_key = {}
for x in recs:
    if not x.get("error"):
        for u in (x.get("facebookUrl"), x.get("pageUrl")):
            if u:
                by_key[keyid(u)] = x

added = 0
for l, u in cand:
    rec = by_key.get(keyid(u))
    if not rec:
        continue
    cats = " ".join(rec.get("categories") or []) + " " + (rec.get("title") or "")
    if REJECT.search(cats) or not HAULIER.search(cats):
        continue
    if not (toks(l["company"], l.get("owner")) & toks(rec.get("title"))):
        continue
    added += 1
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

json.dump(L, open("scripts/customoffice/data/leads_v3.json", "w"), ensure_ascii=False, indent=1)
print(f"\npass2 added: +{added}  ->  TOTAL confirmed FB: {sum(1 for l in L if l.get('fb_status')=='confirmed')}/50")