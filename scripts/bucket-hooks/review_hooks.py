#!/usr/bin/env python3
"""
Review hooks WITH CONTEXT — for judging quality.

For each lead, cascade as usual but print the WINNING bucket's raw signal (the
premise the hook was built from) right next to the hook, so you can see whether
the overlap is real or a stretch.

Usage: python3 scripts/bucket-hooks/review_hooks.py [num_leads]   # default 6
"""
import sys
from generate_hooks import load_env, fetch_leads, slugof, fetch_posts, sb_get
from cascade_hooks import fetch_profiles
from waterfall_hooks import b1_block, b2_block, b3_block, b5_block, b6_block, write_line, apify, is_owner

ENV = load_env()
NAMES = {"1": "self-authored post", "2": "engaged (comment/like/share)",
         "3": "self-written profile", "5": "background", "6": "company"}


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
    print(f"Reviewing {len(leads)} leads WITH context (scraping)...")
    posts_by = fetch_posts(urls)
    profiles_by = fetch_profiles(urls)

    for l in leads:
        s = slugof(l["linkedin_url"])
        posts, profile = posts_by.get(s, []), profiles_by.get(s)
        cache = {}

        def block(b):
            if b == "1": return b1_block(posts)
            if b == "2":
                re = cache.setdefault("re", apify("harvestapi~linkedin-profile-reactions", {"profiles": [l["linkedin_url"]], "maxItems": 8}))
                co = cache.setdefault("co", apify("harvestapi~linkedin-profile-comments", {"profiles": [l["linkedin_url"]], "maxItems": 8}))
                return b2_block(re, posts, co)
            if b == "3": return b3_block(profile)
            if b == "5": return b5_block(profile)
            if b == "6": return b6_block((l.get("website") or "").strip())

        order = ["1", "2", "6", "3", "5"] if is_owner(l.get("title")) else ["1", "2", "3", "5", "6"]
        won = None
        for b in order:
            blk = block(b)
            if blk and (line := write_line(l, b, blk)):
                won = (b, blk, line)
                break

        nm = f"{l.get('first_name','')} {l.get('last_name','')}".strip()
        print("\n" + "═" * 96)
        print(f"{nm}  —  {(l.get('title') or '')[:60]}")
        print("═" * 96)
        if not won:
            print("  → FLOOR (intet ægte overlap fundet)")
            continue
        b, blk, line = won
        print(f"  BUCKET {b} ({NAMES.get(b, b)})")
        print(f"  CONTEXT (signalet den brugte):")
        for ln in blk.split("\n")[:6]:
            print(f"      {ln[:160]}")
        print(f"\n  HOOK:  {line}")


if __name__ == "__main__":
    main()
