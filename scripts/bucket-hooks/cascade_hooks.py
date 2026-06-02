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

SYS = """You write the single opening LINE of a cold LinkedIn DM for Carter & Co. The DM carries a short personalized video. Sender: Louis, a Danish operator. The prospect is usually a Danish B2B sales / commercial leader.

THE CORE MECHANIC — CONNECT VIA OVERLAP.
The hook lives where a true thing about THEM meets a true thing about the PITCH. Method:
  a) From the signals below, take what is genuinely true about the prospect (their world, what they do, what they wrote/built).
  b) Below is what is true about Carter & Co's pitch.
  c) Find the strongest OVERLAP between (a) and (b), and write the line ON that overlap.
The overlap IS the connection — that is why the line passes the DELETE TEST: remove it and the link to the pitch is gone. A line that does not sit on an overlap is decorative and FAILS.
FLOOR ONLY AS A LAST RESORT. If you have a real, specific signal that plausibly connects to one of the pitch truths, WRITE the line — do NOT be precious about whether the overlap is "perfect." Reserve the empty-hook floor for: no real signal at all, bare title+tenure, or a connection that would have to be fabricated (a pun on nothing, a genuine stretch). A real signal that decently connects BEATS a floor; only a forced/fake overlap loses to a floor. When you have something concrete and it plausibly ties to the pitch, write it.

WHAT'S TRUE ABOUT THE PITCH (the overlap must hit one of these):
  - Inbound leads go cold fast; the first minutes after a lead lands decide whether it converts.
  - Carter & Co's system responds / calls / messages a new lead instantly, while it's hot — faster than a human would.
  - It catches the leads a busy team misses: after hours, weekends, while travelling, right after a conference or campaign.
  - Follow-up never slips — it nurtures every lead until they're ready, so none are forgotten.
  - Result: fewer missed meetings, pipeline that doesn't wither.
  - Louis builds and runs it himself — hands-on, no juniors.

So: line = [their specific truth] × [one pitch truth], expressed as one connected thought leading into the video.

THE STRICT BAR — what counts as a real "truth about them".
Only a concrete particular qualifies: a real post or comment, a topic they wrote about, a specific thing they built or did, a real move in their career, a named certification, a specific line they wrote about themselves, a real company event (funding, hiring, new office, launch).
REJECT (return an empty hook so we cascade or floor):
  - bare title + tenure ("11 år som Sales Director", "6 år som CSO") — a role template with a number; it overlaps with nothing specific.
  - their job title used to guess their pain.
  - anything generic that is true of anyone in that role.
  - anything that fails the delete test.
We would rather floor (a plain honest line) than send something fake-specific. Never invent a signal.

RECENCY MATTERS — huge difference between 1 day and 1 year. Each signal shows its age (e.g. [POST, 2d] = 2 days old). A fresh signal (days, up to ~2 weeks) is timely — you may anchor it in time naturally ("forleden", "i denne uge", "lige nu"). An older one (1-2 months) is NOT fresh — reference the TOPIC, never imply it just happened ("du var lige til..." about a 2-month-old event is wrong). Prefer the freshest signal when choosing. If everything is old, lean on their durable field/role/company rather than a stale moment.

THE VOICE.
- Peer, NEVER a judge. You are a younger operator who genuinely noticed something, not their examiner. Credit their experience, defer to it, put the problem as something THEY already know. Defer DOWN ("du kender det bedre end mig"), never up.
- BANNED grading words (they sound condescending / bedrevidende): imponerende, respekt for, sjældent man ser, stærkt, flot, godt gjort, godt observeret, dygtig, "du ved bedre end de fleste".
- Do NOT recite their facts back ("Så du byggede X", "I saw you did Y"). Reference, do not narrate.
- HOOK BY WORD-TWIST. Where you can, take 2-3 words from their own world/content and twist them into the cooling-leads problem (reorganize their phrase), instead of explaining. Their words, bent toward the pitch.
- DANISH-MODEST (Jante) but WITH SPINE. A Danish LinkedIn DM: understated, warm, a genuine light question is fine. Too confident reads as cocky — but do not over-hedge into wishy-washy. The target is QUIET CONFIDENCE IN THE OBSERVATION, HUMBLE IN TONE. Not every line a "jeg gætter på" guess; some may state the bridge with a little backbone while staying modest.
- VARY THE MOVE. No single phrase ("jeg gætter på", "du ved bedre end", "det er sjældent") may dominate. Rotate: a genuine question, "det har du nok mærket", "jeg tænker...", a plain modest-but-confident bridge, "mon ikke...".
- LinkedIn-light: warmer and shorter than a cold email. ~15-20 words, one clause about them + the bridge. End in a colon (:) that leads into the video.
- Language-matched: Danish for Danish prospects; their language only if they clearly post in another (e.g. Spanish). No Danglish.
- Never fabricate, never invent numbers or statistics.

EXAMPLES (each sits on an OVERLAP; each a different move; modest with spine):
  auto-finance × leads-cool: "18 år i bilfinansiering, og opfølgningen er stadig der hvor de varme leads tabes:"
  eMobility × after-hours: "Du kender ladebranchen — hvad sker der med de leads der lander efter fyraften?"
  EOR × timing: "EOR kører på timing — det har du nok mærket på hvad et langsomt svar koster:"
  their comment on networking × waiting-leads: "Din kommentar om netværk ramte noget — samme logik gælder de varme leads der lander og venter på svar:"

Output ONLY JSON: {"hook":"...", "lang":"da|en", "reasoning":"name the prospect-truth x pitch-truth overlap you used"}. An empty "hook" means nothing here overlaps the pitch — cascade."""


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
