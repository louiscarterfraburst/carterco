#!/usr/bin/env python3
"""Sync the OdaGroup AI brief from canonical .md → deploy mirror .ts.

Why this exists:
  Deno edge functions can't read repo files at runtime, so the brief in
  `clients/odagroup/agent-brief.md` is bundled into a String.raw constant
  inside `supabase/functions/_shared/draft-first-message.ts` at deploy time.
  Without this script, you edit the .md, redeploy, and silently nothing
  changes in production because the .ts mirror is what actually ships.

Usage:
  python3 scripts/sync_odagroup_brief.py            # sync .md → .ts
  python3 scripts/sync_odagroup_brief.py --check    # exit non-zero if drifted

Run --check in CI before any deploy of outreach-ai or sendpilot-webhook.
Run sync after any edit to the .md, then redeploy the two functions.
"""
import argparse
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MD_PATH = REPO / "clients" / "odagroup" / "agent-brief.md"
TS_PATH = REPO / "supabase" / "functions" / "_shared" / "draft-first-message.ts"

# Body boundary in the .md: everything from the first H2 onward. The H1 + lead
# paragraph above it are documentation for human readers, not for the agent.
BODY_START_RE = re.compile(r"^## 1\.", re.MULTILINE)

# String.raw block in the .ts — anchored on the unique const name so we don't
# accidentally match other String.raw uses if more get added.
TS_BLOCK_RE = re.compile(
    r"(const ODAGROUP_AGENT_BRIEF = String\.raw`)([\s\S]*?)(`;)",
    re.MULTILINE,
)


def extract_md_body() -> str:
    md = MD_PATH.read_text()
    m = BODY_START_RE.search(md)
    if not m:
        sys.exit(f"could not find '## 1.' section in {MD_PATH}")
    body = md[m.start():].rstrip() + "\n"
    return "\n" + escape_for_string_raw(body)


def escape_for_string_raw(text: str) -> str:
    """Escape characters that have special meaning inside a String.raw`...` template.

    String.raw treats backslashes as literal, so we don't escape `\\`. But two
    sequences would still terminate or interpolate the template literal:
      - `        → must become \\`     (backtick closes the template)
      - `${`     → must become \\${    (starts an interpolation)

    The .md uses backticks freely for inline code spans (e.g. `crm_platform`),
    so without escaping the bundle fails to parse with "Expression expected".
    """
    return text.replace("`", r"\`").replace("${", r"\${")


def current_ts_body() -> str:
    ts = TS_PATH.read_text()
    m = TS_BLOCK_RE.search(ts)
    if not m:
        sys.exit(f"could not find ODAGROUP_AGENT_BRIEF String.raw block in {TS_PATH}")
    return m.group(2)


def write_ts_body(new_body: str) -> None:
    ts = TS_PATH.read_text()
    new_ts = TS_BLOCK_RE.sub(
        lambda m: m.group(1) + new_body + m.group(3),
        ts,
        count=1,
    )
    TS_PATH.write_text(new_ts)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true",
                    help="exit non-zero if .md and .ts mirror are out of sync")
    args = ap.parse_args()

    md_body = extract_md_body()
    ts_body = current_ts_body()

    if md_body == ts_body:
        print(f"in sync ({len(md_body)} chars)")
        return 0

    if args.check:
        # Show a small hint about where they diverge.
        md_lines = md_body.splitlines()
        ts_lines = ts_body.splitlines()
        for i, (a, b) in enumerate(zip(md_lines, ts_lines)):
            if a != b:
                print(f"DRIFTED at line {i+1}:")
                print(f"  .md: {a!r}")
                print(f"  .ts: {b!r}")
                break
        else:
            print(f"DRIFTED (length: .md={len(md_body)}, .ts={len(ts_body)})")
        print()
        print("Run: python3 scripts/sync_odagroup_brief.py")
        print("Then redeploy outreach-ai and sendpilot-webhook.")
        return 1

    write_ts_body(md_body)
    print(f"synced .md → .ts ({len(md_body)} chars)")
    print("Now redeploy outreach-ai and sendpilot-webhook.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
