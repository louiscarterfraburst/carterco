"""Pull recent FB page posts for the leads that have a page, for personalized intros.
Runs apify/facebook-posts-scraper (needs Apify cap headroom). Date-limited to recent
posts so the hook is timely. Writes fbposts_raw.json. Also serves as content-verification
for the 7 'namematch' pages (if a page's posts aren't haulier-ish, we drop it).
"""
import json, time, urllib.request

ENV = {k: v.strip() for k, v in (l.split("=", 1) for l in open(".env.local") if "=" in l and not l.startswith("#"))}
TOKEN = ENV["APIFY_API_TOKEN"]
L = json.load(open("scripts/customoffice/data/leads_v3.json"))

pages = [l for l in L if l.get("fb_url") and l.get("fb_status") in ("confirmed", "namematch")]
urls, seen = [], set()
for l in pages:
    if l["fb_url"] not in seen:
        seen.add(l["fb_url"])
        urls.append({"url": l["fb_url"]})
print(f"pulling posts for {len(urls)} FB pages")

payload = {"startUrls": urls, "resultsLimit": 8, "onlyPostsNewerThan": "10 months", "captionText": False}
r = urllib.request.urlopen(urllib.request.Request(
    f"https://api.apify.com/v2/acts/apify~facebook-posts-scraper/runs?token={TOKEN}",
    data=json.dumps(payload).encode(), headers={"content-type": "application/json"}), timeout=40)
d = json.loads(r.read())["data"]
rid, dsid = d["id"], d["defaultDatasetId"]
print("run", rid)
for _ in range(80):
    st = json.loads(urllib.request.urlopen(
        f"https://api.apify.com/v2/actor-runs/{rid}?token={TOKEN}", timeout=20).read())["data"]["status"]
    if st in ("SUCCEEDED", "FAILED", "ABORTED"):
        break
    time.sleep(10)
print("status", st)
recs = json.loads(urllib.request.urlopen(
    f"https://api.apify.com/v2/datasets/{dsid}/items?clean=true&format=json&token={TOKEN}", timeout=60).read())
json.dump(recs, open("scripts/customoffice/data/fbposts_raw.json", "w"), ensure_ascii=False, indent=1)
print(f"posts pulled: {len(recs)}")
