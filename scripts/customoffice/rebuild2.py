"""Rebuild the 50 from the employees>=4 pool (CustomOffice needs people to manage).
Band 4-50 employees (small/mid owner-led vognmænd, not enterprise). Two fits:
 - hiring_driver: live job ad + a crew (strongest)
 - employer: established vognmand with 4-50 on payroll, manual timesheets
Writes leads_v3.json (pre-FB, pre-copy).
"""
import json, re

ICP = {"494100", "493200", "532000", "522920", "493910", "016100", "412000", "431200"}
PRIMARY = {"494100", "493200", "532000"}


def d8(p):
    d = re.sub(r"\D", "", p or "")
    return d[-8:] if len(d) >= 8 else ""


def keep(r):
    e = r.get("employees")
    return (r.get("cvrNumber") and r.get("industryCode") in ICP and not r.get("bankrupt")
            and isinstance(e, int) and 4 <= e <= 50)


def derive_owner(name):
    n = re.sub(r"(?i)\b(vognmand|vognmandsforretning|vognmandsfirmaet|transport|i/?s|aps|a/s|v/)\b", " ", name or "")
    n = re.sub(r"\s+", " ", n).strip(" .,-")
    parts = n.split()
    if 2 <= len(parts) <= 4 and not re.search(r"(?i)gården|firma|center|service|logistik", n):
        return n.title()
    return None


# --- maps ---
jobnet = json.load(open("scripts/customoffice/data/jobnet_raw.json"))
jn_by_cvr = {}
for x in jobnet:
    c = str(x.get("cvrNumber") or "")
    if c and c not in jn_by_cvr:
        jn_by_cvr[c] = x

gmaps = []
for f in ["run_gmaps_items.json", "run_gmaps_Nordjylland_items.json", "run_gmaps_Syddanmark_items.json"]:
    gmaps += json.load(open("scripts/customoffice/data/" + f))
gm_by_phone = {}
for x in gmaps:
    k = d8(x.get("phoneUnformatted") or x.get("phone"))
    if k and k not in gm_by_phone:
        gm_by_phone[k] = x

leads = {}

# --- hiring fit ---
for r in json.load(open("scripts/customoffice/data/jobnetcvr_raw.json")):
    if not keep(r):
        continue
    cvr = str(r["cvrNumber"])
    jn = jn_by_cvr.get(cvr, {})
    leads[cvr] = {
        "company": r.get("name"), "cvr": cvr, "owner": None,
        "town": jn.get("employerCity") or jn.get("municipality") or r.get("city"),
        "employees": r.get("employees"), "founded": r.get("startDate"),
        "industry": r.get("industryDesc"), "industry_code": r.get("industryCode"),
        "company_type": r.get("companyTypeShort") or r.get("companyType"),
        "signals": ["hiring_driver"], "job_title": jn.get("title"),
        "website": r.get("website") or None, "phone": r.get("phone") or jn.get("employerPhone"),
        "email": r.get("email"), "google_rating": None, "fb_url": None, "fb_status": "none",
    }

# --- employer (footprint) fit ---
for src in ["cvrphone_raw.json", "newphones_raw.json"]:
    for r in json.load(open("scripts/customoffice/data/" + src)):
        if not keep(r):
            continue
        cvr = str(r["cvrNumber"])
        ph = d8(r.get("queryInput") or r.get("phone"))
        g = gm_by_phone.get(ph, {})
        disp = g.get("title") or r.get("name")
        if cvr in leads:
            if g.get("totalScore"):
                leads[cvr]["google_rating"] = g
            continue
        leads[cvr] = {
            "company": disp, "cvr": cvr, "owner": derive_owner(disp),
            "town": g.get("city") or r.get("city"),
            "employees": r.get("employees"), "founded": r.get("startDate"),
            "industry": r.get("industryDesc"), "industry_code": r.get("industryCode"),
            "company_type": r.get("companyTypeShort") or r.get("companyType"),
            "signals": ["employer"], "job_title": None,
            "website": (r.get("website") or g.get("website")) or None,
            "phone": r.get("phone") or g.get("phone"), "email": r.get("email"),
            "google_rating": g if g.get("totalScore") else None,
            "fb_url": None, "fb_status": "none",
        }

# normalize google_rating to a display string (only strong ones worth congratulating)
for l in leads.values():
    g = l.get("google_rating")
    if isinstance(g, dict):
        sc, n = g.get("totalScore"), g.get("reviewsCount")
        l["google_rating"] = (f"{sc}".rstrip("0").rstrip(".") + f"★ ({n} anmeldelser)"
                              if isinstance(sc, (int, float)) and sc >= 4.5 and isinstance(n, int) and n >= 3 else None)


def score(l):
    s = 0
    if "hiring_driver" in l["signals"]:
        s += 30
    e = l["employees"]
    s += 12 if 6 <= e <= 30 else (7 if e <= 5 else 8)
    if l.get("google_rating"):
        s += 8
    if l.get("owner"):
        s += 5
    if l.get("industry_code") in PRIMARY:
        s += 4
    try:
        if int((l.get("founded") or "0")[:4]) <= 2010:
            s += 3
    except ValueError:
        pass
    return s


ranked = sorted(leads.values(), key=score, reverse=True)
final = ranked[:50]
json.dump(final, open("scripts/customoffice/data/leads_v3.json", "w"), ensure_ascii=False, indent=1)

from collections import Counter
print(f"pool (emp 4-50, ICP): {len(leads)}  ->  final 50")
print("fit:", dict(Counter(l['signals'][0] for l in final)))
print("emp range:", min(l['employees'] for l in final), "-", max(l['employees'] for l in final),
      "| median ~", sorted(l['employees'] for l in final)[25])
print("with owner:", sum(1 for l in final if l.get('owner')),
      "| strong rating:", sum(1 for l in final if l.get('google_rating')),
      "| with phone:", sum(1 for l in final if l.get('phone')),
      "| has gmaps town:", sum(1 for l in final if l.get('town')))