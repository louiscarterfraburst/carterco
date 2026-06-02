#!/usr/bin/env python3
"""
Bucket-hook generator — STANDALONE TEST (Step 1).

Becc-Holland-style "buckets of personalization" applied to CarterCo's own
post-accept outbound. For each accepted CarterCo lead:
  1. Pull recent LinkedIn posts via Apify (harvestapi~linkedin-profile-posts).
  2. Keep only fresh (<=90d) posts = Bucket 1 (their post) / Bucket 2 (repost).
  3. Haiku writes the opening LINE of the video message, floor-up:
       Bucket 1/2 (credible fresh post) > Bucket 3 (role pain from title).
     The line replaces the generic "Jeg var lige inde på {website}..." middle
     line and must lead into {videoLink}.

This does NOT touch the pipeline. It prints what the engine would write so the
hooks can be judged before wiring schema/template/trigger.

Usage:
  python3 scripts/bucket-hooks/generate_hooks.py [limit]   # default 20
"""
import os, sys, json, time, urllib.request

CC_WS = "1e067f9a-d453-41a7-8bc4-9fdb5644a5fa"
POSTS_ACTOR = "harvestapi~linkedin-profile-posts"
HAIKU = "claude-haiku-4-5-20251001"
FRESH_DAYS = 90


def load_env(path=".env.local"):
    env = {}
    for line in open(path):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


ENV = load_env()
SB = ENV["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/")
SRK = ENV["SUPABASE_SERVICE_ROLE_KEY"]
APIFY = ENV["APIFY_API_TOKEN"]
ANTHROPIC = ENV["ANTHROPIC_API_KEY"]


def http_json(url, data=None, headers=None, timeout=280):
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, headers=h, method="POST" if data is not None else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def sb_get(path):
    return http_json(SB + "/rest/v1/" + path, headers={"apikey": SRK, "Authorization": "Bearer " + SRK})


def slugof(u):
    import re
    m = re.search(r"/in/([^/?]+)", u or "")
    return m.group(1).lower() if m else (u or "").lower()


def fetch_leads(limit):
    statuses = "(pending_pre_render,pending_alt_review,sent,pending_approval)"
    rows = sb_get(f"outreach_pipeline?select=contact_email&workspace_id=eq.{CC_WS}"
                  f"&status=in.{statuses}&order=updated_at.desc&limit={limit*3}")
    emails = [r["contact_email"] for r in rows if r.get("contact_email")]
    out, seen = [], set()
    # query leads one IN-batch via PostgREST
    import urllib.parse
    inlist = "in.(" + ",".join('"' + e + '"' for e in emails) + ")"
    q = "outreach_leads?select=contact_email,first_name,last_name,title,company,website,linkedin_url&contact_email=" + urllib.parse.quote(inlist, safe="")
    leads = sb_get(q)
    for l in leads:
        u = l.get("linkedin_url")
        if not u or u in seen:
            continue
        seen.add(u)
        out.append(l)
        if len(out) >= limit:
            break
    return out


def fetch_posts(urls):
    url = f"https://api.apify.com/v2/acts/{POSTS_ACTOR}/run-sync-get-dataset-items?token={APIFY}"
    arr = http_json(url, {"targetUrls": urls, "maxPosts": 6, "includeReposts": True, "includeQuotePosts": True})
    by = {slugof(u): [] for u in urls}
    now_ms = time.time() * 1000
    for it in arr if isinstance(arr, list) else []:
        if not isinstance(it, dict):
            continue
        q = it.get("query") or {}
        src = q.get("targetUrl") or q.get("url") or ""
        s = slugof(src)
        if s not in by:
            a = it.get("author") or {}
            s = slugof(a.get("linkedinUrl", ""))
        if s not in by:
            continue
        pa = it.get("postedAt") or {}
        ts = pa.get("timestamp")
        age = (now_ms - ts) / 86400000 if ts else 999
        if age > FRESH_DAYS:
            continue
        text = (it.get("content") or it.get("text") or "").strip()
        if not text:
            continue
        by[s].append({"text": text[:600], "age_days": round(age), "is_repost": bool(it.get("repost"))})
    return by


SYS_PROMPT = """You write the single opening LINE of a cold LinkedIn message for Carter & Co (sender: Louis, Denmark). The message carries a short personalized video. Your line REPLACES this generic line and must lead naturally into the video link that follows it:
"Jeg var lige inde på {website} og optog en kort video om én ting, jeg tror I mister lidt værdi på:"

HARD RULES:
- Write in the prospect's language (Danish for .dk / Danish names; otherwise English).
- Measured, direct operator voice. No hype, no emojis, no flattery, no buzzwords.
- NEVER fabricate. Only use the signals given. No "jeg så din demo / deltog i / elskede" claims.
- The line MUST end leading into the video, ending with a colon (:).
- 1-2 sentences, concrete.

PERSONALIZATION PRIORITY (use the HIGHEST bucket that has a credible signal):
  Bucket 1 = an ORIGINAL recent post the prospect wrote (reference as "dit opslag om ...").
  Bucket 2 = a REPOST the prospect shared (reference as "du delte ...").
  Bucket 3 = their ROLE — open from the pain their title actually owns.
DROP and never reference: job-search posts ("søger nyt job"), pure hiring posts, personal/humblebrag (marathons, holidays, anniversaries), anything not professionally substantive. If the only posts are those, fall to Bucket 3.

Output ONLY JSON, no fences:
{"hook": "...", "bucket": "1|2|3", "reasoning": "one short sentence", "language": "da|en"}"""


def make_hook(lead, posts):
    name = ((lead.get("first_name") or "") + " " + (lead.get("last_name") or "")).strip()
    title = lead.get("title") or "(unknown)"
    company = lead.get("company") or "(unknown)"
    lines = [f"Prospect: {name} — {title} at {company}."]
    if posts:
        lines.append("Recent posts (<=90 days):")
        for p in posts:
            kind = "REPOST" if p["is_repost"] else "ORIGINAL"
            lines.append(f"- [{kind}, {p['age_days']}d ago] {p['text']}")
    else:
        lines.append("No fresh posts found — use Bucket 3 (role).")
    user = "\n".join(lines)
    resp = http_json(
        "https://api.anthropic.com/v1/messages",
        {"model": HAIKU, "max_tokens": 500, "system": SYS_PROMPT,
         "messages": [{"role": "user", "content": user}]},
        headers={"x-api-key": ANTHROPIC, "anthropic-version": "2023-06-01"},
        timeout=60,
    )
    txt = "".join(b.get("text", "") for b in resp.get("content", []) if b.get("type") == "text").strip()
    s, e = txt.find("{"), txt.rfind("}")
    try:
        return json.loads(txt[s:e + 1])
    except Exception:
        return {"hook": "(parse-fail) " + txt[:120], "bucket": "?", "reasoning": "", "language": "?"}


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 20
    print(f"Fetching {limit} accepted CarterCo leads...")
    leads = fetch_leads(limit)
    print(f"  got {len(leads)} leads with LinkedIn URLs")
    print("Pulling posts (one Apify run)...")
    posts_by = fetch_posts([l["linkedin_url"] for l in leads])
    counts = {"1": 0, "2": 0, "3": 0, "?": 0}
    print("\n" + "=" * 100)
    for l in leads:
        posts = posts_by.get(slugof(l["linkedin_url"]), [])
        out = make_hook(l, posts)
        b = str(out.get("bucket", "?"))
        counts[b] = counts.get(b, 0) + 1
        name = ((l.get("first_name") or "") + " " + (l.get("last_name") or "")).strip()
        print(f"\n● {name}  —  {l.get('title','')[:60]}")
        print(f"  bucket {b} | {len(posts)} fresh post(s) | why: {out.get('reasoning','')}")
        print(f"  HOOK: {out.get('hook','')}")
    print("\n" + "=" * 100)
    print(f"Bucket mix: 1(post)={counts.get('1',0)}  2(repost)={counts.get('2',0)}  "
          f"3(role floor)={counts.get('3',0)}  unparsed={counts.get('?',0)}")


if __name__ == "__main__":
    main()
