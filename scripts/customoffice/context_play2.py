"""Regenerate per-lead opener material with the WARM framing Louis asked for:
- anledning: a genuine thing to congratulate / acknowledge (longevity, growth, rating).
  Grounded only in real data. No flattery, no invented facts.
- relevans: why CustomOffice is relevant to THEM (drivers on payroll, hours+overenskomst
  done by hand). NEVER 'no website = needs software'.
- play: an opener that LEADS with the congratulation, then softly bridges to relevance.
"""
import json, re, urllib.request

KEY = next(l.split("=", 1)[1].strip() for l in open(".env.local") if l.startswith("ANTHROPIC_API_KEY="))
L = json.load(open("scripts/customoffice/data/leads_v3.json"))

compact = []
for i, l in enumerate(L):
    yr = (l.get("founded") or "")[:4]
    compact.append({
        "i": i, "navn": l["company"], "ejer": l.get("owner"), "by": l.get("town"),
        "ansatte": l.get("employees") if isinstance(l.get("employees"), int) else None,
        "stiftet": yr if yr.isdigit() else None,
        "branche": l.get("industry"),
        "google_rating": l.get("google_rating"),
        "soeger_chauffoer": l.get("job_title"),
        "fb_intro": (l.get("fb_intro") or "")[:120] or None,
        "kanal": ("Facebook Messenger + telefon" if l.get("fb_status") == "confirmed" and l.get("phone")
                  else "Facebook Messenger" if l.get("fb_status") == "confirmed"
                  else "telefon/SMS" if l.get("phone") else "telefon"),
    })

SYSTEM = """Du er GTM-engineer hos Carter & Co og hjælper CustomOffice (dansk SaaS til
tidsregistrering, køresedler og løn for vognmænd, maskinstationer og entreprenører) med
at åbne en varm samtale med små vognmænd.

VIGTIGST: Åbn ALTID med noget ægte at anerkende eller ønske tillykke med, ikke et "signal".
Den røde tråd er respekt fra én operatør til en anden, derefter en blød bro til hvorfor
tidsregistrering er relevant for netop dem.

Hvad man kan anerkende (kun hvis det står i data):
- Lang levetid ("I har kørt siden 1977, snart 50 år" - stærkest og mest ægte).
- At de vokser (søger chauffør lige nu).
- Flot omdømme (kun hvis google_rating er givet).
- Flådestørrelse eller andet konkret fra fb_intro.
Hvis intet af det findes: en jordnær, ikke-smiskende anerkendelse af at drive en mindre
vognmandsforretning. ALDRIG opfundet ros, tal eller "jeg elsker det I laver".

Hvorfor relevant (relevans) - den ÆGTE logik, aldrig "ingen hjemmeside = vil have software":
- Har de chauffører på løn, skal timer, tillæg og overenskomst styres. Gøres det i hånden
  eller på papir, er det tidsrøvende og fejlbehæftet. Det er dér CustomOffice sparer tid.
- Vokser de, vokser den byrde.
- Kører de selv plus fakturerer, æder køresedler og timer stadig aftenerne.

Regler (bindende): dansk, håndskrevet-menneskeligt. INGEN tankestreg (—), brug komma/punktum.
Ingen ™/®, ingen KAPITÆLER som styling. CTA er en samtale (ring/skriv), aldrig "book møde".
Intet opfundet. Ingen pral om handlinger du ikke har gjort."""

USER = ('Returnér KUN et JSON-array, ét objekt pr. lead i samme rækkefølge, felter: '
        '{"i": <i>, "anledning": "...", "relevans": "...", "play": "..."}. '
        '"play" = kanal + en kort åbner (1-3 sætninger) der STARTER med anledningen og '
        'derefter blødt bygger bro til relevans og ender i et spørgsmål. Ingen tekst udenfor JSON.\n\n'
        + json.dumps(compact, ensure_ascii=False))

body = json.dumps({"model": "claude-sonnet-4-6", "max_tokens": 14000,
                   "system": SYSTEM, "messages": [{"role": "user", "content": USER}]}).encode()
req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, headers={
    "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"})
with urllib.request.urlopen(req, timeout=420) as r:
    resp = json.loads(r.read().decode())

text = "".join(b.get("text", "") for b in resp.get("content", []))
arr = json.loads(re.search(r"\[.*\]", text, re.S).group(0))
by_i = {o["i"]: o for o in arr}
for i, l in enumerate(L):
    o = by_i.get(i, {})
    l["anledning"] = o.get("anledning", "")
    l["relevans"] = o.get("relevans", "")
    l["play"] = o.get("play", "")

json.dump(L, open("scripts/customoffice/data/leads_v3.json", "w"), ensure_ascii=False, indent=1)
print(f"regenerated {sum(1 for l in L if l['anledning'])}/{len(L)} (usage {resp.get('usage',{}).get('output_tokens')} out tok)")
print("\n--- samples across segments ---")
import itertools
shown = set()
for l in L:
    if l["segment"] in shown:
        continue
    shown.add(l["segment"])
    print(f"\n[{l['company']}] — {l['segment']} (stiftet {(l.get('founded') or '?')[:4]}, {l.get('employees')} ans, {l.get('google_rating') or 'ingen rating'})")
    print(" anledning:", l["anledning"])
    print(" relevans: ", l["relevans"])
    print(" play:     ", l["play"])