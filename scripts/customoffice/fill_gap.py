"""Close the personalization gap: leads that HAVE a scraped FB page but no hook yet.
Use their posts (any genuine one) + the page's own description (fb_intro: fleet size,
specialty, longevity) to craft an intro + ready-to-send message. Keep the existing 13
untouched. Skip honestly only if there's truly no real material.
"""
import json, re, urllib.request

KEY = next(l.split("=", 1)[1].strip() for l in open(".env.local") if l.startswith("ANTHROPIC_API_KEY="))
L = json.load(open("scripts/customoffice/data/leads_v3.json"))
P = json.load(open("scripts/customoffice/data/fbposts_raw.json"))


def keyid(u):
    m = re.search(r"(\d{6,})", u or "")
    if m:
        return m.group(1)
    m = re.search(r"facebook\.com/(?:p/|people/|pages/)?([^/?#]+)", u or "", re.I)
    return (m.group(1) or "").lower()


posts_by_page = {}
for p in P:
    t = (p.get("text") or "").strip()
    if not t:
        continue
    k = keyid(p.get("inputUrl") or p.get("facebookUrl") or p.get("url"))
    posts_by_page.setdefault(k, []).append({"date": (p.get("time") or "")[:10], "text": t[:400]})

targets = [l for l in L if l.get("fb_status") in ("confirmed", "namematch") and not l.get("personalized_intro")]
items = []
for l in targets:
    items.append({
        "i": L.index(l), "navn": l["company"], "ejer": l.get("owner"),
        "ansatte": l.get("employees"), "stiftet": (l.get("founded") or "")[:4] or None,
        "side_beskrivelse": (l.get("fb_intro") or "")[:200] or None,
        "opslag": posts_by_page.get(keyid(l.get("fb_url")), [])[:6],
        "kanal": "Facebook Messenger" if l.get("fb_status") == "confirmed" else "telefon",
    })

SYSTEM = """Du er GTM-engineer hos Carter & Co og skriver til en vognmand på vegne af
CustomOffice (dansk SaaS til tidsregistrering, køresedler og løn).

Find en ÆGTE personlig krog fra materialet, i prioriteret rækkefølge:
1. Et konkret Facebook-opslag (ny lastbil, jubilæum, en specialopgave, en ny medarbejder).
2. Hvis ingen god post: noget konkret fra side_beskrivelsen (flådestørrelse som "20 lastbiler",
   en specialisering, mange års historie).
Brug kun hvad der faktisk står. Opfind ALDRIG noget. Hvis der virkelig ingen konkret krog er,
returnér {"i":<i>,"skip":true}.

Når der ER en krog, skriv en FÆRDIG, klar-til-at-sende besked (3-5 sætninger):
1. åbn med krogen, 2. blød bro til at chauffører på løn betyder timer/tillæg/overenskomst der
skal styres, og manuelt koster det tid og fejl, 3. afslut med ét kort spørgsmål.
Regler: dansk, håndskrevet. INGEN tankestreg (—), brug komma/punktum. Ingen ™/®, ingen
KAPITÆLER som styling. CTA = en samtale, aldrig "book møde". "Hej <fornavn>" hvis ejer kendt."""

USER = ('Returnér KUN et JSON-array: {"i":<i>,"intro":"<krogen i 1 sætning>","besked":"<hele '
        'beskeden>","skip":false} eller {"i":<i>,"skip":true}. Ingen tekst udenfor JSON.\n\n'
        + json.dumps(items, ensure_ascii=False))

body = json.dumps({"model": "claude-sonnet-4-6", "max_tokens": 9000,
                   "system": SYSTEM, "messages": [{"role": "user", "content": USER}]}).encode()
req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, headers={
    "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"})
with urllib.request.urlopen(req, timeout=300) as r:
    resp = json.loads(r.read().decode())
arr = json.loads(re.search(r"\[.*\]", "".join(b.get("text", "") for b in resp.get("content", [])), re.S).group(0))
by_i = {o["i"]: o for o in arr}
filled = skipped = 0
for l in targets:
    o = by_i.get(L.index(l), {})
    if o.get("skip") or not o.get("besked"):
        skipped += 1
        continue
    filled += 1
    l["personalized_intro"] = o.get("intro", "")
    kanal = "Facebook Messenger" if l.get("fb_status") == "confirmed" else "Telefon/SMS"
    l["play"] = f"{kanal}. {o['besked']}"

json.dump(L, open("scripts/customoffice/data/leads_v3.json", "w"), ensure_ascii=False, indent=1)
print(f"gap leads: {len(targets)}  ->  filled {filled}, skipped {skipped} (no real hook)")
print(f"TOTAL personalized intros now: {sum(1 for l in L if l.get('personalized_intro'))}")
for l in targets:
    if l.get("personalized_intro") and L.index(l) in by_i and not by_i[L.index(l)].get("skip"):
        print(f"\n[{l['company']}]\n  {l['play']}")