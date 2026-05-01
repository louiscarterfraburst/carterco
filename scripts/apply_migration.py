#!/usr/bin/env python3
"""Apply a SQL migration file via the Supabase Management API.

Uses the Management API endpoint:
  POST https://api.supabase.com/v1/projects/{ref}/database/query

Required env:
  SUPABASE_ACCESS_TOKEN     personal access token (sbp_...) from
                            https://supabase.com/dashboard/account/tokens
  NEXT_PUBLIC_SUPABASE_URL  used to derive the project ref

Usage:
  python3 scripts/apply_migration.py supabase/test_leads.sql
"""
from __future__ import annotations
import json
import os
import re
import sys
import urllib.error
import urllib.request


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: apply_migration.py <path/to/migration.sql>")
    path = sys.argv[1]

    token = os.environ.get("SUPABASE_ACCESS_TOKEN")
    if not token:
        sys.exit(
            "SUPABASE_ACCESS_TOKEN must be set in .env.local — generate at "
            "https://supabase.com/dashboard/account/tokens"
        )

    url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    if not url:
        sys.exit("NEXT_PUBLIC_SUPABASE_URL must be set")
    m = re.match(r"https?://([a-z0-9]+)\.supabase\.co", url)
    if not m:
        sys.exit(f"could not derive project ref from {url}")
    project_ref = m.group(1)

    with open(path) as f:
        sql = f.read()

    print(f"Applying {path} → project {project_ref} ({len(sql)} chars)…", file=sys.stderr)

    payload = json.dumps({"query": sql}).encode()
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{project_ref}/database/query",
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "carterco-migration-runner/1.0",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as f:
            body = f.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        msg = e.read().decode("utf-8", errors="ignore")
        sys.exit(f"HTTP {e.code}: {msg}")

    print("OK.", file=sys.stderr)
    if body.strip() and body.strip() != "[]":
        print(body)


if __name__ == "__main__":
    main()
