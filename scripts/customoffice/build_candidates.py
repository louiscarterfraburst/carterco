"""Build the candidate pool from the two discovery feeds, before CVR enrichment.

Feed A = jobnet (hiring signal): companies with a live driver job ad. Has CVR.
Feed B = gmaps (footprint signal): local vognmænd, tells us website-or-not + phone.

Output: data/candidates.json — deduped, signal-tagged, Jylland-weighted.
"""
import json, re

JOBNET = json.load(open("scripts/customoffice/data/jobnet_raw.json"))
GMAPS = json.load(open("scripts/customoffice/data/gmaps_raw.json"))

# Occupations from jobnet that mean road-freight haulier (exclude bus/taxi/handicap/etc).
GOOD_OCC = re.compile(r"fragt|distribution|blandet kørsel|specialtransport|tankvogn|vareudbringning|varevogn|kørselsleder|renovation|kran", re.I)
BAD_OCC = re.compile(r"persontransport|buschauff|taxi|handicap|lager|teamkoordinator|pædagog|sundhed", re.I)

# gmaps categories that are real hauliers.
GOOD_CAT = re.compile(r"vognmand|fragt|transport|shipping|spedition|kran|flytte", re.I)


def is_jylland_postal(pc):
    try:
        return int(str(pc)[:4]) >= 6000
    except Exception:
        return False


def norm(s):
    return re.sub(r"\s+", " ", (s or "").strip())


# ---- Feed A: jobnet hiring signal ----
seen_cvr = {}
for x in JOBNET:
    occ = x.get("occupation") or ""
    if BAD_OCC.search(occ) or not GOOD_OCC.search(occ):
        continue
    cvr = str(x.get("cvrNumber") or "").strip()
    if not cvr:
        continue
    rec = {
        "source": "jobnet",
        "signal": "hiring_driver",
        "cvr": cvr,
        "name": norm(x.get("employerName")),
        "town": norm(x.get("employerCity") or x.get("municipality")),
        "postal": x.get("postalCode"),
        "jylland": is_jylland_postal(x.get("postalCode")),
        "job_title": norm(x.get("title")),
        "occupation": occ,
        "date_posted": (x.get("datePosted") or "")[:10],
        "website": None,
        "phone": None,
        "fb_hint": None,
    }
    # keep one row per CVR; prefer Jylland / most recent
    prev = seen_cvr.get(cvr)
    if not prev or (rec["jylland"] and not prev["jylland"]):
        seen_cvr[cvr] = rec
jobnet_cands = list(seen_cvr.values())

# ---- Feed B: gmaps footprint signal ----
gmaps_cands = []
seen_name = set()
for x in GMAPS:
    cat = x.get("categoryName") or ""
    if not GOOD_CAT.search(cat):
        continue
    nm = norm(x.get("title"))
    key = nm.lower()
    if not nm or key in seen_name:
        continue
    seen_name.add(key)
    has_web = bool(x.get("website"))
    gmaps_cands.append({
        "source": "gmaps",
        "signal": "no_website" if not has_web else "local_haulier",
        "cvr": None,
        "name": nm,
        "town": norm(x.get("city")),
        "postal": (x.get("postalCode") or None),
        "jylland": True,  # search was Midtjylland
        "job_title": None,
        "occupation": cat,
        "date_posted": None,
        "website": x.get("website"),
        "phone": x.get("phone"),
        "fb_hint": (x.get("facebooks") or [None])[0],
        "address": norm(x.get("address")),
    })

cands = {"jobnet": jobnet_cands, "gmaps": gmaps_cands}
json.dump(cands, open("scripts/customoffice/data/candidates.json", "w"), ensure_ascii=False, indent=1)

print(f"jobnet transport candidates (deduped by CVR): {len(jobnet_cands)}")
print(f"   of which Jylland: {sum(1 for c in jobnet_cands if c['jylland'])}")
print(f"gmaps haulier candidates (deduped by name):   {len(gmaps_cands)}")
print(f"   of which NO website: {sum(1 for c in gmaps_cands if c['signal']=='no_website')}")
