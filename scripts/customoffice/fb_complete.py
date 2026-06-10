"""Finish the interrupted FB pass on the leads still without a page.
powerai FB page-search (FB's own index) by company name + town, then by owner name as
a fallback. Verify every candidate via facebook-pages-scraper (category + name match).
- Haulier category + name match  -> fb_status 'confirmed'
- Scrape fails (personal profile) but strong name match -> 'profile' (ejers FB-profil, flagged)
Updates leads_v3.json.
"""
import json, re, time, urllib.request

ENV = {k: v.strip() for k, v in (l.split("=", 1) for l in open(".env.local") if "=" in l and not l.startswith("#"))}
TOKEN = ENV["APIFY_API_TOKEN"]
L = json.load(open("scripts/customoffice/data/leads_v3.json"))

GENERIC = {"vognmand", "vognmandsforretning", "vognmandsfirmaet", "transport", "logistics",
           "logistik", "fragt", "aps", "og", "søn", "sønner", "danmark", "service", "autotransport", "person"}
HAULIER = re.compile(r"transport|cargo|freight|moving|logistic|vognmand|truck|lastbil|local business|"
                     r"local service|community|recruiter|building material|product/service|maskinstation|entrepren|kran", re.I)
REJECT = re.compile(r"hair|salon|restaurant|cafe|spejder|scout|sport|beauty|church|\bvvs\b|plumb|fitness|musician|artist|politician|gym", re.I)


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


def powerai(q):
    try:
        req = urllib.request.Request(
            f"https://api.apify.com/v2/acts/powerai~facebook-page-search-scraper/run-sync-get-dataset-items?token={TOKEN}",
            data=json.dumps({"query": q, "maxResults": 5}).encode(), headers={"content-type": "application/json"})
        return json.loads(urllib.request.urlopen(req, timeout=160).read())
    except Exception:
        return []


def best_candidate(lead):
    t = toks(lead["company"], lead.get("owner"))
    queries = [f'{lead["company"]} {lead.get("town") or ""}'.strip()]
    if lead.get("owner"):
        queries.append(f'{lead["owner"]} {lead.get("town") or ""}'.strip())
    best, bs = None, 0
    for q in queries:
        for it in powerai(q) or []:
            ov = len(t & toks(it.get("name", "")))
            if ov > bs:
                best, bs = (it.get("url") or it.get("profile_url")), ov
        if bs >= 2:
            break
    return best


def verify_run(urls):
    if not urls:
        return []
    r = urllib.request.urlopen(urllib.request.Request(
        f"https://api.apify.com/v2/acts/apify~facebook-pages-scraper/runs?token={TOKEN}",
        data=json.dumps({"startUrls": [{"url": u} for u in urls]}).encode(),
        headers={"content-type": "application/json"}), timeout=40)
    d = json.loads(r.read())["data"]
    rid, dsid = d["id"], d["defaultDatasetId"]
    for _ in range(60):
        st = json.loads(urllib.request.urlopen(f"https://api.apify.com/v2/actor-runs/{rid}?token={TOKEN}", timeout=20).read())["data"]["status"]
        if st in ("SUCCEEDED", "FAILED", "ABORTED"):
            break
        time.sleep(8)
    return json.loads(urllib.request.urlopen(f"https://api.apify.com/v2/datasets/{dsid}/items?clean=true&format=json&token={TOKEN}", timeout=40).read())


misses = [l for l in L if l.get("fb_status") not in ("confirmed", "namematch")]
print(f"searching FB for {len(misses)} leads...")
pairs = []
for i, l in enumerate(misses):
    u = best_candidate(l)
    if u:
        pairs.append((l, u))
    print(f"  {i+1:2d}/{len(misses)} {l['company'][:34]:34s} -> {u or '(none on FB)'}")

urls = list({u for _, u in pairs})
print(f"\nverifying {len(urls)} candidates...")
recs = verify_run(urls)
by_key = {}
for x in recs:
    for u in (x.get("facebookUrl"), x.get("pageUrl")):
        if u:
            by_key[keyid(u)] = x

conf = prof = 0
for l, u in pairs:
    rec = by_key.get(keyid(u))
    nameok = bool(toks(l["company"], l.get("owner")) & toks((rec or {}).get("title")))
    if rec and not rec.get("error"):
        cats = " ".join(rec.get("categories") or []) + " " + (rec.get("title") or "")
        if not REJECT.search(cats) and HAULIER.search(cats) and nameok:
            conf += 1
            l.update(fb_url=rec.get("pageUrl") or u, fb_status="confirmed",
                     fb_category=(rec.get("categories") or [None])[-1], fb_likes=rec.get("likes"),
                     fb_intro=rec.get("intro"), fb_messenger=rec.get("messenger"))
            if (rec.get("websites") or rec.get("website")) and not l.get("website"):
                l["website"] = (rec.get("websites") or [rec.get("website")])[0]
    elif rec and rec.get("error") == "not_available" and ("people/" in u or re.search(r"/\d{6,}", u)):
        # personal profile we couldn't scrape, but powerai matched the name -> flag, don't claim verified
        prof += 1
        l.update(fb_url=u, fb_status="profile")

json.dump(L, open("scripts/customoffice/data/leads_v3.json", "w"), ensure_ascii=False, indent=1)
from collections import Counter
print(f"\n+{conf} confirmed, +{prof} personal-profile (flagged)")
print("fb_status now:", dict(Counter(l.get('fb_status', 'none') for l in L)))