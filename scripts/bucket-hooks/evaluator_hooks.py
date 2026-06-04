#!/usr/bin/env python3
"""
TWO-LAYER hook generator: evaluator picks the best angle, writer writes it.

  scrape cheap LinkedIn sources (posts + profile + reactions + comments)
        -> build ALL candidate angles (bucket + age + text)
  LAYER 1  EVALUATOR (LLM): score each on overlap × freshness × reader-
        recognizability × specificity; pick the single best, or floor.
        (if floor: scrape company B6, add candidates, evaluate again)
  LAYER 2  WRITER (LLM): write the hook from the chosen angle (voice rules).

Fixes the "writer drifts to a weaker/staler angle" problem (Dennis' book vs
Salone; Bo's PISTA like vs generic).

Usage: python3 scripts/bucket-hooks/evaluator_hooks.py [num_leads]   # default 8
"""
import sys, json, os, urllib.request, urllib.parse
from generate_hooks import load_env, fetch_leads, slugof, fetch_posts, sb_get
from cascade_hooks import fetch_profiles
from waterfall_hooks import write_line, apify, _age_days, b6_block

ENV = load_env()
ANTHROPIC = ENV["ANTHROPIC_API_KEY"]
EVAL_MODEL = "claude-sonnet-4-6"

# ---- web research (what a human does: google the person + the company) ----
BRAVE_KEY = os.environ.get("BRAVE_SEARCH_API_KEY") or ENV.get("BRAVE_SEARCH_API_KEY")
SKIP_HOSTS = ["linkedin.com", "facebook.com", "instagram.com", "twitter.com", "x.com",
              "youtube.com", "greens.dk", "bizz.dk", "proff.dk", "krak.dk", "wikipedia.org", "cvr.dk", "virk.dk",
              "zoominfo.com", "rocketreach.co", "apollo.io", "tracxn.com", "lusha.com", "contactout.com",
              "signalhire.com", "leadiq.com", "theorg.com", "cambridge.org", "dictionary.com",
              "collinsdictionary.com", "merriam-webster.com", "glassdoor.com", "indeed.com", "prospeo.io"]


def web_queries(first, last, company):
    """Strip legal suffix + EXACT-quote the company (bare generic-word names like
    'VOCAST'/'BusySunday' otherwise return dictionary/namesake junk).
    Returns (person_query, company_query) or (None, None) if no company."""
    import re
    clean = re.sub(r"\s+(a/s|aps|ivs|p/s|k/s|inc|llc|ltd|gmbh)\.?$", "", company, flags=re.I).strip()
    if not clean:
        return None, None
    name = f"{first} {last}".strip()
    return (f'"{name}" "{clean}"', f'"{clean}"')


def web_search(query, count=5, freshness=None):
    """Brave Search -> [{title,url,description}]. [] on any failure (best-effort)."""
    if not BRAVE_KEY or not query.strip():
        return []
    p = {"q": query, "count": count}
    if freshness:
        p["freshness"] = freshness
    req = urllib.request.Request(
        "https://api.search.brave.com/res/v1/web/search?" + urllib.parse.urlencode(p),
        headers={"Accept": "application/json", "X-Subscription-Token": BRAVE_KEY})
    try:
        body = json.loads(urllib.request.urlopen(req, timeout=20).read().decode())
    except Exception:
        return []
    web = (body.get("web") or {}).get("results") or []
    return [{"title": r.get("title") or "", "url": r.get("url") or "", "description": r.get("description") or ""}
            for r in web if (r.get("title") or r.get("description"))]


def _host(url):
    try:
        hn = urllib.parse.urlparse(url).hostname or ""
        return hn[4:] if hn.startswith("www.") else hn
    except Exception:
        return ""


def skip_host(url, own_domain=None):
    h = _host(url)
    if not h:
        return True
    if own_domain and (h == own_domain or h.endswith("." + own_domain)):
        return True
    return any(h == s or h.endswith("." + s) for s in SKIP_HOSTS)


def domain_of(website):
    if not website:
        return None
    try:
        u = website if website.startswith("http") else "http://" + website
        hn = urllib.parse.urlparse(u).hostname
        return (hn[4:] if hn and hn.startswith("www.") else hn) or None
    except Exception:
        return None

EVAL_SYS = """You are the ANGLE EVALUATOR for Carter & Co's cold LinkedIn outreach. You get a numbered list of candidate signals about ONE prospect (each tagged with bucket + age). Pick the SINGLE best angle to build a personalized opening line on — or decline (floor).

WHAT CARTER & CO PITCHES (the line will connect to one of these):
- inbound leads go cold fast; the first minutes after a lead lands decide it
- a system that responds/calls/messages a new lead instantly, while it's hot
- it catches the leads a busy team misses: after hours, weekends, travel, post-conference
- follow-up that never slips; nurtures every lead until ready
- fewer missed meetings, pipeline that doesn't wither

SCORE each candidate on:
1. OVERLAP — how strongly can you connect THIS signal to the pitch (cooling leads / speed / follow-up)? Could you write a line where deleting it breaks the message? Strong overlap > weak.
2. FRESHNESS — newer is much better. 0-3 days = timely; ~2 weeks = recent; 1-2 months = stale. Prefer fresh; a stale signal loses to a fresh one.
3. READER-RECOGNIZABILITY — would the prospect INSTANTLY recognize it as theirs (their own post, their company, a named event) vs something oblique they'd strain to recall (a fleeting like of someone else's post, a generic role line)?
4. SPECIFICITY — a concrete particular, not bare title/tenure.

REJECT a candidate outright if: bare title + tenure ("X years as Sales Director"), generic-to-anyone, a like/repost of someone ELSE's post that isn't clearly the prospect's own view, or no real overlap with the pitch.

WEB SIGNALS (bucket 6 "company news (web…)" and bucket 7 "web/press about them") come from googling the person + company — press, interviews, podcasts, talks, funding/hiring/launch news. A clearly-about-THEM web hit with real overlap is strong and recognizable (recent company news especially). But REJECT a web hit if: it could be a NAMESAKE (a different person with the same name — when in doubt, reject), it's a generic directory/aggregator/profile page, or it's a stale fact dressed as news. Only pick a web signal you'd bet is genuinely about this exact prospect/company.

Pick the ONE best overall (a fresh, recognizable, strongly-overlapping own-post usually beats a stale or oblique one). If NOTHING clears the bar, choose floor.

Output ONLY JSON: {"choice": <the [index] number, or "floor">, "why": "one line: the overlap + why this beat the others (freshness / recognizability)"}"""


def anthropic_json(system, user, model=EVAL_MODEL):
    body = json.dumps({"model": model, "max_tokens": 400, "system": system,
                       "messages": [{"role": "user", "content": user}]}).encode()
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body,
                                 headers={"Content-Type": "application/json", "x-api-key": ANTHROPIC, "anthropic-version": "2023-06-01"})
    txt = "".join(b.get("text", "") for b in json.loads(urllib.request.urlopen(req, timeout=60).read()).get("content", []) if b.get("type") == "text").strip()
    try:
        return json.loads(txt[txt.find("{"):txt.rfind("}") + 1])
    except Exception:
        return {"choice": "floor", "why": "parse-fail"}


def build_candidates(posts, profile, reactions, comments, website=None, with_company=False,
                     person_web=None, company_web=None, own_domain=None):
    c = []
    for p in sorted([p for p in posts if not p["is_repost"]], key=lambda x: x["age_days"])[:5]:
        c.append({"b": "1", "age": p["age_days"], "t": "own post: " + p["text"][:400]})
    for cm in (comments or []):
        if isinstance(cm, dict) and (cm.get("commentary") or "").strip():
            age = _age_days(cm.get("createdAtTimestamp"))
            if age <= 90:
                on = ((cm.get("post") or {}).get("content") or "")[:80]
                c.append({"b": "2", "age": age, "t": f'their comment: "{cm["commentary"][:200]}" (under a post about: {on})'})
    for r in (reactions or []):
        if isinstance(r, dict):
            liked = ((r.get("post") or {}).get("content") or "")
            age = _age_days(r.get("createdAtTimestamp"))
            if liked and age <= 90:
                c.append({"b": "2", "age": age, "t": f"liked someone's post: {liked[:200]}"})
    for p in posts:
        if p["is_repost"]:
            c.append({"b": "2", "age": p["age_days"], "t": "shared/reposted: " + p["text"][:200]})
    if profile:
        if profile.get("headline"):
            c.append({"b": "3", "age": None, "t": "their headline: " + profile["headline"][:200]})
        if profile.get("about"):
            c.append({"b": "3", "age": None, "t": "their About: " + profile["about"][:400]})
        cur = (profile.get("currentPosition") or [{}])[0]
        if cur.get("description"):
            c.append({"b": "3", "age": None, "t": "their role description: " + cur["description"][:300]})
        exp = profile.get("experience") or []
        if exp:
            c.append({"b": "5", "age": None, "t": "career: " + "  |  ".join(f"{e.get('position','?')} @ {e.get('companyName','?')} ({e.get('duration','?')})" for e in exp[:5])})
        certs = [x.get("title") for x in (profile.get("certifications") or [])[:6] if x.get("title")]
        if certs:
            c.append({"b": "5", "age": None, "t": "certifications: " + ", ".join(certs)})
    if with_company and website:
        blk = b6_block(website)
        if blk:
            c.append({"b": "6", "age": None, "t": "company site: " + blk[:500]})
    # B6 (web) — external company news; B7 — press / web mention of the person
    for h in (company_web or []):
        if skip_host(h["url"], own_domain):
            continue
        c.append({"b": "6", "age": None, "t": (f"company news (web, past yr): {h['title']} — {h['description']}")[:400]})
    for h in (person_web or []):
        if skip_host(h["url"], own_domain):
            continue
        c.append({"b": "7", "age": None, "t": (f"web/press about them: {h['title']} — {h['description']}")[:400]})
    return c


def evaluate(lead, cands):
    listing = "\n".join(f"[{i}] (bucket {c['b']}, {('age ' + str(c['age']) + 'd') if c['age'] is not None else 'no date'}) {c['t']}" for i, c in enumerate(cands))
    user = f"Prospect: {lead.get('first_name','')} {lead.get('last_name','')} — {lead.get('title','')} at {lead.get('company','')}.\n\nCandidates:\n{listing}"
    return anthropic_json(EVAL_SYS, user)


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 8
    leads = fetch_leads(n)
    import urllib.parse as up
    ems = [l["contact_email"] for l in leads if l.get("contact_email")]
    inl = "in.(" + ",".join('"' + e + '"' for e in ems) + ")"
    wsites = {w["contact_email"]: w.get("website") for w in
              sb_get("outreach_leads?select=contact_email,website&contact_email=" + up.quote(inl, safe=""))}
    for l in leads:
        l["website"] = wsites.get(l.get("contact_email"))
    urls = [l["linkedin_url"] for l in leads]
    print(f"Two-layer on {len(leads)} leads (scrape -> evaluate -> write)...")
    posts_by = fetch_posts(urls)
    profiles_by = fetch_profiles(urls)

    for l in leads:
        s = slugof(l["linkedin_url"])
        posts, profile = posts_by.get(s, []), profiles_by.get(s)
        react = apify("harvestapi~linkedin-profile-reactions", {"profiles": [l["linkedin_url"]], "maxItems": 8})
        com = apify("harvestapi~linkedin-profile-comments", {"profiles": [l["linkedin_url"]], "maxItems": 8})
        cands = build_candidates(posts, profile, react, com)
        ev = evaluate(l, cands) if cands else {"choice": "floor", "why": "no signals"}
        # floor on cheap sources -> add company, evaluate again
        if str(ev.get("choice")) == "floor":
            cands = build_candidates(posts, profile, react, com, (l.get("website") or "").strip(), with_company=True)
            ev = evaluate(l, cands) if cands else ev

        nm = f"{l.get('first_name','')} {l.get('last_name','')}".strip()
        print("\n" + "═" * 96)
        print(f"{nm}  —  {(l.get('title') or '')[:55]}")
        print("═" * 96)
        ch = ev.get("choice")
        if str(ch) == "floor" or not isinstance(ch, int) and not (isinstance(ch, str) and ch.isdigit()):
            print(f"  → FLOOR  ({ev.get('why','')})")
            continue
        idx = int(ch)
        if idx >= len(cands):
            print("  → FLOOR (bad index)")
            continue
        chosen = cands[idx]
        agetag = f"{chosen['age']}d" if chosen["age"] is not None else "no date"
        angle = f"[CHOSEN ANGLE — bucket {chosen['b']}, {agetag}] {chosen['t']}\nWHY: {ev.get('why','')}"
        hook = write_line(l, chosen["b"], angle)
        print(f"  EVALUATOR picked bucket {chosen['b']} ({agetag}): {ev.get('why','')}")
        print(f"  ANGLE: {chosen['t'][:120]}")
        print(f"  HOOK:  {hook}")


if __name__ == "__main__":
    main()
