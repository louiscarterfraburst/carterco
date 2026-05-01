"""Tiny Supabase REST client (shared with lead-enrichment-v2). Service-role auth."""
from __future__ import annotations
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
if not SUPABASE_URL or not SERVICE_KEY:
    sys.exit("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")

REST = SUPABASE_URL.rstrip("/") + "/rest/v1"


def _headers(prefer: str = "", count: bool = False) -> dict[str, str]:
    h = {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
    }
    if prefer:
        h["Prefer"] = prefer
    if count:
        h["Prefer"] = (h.get("Prefer", "") + ",count=exact").lstrip(",")
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
    qs = f"?on_conflict={on_conflict}" if on_conflict else ""
    for i in range(0, len(rows), 500):
        chunk = rows[i : i + 500]
        _request("POST", f"{table}{qs}", chunk,
                 prefer="resolution=merge-duplicates,return=minimal")


def insert(table: str, rows: list[dict]) -> list[dict]:
    return _request("POST", table, rows, prefer="return=representation") or []


def select(table: str, query: str = "") -> list[dict]:
    """Single-page select. Use select_paged for >1000 rows."""
    return _request("GET", f"{table}?{query}") or []


def select_paged(table: str, query: str = "", page_size: int = 1000) -> list[dict]:
    """Paginate past Supabase's implicit 1000-row cap via offset."""
    out: list[dict] = []
    offset = 0
    while True:
        q = f"{query}&limit={page_size}&offset={offset}" if query else f"limit={page_size}&offset={offset}"
        page = _request("GET", f"{table}?{q}") or []
        out.extend(page)
        if len(page) < page_size:
            break
        offset += page_size
    return out


def update(table: str, where: str, patch: dict) -> None:
    _request("PATCH", f"{table}?{where}", patch, prefer="return=minimal")
