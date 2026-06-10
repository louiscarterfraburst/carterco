#!/usr/bin/env bash
# Push the Soho CAPI secrets from .env.local to Supabase function secrets.
# One-shot helper: terminal-paste-safe (no inline substitution to wrap/break).
set -euo pipefail
cd "$(dirname "$0")/../.."

TOKEN=$(grep '^META_CAPI_ACCESS_TOKEN_SOHO=' .env.local | cut -d= -f2-)
DATASET=$(grep '^META_CAPI_DATASET_ID_SOHO=' .env.local | cut -d= -f2- | awk '{print $1}')

if [ -z "$TOKEN" ] || [ -z "$DATASET" ]; then
  echo "ERROR: META_CAPI_ACCESS_TOKEN_SOHO / META_CAPI_DATASET_ID_SOHO not found in .env.local" >&2
  exit 1
fi

npx -y supabase secrets set \
  "META_CAPI_ACCESS_TOKEN_SOHO=${TOKEN}" \
  "META_CAPI_DATASET_ID_SOHO=${DATASET}" \
  --project-ref znpaevzwlcfuzqxsbyie

echo
echo "Done. Verify (values are hashed, names + digest shown):"
npx -y supabase secrets list --project-ref znpaevzwlcfuzqxsbyie | grep -E 'SOHO|NAME' || true
