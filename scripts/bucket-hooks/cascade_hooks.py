#!/usr/bin/env python3
"""
Cascade hook generator — the WATERFALL (Step 1 redesign).

Becc's critique fix: instead of falling back to role mad-libs ("as a Sales
Director you struggle with...") when no post exists, cascade SIDEWAYS through
real signals until something specific and credible is found:

  Bucket 1/2  posts / activity        (Apify posts)
  Bucket 3    real headline / about / role line they WROTE   (Apify profile)
  Bucket 5    tenure, trajectory, certs, recommendations, awards  (Apify profile)
  -> floor    honest website line. NEVER role-projection.

A STRICT judge picks the single best signal that clears a specificity bar, or
returns 'floor' (we'd rather be plainly generic than dishonestly specific).

Run-only harness for quality iteration (does not write the pipeline).
Usage: python3 scripts/bucket-hooks/cascade_hooks.py [limit]
"""
import sys, json, time, urllib.request, urllib.parse
from generate_hooks import load_env, fetch_leads, slugof, fetch_posts  # noqa

ENV = load_env()
APIFY = ENV["APIFY_API_TOKEN"]
ANTHROPIC = ENV["ANTHROPIC_API_KEY"]
HAIKU = "claude-sonnet-4-6"
PROFILE_ACTOR = "harvestapi~linkedin-profile-scraper"

WEBSITE_FLOOR = "Jeg var lige inde på jeres side og optog en kort video om én ting, jeg tror I mister lidt værdi på:"

SYS = """You write the single opening LINE of a cold LinkedIn DM for Carter & Co. The DM carries a short personalized video. Sender: Louis, a Danish operator.

WHAT CARTER & CO DOES — the line MUST connect to this:
Louis builds and runs the system that catches inbound leads and acts before they go cold: instant response, calling/messaging leads while they're hot, follow-up that doesn't slip, so meetings don't get missed and pipeline doesn't wither. The pain he removes: leads cooling off, slow or missing response, follow-up falling through.

YOUR JOB: from the real signals below, pick the single best one and write ONE line that (a) reacts to it as a peer AND (b) bridges naturally into why Louis is reaching out — the speed / cooling-leads / follow-up problem. CONNECTION IS REQUIRED: if you could delete the line and the message still made sense, it FAILS. A decorative compliment that doesn't connect to the problem is wrong.

THE VOICE:
- LinkedIn, not email. A little lighter, warmer, shorter, more conversational than a cold email. A light question is fine. No "Dear", no formality, no pitch structure.
- Peer or looking-UP, NEVER a judge. Credit their experience and defer to it: "du ved bedre end mig...", "du kender X bedre end nogen...". Put the problem as something THEY already know, not something you are teaching them.
- BANNED (grading from above — reads as bedrevidende): "imponerende", "respekt for", "sjældent man ser", "stærkt", "flot", "godt gjort", "godt observeret", "dygtig". You are not their examiner.
- Do NOT lecture or explain their job back to them. Defer to their expertise, then let the shared problem do the work.
- VARY THE MOVE — this is critical. Do NOT begin most lines with "du ved bedre end..." or any single phrase. Read across 20 leads it would scream template. Rotate how you defer + connect: (a) a direct light question to them ("hvad gør I med de leads der lander fredag aften?"), (b) "det har du nok mærket...", (c) just state the bridge plainly, (d) only occasionally "du ved bedre end...". Never let one formula dominate.
- KEEP IT SHORT. Often one clause about them + the bridge. Max ~20 words. Shorter is better on LinkedIn.

EXAMPLES (note how each uses a DIFFERENT move):
  Bo (18 yrs auto-finance), plain bridge: "18 år i bilfinansiering, og opfølgningen er stadig der hvor de varme leads tabes:"
  Daniel (eMobility, charging subs), question: "Du kender ladebranchen — hvad sker der med de leads der lander mens sælgeren kører hjem fra Sønderborg?"
  Anja (EOR), "det har du nok mærket": "EOR sælges på timing — det har du nok mærket på hvad et langsomt svar koster:"

STRICT SIGNAL BAR:
- Use a real concrete particular: a post, a specific build/achievement, a real career move, something they wrote about themselves. NEVER their bare job title.
- If nothing real connects to the problem: {"bucket":"floor","hook":""}. We use a plain honest line. Never fake it.

FORMAT: one tight line, ends in a colon (:) that leads into the video. Danish for Danish prospects; their language only if they clearly write in another. No Danglish, no invented numbers.

Output ONLY JSON: {"hook":"...", "bucket":"1|2|3|5|floor", "signal":"the exact signal you used", "reasoning":"one short sentence"}"""


def fetch_profiles(urls):
    url = f"https://api.apify.com/v2/acts/{PROFILE_ACTOR}/run-sync-get-dataset-items?token={APIFY}"
    body = json.dumps({"queries": urls, "profileScraperMode": "Profile details no email ($4 per 1k)"}).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    arr = json.loads(urllib.request.urlopen(req, timeout=280).read())
    by = {}
    for it in arr if isinstance(arr, list) else []:
        if not isinstance(it, dict):
            continue
        s = slugof(it.get("linkedinUrl") or (it.get("originalQuery") or {}).get("query") or "")
        if s:
            by[s] = it
    return by


def extract_signals(profile, posts):
    """Build the candidate-signals block, grouped by bucket."""
    lines = []
    # Bucket 1/2 — posts / reposts
    if posts:
        lines.append("== Bucket 1/2 (their own posts / activity, <=90d) ==")
        for p in posts[:4]:
            lines.append(f"- [{'REPOST' if p['is_repost'] else 'POST'}, {p['age_days']}d] {p['text']}")
    if profile:
        # Bucket 3 — self-written
        hl = (profile.get("headline") or "").strip()
        about = (profile.get("about") or "").strip()
        if hl:
            lines.append(f"\n== Bucket 3 (self-written headline) ==\n- {hl}")
        if about:
            lines.append(f"\n== Bucket 3 (self-written About, excerpt) ==\n- {about[:600]}")
        # Bucket 5 — background
        exp = profile.get("experience") or []
        if exp:
            traj = []
            for e in exp[:5]:
                traj.append(f"{e.get('position','?')} @ {e.get('companyName','?')} ({e.get('duration','?')})")
            lines.append("\n== Bucket 5 (career trajectory / tenure) ==\n- " + "  |  ".join(traj))
        certs = [c.get("title") for c in (profile.get("certifications") or [])[:6] if c.get("title")]
        if certs:
            lines.append("\n== Bucket 5 (certifications) ==\n- " + ", ".join(certs))
        awards = [a.get("title") for a in (profile.get("honorsAndAwards") or [])[:4] if a.get("title")]
        if awards:
            lines.append("\n== Bucket 5 (awards) ==\n- " + ", ".join(awards))
        recs = profile.get("receivedRecommendations") or []
        if recs:
            r0 = recs[0]
            txt = (r0.get("text") or r0.get("description") or "")[:300] if isinstance(r0, dict) else str(r0)[:300]
            if txt:
                lines.append(f"\n== Bucket 5 (a recommendation written about them) ==\n- {txt}")
    if not lines:
        lines.append("(no signals found)")
    return "\n".join(lines)


def judge_write(name, title, company, signals_block):
    user = f"Prospect: {name} — {title} at {company}.\n\nCandidate signals:\n{signals_block}"
    body = json.dumps({"model": HAIKU, "max_tokens": 500, "system": SYS,
                       "messages": [{"role": "user", "content": user}]}).encode()
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body,
                                 headers={"Content-Type": "application/json", "x-api-key": ANTHROPIC, "anthropic-version": "2023-06-01"})
    resp = json.loads(urllib.request.urlopen(req, timeout=60).read())
    txt = "".join(b.get("text", "") for b in resp.get("content", []) if b.get("type") == "text").strip()
    s, e = txt.find("{"), txt.rfind("}")
    try:
        return json.loads(txt[s:e + 1])
    except Exception:
        return {"hook": "(parse-fail)", "bucket": "?", "signal": "", "reasoning": txt[:120]}


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 20
    print(f"Fetching {limit} accepted CarterCo leads...")
    leads = fetch_leads(limit)
    urls = [l["linkedin_url"] for l in leads]
    print(f"  {len(leads)} leads. Pulling posts + profiles (2 Apify runs)...")
    posts_by = fetch_posts(urls)
    profiles_by = fetch_profiles(urls)

    counts = {}
    print("\n" + "=" * 100)
    for l in leads:
        s = slugof(l["linkedin_url"])
        posts = posts_by.get(s, [])
        profile = profiles_by.get(s)
        sig = extract_signals(profile, posts)
        out = judge_write(f"{l.get('first_name','')} {l.get('last_name','')}".strip(),
                          l.get("title") or "?", l.get("company") or "?", sig)
        b = str(out.get("bucket", "?"))
        counts[b] = counts.get(b, 0) + 1
        hook = out.get("hook") or ""
        if b == "floor" or not hook.strip():
            hook = WEBSITE_FLOOR + "  [honest floor]"
        name = f"{l.get('first_name','')} {l.get('last_name','')}".strip()
        print(f"\n● {name}  —  {(l.get('title') or '')[:55]}")
        print(f"  bucket {b} | signal: {out.get('signal','')[:80]}")
        print(f"  HOOK: {hook}")
    print("\n" + "=" * 100)
    print("Bucket mix:", {k: counts[k] for k in sorted(counts)})


if __name__ == "__main__":
    main()
