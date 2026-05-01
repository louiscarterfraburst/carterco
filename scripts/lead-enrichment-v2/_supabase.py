"""Tiny Supabase client. PostgREST over HTTP, service-role auth.

We avoid the supabase-py SDK on purpose — it pulls in httpx, gotrue,
postgrest, etc. Single-file stdlib client keeps deps minimal.
"""
from __future__ import annotations
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get(
    "SUPABASE_URL"
)
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SERVICE_KEY:
    sys.exit(
        "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local"
    )

REST = SUPABASE_URL.rstrip("/") + "/rest/v1"


def _headers(prefer: str = "") -> dict[str, str]:
    h = {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }
    if prefer:
        h["Prefer"] = prefer
    return h


def _request(method: str, path: str, body: Any = None, prefer: str = "") -> Any:
    url = f"{REST}/{path.lstrip('/')}"
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method, headers=_headers(prefer))
    try:
        with urllib.request.urlopen(req, timeout=60) as f:
            raw = f.read().decode("utf-8") or "[]"
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        msg = e.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"{method} {path} → {e.code}: {msg[:500]}")


def upsert(table: str, rows: list[dict], on_conflict: str = "") -> None:
    """Bulk upsert. Splits into chunks of 500."""
    qs = f"?on_conflict={on_conflict}" if on_conflict else ""
    for i in range(0, len(rows), 500):
        chunk = rows[i : i + 500]
        _request(
            "POST",
            f"{table}{qs}",
            chunk,
            prefer="resolution=merge-duplicates,return=minimal",
        )


def select(table: str, query: str = "") -> list[dict]:
    return _request("GET", f"{table}?{query}") or []


def update(table: str, where: str, patch: dict) -> None:
    _request("PATCH", f"{table}?{where}", patch, prefer="return=minimal")


def count(table: str, query: str = "") -> int:
    """Use HEAD with Prefer: count=exact."""
    url = f"{REST}/{table}?{query}&select=linkedin_url"
    req = urllib.request.Request(
        url,
        method="HEAD",
        headers={
            **_headers("count=exact"),
            "Range-Unit": "items",
            "Range": "0-0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as f:
            cr = f.headers.get("Content-Range", "")
            # Format: "0-0/N" or "*/N"
            if "/" in cr:
                return int(cr.split("/")[-1])
            return 0
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HEAD {table} → {e.code}: {e.read().decode()[:300]}")
