#!/usr/bin/env python3
"""
SEQUENTIAL waterfall hook generator (the real architecture).

accept -> Bucket 1 (posts) -> 2 (engaged) -> 3 (self-written) -> 5 (background)
       -> 6 (company) -> floor.  Stop at the FIRST bucket with a connected line.
Only scrape what isn't already scraped; cheapest/highest-priority first.

Harness: B1/B3/B5 are batch-prefetched (cheap, cover most); B2 + B6 are fetched
LAZILY per lead, only when the cascade reaches them. Same connected/peer/
LinkedIn-light voice we locked. Sonnet writes the line.

Usage: python3 scripts/bucket-hooks/waterfall_hooks.py [limit]
"""
import sys, json, time, urllib.request, urllib.parse
from generate_hooks import load_env, fetch_leads, slugof, fetch_posts
from cascade_hooks import SYS, fetch_profiles  # reuse locked voice + profile scrape

ENV = load_env()
APIFY = ENV["APIFY_API_TOKEN"]
ANTHROPIC = ENV["ANTHROPIC_API_KEY"]
SB = ENV["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/")
SRK = ENV["SUPABASE_SERVICE_ROLE_KEY"]
FIRECRAWL = ENV["FIRECRAWL_API"]
MODEL = "claude-sonnet-4-6"
WEBSITE_FLOOR = "Jeg var lige inde på jeres side og optog en kort video om én ting, jeg tror I mister lidt værdi på:"


def apify(actor, body, timeout=200):
    url = f"https://api.apify.com/v2/acts/{actor}/run-sync-get-dataset-items?token={APIFY}"
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=timeout).read())
    except Exception as e:
        print("   apify err", actor, e)
        return []


def write_line(lead, bucket, signals_block):
    """Ask Sonnet to write a connected line from THIS bucket's signals, or decline (floor)."""
    user = (f"Prospect: {lead.get('first_name','')} {lead.get('last_name','')} — "
            f"{lead.get('title','')} at {lead.get('company','')}.\n\n"
            f"Candidate signals (Bucket {bucket} only):\n{signals_block}\n\n"
            f"If nothing here is worth a CONNECTED line, return {{\"bucket\":\"floor\",\"hook\":\"\"}}.")
    body = json.dumps({"model": MODEL, "max_tokens": 400, "system": SYS,
                       "messages": [{"role": "user", "content": user}]}).encode()
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body,
                                 headers={"Content-Type": "application/json", "x-api-key": ANTHROPIC, "anthropic-version": "2023-06-01"})
    try:
        resp = json.loads(urllib.request.urlopen(req, timeout=60).read())
        txt = "".join(b.get("text", "") for b in resp.get("content", []) if b.get("type") == "text").strip()
        out = json.loads(txt[txt.find("{"):txt.rfind("}") + 1])
        hook = (out.get("hook") or "").strip()
        return hook if hook and str(out.get("bucket")) != "floor" else None
    except Exception:
        return None


# ---- per-bucket signal blocks ----
def b1_block(posts):
    own = [p for p in posts if not p["is_repost"]]
    if not own:
        return None
    return "\n".join(f"- [POST, {p['age_days']}d] {p['text']}" for p in own[:4])


def b2_block(reactions, posts):
    out = []
    for p in posts:
        if p["is_repost"]:
            out.append(f"- [SHARED/REPOST, {p['age_days']}d] {p['text']}")
    for r in (reactions or [])[:6]:
        t = r.get("text") or r.get("content") or (r.get("post") or {}).get("text") if isinstance(r, dict) else None
        act = r.get("action") or r.get("reactionType") or "engaged with" if isinstance(r, dict) else ""
        if t:
            out.append(f"- [{act}] {str(t)[:240]}")
    return "\n".join(out) if out else None


def b3_block(profile):
    if not profile:
        return None
    out = []
    if profile.get("headline"):
        out.append(f"- headline: {profile['headline']}")
    if profile.get("about"):
        out.append(f"- about (excerpt): {profile['about'][:600]}")
    cur = (profile.get("currentPosition") or [{}])[0]
    if cur.get("description"):
        out.append(f"- role description: {cur['description'][:300]}")
    return "\n".join(out) if out else None


def b5_block(profile):
    if not profile:
        return None
    out = []
    exp = profile.get("experience") or []
    if exp:
        out.append("- trajectory: " + "  |  ".join(
            f"{e.get('position','?')} @ {e.get('companyName','?')} ({e.get('duration','?')})" for e in exp[:5]))
    certs = [c.get("title") for c in (profile.get("certifications") or [])[:6] if c.get("title")]
    if certs:
        out.append("- certifications: " + ", ".join(certs))
    awards = [a.get("title") for a in (profile.get("honorsAndAwards") or [])[:4] if a.get("title")]
    if awards:
        out.append("- awards: " + ", ".join(awards))
    recs = profile.get("receivedRecommendations") or []
    if recs and isinstance(recs[0], dict):
        t = recs[0].get("text") or recs[0].get("description") or ""
        if t:
            out.append(f"- a recommendation about them: {t[:300]}")
    return "\n".join(out) if out else None


def b6_block(website):
    if not website:
        return None
    try:
        req = urllib.request.Request("https://api.firecrawl.dev/v1/scrape",
                                     data=json.dumps({"url": website, "formats": ["markdown"]}).encode(),
                                     headers={"Authorization": f"Bearer {FIRECRAWL}", "Content-Type": "application/json"})
        d = json.loads(urllib.request.urlopen(req, timeout=60).read())
        md = ((d.get("data") or {}).get("markdown") or "")[:1500]
        return f"- company site language:\n{md}" if md.strip() else None
    except Exception:
        return None


def waterfall(lead, posts, profile):
    """Sequential cascade. Returns (bucket, line). Lazy-fetches B2 + B6."""
    url = lead["linkedin_url"]
    # 1 — self-authored posts (prefetched)
    blk = b1_block(posts)
    if blk and (line := write_line(lead, 1, blk)):
        return "1", line
    # 2 — engaged (lazy: reactions actor)
    react = apify("harvestapi~linkedin-profile-reactions", {"queries": [url], "maxItems": 8})
    blk = b2_block(react, posts)
    if blk and (line := write_line(lead, 2, blk)):
        return "2", line
    # 3 — self-written (prefetched profile)
    blk = b3_block(profile)
    if blk and (line := write_line(lead, 3, blk)):
        return "3", line
    # 5 — background (same profile, no new scrape)
    blk = b5_block(profile)
    if blk and (line := write_line(lead, 5, blk)):
        return "5", line
    # 6 — company (lazy: Firecrawl)
    blk = b6_block((lead.get("website") or "").strip())
    if blk and (line := write_line(lead, 6, blk)):
        return "6", line
    return "floor", WEBSITE_FLOOR


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 20
    print(f"Fetching {limit} leads...")
    leads = fetch_leads(limit)
    # attach website
    import urllib.parse as up
    ems = [l["contact_email"] for l in leads if l.get("contact_email")]
    inl = "in.(" + ",".join('"' + e + '"' for e in ems) + ")"
    from generate_hooks import sb_get
    wsites = {w["contact_email"]: w.get("website") for w in
              sb_get("outreach_leads?select=contact_email,website&contact_email=" + up.quote(inl, safe=""))}
    for l in leads:
        l["website"] = wsites.get(l.get("contact_email"))
    urls = [l["linkedin_url"] for l in leads]
    print("  prefetch posts + profiles (B1/B3/B5)...")
    posts_by = fetch_posts(urls)
    profiles_by = fetch_profiles(urls)

    counts = {}
    print("\n" + "=" * 100)
    for l in leads:
        s = slugof(l["linkedin_url"])
        bucket, line = waterfall(l, posts_by.get(s, []), profiles_by.get(s))
        counts[bucket] = counts.get(bucket, 0) + 1
        nm = f"{l.get('first_name','')} {l.get('last_name','')}".strip()
        tag = "  [floor]" if bucket == "floor" else ""
        print(f"\n● {nm}  (stop @ bucket {bucket}){tag}")
        print(f"  {line}")
    print("\n" + "=" * 100)
    print("Stop-bucket distribution:", {k: counts[k] for k in sorted(counts)})


if __name__ == "__main__":
    main()
