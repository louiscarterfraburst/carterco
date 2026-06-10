"""Verify each Brave-found FB page against the scraped category + name, attach the
confirmed ones, and reconcile real website presence so we never falsely claim
'no website'. Writes leads_final.json.
"""
import json, re

LEADS = json.load(open("scripts/customoffice/data/leads.json"))
FB = [x for x in json.load(open("scripts/customoffice/data/fbpages_raw.json")) if not x.get("error")]

HAULIER = re.compile(r"transport|cargo|freight|moving|logistic|vognmand|truck|lastbil|"
                     r"local business|local service|community|recruiter|building material|"
                     r"product/service|maskinstation|entrepren", re.I)
REJECT = re.compile(r"hair|salon|restaurant|cafe|caf\b|spejder|scout|sport|beauty|church|"
                    r"\bvvs\b|plumb|fitness|musician|artist|politician", re.I)
GENERIC = {"vognmand", "vognmandsforretning", "transport", "logistics", "logistik", "fragt",
           "aps", "a/s", "i/s", "og", "søn", "sønner", "danmark", "service"}


def deacc(s):
    return (s or "").lower().replace("æ", "ae").replace("ø", "oe").replace("å", "aa")


def toks(*p):
    out = set()
    for x in p:
        for t in re.findall(r"[a-zæøå]{4,}", (x or "").lower()):
            if t not in GENERIC:
                out.add(deacc(t))
    return out


def keyid(u):
    m = re.search(r"(\d{6,})", u or "")
    if m:
        return m.group(1)
    m = re.search(r"facebook\.com/(?:p/|people/|pages/)?([^/?#]+)", u or "", re.I)
    return deacc(m.group(1)) if m else (u or "")


fb_by_key = {}
for x in FB:
    for u in (x.get("facebookUrl"), x.get("pageUrl")):
        if u:
            fb_by_key[keyid(u)] = x

confirmed = 0
for l in LEADS:
    fburl = l.get("fb_url")
    l["fb_status"] = "none"
    l["fb_category"] = l["fb_likes"] = l["fb_intro"] = l["fb_messenger"] = None
    rec = fb_by_key.get(keyid(fburl)) if fburl else None
    if rec:
        cats = " ".join(rec.get("categories") or []) + " " + (rec.get("title") or "")
        name_ok = bool(toks(l["company"], l.get("owner")) & toks(rec.get("title")))
        is_profile = "profile" in deacc(" ".join(rec.get("categories") or [])) or not rec.get("categories")
        if REJECT.search(cats) or not HAULIER.search(cats) or not name_ok:
            l["fb_url"] = None                 # reject wrong/unrelated page
            l["fb_status"] = "rejected"
        else:
            confirmed += 1
            l["fb_url"] = rec.get("pageUrl") or fburl
            l["fb_status"] = "confirmed"
            l["fb_category"] = (rec.get("categories") or [None, None])[-1]
            l["fb_likes"] = rec.get("likes")
            l["fb_intro"] = rec.get("intro")
            l["fb_messenger"] = rec.get("messenger")
            # reconcile website + phone from the FB page
            fbweb = rec.get("websites") or ([rec.get("website")] if rec.get("website") else [])
            if fbweb and not l.get("website"):
                l["website"] = fbweb[0]
            if not l.get("phone"):
                l["phone"] = rec.get("phone")
    else:
        if fburl:
            l["fb_status"] = "unscraped"   # likely a personal profile we couldn't read

    # recompute the no_website signal honestly: only if NO website found anywhere.
    # footprint-sourced leads that DO have a site keep a 'low_footprint' tag
    # (they had no website on their Google Business listing + are off LinkedIn).
    sigs = set(l["signals"])
    had_nowebsite = "no_website" in sigs
    if l.get("website"):
        sigs.discard("no_website")
        if had_nowebsite and "hiring_driver" not in sigs:
            sigs.add("low_footprint")
    l["signals"] = sorted(sigs)

json.dump(LEADS, open("scripts/customoffice/data/leads_final.json", "w"), ensure_ascii=False, indent=1)

from collections import Counter
print(f"FB confirmed: {confirmed}/50")
print("fb_status:", dict(Counter(l["fb_status"] for l in LEADS)))
print("signal mix:", dict(Counter("+".join(l["signals"]) or "(none)" for l in LEADS)))
print(f"truly no website (no site anywhere): {sum(1 for l in LEADS if 'no_website' in l['signals'])}")
print(f"has phone: {sum(1 for l in LEADS if l.get('phone'))}  | has owner: {sum(1 for l in LEADS if l.get('owner'))}  | has confirmed FB: {confirmed}")