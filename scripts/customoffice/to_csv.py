"""Write the final pitch deliverable from leads_v3.json: warm, congratulate-first."""
import csv, json, re

L = json.load(open("scripts/customoffice/data/leads_v3.json"))


def year(s):
    m = re.search(r"(19|20)\d{2}", s or "")
    return m.group(0) if m else ""


COLS = [
    ("Virksomhed", lambda l: l["company"]),
    ("CVR", lambda l: l.get("cvr") or ""),
    ("Beslutningstager", lambda l: l.get("owner") or ""),
    ("By", lambda l: l.get("town") or ""),
    ("Ansatte", lambda l: l.get("employees") if isinstance(l.get("employees"), int) else ""),
    ("Stiftet", lambda l: year(l.get("founded"))),
    ("Branche", lambda l: l.get("industry") or ""),
    ("Segment", lambda l: l.get("segment") or ""),
    ("Personlig intro (FB-opslag)", lambda l: l.get("personalized_intro") or ""),
    ("FB-opslag ref", lambda l: l.get("post_ref") or ""),
    ("Anledning (åbn med dette)", lambda l: l.get("anledning") or ""),
    ("Relevans (hvorfor nu)", lambda l: l.get("relevans") or ""),
    ("Aktivt jobopslag", lambda l: l.get("job_title") or ""),
    ("Google", lambda l: l.get("google_rating") or ""),
    ("Kanal + footprint", lambda l: l.get("footprint_note") or ""),
    ("Telefon", lambda l: l.get("phone") or ""),
    ("Email", lambda l: l.get("email") or ""),
    ("Facebook", lambda l: (l.get("fb_url") + (" (bekræft inden DM)" if l.get("fb_status") == "namematch" else ""))
        if l.get("fb_url") and l.get("fb_status") in ("confirmed", "namematch") else ""),
    ("Foreslået play (åbner)", lambda l: l.get("play") or ""),
]

order = {"Vokser - søger chauffør": 0, "Etableret, folk på løn": 1,
         "Etableret enkeltmandsvognmand": 2, "Mindre vognmand": 3}
L.sort(key=lambda l: (order.get(l.get("segment"), 9), not l.get("owner")))

path = "scripts/customoffice/CustomOffice_leads_50.csv"
with open(path, "w", newline="") as f:
    w = csv.writer(f)
    w.writerow([c[0] for c in COLS])
    for l in L:
        w.writerow([fn(l) for _, fn in COLS])
print("wrote", path, "rows:", len(L))