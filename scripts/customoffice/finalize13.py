"""For the 13 leads with a real FB-post hook, write ONE complete ready-to-send DM:
opens with the personalized intro (the post reference), bridges to the real relevance
(drivers on payroll -> timer/tillæg/løn by hand), ends in a soft question.
Replaces 'play' for those 13. CarterCo voice rules apply.
"""
import json, re, urllib.request

KEY = next(l.split("=", 1)[1].strip() for l in open(".env.local") if l.startswith("ANTHROPIC_API_KEY="))
L = json.load(open("scripts/customoffice/data/leads_v3.json"))

targets = [l for l in L if l.get("personalized_intro")]
items = [{
    "i": L.index(l), "navn": l["company"], "ejer": l.get("owner"),
    "intro_der_skal_aabnes_med": l["personalized_intro"],
    "ansatte": l.get("employees"), "stiftet": (l.get("founded") or "")[:4] or None,
    "kanal": "Facebook Messenger" if l.get("fb_status") == "confirmed" else "telefon",
    "soeger_chauffoer": l.get("job_title"),
} for l in targets]

SYSTEM = """Du er GTM-engineer hos Carter & Co og skriver en FÆRDIG, klar-til-at-sende
besked (DM eller opkalds-åbner) til en vognmand på vegne af CustomOffice (dansk SaaS til
tidsregistrering, køresedler og løn).

Beskeden skal:
1. ÅBNE med den udleverede intro (henvisning til deres eget Facebook-opslag), brug den
   stort set ordret, det er den varme krog.
2. Bygge en blød bro til hvorfor CustomOffice er relevant: har de chauffører på løn, skal
   timer, tillæg og overenskomst styres, og gøres det i hånden, æder det tid og giver fejl.
3. Ende i ET kort, konkret spørgsmål der inviterer til en samtale.

Hold det kort (3-5 sætninger), som et menneske der skriver det selv. Regler (bindende):
dansk, INGEN tankestreg (—), brug komma/punktum. Ingen ™/®, ingen KAPITÆLER som styling.
Intet opfundet ud over det udleverede. CTA er en samtale, aldrig "book et møde". Start
gerne med "Hej <fornavn>" hvis ejer er givet, ellers bare "Hej"."""

USER = ('Returnér KUN et JSON-array: {"i": <i>, "besked": "<hele beskeden>"}. '
        'Ingen tekst udenfor JSON.\n\n' + json.dumps(items, ensure_ascii=False))

body = json.dumps({"model": "claude-sonnet-4-6", "max_tokens": 8000,
                   "system": SYSTEM, "messages": [{"role": "user", "content": USER}]}).encode()
req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, headers={
    "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"})
with urllib.request.urlopen(req, timeout=300) as r:
    resp = json.loads(r.read().decode())
arr = json.loads(re.search(r"\[.*\]", "".join(b.get("text", "") for b in resp.get("content", [])), re.S).group(0))
by_i = {o["i"]: o for o in arr}
n = 0
for i, l in enumerate(L):
    o = by_i.get(i)
    if o and o.get("besked"):
        kanal = "Facebook Messenger" if l.get("fb_status") == "confirmed" else "Telefon/SMS"
        l["play"] = f"{kanal}. {o['besked']}"
        n += 1

json.dump(L, open("scripts/customoffice/data/leads_v3.json", "w"), ensure_ascii=False, indent=1)
print(f"wrote {n} ready-to-send messages")
for l in L:
    if l.get("personalized_intro"):
        print(f"\n[{l['company']}] ({l.get('post_ref')})\n  {l['play']}")
