"""cvrapi.dk free enrichment layer for the CustomOffice vognmand lead list.

Single-company lookup by name or CVR. Returns owner (decision-maker), employees,
founding date, bankruptcy flag, official phone/email, company type, industrycode.
Free tier: be polite (UA with contact, throttle). No fabrication — a miss returns None.
"""
import json, time, urllib.parse, urllib.request

UA = "CarterCo lead research (hauge@burstcreators.com)"
_LAST = [0.0]

# DB07 industry codes that count as "haulier / road-freight-ish" for our ICP filter.
# 494100 vejgodstransport, 532000 andre post-/kurertjenester, 522920 godshåndtering,
# 493910 anden landpassagertransport (some small ops misfiled here), 016100 maskinstation.
TRANSPORT_CODES = {494100, 532000, 522920, 493910, 16100}


def _throttle(min_gap=1.6):
    dt = time.time() - _LAST[0]
    if dt < min_gap:
        time.sleep(min_gap - dt)
    _LAST[0] = time.time()


def lookup(name_or_cvr, by_vat=False):
    """Return cvrapi.dk record dict, or None on miss/error."""
    _throttle()
    key = "vat" if by_vat else "search"
    q = urllib.parse.urlencode({key: str(name_or_cvr), "country": "dk"})
    url = f"https://cvrapi.dk/api?{q}"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            data = json.loads(r.read().decode())
        if data.get("error"):
            return None
        return data
    except Exception:
        return None


def first_owner(rec):
    """Best-guess decision-maker name from cvrapi owners[] (small ApS/enkeltmands)."""
    owners = rec.get("owners") or []
    for o in owners:
        nm = (o.get("name") or "").strip()
        if nm:
            return nm
    return None


if __name__ == "__main__":
    import sys
    for q in sys.argv[1:] or ["danske fragtmænd"]:
        rec = lookup(q)
        if not rec:
            print(f"{q!r}: MISS"); continue
        print(json.dumps({
            "name": rec.get("name"), "vat": rec.get("vat"),
            "city": rec.get("city"), "zipcode": rec.get("zipcode"),
            "employees": rec.get("employees"), "startdate": rec.get("startdate"),
            "industrycode": rec.get("industrycode"), "industrydesc": rec.get("industrydesc"),
            "companydesc": rec.get("companydesc"), "bankrupt": rec.get("creditbankrupt"),
            "phone": rec.get("phone"), "email": rec.get("email"),
            "owner": first_owner(rec),
        }, ensure_ascii=False))
