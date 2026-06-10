"""Reframe pass: dedupe, attach Google rating (strong ones only, for a genuine
congratulation), recompute an honest segment, drop 'no website' as a buying signal.
Writes leads_v2.json. No 'no website = wants software' logic anywhere.
"""
import json, re

L = json.load(open("scripts/customoffice/data/leads_final.json"))
G = json.load(open("scripts/customoffice/data/gmaps_raw.json"))
C = json.load(open("scripts/customoffice/data/candidates.json"))


def d8(p):
    d = re.sub(r"\D", "", p or "")
    return d[-8:] if len(d) >= 8 else ""


def norm(n):
    n = re.sub(r"(?i)\b(aps|a/s|i/s|is|as|vognmandsforretning|vognmand|transport)\b", " ", n)
    n = re.sub(r"(?i)\s+v/.*$", "", n)
    return re.sub(r"[^a-zæøå ]", " ", n.lower()).strip()


# --- Google rating, only when genuinely worth congratulating ---
rating = {}
for x in G:
    k = d8(x.get("phoneUnformatted") or x.get("phone"))
    sc, n = x.get("totalScore"), x.get("reviewsCount")
    if k and isinstance(sc, (int, float)) and sc >= 4.5 and isinstance(n, int) and n >= 3:
        rating[k] = {"score": sc, "n": n}

for l in L:
    r = rating.get(d8(l.get("phone")))
    l["google_rating"] = f"{r['score']}".rstrip("0").rstrip(".") + f"★ ({r['n']} anmeldelser)" if r else None


# --- dedupe by normalized name, keep the richer record ---
def richness(l):
    return (l.get("fb_status") == "confirmed", isinstance(l.get("employees"), int),
            bool(l.get("founded")), bool(l.get("google_rating")))


best = {}
for l in L:
    k = norm(l["company"])
    if k not in best or richness(l) > richness(best[k]):
        best[k] = l
deduped = list(best.values())

# --- backfill toward 50 from unused gmaps no-website hauliers (gmaps-only fields) ---
have = {norm(l["company"]) for l in deduped}
GOOD = re.compile(r"vognmand|fragt|transport|shipping|spedition|kran|flytte", re.I)
for c in C["gmaps"]:
    if len(deduped) >= 50:
        break
    if c["signal"] != "no_website" or norm(c["name"]) in have:
        continue
    have.add(norm(c["name"]))
    deduped.append({
        "company": c["name"], "cvr": None, "owner": None, "town": c.get("town"),
        "employees": None, "founded": None, "industry": c.get("occupation"),
        "company_type": None, "signals": ["no_website"], "job_title": None,
        "website": None, "phone": c.get("phone"), "email": None,
        "fb_url": None, "fb_status": "none", "fb_category": None, "fb_likes": None,
        "fb_intro": None, "fb_messenger": None, "google_rating": None,
    })


# --- honest segment (NOT 'no website') ---
def segment(l):
    if "hiring_driver" in l["signals"]:
        return "Vokser - søger chauffør"
    e = l.get("employees")
    if isinstance(e, int) and e >= 2:
        return "Etableret, folk på løn"
    yr = (l.get("founded") or "")[:4]
    if yr and yr.isdigit() and int(yr) <= 2016:
        return "Etableret enkeltmandsvognmand"
    return "Mindre vognmand"


for l in deduped:
    l["segment"] = segment(l)
    # footprint = how to reach + the manual-ops tell (context, not a buying claim)
    foot = []
    if "no_website" in l["signals"]:
        foot.append("ingen hjemmeside")
    elif "low_footprint" in l["signals"]:
        foot.append("ingen hjemmeside på Google")
    if l.get("fb_status") == "confirmed":
        foot.append("aktiv på Facebook")
    l["footprint_note"] = ", ".join(foot)

json.dump(deduped, open("scripts/customoffice/data/leads_v2.json", "w"), ensure_ascii=False, indent=1)

from collections import Counter
print("leads:", len(deduped))
print("segments:", dict(Counter(l["segment"] for l in deduped)))
print("with genuine congrat hook (founded<=2016 or strong rating or hiring):",
      sum(1 for l in deduped if l.get("google_rating") or "hiring_driver" in l["signals"]
          or ((l.get("founded") or "")[:4].isdigit() and int((l.get("founded") or "0")[:4] or 0) <= 2016)))
print("strong google rating:", sum(1 for l in deduped if l.get("google_rating")))