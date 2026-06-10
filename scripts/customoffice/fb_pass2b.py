"""Verify the 8 candidate pages powerai found (captured from the pass-2 run output)
via the async facebook-pages-scraper, and attach the confirmed ones. Avoids re-spending
on powerai. Category + name must match.
"""
import json, re, time, urllib.request

ENV = {k: v.strip() for k, v in (l.split("=", 1) for l in open(".env.local") if "=" in l and not l.startswith("#"))}
TOKEN = ENV["APIFY_API_TOKEN"]
L = json.load(open("scripts/customoffice/data/leads_v3.json"))

CANDS = {  # company substring -> url powerai returned
    "DUEHOLM VOGNMANDSFORRETNING": "https://www.facebook.com/dueholmvf",
    "TH. RASMUSSEN & SØN": "https://www.facebook.com/people/Th-Rasmussen-S%C3%B8n-AS/61558975525385/",
    "BRDR. LARSEN TRANSPORT": "https://www.facebook.com/people/Brdr-Larsen-Transport-ApS/100063936551632/",
    "MAIMBURG ApS": "https://www.facebook.com/Maimburgaps",
    "Skovby Transport": "https://www.facebook.com/people/Skovby-Transport-aps/100063996314689/",
    "T. Søgaard Logistics": "https://www.facebook.com/SoegaardLogistics",
    "BLACK STAR ApS": "https://www.facebook.com/BlackStarHub",
    "Vognmand Thomas Krogh Andersen": "https://www.facebook.com/vognmandthomaskroghandersen",
}
GENERIC = {"vognmand", "vognmandsforretning", "transport", "logistics", "logistik", "fragt",
           "aps", "og", "søn", "sønner", "danmark", "service", "autotransport"}
HAULIER = re.compile(r"transport|cargo|freight|moving|logistic|vognmand|truck|lastbil|local business|"
                     r"local service|community|recruiter|building material|product/service|maskinstation|entrepren", re.I)
REJECT = re.compile(r"hair|salon|restaurant|cafe|spejder|scout|sport|beauty|church|\bvvs\b|plumb|fitness|musician|artist", re.I)


def toks(*p):
    out = set()
    for x in p:
        for t in re.findall(r"[a-zæøå]{4,}", (x or "").lower()):
            if t not in GENERIC:
                out.add(t.replace("æ", "ae").replace("ø", "oe").replace("å", "aa"))
    return out


def keyid(u):
    m = re.search(r"(\d{6,})", u or "")
    if m:
        return m.group(1)
    m = re.search(r"facebook\.com/(?:p/|people/|pages/)?([^/?#]+)", u or "", re.I)
    return (m.group(1).lower() if m else (u or "")).replace("æ", "ae").replace("ø", "oe").replace("å", "aa")


# attach candidate urls to leads
pairs = []
for l in L:
    if l.get("fb_status") == "confirmed":
        continue
    for sub, url in CANDS.items():
        if sub.lower() in l["company"].lower():
            pairs.append((l, url))
            break

urls = [{"url": u} for _, u in pairs]
# async run
r = urllib.request.urlopen(urllib.request.Request(
    f"https://api.apify.com/v2/acts/apify~facebook-pages-scraper/runs?token={TOKEN}",
    data=json.dumps({"startUrls": urls}).encode(), headers={"content-type": "application/json"}), timeout=40)
d = json.loads(r.read())["data"]
rid, dsid = d["id"], d["defaultDatasetId"]
for _ in range(40):
    st = json.loads(urllib.request.urlopen(f"https://api.apify.com/v2/actor-runs/{rid}?token={TOKEN}", timeout=20).read())["data"]["status"]
    if st in ("SUCCEEDED", "FAILED", "ABORTED"):
        break
    time.sleep(8)
recs = json.loads(urllib.request.urlopen(f"https://api.apify.com/v2/datasets/{dsid}/items?clean=true&format=json&token={TOKEN}", timeout=40).read())
by_key = {}
for x in recs:
    if not x.get("error"):
        for u in (x.get("facebookUrl"), x.get("pageUrl")):
            if u:
                by_key[keyid(u)] = x

added = 0
for l, u in pairs:
    rec = by_key.get(keyid(u))
    if not rec:
        print(f"  unscraped: {l['company']}")
        continue
    cats = " ".join(rec.get("categories") or []) + " " + (rec.get("title") or "")
    ok = not REJECT.search(cats) and HAULIER.search(cats) and (toks(l["company"], l.get("owner")) & toks(rec.get("title")))
    print(f"  {'OK ' if ok else 'rej'} {l['company'][:30]:30s} {rec.get('title')} {rec.get('categories')}")
    if not ok:
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

json.dump(L, open("scripts/customoffice/data/leads_v3.json", "w"), ensure_ascii=False, indent=1)
print(f"\nadded +{added}  ->  TOTAL confirmed FB: {sum(1 for l in L if l.get('fb_status')=='confirmed')}/50")