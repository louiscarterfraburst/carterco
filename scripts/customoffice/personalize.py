"""Turn recent FB posts into a personalized intro line per lead, grounded in a REAL
post. No fabrication: if there's no specific, usable recent post, we keep the existing
data-grounded 'anledning' and leave personalized_intro empty. One Anthropic call.
"""
import json, re, urllib.request

KEY = next(l.split("=", 1)[1].strip() for l in open(".env.local") if l.startswith("ANTHROPIC_API_KEY="))
L = json.load(open("scripts/customoffice/data/leads_v3.json"))
POSTS = json.load(open("scripts/customoffice/data/fbposts_raw.json"))


def page_key(u):
    m = re.search(r"(\d{6,})", u or "")
    if m:
        return m.group(1)
    m = re.search(r"facebook\.com/(?:p/|people/|pages/)?([^/?#]+)", u or "", re.I)
    return (m.group(1) or "").lower()


# group posts by their page url/id
by_page = {}
for p in POSTS:
    u = p.get("pageUrl") or p.get("facebookUrl") or p.get("url") or p.get("inputUrl")
    txt = (p.get("text") or p.get("message") or "").strip()
    if not txt:
        continue
    by_page.setdefault(page_key(u), []).append({"date": (p.get("time") or p.get("date") or "")[:10], "text": txt[:400]})

items = []
for i, l in enumerate(L):
    posts = by_page.get(page_key(l.get("fb_url"))) if l.get("fb_url") else None
    if posts:
        items.append({"i": i, "navn": l["company"], "by": l.get("town"), "posts": posts[:6]})

SYSTEM = """Du er GTM-engineer hos Carter & Co. Du får en vognmands SENESTE Facebook-opslag.
Skriv en kort, personlig intro-linje (1-2 sætninger, dansk) CustomOffice kan åbne med, der
refererer til noget KONKRET og ægte fra deres opslag (en ny lastbil, en jubilæum, en tur de
søger folk til, en sponsorat, et billede de har delt).

Regler (bindende): Kun hvad der faktisk står i opslagene, intet opfundet. Ingen smisk som
"jeg elsker jeres opslag". Lyd som et menneske, operatør til operatør. INGEN tankestreg (—),
brug komma/punktum. Ingen KAPITÆLER som styling.
Hvis ingen af opslagene giver en ægte, konkret krog, returnér "skip": true (så bruger vi den
eksisterende åbner i stedet). Tving aldrig en personlig krog frem."""

USER = ('For hvert objekt, returnér KUN et JSON-array: {"i": <i>, "intro": "...", "post_ref": '
        '"<kort hvilket opslag>", "skip": false} eller {"i": <i>, "skip": true}. Ingen tekst udenfor JSON.\n\n'
        + json.dumps(items, ensure_ascii=False))

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
    if o and not o.get("skip") and o.get("intro"):
        l["personalized_intro"] = o["intro"]
        l["post_ref"] = o.get("post_ref", "")
        n += 1
    else:
        l["personalized_intro"] = ""
        l["post_ref"] = ""

json.dump(L, open("scripts/customoffice/data/leads_v3.json", "w"), ensure_ascii=False, indent=1)
print(f"personalized intros from real posts: {n}/{len(items)} pages with posts ({len(L)} leads total)")
for l in L:
    if l.get("personalized_intro"):
        print(f"\n[{l['company']}] ({l.get('post_ref')})\n  {l['personalized_intro']}")
