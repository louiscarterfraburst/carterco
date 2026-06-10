"""Generate a 1-line context + a suggested outbound play per lead, in Danish,
following CarterCo outreach rules. One batched Anthropic call. Attaches to leads.
"""
import json, re, urllib.request

KEY = next(l.split("=", 1)[1].strip() for l in open(".env.local") if l.startswith("ANTHROPIC_API_KEY="))
LEADS = json.load(open("scripts/customoffice/data/leads_final.json"))

SIGNAL_DESC = {
    "hiring_driver": "har lige nu et aktivt chauffør-jobopslag (vokser, flere timer at holde styr på)",
    "no_website": "ingen hjemmeside fundet nogen steder (papir-drevet, ikke på LinkedIn)",
    "low_footprint": "ingen hjemmeside på deres Google-profil, ikke på LinkedIn (lav digital footprint)",
}

compact = []
for i, l in enumerate(LEADS):
    compact.append({
        "i": i,
        "navn": l["company"],
        "ejer": l.get("owner"),
        "by": l.get("town"),
        "ansatte": l.get("employees"),
        "stiftet": (l.get("founded") or "")[:4] or None,
        "branche": l.get("industry"),
        "signaler": [SIGNAL_DESC.get(s, s) for s in l["signals"]],
        "jobopslag": l.get("job_title"),
        "kanal": ("Facebook Messenger + telefon" if l.get("fb_status") == "confirmed" and l.get("phone")
                  else "Facebook Messenger" if l.get("fb_status") == "confirmed"
                  else "telefon/SMS" if l.get("phone") else "telefon"),
        "fb_intro": (l.get("fb_intro") or "")[:120] or None,
    })

SYSTEM = """Du er GTM-engineer hos Carter & Co. Du hjælper CustomOffice (dansk SaaS til
tidsregistrering/løn for vognmænd, maskinstationer og entreprenører) med at forstå et
sæt leads og hvordan man rækker ud. Stil og regler (BINDENDE):
- Skriv på dansk, som et menneske der har skrevet det i hånden.
- INGEN tankestreg (—). Brug komma eller punktum. Ingen ™/®. Ingen ord i KAPITÆLER som styling.
- Opfind ALDRIG fakta, tal eller citater. Brug kun det du får udleveret.
- Ingen pral om handlinger du ikke har gjort ("jeg har set jeres demo" o.l.).
- CTA er altid en samtale (ring/skriv), aldrig "book et møde" eller "tilmeld dig".
- Vinklen er operatør-til-operatør: konkret pain (køresedler, timer, overenskomst, løn), ikke salgs-floskler.
For HVER lead, returnér: "context" (1 sætning: hvem de er + hvorfor de er et fit lige nu) og
"play" (kanal + den konkrete trigger man nævner + en kort eksempel-åbner på 1-2 sætninger CustomOffice kan sige)."""

USER = ("Her er leads som JSON. Returnér KUN et JSON-array, et objekt pr. lead, i samme rækkefølge, "
        'med felterne: {"i": <samme i>, "context": "...", "play": "..."}. Ingen tekst udenfor JSON.\n\n'
        + json.dumps(compact, ensure_ascii=False))

body = json.dumps({
    "model": "claude-sonnet-4-6",
    "max_tokens": 12000,
    "system": SYSTEM,
    "messages": [{"role": "user", "content": USER}],
}).encode()

req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, headers={
    "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"})
with urllib.request.urlopen(req, timeout=180) as r:
    resp = json.loads(r.read().decode())

text = "".join(b.get("text", "") for b in resp.get("content", []))
m = re.search(r"\[.*\]", text, re.S)
arr = json.loads(m.group(0))
by_i = {o["i"]: o for o in arr}
miss = 0
for i, l in enumerate(LEADS):
    o = by_i.get(i, {})
    l["context"] = o.get("context") or ""
    l["play"] = o.get("play") or ""
    if not l["context"]:
        miss += 1

json.dump(LEADS, open("scripts/customoffice/data/leads_final.json", "w"), ensure_ascii=False, indent=1)
print(f"context+play generated for {len(LEADS)-miss}/{len(LEADS)} leads (usage: {resp.get('usage')})")
print("\n--- 3 samples ---")
for l in LEADS[:3]:
    print(f"\n[{l['company']}] signals={l['signals']}")
    print(" context:", l["context"])
    print(" play:", l["play"])