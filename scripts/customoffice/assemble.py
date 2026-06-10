"""Merge the two enriched feeds into a single deduped 50-lead list.

hiring  = jobnet Jylland, CVR-enriched (owner, employees, founded) — signal: hiring_driver
footprint = gmaps no-website hauliers, phone-resolved to CVR — signal: no_website
A company in both gets both signal tags (strongest leads).
"""
import json, re

HIRING = json.load(open("scripts/customoffice/data/enriched.json"))["hiring"]
PHONE = json.load(open("scripts/customoffice/data/cvrphone_raw.json"))
GMAPS = json.load(open("scripts/customoffice/data/gmaps_raw.json"))

# CustomOffice ICP industry codes: vognmand/freight + maskinstation + entreprenør (all paper-timesheet pain)
ICP_CODES = {494100, 493200, 532000, 522920, 493910, 16100, 412000, 421100, 431200}
PRIMARY = {494100, 493200, 532000}  # core "trucking" for the pitch hook


def d8(p):
    d = re.sub(r"\D", "", p or "")
    return d[-8:] if len(d) >= 8 else ""


# index gmaps by phone8 to recover town/phone/address/category for footprint leads
gmaps_by_phone = {}
for x in GMAPS:
    k = d8(x.get("phoneUnformatted") or x.get("phone"))
    if k and k not in gmaps_by_phone:
        gmaps_by_phone[k] = x


def derive_owner(name):
    """For 'Vognmand Per H Andersen' / 'PER ANDERSEN' the owner is the person named."""
    n = re.sub(r"(?i)\b(vognmand|vognmandsforretning|vognmandsfirmaet|transport|i/?s|aps|a/s|v/)\b", " ", name)
    n = re.sub(r"\s+", " ", n).strip(" .,-")
    parts = n.split()
    # looks like a person name (2-3 capitalized tokens, not a generic word)
    if 2 <= len(parts) <= 4 and not re.search(r"(?i)gården|firma|center|service", n):
        return n.title()
    return None


leads = {}  # cvr -> lead

# --- hiring feed ---
for c in HIRING:
    cvr = c.get("cvr")
    leads[cvr] = {
        "company": c.get("legal_name") or c.get("name"),
        "cvr": cvr,
        "owner": c.get("owner"),
        "town": c.get("cvr_city") or c.get("town"),
        "employees": c.get("employees"),
        "founded": c.get("founded"),
        "industry_code": c.get("industrycode"),
        "industry": c.get("industrydesc"),
        "company_type": c.get("company_type"),
        "signals": ["hiring_driver"],
        "job_title": c.get("job_title"),
        "date_posted": c.get("date_posted"),
        "website": None,        # unknown for hiring feed; FB step / cvr may fill
        "phone": c.get("cvr_phone"),
        "email": c.get("cvr_email"),
        "address": None,
        "fb_url": None,
    }

# --- footprint feed (no website) ---
for r in PHONE:
    cvr = r.get("cvrNumber")
    try:
        ic = int(r.get("industryCode")) if r.get("industryCode") else None
    except (TypeError, ValueError):
        ic = None
    if not cvr or r.get("bankrupt"):
        continue
    if ic not in ICP_CODES:
        continue
    emp = r.get("employees")
    if isinstance(emp, int) and emp > 60:
        continue
    g = gmaps_by_phone.get(d8(r.get("phone"))) or {}
    if cvr in leads:
        leads[cvr]["signals"].append("no_website")
        leads[cvr]["website"] = leads[cvr]["website"] or (r.get("website") or None)
        continue
    name = r.get("name")
    leads[cvr] = {
        "company": name,
        "cvr": cvr,
        "owner": derive_owner(name),
        "town": r.get("city") or g.get("city"),
        "employees": emp,
        "founded": r.get("startDate"),
        "industry_code": ic,
        "industry": r.get("industryDesc"),
        "company_type": r.get("companyTypeShort") or r.get("companyType"),
        "signals": ["no_website"],
        "job_title": None,
        "date_posted": None,
        "website": r.get("website") or None,
        "phone": r.get("phone") or g.get("phone"),
        "email": r.get("email"),
        "address": (g.get("address") or r.get("address")),
        "fb_url": None,
    }

allleads = list(leads.values())

# --- backfill toward 50 with remaining no-website gmaps hauliers (CVR unresolved) ---
used_phone8 = {d8(l.get("phone")) for l in allleads}
used_names = {(l["company"] or "").lower() for l in allleads}
GOOD_CAT = re.compile(r"vognmand|fragt|transport|shipping|spedition|kran|flytte", re.I)
backfill = []
for x in GMAPS:
    if x.get("website") or not GOOD_CAT.search(x.get("categoryName") or ""):
        continue
    nm = re.sub(r"\s+", " ", (x.get("title") or "").strip())
    if not nm or nm.lower() in used_names or d8(x.get("phone")) in used_phone8:
        continue
    used_names.add(nm.lower())
    backfill.append({
        "company": nm, "cvr": None, "owner": derive_owner(nm),
        "town": x.get("city"), "employees": None, "founded": None,
        "industry_code": None, "industry": x.get("categoryName"),
        "company_type": None, "signals": ["no_website"],
        "job_title": None, "date_posted": None, "website": None,
        "phone": x.get("phone"), "email": None, "address": x.get("address"), "fb_url": None,
    })


def score(l):
    s = 0
    if "hiring_driver" in l["signals"] and "no_website" in l["signals"]:
        s += 100              # both signals = strongest
    if l["industry_code"] in PRIMARY:
        s += 20
    if "hiring_driver" in l["signals"]:
        s += 15               # active intent
    if "no_website" in l["signals"]:
        s += 10
    if isinstance(l["employees"], int) and 1 <= l["employees"] <= 25:
        s += 8                # sweet-spot size
    if l.get("owner"):
        s += 4
    return s


allleads.sort(key=score, reverse=True)
final = allleads[:50]
if len(final) < 50:
    final += backfill[:50 - len(final)]
json.dump(final, open("scripts/customoffice/data/leads.json", "w"), ensure_ascii=False, indent=1)

from collections import Counter
sigc = Counter()
for l in final:
    sigc["+".join(sorted(l["signals"]))] += 1
print(f"FINAL leads: {len(final)}")
for k, v in sigc.items():
    print(f"   {v:3d}  {k}")
print(f"   primary trucking (494100/493200/532000): {sum(1 for l in final if l['industry_code'] in PRIMARY)}")
print(f"   with owner name: {sum(1 for l in final if l.get('owner'))}")
print(f"   with phone: {sum(1 for l in final if l.get('phone'))}")
