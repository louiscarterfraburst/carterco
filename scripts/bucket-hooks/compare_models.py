#!/usr/bin/env python3
"""
Model bake-off: same evaluator-chosen angle, written by BOTH Sonnet and OpenAI,
side by side, so we can see which writes the better hook.

Usage: python3 scripts/bucket-hooks/compare_models.py [num_leads]   # default 6
"""
import sys, json, urllib.request
from generate_hooks import load_env, fetch_leads, slugof, fetch_posts, sb_get
from cascade_hooks import fetch_profiles, SYS  # SYS = the locked writer voice
from waterfall_hooks import apify, write_line  # write_line = Sonnet writer
from evaluator_hooks import build_candidates, evaluate

ENV = load_env()
OPENAI_KEY = ENV["OPENAI_API_KEY"]
OPENAI_MODEL = "gpt-4o"


def write_openai(lead, angle):
    user = (f"Prospect: {lead.get('first_name','')} {lead.get('last_name','')} — "
            f"{lead.get('title','')} at {lead.get('company','')}.\n\nCandidate signals:\n{angle}")
    body = json.dumps({"model": OPENAI_MODEL, "max_tokens": 400, "temperature": 0.7,
                       "messages": [{"role": "system", "content": SYS}, {"role": "user", "content": user}]}).encode()
    req = urllib.request.Request("https://api.openai.com/v1/chat/completions", data=body,
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + OPENAI_KEY})
    try:
        resp = json.loads(urllib.request.urlopen(req, timeout=60).read())
        txt = resp["choices"][0]["message"]["content"].strip()
        return json.loads(txt[txt.find("{"):txt.rfind("}") + 1]).get("hook", "") or "(empty)"
    except Exception as e:
        return f"(err: {str(e)[:80]})"


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 6
    leads = fetch_leads(n)
    import urllib.parse as up
    ems = [l["contact_email"] for l in leads if l.get("contact_email")]
    inl = "in.(" + ",".join('"' + e + '"' for e in ems) + ")"
    wsites = {w["contact_email"]: w.get("website") for w in
              sb_get("outreach_leads?select=contact_email,website&contact_email=" + up.quote(inl, safe=""))}
    for l in leads:
        l["website"] = wsites.get(l.get("contact_email"))
    urls = [l["linkedin_url"] for l in leads]
    print(f"Bake-off on {len(leads)} leads: Sonnet vs {OPENAI_MODEL} (same chosen angle)...")
    posts_by = fetch_posts(urls)
    profiles_by = fetch_profiles(urls)

    for l in leads:
        s = slugof(l["linkedin_url"])
        posts, profile = posts_by.get(s, []), profiles_by.get(s)
        react = apify("harvestapi~linkedin-profile-reactions", {"profiles": [l["linkedin_url"]], "maxItems": 8})
        com = apify("harvestapi~linkedin-profile-comments", {"profiles": [l["linkedin_url"]], "maxItems": 8})
        cands = build_candidates(posts, profile, react, com)
        ev = evaluate(l, cands) if cands else {"choice": "floor"}
        if str(ev.get("choice")) == "floor":
            cands = build_candidates(posts, profile, react, com, (l.get("website") or "").strip(), with_company=True)
            ev = evaluate(l, cands) if cands else ev

        nm = f"{l.get('first_name','')} {l.get('last_name','')}".strip()
        print("\n" + "═" * 96)
        print(f"{nm}  —  {(l.get('title') or '')[:55]}")
        print("═" * 96)
        ch = ev.get("choice")
        if not (isinstance(ch, int) or (isinstance(ch, str) and ch.isdigit())) or int(ch) >= len(cands):
            print(f"  → FLOOR  ({ev.get('why','')})")
            continue
        chosen = cands[int(ch)]
        agetag = f"{chosen['age']}d" if chosen["age"] is not None else "no date"
        angle = f"[CHOSEN ANGLE — bucket {chosen['b']}, {agetag}] {chosen['t']}\nWHY: {ev.get('why','')}"
        print(f"  ANGLE (bucket {chosen['b']}, {agetag}): {chosen['t'][:110]}")
        print(f"  SONNET:  {write_line(l, chosen['b'], angle)}")
        print(f"  OPENAI:  {write_openai(l, angle)}")


if __name__ == "__main__":
    main()
