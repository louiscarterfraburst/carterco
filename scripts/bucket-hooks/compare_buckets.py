#!/usr/bin/env python3
"""
Bucket head-to-head. For a few leads, generate a line from EVERY bucket that has
a signal (not stop-early) and print them side by side, so we can see which bucket
gives the strongest line and sanity-check the priority order + the strict bar.

Usage: python3 scripts/bucket-hooks/compare_buckets.py [num_leads]   # default 5
"""
import sys
from generate_hooks import load_env, fetch_leads, slugof, fetch_posts, sb_get
from cascade_hooks import fetch_profiles
from waterfall_hooks import b1_block, b2_block, b3_block, b5_block, b6_block, write_line, apify

ENV = load_env()


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    leads = fetch_leads(n)
    import urllib.parse as up
    ems = [l["contact_email"] for l in leads if l.get("contact_email")]
    inl = "in.(" + ",".join('"' + e + '"' for e in ems) + ")"
    wsites = {w["contact_email"]: w.get("website") for w in
              sb_get("outreach_leads?select=contact_email,website&contact_email=" + up.quote(inl, safe=""))}
    for l in leads:
        l["website"] = wsites.get(l.get("contact_email"))
    urls = [l["linkedin_url"] for l in leads]
    print(f"Comparing {len(leads)} leads across all buckets (scraping everything)...")
    posts_by = fetch_posts(urls)
    profiles_by = fetch_profiles(urls)

    for l in leads:
        s = slugof(l["linkedin_url"])
        posts = posts_by.get(s, [])
        profile = profiles_by.get(s)
        reactions = apify("harvestapi~linkedin-profile-reactions", {"profiles": [l["linkedin_url"]], "maxItems": 8})
        blocks = {
            "1 self-authored": b1_block(posts),
            "2 engaged":       b2_block(reactions, posts),
            "3 self-written":  b3_block(profile),
            "5 background":    b5_block(profile),
            "6 company":       b6_block((l.get("website") or "").strip()),
        }
        nm = f"{l.get('first_name','')} {l.get('last_name','')}".strip()
        print("\n" + "=" * 96)
        print(f"{nm}  —  {(l.get('title') or '')[:60]}")
        print("=" * 96)
        for label, blk in blocks.items():
            if not blk:
                print(f"  [{label}]  — intet signal")
                continue
            line = write_line(l, label, blk)
            print(f"  [{label}]  {line if line else '(afvist af baren → cascade)'}")


if __name__ == "__main__":
    main()
