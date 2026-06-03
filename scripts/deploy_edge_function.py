#!/usr/bin/env python3
"""Deploy a single Supabase edge function via the Management API. Reads source
from disk and posts a multipart upload. Avoids needing the supabase CLI.

Usage:
  set -a; source .env.local; set +a
  python3 scripts/deploy_edge_function.py <slug> <entry_relpath> <verify_jwt> <file1>[ <file2>...]

Example:
  python3 scripts/deploy_edge_function.py outreach-ai \
    supabase/functions/outreach-ai/index.ts true \
    supabase/functions/outreach-ai/index.ts \
    supabase/functions/_shared/draft-first-message.ts \
    supabase/functions/_shared/workspaces.ts

The first file MUST be the entrypoint. <entry_relpath> is the same path; we
strip the leading `supabase/` to produce the bundle name (`functions/...`).
"""
import json
import mimetypes
import os
import sys
import uuid

import urllib.request
import urllib.error

PROJECT_REF = "znpaevzwlcfuzqxsbyie"
TOKEN = os.environ.get("SUPABASE_ACCESS_TOKEN") or sys.exit("SUPABASE_ACCESS_TOKEN required")


def bundle_name(local_path: str) -> str:
    # supabase/functions/foo/index.ts -> functions/foo/index.ts
    if local_path.startswith("supabase/"):
        return local_path[len("supabase/"):]
    return local_path


def build_multipart(meta: dict, files: list[tuple[str, str, bytes]]) -> tuple[bytes, str]:
    boundary = "----CarterCo" + uuid.uuid4().hex
    crlf = b"\r\n"
    parts: list[bytes] = []

    # metadata as JSON
    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n".encode()
        + json.dumps(meta).encode()
        + crlf
    )

    # each file as form field "file"
    for field_name, bundle_path, content in files:
        ctype = mimetypes.guess_type(bundle_path)[0] or "application/typescript"
        header = (
            f"--{boundary}\r\n"
            f"Content-Disposition: form-data; name=\"{field_name}\"; filename=\"{bundle_path}\"\r\n"
            f"Content-Type: {ctype}\r\n\r\n"
        ).encode()
        parts.append(header + content + crlf)

    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def main() -> int:
    if len(sys.argv) < 5:
        print(__doc__)
        return 2
    slug = sys.argv[1]
    entry_relpath = sys.argv[2]
    verify_jwt = sys.argv[3].lower() in ("true", "1", "yes")
    file_paths = sys.argv[4:]

    if entry_relpath != file_paths[0]:
        print(f"WARN: entrypoint {entry_relpath} not first in files list", file=sys.stderr)

    meta = {
        "entrypoint_path": bundle_name(entry_relpath),
        "name": slug,
        "verify_jwt": verify_jwt,
    }
    files = []
    for fp in file_paths:
        with open(fp, "rb") as f:
            content = f.read()
        files.append(("file", bundle_name(fp), content))

    body, ctype = build_multipart(meta, files)

    url = f"https://api.supabase.com/v1/projects/{PROJECT_REF}/functions/deploy?slug={slug}"
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": ctype,
            "User-Agent": "supabase-cli/1.0 (carterco)",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            print(f"deploy {slug} → {resp.status}")
            print(resp.read().decode()[:500])
    except urllib.error.HTTPError as e:
        body_txt = e.read().decode()[:800]
        print(f"deploy {slug} → HTTP {e.code}", file=sys.stderr)
        print(body_txt, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
