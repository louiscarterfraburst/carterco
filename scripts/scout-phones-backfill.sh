#!/usr/bin/env bash
# scout-phones-backfill.sh
#
# Parallel backfill of phone enrichment across un-scouted leads.
#
# Defaults to CarterCo workspace + pipeline rows with accepted_at set and
# phone_scouted_at null. Fires scout-phones in parallel (4 concurrent)
# because the function is mostly I/O-bound (scrape fetches + Apify call).
#
# Usage:
#   ./scripts/scout-phones-backfill.sh              # CarterCo pipeline backfill
#   KIND=alt ./scripts/scout-phones-backfill.sh     # alt_contacts backfill
#   PARALLEL=8 ./scripts/scout-phones-backfill.sh   # higher concurrency
#   WORKSPACE_ID=<uuid> ./scripts/scout-phones-backfill.sh
#
# Reads SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_URL from .env.local
# at repo root.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env.local"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE"; exit 1; }

SU=$(grep '^NEXT_PUBLIC_SUPABASE_URL=' "$ENV_FILE" | cut -d= -f2-)
SK=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' "$ENV_FILE" | cut -d= -f2-)
[ -n "$SU" ] && [ -n "$SK" ] || { echo "supabase env vars missing"; exit 1; }

KIND="${KIND:-pipeline}"
WORKSPACE_ID="${WORKSPACE_ID:-1e067f9a-d453-41a7-8bc4-9fdb5644a5fa}"  # CarterCo
PARALLEL="${PARALLEL:-4}"

# Build the candidate-IDs SQL. The scout function itself is idempotent —
# safe to re-run on already-scouted rows — but we skip them to save Apify
# credits ($0.20/hit).
case "$KIND" in
  pipeline)
    SQL="select sendpilot_lead_id as id from outreach_pipeline
         where workspace_id = '$WORKSPACE_ID'
           and accepted_at is not null
           and phone_scouted_at is null
         order by accepted_at desc"
    ;;
  alt)
    SQL="select id from outreach_alt_contacts
         where workspace_id = '$WORKSPACE_ID'
           and linkedin_url is not null
           and phone_scouted_at is null
         order by surfaced_at desc"
    ;;
  signal)
    SQL="select id from outreach_signals
         where workspace_id = '$WORKSPACE_ID'
           and handled = false
           and phone_scouted_at is null
         order by identified_at desc"
    ;;
  *)
    echo "unknown KIND=$KIND (use pipeline|alt|signal)"; exit 1;;
esac

# Query candidates via PostgREST directly (no RPC needed — direct table reads
# respect RLS, and we send service-role auth so all rows in the workspace
# are visible).
case "$KIND" in
  pipeline)
    IDS=$(curl -sS "$SU/rest/v1/outreach_pipeline?select=sendpilot_lead_id&workspace_id=eq.$WORKSPACE_ID&accepted_at=not.is.null&phone_scouted_at=is.null&order=accepted_at.desc" \
      -H "apikey: $SK" -H "Authorization: Bearer $SK" | python3 -c 'import json,sys; print(json.dumps([r["sendpilot_lead_id"] for r in json.load(sys.stdin)]))')
    ;;
  alt)
    IDS=$(curl -sS "$SU/rest/v1/outreach_alt_contacts?select=id&workspace_id=eq.$WORKSPACE_ID&linkedin_url=not.is.null&phone_scouted_at=is.null&order=surfaced_at.desc" \
      -H "apikey: $SK" -H "Authorization: Bearer $SK" | python3 -c 'import json,sys; print(json.dumps([r["id"] for r in json.load(sys.stdin)]))')
    ;;
  signal)
    IDS=$(curl -sS "$SU/rest/v1/outreach_signals?select=id&workspace_id=eq.$WORKSPACE_ID&handled=eq.false&phone_scouted_at=is.null&order=identified_at.desc" \
      -H "apikey: $SK" -H "Authorization: Bearer $SK" | python3 -c 'import json,sys; print(json.dumps([r["id"] for r in json.load(sys.stdin)]))')
    ;;
esac

COUNT=$(echo "$IDS" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')
echo "Backfilling $COUNT $KIND row(s) with concurrency=$PARALLEL"

scout_one() {
  local id="$1"
  local resp
  resp=$(curl -sS -X POST "$SU/functions/v1/scout-phones" \
    -H "Authorization: Bearer $SK" \
    -H "Content-Type: application/json" \
    -d "{\"kind\":\"$KIND\",\"id\":\"$id\"}" \
    --max-time 90 2>/dev/null)
  local phone source
  phone=$(echo "$resp" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("trace",{}).get("decision",{}).get("phone_direct") or d.get("trace",{}).get("decision",{}).get("phone_office") or "—")' 2>/dev/null)
  source=$(echo "$resp" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("trace",{}).get("decision",{}).get("phone_source") or "none")' 2>/dev/null)
  printf "  %s -> phone=%s (source=%s)\n" "$id" "$phone" "$source"
}
export -f scout_one
export SU SK KIND

echo "$IDS" | python3 -c 'import json,sys
for x in json.load(sys.stdin): print(x)' | \
  xargs -n1 -P"$PARALLEL" -I{} bash -c 'scout_one "$@"' _ {}

echo "Done."
