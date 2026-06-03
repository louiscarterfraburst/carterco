#!/usr/bin/env python3
"""One-shot: draft replies for inbound question/interested replies that
don't have one yet. Mirrors outreach-ai/draft_reply's prompt locally because
edge-to-edge calls to outreach-ai are broken at the gateway (UNAUTHORIZED_
INVALID_JWT_FORMAT). Calls Claude Sonnet directly.

Env: ANTHROPIC_API_KEY, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL.

Usage:
  set -a; source .env.local; set +a
  python3 scripts/backfill_drafts_local.py [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

SB_URL = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SB_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
AN_KEY = os.environ["ANTHROPIC_API_KEY"]

SB_HEADERS = {
    "apikey": SB_KEY,
    "Authorization": f"Bearer {SB_KEY}",
    "Content-Type": "application/json",
}

MODEL = "claude-sonnet-4-6"


def sb_get(path: str) -> list:
    req = urllib.request.Request(f"{SB_URL}/rest/v1/{path}", headers=SB_HEADERS, method="GET")
    with urllib.request.urlopen(req, timeout=30) as f:
        return json.loads(f.read().decode())


def sb_patch(path: str, where: dict, payload: dict) -> None:
    q = "&".join(f"{k}=eq.{urllib.parse.quote(str(v))}" for k, v in where.items())
    req = urllib.request.Request(
        f"{SB_URL}/rest/v1/{path}?{q}",
        data=json.dumps(payload).encode(),
        headers={**SB_HEADERS, "Prefer": "return=minimal"},
        method="PATCH",
    )
    with urllib.request.urlopen(req, timeout=30) as f:
        f.read()


def claude_text(system: str, user: str, max_tokens: int = 400) -> str | None:
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps({
            "model": MODEL,
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        }).encode(),
        headers={
            "x-api-key": AN_KEY,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as f:
            d = json.loads(f.read().decode())
        blocks = d.get("content") or []
        text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text").strip()
        return text or None
    except urllib.error.HTTPError as e:
        print(f"  claude HTTP {e.code}: {e.read().decode()[:200]}", file=sys.stderr)
        return None


def build_prompt(reply: dict, playbook: dict, pipe: dict | None, lead: dict | None, thread: list) -> tuple[str, str]:
    owner = playbook.get("owner_first_name", "")
    value_prop = playbook.get("value_prop", "")
    guidelines = playbook.get("guidelines", "")
    cta = playbook.get("cta_preference", "soft_discovery")
    booking_link = playbook.get("booking_link") or "(missing)"

    if cta == "no_cta":
        cta_instr = "Do NOT push for a meeting, demo, or call. The vibe is collaborative — leave room for a low-friction next exchange."
    elif cta == "booking_link":
        cta_instr = f"When suggesting a next step, include the booking link: {booking_link}"
    else:
        cta_instr = (
            'Use soft-discovery framing — suggest informal exchange ("stikke hovederne sammen", '
            '"sig til hvis det giver mening"). Never aggressive close.'
        )

    system = "\n".join([
        f"You're drafting a LinkedIn reply on behalf of {owner}.",
        "",
        "## What we offer",
        value_prop,
        "",
        "## Voice — VERY IMPORTANT",
        (f"Your reference voice is {owner}'s OWN past outbound messages in the conversation history below. "
         f"Match that voice EXACTLY: same sentence length, same word choice, same level of formality, "
         f"same use of emoji (or lack of). Never sound more salesy or more corporate than {owner} actually writes."),
        "",
        "If no prior outbound exists in this thread (this is the first inbound reply to a fresh cold message), fall back to the guidelines below.",
        "",
        "## Match the prospect's tone",
        "- They wrote casually (emoji, contractions, joking) → match casual",
        "- They wrote formally → match more measured",
        "- They wrote terse → keep yours short",
        "- They wrote long → match length but stay concise",
        "Never sacrifice clarity for tone-matching.",
        "",
        f"## Guidelines specific to {owner}",
        guidelines,
        "",
        "## CTA preference",
        cta_instr,
        "",
        "## Output format",
        "- Plain Danish text, ready to paste into LinkedIn",
        '- No "Best regards", no "/"-signature, no "Bh," closing — SendPilot adds those',
        "- No <reasoning> tags, no preamble, no explanation",
        "- Just the message body",
    ])

    lines: list[str] = []
    lname = f"{lead.get('first_name') or '?'} {lead.get('last_name') or ''}".strip()
    lcomp = lead.get("company") or "?"
    ltitle = lead.get("title") or "?"
    lines.append(f"Lead: {lname} at {lcomp}, {ltitle}")
    lines.append("")
    if pipe and pipe.get("rendered_message"):
        lines.append(f"{owner}'s original outbound (the cold opener):")
        msg = pipe["rendered_message"].replace("\n", "\n> ")
        lines.append(f"> {msg}")
        lines.append("")
    if thread:
        lines.append("Conversation since then (chronological):")
        for m in thread:
            role = owner if m["direction"] == "outbound" else (lead.get("first_name") or "Prospect")
            lines.append(f"{role}: {m['message']}")
        lines.append("")
    lines.append(
        f'The prospect just sent the latest inbound reply above '
        f'(intent classified as "{reply.get("intent")}", '
        f'reasoning: "{reply.get("reasoning") or ""}").'
    )
    lines.append("")
    lines.append(f"Draft {owner}'s reply now. Plain text only.")
    user = "\n".join(lines)
    return system, user


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    # Pull all unhandled question/interested replies with no draft.
    rows = sb_get(
        "outreach_replies?select=id,sendpilot_lead_id,message,intent,reasoning,workspace_id"
        "&direction=eq.inbound&intent=in.(question,interested)&suggested_reply=is.null&handled=eq.false"
        "&order=received_at.desc"
    )
    print(f"Found {len(rows)} replies needing drafts.\n")

    for r in rows:
        print(f"— {r['id'][:8]} intent={r['intent']}")
        # workspace playbook
        pb_rows = sb_get(
            f"outreach_voice_playbooks?workspace_id=eq.{r['workspace_id']}&limit=1"
        )
        if not pb_rows:
            print("  no playbook for workspace, skip")
            continue
        playbook = pb_rows[0]

        # pipeline + lead
        pipe_rows = sb_get(
            f"outreach_pipeline?select=contact_email,rendered_message,referred_from_pipeline_lead_id"
            f"&sendpilot_lead_id=eq.{r['sendpilot_lead_id']}&limit=1"
        )
        pipe = pipe_rows[0] if pipe_rows else None
        lead = None
        if pipe and pipe.get("contact_email"):
            lead_rows = sb_get(
                f"outreach_leads?select=first_name,last_name,company,title,website"
                f"&contact_email=eq.{urllib.parse.quote(pipe['contact_email'])}&limit=1"
            )
            lead = lead_rows[0] if lead_rows else None

        # full thread chronological
        thread = sb_get(
            f"outreach_replies?select=direction,message,received_at"
            f"&sendpilot_lead_id=eq.{r['sendpilot_lead_id']}&order=received_at.asc"
        )

        system, user = build_prompt(r, playbook, pipe, lead, thread)

        if args.dry_run:
            print(f"  [dry-run] would draft for {r['id'][:8]}")
            continue

        draft = claude_text(system, user, max_tokens=400)
        if not draft:
            print(f"  draft failed")
            continue

        sb_patch(
            "outreach_replies",
            {"id": r["id"]},
            {
                "suggested_reply": draft,
                "suggested_reply_generated_at": datetime.now(timezone.utc).isoformat(),
            },
        )
        print(f"  + draft ({len(draft)} chars): {draft[:120]!r}")

    print("\nDone.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
