#!/usr/bin/env bash
# Scaffold a new client directory under clients/<name>/.
#
# Usage:
#   scripts/new-client.sh <name> [--status STATUS] [--owner-name NAME] [--owner-email EMAIL] [--style STYLE]
#
# Example:
#   scripts/new-client.sh bikenor --owner-name "Nikolaj Mehlin" --status scoping --style ai-drafted-dm
#
# Creates:
#   clients/<name>/CLAUDE.md      — per-client Claude Code context (from template, with placeholders filled)
#   clients/<name>/agent-brief.md — empty starter brief
#   clients/<name>/data/.gitkeep  — placeholder for lead lists / exports
#
# Will refuse to overwrite an existing client directory.

set -euo pipefail

# --- locate repo root from this script's location ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE="$REPO_ROOT/clients/_template/CLAUDE.md"

# --- parse args ---
NAME=""
STATUS="prospect"
OWNER_NAME=""
OWNER_EMAIL=""
WORKSPACE_ID="n/a"
STYLE="none-yet"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --status)        STATUS="$2"; shift 2 ;;
    --owner-name)    OWNER_NAME="$2"; shift 2 ;;
    --owner-email)   OWNER_EMAIL="$2"; shift 2 ;;
    --workspace-id)  WORKSPACE_ID="$2"; shift 2 ;;
    --style)         STYLE="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    -*)
      echo "error: unknown flag: $1" >&2
      exit 1
      ;;
    *)
      if [[ -z "$NAME" ]]; then
        NAME="$1"
        shift
      else
        echo "error: unexpected positional arg: $1" >&2
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$NAME" ]]; then
  echo "error: client name is required" >&2
  echo "usage: scripts/new-client.sh <name> [--status STATUS] [--owner-name NAME] [--owner-email EMAIL] [--style STYLE]" >&2
  exit 1
fi

# normalize: lowercase, allow only [a-z0-9-]
SLUG="$(echo "$NAME" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed 's/-\{2,\}/-/g; s/^-//; s/-$//')"
if [[ -z "$SLUG" ]]; then
  echo "error: client name produced an empty slug" >&2
  exit 1
fi

CLIENT_DIR="$REPO_ROOT/clients/$SLUG"
if [[ -e "$CLIENT_DIR" ]]; then
  echo "error: $CLIENT_DIR already exists — refusing to overwrite" >&2
  exit 1
fi

if [[ ! -f "$TEMPLATE" ]]; then
  echo "error: template not found at $TEMPLATE" >&2
  exit 1
fi

TODAY="$(date +%Y-%m-%d)"

# --- create files ---
mkdir -p "$CLIENT_DIR/data"
: > "$CLIENT_DIR/data/.gitkeep"

# starter agent-brief.md
cat > "$CLIENT_DIR/agent-brief.md" <<EOF
# $NAME — agent brief

<!--
Canonical brief for the AI message drafter. For AI-drafted-DM clients this is
mirrored into supabase/functions/_shared/draft-first-message.ts — sync after
edits. See clients/README.md for the workflow.
-->

## Who they are

## What we send

## Voice
EOF

# CLAUDE.md from template with placeholders filled
# (use awk so values with special chars don't break sed)
awk -v name="$NAME" \
    -v status="$STATUS" \
    -v owner_name="${OWNER_NAME:-TBD}" \
    -v owner_email="${OWNER_EMAIL:-TBD}" \
    -v workspace_id="$WORKSPACE_ID" \
    -v style="$STYLE" \
    -v onboarded="$TODAY" '
{
  gsub(/\{\{CLIENT_NAME\}\}/, name)
  gsub(/\{\{STATUS\}\}/, status)
  gsub(/\{\{OWNER_NAME\}\}/, owner_name)
  gsub(/\{\{OWNER_EMAIL\}\}/, owner_email)
  gsub(/\{\{WORKSPACE_ID\}\}/, workspace_id)
  gsub(/\{\{OUTREACH_STYLE\}\}/, style)
  gsub(/\{\{ONBOARDED_DATE\}\}/, onboarded)
  print
}' "$TEMPLATE" > "$CLIENT_DIR/CLAUDE.md"

echo "✓ created clients/$SLUG/"
echo "  - CLAUDE.md"
echo "  - agent-brief.md"
echo "  - data/"
echo ""
echo "Next:"
echo "  cd clients/$SLUG && claude   # opens a Claude session scoped to this client"
echo "  Edit CLAUDE.md to fill in deal context + active workstreams."
echo "  For full onboarding (workspace, voice playbook, sequences) see clients/README.md."
