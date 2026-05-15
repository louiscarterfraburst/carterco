#!/usr/bin/env python3
"""Smoke test: call Anthropic with the exact prompt the OdaGroup
draft_first_message helper builds. No DB writes, no edge function deploy.
Just shows what Sonnet 4.6 produces for 4 synthetic leads (one per strategy)."""
import json
import os
import re
import sys
import urllib.request

# Load .env.local
env_path = "/Users/louiscarter/carterco/.env.local"
if os.path.exists(env_path):
    for line in open(env_path):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

API_KEY = os.environ.get("ANTHROPIC_API_KEY") or sys.exit("no ANTHROPIC_API_KEY")
MODEL = "claude-sonnet-4-6"

# Read the brief from the bundled TS const (between backticks)
brief_ts = open("/Users/louiscarter/carterco/supabase/functions/_shared/briefs/odagroup.ts").read()
m = re.search(r"String\.raw`([\s\S]*?)`;", brief_ts)
if not m:
    sys.exit("could not extract brief from odagroup.ts")
BRIEF = m.group(1).strip()

OWNER_FIRST = "Niels"

LEADS = [
    {"firstName":"Sarah","lastName":"Jones","title":"Veeva Product Owner","company":"Roche","country":"UK","linkedinUrl":"https://linkedin.com/in/sarah-jones-roche"},
    {"firstName":"Mette","lastName":"Larsen","title":"Commercial Excellence Director","company":"Novo Nordisk","country":"DK","linkedinUrl":"https://linkedin.com/in/mette-larsen-novo"},
    {"firstName":"James","lastName":"Patel","title":"GenAI Lead","company":"GSK","country":"UK","linkedinUrl":"https://linkedin.com/in/james-patel-gsk"},
    {"firstName":"Camille","lastName":"Martin","title":"Medical Affairs Director","company":"Sanofi","country":"FR","linkedinUrl":"https://linkedin.com/in/camille-martin-sanofi"},
    # Edge case: ambiguous title → fallback path
    {"firstName":"Anders","lastName":"Holm","title":"Director, Operations & Strategy","company":"Lundbeck","country":"DK","linkedinUrl":"https://linkedin.com/in/anders-holm"},
]

SYSTEM = "\n".join([
    f"You are drafting a first LinkedIn DM on behalf of {OWNER_FIRST} immediately after a connection request was accepted.",
    "",
    "Follow the brief below to the letter. Pick ONE strategy based on the prospect's title, write in the chosen language, and return ONLY a JSON object — no preamble, no code fences, no extra keys.",
    "",
    "=== AGENT BRIEF ===",
    BRIEF,
    "=== END BRIEF ===",
])

def draft(lead):
    user_prompt = "\n".join([
        "Draft the first message for this lead. Output the JSON envelope only.",
        "",
        "LEAD:",
        json.dumps(lead, indent=2),
    ])
    body = json.dumps({
        "model": MODEL,
        "max_tokens": 800,
        "system": SYSTEM,
        "messages": [{"role": "user", "content": user_prompt}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        method="POST",
        headers={
            "x-api-key": API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as f:
            data = json.loads(f.read())
    except urllib.error.HTTPError as e:
        return {"_error": f"HTTP {e.code}", "_raw": e.read().decode()[:1000]}
    raw = "".join(b.get("text","") for b in data.get("content",[]) if b.get("type")=="text").strip()
    j = re.search(r"\{[\s\S]*\}", raw)
    if not j:
        return {"_raw": raw, "_error": "no JSON found"}
    try:
        return json.loads(j.group(0))
    except Exception as e:
        return {"_raw": raw, "_error": f"parse failed: {e}"}

if __name__ == "__main__":
    for lead in LEADS:
        print("=" * 78)
        print(f"INPUT: {lead['firstName']} {lead['lastName']} — {lead['title']} @ {lead['company']} ({lead['country']})")
        print("-" * 78)
        env = draft(lead)
        if "_error" in env:
            print(f"ERROR: {env['_error']}")
            print(env.get("_raw","")[:500])
            continue
        print(f"strategy:  {env.get('strategy')}")
        print(f"language:  {env.get('language')}")
        print(f"rationale: {env.get('rationale')}")
        print(f"length:    {len(env.get('message','').split())} words")
        print()
        print(env.get("message",""))
        print()
