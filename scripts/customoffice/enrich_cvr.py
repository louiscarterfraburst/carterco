"""CVR enrichment pass via cvrapi.dk (free). Attaches owner/employees/founded/
bankruptcy/type to each candidate, filters to real hauliers, writes enriched.json.

jobnet candidates: looked up by CVR (exact). gmaps candidates: looked up by name,
then city-verified so we never attach the wrong company (no-fabrication rule).
"""
import json, re, sys
sys.path.insert(0, "scripts/customoffice")
import cvr as cvrmod

C = json.load(open("scripts/customoffice/data/candidates.json"))


def tokens(s):
    return set(re.findall(r"[a-zæøå]{3,}", (s or "").lower()))


def attach(rec, c, by_vat):
    key = c["cvr"] if by_vat else c["name"]
    r = cvrmod.lookup(key, by_vat=by_vat)
    if not r:
        c["cvr_match"] = "miss"
        return c
    # city-verify name lookups so we don't bind a wrong CVR
    if not by_vat:
        cand_city = (c.get("town") or "").lower()
        cvr_city = (r.get("city") or "").lower()
        cvr_cityname = (r.get("cityname") or "").lower()
        name_overlap = len(tokens(c["name"]) & tokens(r.get("name"))) >= 1
        city_ok = bool(cand_city) and (cand_city in (cvr_city, cvr_cityname) or cvr_city in cand_city)
        c["cvr_match"] = "high" if (name_overlap and city_ok) else ("name_only" if name_overlap else "low")
        if c["cvr_match"] == "low":
            return c  # don't trust the binding
        c["cvr"] = str(r.get("vat"))
    else:
        c["cvr_match"] = "exact"
    c["legal_name"] = r.get("name")
    c["owner"] = cvrmod.first_owner(r)
    c["employees"] = r.get("employees")
    c["founded"] = r.get("startdate")
    c["industrycode"] = r.get("industrycode")
    c["industrydesc"] = r.get("industrydesc")
    c["company_type"] = r.get("companydesc")
    c["bankrupt"] = r.get("creditbankrupt")
    c["cvr_phone"] = r.get("phone")
    c["cvr_email"] = r.get("email")
    c["cvr_city"] = r.get("city")
    c["cvr_zip"] = r.get("zipcode")
    return c


def keep(c):
    if c.get("bankrupt"):
        return False
    ic = c.get("industrycode")
    if ic is not None and ic not in cvrmod.TRANSPORT_CODES:
        return False
    emp = c.get("employees")
    if isinstance(emp, int) and emp > 60:   # CustomOffice ICP = small operators
        return False
    return True


# --- jobnet: Jylland hiring-signal, lookup by CVR ---
jobnet = sorted(C["jobnet"], key=lambda c: (not c["jylland"], c["name"]))
jobnet_jyl = [c for c in jobnet if c["jylland"]]
enr_hiring = []
for c in jobnet_jyl:
    c = attach(c, c, by_vat=True)
    if keep(c):
        enr_hiring.append(c)
    print(f"  [hiring] {c['name'][:30]:30s} ic={c.get('industrycode')} emp={c.get('employees')} keep={keep(c)}", file=sys.stderr)

# --- gmaps: no-website first, lookup by name ---
gmaps = sorted(C["gmaps"], key=lambda c: (c["signal"] != "no_website", c["name"]))
enr_footprint = []
for c in gmaps:
    if c["signal"] != "no_website":
        continue
    c = attach(c, c, by_vat=False)
    if keep(c) and c.get("cvr_match") not in ("low", "miss"):
        enr_footprint.append(c)
    print(f"  [no-web] {c['name'][:30]:30s} match={c.get('cvr_match')} ic={c.get('industrycode')} keep={keep(c)}", file=sys.stderr)

out = {"hiring": enr_hiring, "footprint": enr_footprint}
json.dump(out, open("scripts/customoffice/data/enriched.json", "w"), ensure_ascii=False, indent=1)
print(f"\nENRICHED kept -> hiring(Jylland): {len(enr_hiring)}   no-website: {len(enr_footprint)}")
