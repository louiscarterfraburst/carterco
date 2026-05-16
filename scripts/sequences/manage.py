#!/usr/bin/env python3
"""Manage workspace-scoped follow-up sequences in `outreach_sequences`.

Why this exists:
  The engine reads sequences from the `outreach_sequences` DB table — see
  `clients/README.md` → "Per-workspace sequence overrides". Editing that
  table by hand-writing JSON in raw SQL is the documented path but it has
  no validation; a `wait_hours` typo (instead of `waitHours`) silently
  freezes leads. This CLI wraps the table with:

    - schema validation against the SequenceStep shape
    - workspace lookup by slug ("odagroup") instead of UUID
    - "show me the diff before applying" + y/n confirmation
    - obvious failure messages when something's wrong

Auth:
  Uses `SUPABASE_SERVICE_ROLE_KEY` from `.env.local` (auto-loaded). The
  service role bypasses RLS, which is what we want — writes here should
  not be gated by per-user RLS.

Common workflows:

  # Show the current state for one client
  python3 scripts/sequences/manage.py list --workspace odagroup

  # Override a single step's template for one client (most common case)
  python3 scripts/sequences/manage.py set-template \\
    --workspace odagroup --sequence unwatched_followup_v1 --step qualifier \\
    --template "Hej {firstName}, vender lige tilbage på denne..."

  # Replace the full sequence definition for a client from a JSON file
  python3 scripts/sequences/manage.py set-sequence \\
    --workspace odagroup --sequence unwatched_followup_v1 --from path/to/seq.json

  # Remove the override — workspace falls back to the global default
  python3 scripts/sequences/manage.py reset \\
    --workspace odagroup --sequence unwatched_followup_v1

  # Validate a steps JSON file without touching the DB
  python3 scripts/sequences/manage.py validate path/to/seq.json

Pass `--yes` to skip the confirmation prompt (useful in scripts).
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
from pathlib import Path
from typing import Any


# ─── env loading ─────────────────────────────────────────────────────────────

def load_dotenv() -> None:
    """Load .env.local then .env into os.environ (existing values win)."""
    root = Path(__file__).resolve().parent.parent.parent
    for name in (".env.local", ".env"):
        p = root / name
        if not p.exists():
            continue
        for line in p.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            os.environ.setdefault(k, v)


def supabase_url() -> str:
    url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
    if not url:
        sys.exit("NEXT_PUBLIC_SUPABASE_URL is not set (check .env.local)")
    return url.rstrip("/")


def service_key() -> str:
    k = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not k:
        sys.exit("SUPABASE_SERVICE_ROLE_KEY is not set (check .env.local)")
    return k


# ─── HTTP helpers (PostgREST) ────────────────────────────────────────────────

def _request(method: str, path: str, *, params: dict | None = None,
             body: Any = None, prefer: str | None = None) -> Any:
    url = f"{supabase_url()}/rest/v1{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params, safe=",.()-")
    headers = {
        "apikey": service_key(),
        "Authorization": f"Bearer {service_key()}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            if not raw:
                return None
            return json.loads(raw)
    except urllib.error.HTTPError as e:
        try:
            err_body = e.read().decode("utf-8")
        except Exception:
            err_body = ""
        sys.exit(f"HTTP {e.code} from PostgREST {method} {path}\n{err_body}")


def fetch_all_sequences(workspace_id: str | None = None) -> list[dict]:
    """Return every row from outreach_sequences, optionally filtered to one workspace."""
    params = {"select": "id,workspace_id,description,trigger_signal,excludes_global,steps,position,is_active",
              "order": "position.asc"}
    if workspace_id is not None:
        # only this workspace's rows + globals (workspace_id IS NULL)
        params["or"] = f"(workspace_id.is.null,workspace_id.eq.{workspace_id})"
    rows = _request("GET", "/outreach_sequences", params=params)
    return rows or []


def fetch_sequence_row(sequence_id: str, workspace_id: str | None) -> dict | None:
    params = {"id": f"eq.{sequence_id}"}
    if workspace_id is None:
        params["workspace_id"] = "is.null"
    else:
        params["workspace_id"] = f"eq.{workspace_id}"
    rows = _request("GET", "/outreach_sequences", params=params)
    return rows[0] if rows else None


def upsert_sequence_row(row: dict) -> dict:
    """INSERT or UPDATE the row, keying on (workspace_id, id). Returns the row."""
    res = _request(
        "POST", "/outreach_sequences",
        body=row,
        prefer="resolution=merge-duplicates,return=representation",
    )
    return res[0] if isinstance(res, list) and res else res


def delete_workspace_override(sequence_id: str, workspace_id: str) -> int:
    """Drop a workspace's override for this sequence. Returns rows deleted."""
    res = _request(
        "DELETE", "/outreach_sequences",
        params={"id": f"eq.{sequence_id}", "workspace_id": f"eq.{workspace_id}"},
        prefer="return=representation",
    )
    return len(res) if isinstance(res, list) else 0


def lookup_workspace(name_or_uuid: str) -> tuple[str, str]:
    """Resolve 'odagroup' (or a UUID) → (uuid, display_name)."""
    s = name_or_uuid.strip()
    uuid_re = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
    if uuid_re.match(s):
        rows = _request("GET", "/workspaces", params={"select": "id,name", "id": f"eq.{s}"})
        if not rows:
            sys.exit(f"no workspace with id={s}")
        return rows[0]["id"], rows[0]["name"]
    # name lookup, case-insensitive
    rows = _request("GET", "/workspaces", params={"select": "id,name", "name": f"ilike.{s}"})
    if not rows:
        # try contains, gives nicer "did you mean" fallback
        rows = _request("GET", "/workspaces", params={"select": "id,name", "name": f"ilike.*{s}*"})
        if not rows:
            sys.exit(f"no workspace matching {s!r}. Try `list` to see all workspaces.")
        if len(rows) > 1:
            names = ", ".join(r["name"] for r in rows)
            sys.exit(f"ambiguous workspace {s!r}: matched {names}. Use the full name or a UUID.")
    return rows[0]["id"], rows[0]["name"]


# ─── validation ──────────────────────────────────────────────────────────────

VALID_ACTION_TYPES = {"auto_send", "queue_approval", "push_only"}
VALID_SIGNALS = {"sent", "viewed", "played", "watched_end", "cta_clicked",
                 "liked", "replied", "render_failed"}


def validate_steps(steps: Any) -> None:
    """Raise ValueError with a precise message if `steps` doesn't match SequenceStep[].

    Mirrors `supabase/functions/_shared/sequences.ts` → SequenceStep. The engine
    reads exactly these keys; bad shape silently freezes leads, so we're strict.
    """
    if not isinstance(steps, list):
        raise ValueError("steps must be a JSON array")
    if not steps:
        raise ValueError("steps cannot be empty (engine would complete immediately)")
    for i, step in enumerate(steps):
        loc = f"steps[{i}]"
        if not isinstance(step, dict):
            raise ValueError(f"{loc} must be a JSON object")

        # Common typo trap: snake_case instead of camelCase. Catch it loudly.
        snake_traps = {"wait_hours": "waitHours", "max_wait_hours": "maxWaitHours"}
        for snake, camel in snake_traps.items():
            if snake in step:
                raise ValueError(
                    f"{loc}.{snake} found — the engine reads camelCase. Use {camel!r} instead."
                )

        for key in ("id", "waitHours", "branches"):
            if key not in step:
                raise ValueError(f"{loc} missing required field {key!r}")

        if not isinstance(step["id"], str) or not step["id"]:
            raise ValueError(f"{loc}.id must be a non-empty string")
        if not isinstance(step["waitHours"], (int, float)) or step["waitHours"] < 0:
            raise ValueError(f"{loc}.waitHours must be a non-negative number")
        if "maxWaitHours" in step and (
            not isinstance(step["maxWaitHours"], (int, float)) or step["maxWaitHours"] < 0
        ):
            raise ValueError(f"{loc}.maxWaitHours must be a non-negative number")

        excludes = step.get("excludes", [])
        if excludes and not isinstance(excludes, list):
            raise ValueError(f"{loc}.excludes must be an array of Signal strings")
        for sig in excludes:
            if sig not in VALID_SIGNALS:
                raise ValueError(f"{loc}.excludes contains unknown signal {sig!r}. Valid: {sorted(VALID_SIGNALS)}")

        branches = step["branches"]
        if not isinstance(branches, list) or not branches:
            raise ValueError(f"{loc}.branches must be a non-empty array")
        for j, b in enumerate(branches):
            bloc = f"{loc}.branches[{j}]"
            if not isinstance(b, dict):
                raise ValueError(f"{bloc} must be a JSON object")
            if "action" not in b:
                raise ValueError(f"{bloc} missing 'action'")
            action = b["action"]
            if not isinstance(action, dict) or "type" not in action:
                raise ValueError(f"{bloc}.action must be an object with a 'type'")
            if action["type"] not in VALID_ACTION_TYPES:
                raise ValueError(
                    f"{bloc}.action.type={action['type']!r} not in {sorted(VALID_ACTION_TYPES)}"
                )
            if action["type"] in ("auto_send", "queue_approval"):
                if not isinstance(action.get("template"), str) or not action["template"].strip():
                    raise ValueError(f"{bloc}.action.template required for type={action['type']!r}")
            requires = b.get("requires", [])
            if requires and not isinstance(requires, list):
                raise ValueError(f"{bloc}.requires must be an array of Signal strings")
            for sig in requires:
                if sig not in VALID_SIGNALS:
                    raise ValueError(f"{bloc}.requires contains unknown signal {sig!r}")


def validate_trigger(signal: str) -> None:
    if signal not in VALID_SIGNALS:
        raise ValueError(f"trigger_signal={signal!r} not in {sorted(VALID_SIGNALS)}")


# ─── diff / display ──────────────────────────────────────────────────────────

def _fmt_wait(hours: float) -> str:
    if hours < 1:
        return f"{round(hours * 60)} min"
    if hours < 24:
        return f"{hours}t"
    days = hours / 24
    return f"{int(days)}d" if days == int(days) else f"{days:.1f}d"


def fmt_row_brief(row: dict, prefix: str = "") -> list[str]:
    src = "GLOBAL" if row.get("workspace_id") is None else "WORKSPACE"
    lines = [f"{prefix}{row['id']} [{src}] trigger={row.get('trigger_signal')} pos={row.get('position')} active={row.get('is_active', True)}"]
    for step in row.get("steps") or []:
        sid = step.get("id", "?")
        wh = step.get("waitHours", 0)
        templates = []
        for b in step.get("branches") or []:
            t = (b.get("action") or {}).get("template")
            if t:
                templates.append(t[:60] + ("…" if len(t) > 60 else ""))
        templ = " | ".join(templates) if templates else "(no template)"
        lines.append(f"{prefix}  +{_fmt_wait(wh)} {sid}: {templ}")
    return lines


def print_diff(before: dict | None, after: dict) -> None:
    print()
    print("=" * 60)
    if before is None:
        print(" CHANGE: insert new workspace override")
    else:
        print(" CHANGE: replace existing workspace override")
    print("=" * 60)
    print()
    if before:
        print("BEFORE:")
        for line in fmt_row_brief(before, "  "):
            print(line)
        print()
    print("AFTER:")
    for line in fmt_row_brief(after, "  "):
        print(line)
    print()


def confirm(prompt: str, yes: bool) -> bool:
    if yes:
        return True
    sys.stdout.write(f"{prompt} [y/N] ")
    sys.stdout.flush()
    try:
        ans = sys.stdin.readline().strip().lower()
    except (EOFError, KeyboardInterrupt):
        return False
    return ans in ("y", "yes")


# ─── commands ────────────────────────────────────────────────────────────────

def cmd_list(args: argparse.Namespace) -> int:
    workspace_id = None
    workspace_name = None
    if args.workspace:
        workspace_id, workspace_name = lookup_workspace(args.workspace)
        print(f"Sequences resolved for workspace: {workspace_name} ({workspace_id})")
    else:
        print("All sequences (globals + per-workspace overrides):")
    rows = fetch_all_sequences(workspace_id)
    if not rows:
        print("  (none)")
        return 0
    # Group by sequence id; if workspace was given, prefer workspace-specific row
    if workspace_id:
        seen: dict[str, dict] = {}
        for r in rows:
            if r["workspace_id"] is None and r["id"] not in seen:
                seen[r["id"]] = r
        for r in rows:
            if r["workspace_id"] == workspace_id:
                seen[r["id"]] = r
        ordered = sorted(seen.values(), key=lambda r: r.get("position", 100))
        for r in ordered:
            print()
            for line in fmt_row_brief(r):
                print(line)
    else:
        for r in rows:
            print()
            for line in fmt_row_brief(r):
                print(line)
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    raw = Path(args.file).read_text() if args.file != "-" else sys.stdin.read()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        sys.exit(f"invalid JSON: {e}")
    # The file can either be a bare steps array, or a full row object with `steps` inside.
    steps = data["steps"] if isinstance(data, dict) and "steps" in data else data
    try:
        validate_steps(steps)
    except ValueError as e:
        sys.exit(f"INVALID — {e}")
    print(f"OK — {len(steps)} step(s) validated")
    return 0


def _build_override_row(
    *, sequence_id: str, workspace_id: str, base_row: dict | None,
    new_steps: list, description: str | None = None,
    trigger: str | None = None, excludes_global: list | None = None,
    position: int | None = None,
) -> dict:
    """Compose the row that would land in outreach_sequences.

    Inherits trigger/description/etc. from the global default when the workspace
    doesn't already have its own override.
    """
    return {
        "id": sequence_id,
        "workspace_id": workspace_id,
        "description": description if description is not None else (base_row or {}).get("description", ""),
        "trigger_signal": trigger if trigger is not None else (base_row or {}).get("trigger_signal"),
        "excludes_global": excludes_global if excludes_global is not None else (base_row or {}).get("excludes_global") or ["replied"],
        "steps": new_steps,
        "position": position if position is not None else (base_row or {}).get("position", 100),
        "is_active": True,
    }


def cmd_set_template(args: argparse.Namespace) -> int:
    workspace_id, workspace_name = lookup_workspace(args.workspace)

    existing_override = fetch_sequence_row(args.sequence, workspace_id)
    global_row = fetch_sequence_row(args.sequence, None)
    base = existing_override or global_row
    if base is None:
        sys.exit(f"no sequence id={args.sequence!r} found (workspace or global). Run `list` to see what exists.")

    # Deep copy of steps so we don't mutate the cached row.
    steps = json.loads(json.dumps(base["steps"] or []))
    step_idx = next((i for i, s in enumerate(steps) if s.get("id") == args.step), -1)
    if step_idx < 0:
        ids = [s.get("id") for s in steps]
        sys.exit(f"step id={args.step!r} not found in sequence {args.sequence}. Available: {ids}")

    branches = steps[step_idx].get("branches") or []
    auto_send_idx = next((j for j, b in enumerate(branches)
                          if (b.get("action") or {}).get("type") == "auto_send"), -1)
    if auto_send_idx < 0:
        sys.exit(f"step {args.step!r} has no auto_send branch; --template not applicable. Use set-sequence for queue_approval/push_only flows.")

    # bash double-quoted strings pass `\n` as two literal chars. Almost no one
    # types templates expecting backslash-n to stay literal in a LinkedIn DM —
    # they want a real newline. Translate the common escapes (\n, \t, \\).
    # If you really want a literal backslash-n in a template, pass --template
    # via --from file.json instead (JSON encodes it correctly).
    template = (
        args.template
        .replace("\\\\", "\x00").replace("\\n", "\n").replace("\\t", "\t").replace("\x00", "\\")
    )
    branches[auto_send_idx]["action"]["template"] = template
    steps[step_idx]["branches"] = branches

    try:
        validate_steps(steps)
    except ValueError as e:
        sys.exit(f"validation failed AFTER edit (shouldn't happen, but caught): {e}")

    new_row = _build_override_row(
        sequence_id=args.sequence,
        workspace_id=workspace_id,
        base_row=base,
        new_steps=steps,
    )

    print(f"Workspace: {workspace_name} ({workspace_id})")
    print(f"Sequence:  {args.sequence}")
    print(f"Step:      {args.step}")
    print(f"Source:    {'replacing existing workspace override' if existing_override else 'inheriting from global, adding workspace override'}")
    print_diff(existing_override, new_row)

    if not confirm("Apply this change?", args.yes):
        print("aborted.")
        return 1

    upsert_sequence_row(new_row)
    print("✓ override saved. Next engine tick (≤5 min) will use the new template for this workspace.")
    return 0


def cmd_set_sequence(args: argparse.Namespace) -> int:
    workspace_id, workspace_name = lookup_workspace(args.workspace)

    raw = Path(args.from_file).read_text()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        sys.exit(f"invalid JSON in {args.from_file}: {e}")

    # Accept either a bare steps array or a full row {description?, trigger?, excludes_global?, steps}
    if isinstance(data, list):
        steps, meta = data, {}
    elif isinstance(data, dict):
        steps = data.get("steps")
        if steps is None:
            sys.exit(f"{args.from_file} is an object but has no 'steps' key")
        meta = {k: data[k] for k in ("description", "trigger", "trigger_signal",
                                     "excludes_global", "position") if k in data}
    else:
        sys.exit(f"{args.from_file} must contain a JSON array (steps) or an object with 'steps'")

    try:
        validate_steps(steps)
    except ValueError as e:
        sys.exit(f"validation failed: {e}")

    trigger = meta.get("trigger") or meta.get("trigger_signal")
    if trigger is not None:
        try:
            validate_trigger(trigger)
        except ValueError as e:
            sys.exit(f"validation failed: {e}")

    existing_override = fetch_sequence_row(args.sequence, workspace_id)
    global_row = fetch_sequence_row(args.sequence, None)
    base = existing_override or global_row
    if base is None and trigger is None:
        sys.exit(f"sequence {args.sequence!r} doesn't exist globally and no 'trigger' provided in {args.from_file}. Add a 'trigger' field at the root.")

    new_row = _build_override_row(
        sequence_id=args.sequence,
        workspace_id=workspace_id,
        base_row=base,
        new_steps=steps,
        description=meta.get("description"),
        trigger=trigger,
        excludes_global=meta.get("excludes_global"),
        position=meta.get("position"),
    )

    print(f"Workspace: {workspace_name} ({workspace_id})")
    print(f"Sequence:  {args.sequence}")
    print(f"Source:    {args.from_file}")
    print_diff(existing_override, new_row)

    if not confirm("Apply this change?", args.yes):
        print("aborted.")
        return 1

    upsert_sequence_row(new_row)
    print("✓ sequence saved.")
    return 0


def cmd_reset(args: argparse.Namespace) -> int:
    workspace_id, workspace_name = lookup_workspace(args.workspace)
    existing = fetch_sequence_row(args.sequence, workspace_id)
    if not existing:
        print(f"no override exists for {workspace_name} / {args.sequence}. Nothing to do.")
        return 0
    print(f"Workspace: {workspace_name} ({workspace_id})")
    print(f"Sequence:  {args.sequence}")
    print("CURRENT OVERRIDE (will be deleted):")
    for line in fmt_row_brief(existing, "  "):
        print(line)
    global_row = fetch_sequence_row(args.sequence, None)
    if global_row:
        print("\nAFTER DELETE — workspace falls back to GLOBAL:")
        for line in fmt_row_brief(global_row, "  "):
            print(line)
    else:
        print("\nWARNING: no global default exists for this sequence — workspace will simply not run this sequence.")

    if not confirm("\nDelete the override?", args.yes):
        print("aborted.")
        return 1

    n = delete_workspace_override(args.sequence, workspace_id)
    print(f"✓ deleted {n} row(s). Workspace now resolves to the global default.")
    return 0


# ─── argparse wiring ────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="manage.py",
        description="Manage workspace-scoped follow-up sequences (outreach_sequences table).",
    )
    sub = p.add_subparsers(dest="command", required=True)

    sp_list = sub.add_parser("list", help="List sequences (optionally resolved for one workspace)")
    sp_list.add_argument("--workspace", help="Workspace slug or UUID. Omit to list every row.")
    sp_list.set_defaults(func=cmd_list)

    sp_val = sub.add_parser("validate", help="Validate a steps JSON file or object without touching the DB")
    sp_val.add_argument("file", help="Path to JSON file (use '-' for stdin)")
    sp_val.set_defaults(func=cmd_validate)

    sp_st = sub.add_parser("set-template", help="Replace a single step's auto_send template for one workspace")
    sp_st.add_argument("--workspace", required=True)
    sp_st.add_argument("--sequence", required=True, help="e.g. unwatched_followup_v1")
    sp_st.add_argument("--step", required=True, help="step id within the sequence, e.g. qualifier")
    sp_st.add_argument("--template", required=True, help="New template text. {firstName}/{company}/{videoLink} interpolated at fire time.")
    sp_st.add_argument("--yes", "-y", action="store_true", help="Skip confirmation")
    sp_st.set_defaults(func=cmd_set_template)

    sp_seq = sub.add_parser("set-sequence", help="Replace the whole sequence definition for one workspace from a JSON file")
    sp_seq.add_argument("--workspace", required=True)
    sp_seq.add_argument("--sequence", required=True)
    sp_seq.add_argument("--from", dest="from_file", required=True, help="Path to JSON file containing steps[] or full row object")
    sp_seq.add_argument("--yes", "-y", action="store_true")
    sp_seq.set_defaults(func=cmd_set_sequence)

    sp_rst = sub.add_parser("reset", help="Remove a workspace override; workspace falls back to global default")
    sp_rst.add_argument("--workspace", required=True)
    sp_rst.add_argument("--sequence", required=True)
    sp_rst.add_argument("--yes", "-y", action="store_true")
    sp_rst.set_defaults(func=cmd_reset)

    return p


def main() -> int:
    load_dotenv()
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args) or 0


if __name__ == "__main__":
    raise SystemExit(main())
