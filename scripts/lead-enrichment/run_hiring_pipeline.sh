#!/usr/bin/env bash
# One-command hiring-signal pipeline: intake → enrich → resolve → stage+load.
# Used manually AND by .github/workflows/hiring-pipeline.yml (daily cron).
#
# Requires env (locally: `set -a; source .env.local; set +a` first):
#   APIFY_API_TOKEN, SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL),
#   SUPABASE_SERVICE_ROLE_KEY, SENDPILOT_API_KEY
#
# Idempotent: load_hiring_batch.py dedups on linkedin_url, so re-running only
# ever adds the freshly-posted new people — everyone already in is skipped.
#
# Usage:  bash scripts/lead-enrichment/run_hiring_pipeline.sh [manual|cron]
set -euo pipefail

TRIGGER="${1:-manual}"
CAMPAIGN="${HIRING_CAMPAIGN_ID:-cmq2p6otl0bd23a01kguv712n}"
DAYS="${HIRING_DAYS:-30}"
DATA="clients/carterco/data"
S="scripts/lead-enrichment"
mkdir -p "$DATA"

echo "▶ 1/4 intake — DK, last ${DAYS}d, wider titles, A/B/C tier filter"
python3 "$S/apify_hiring_intake.py" \
  --out "$DATA/hiring_intake_dk.csv" \
  --companies-out "$DATA/hiring_companies_dk.csv" \
  --days "$DAYS" --max-items 500

echo "▶ 2/4 enrich — find the commercial buyer per company (poster-preferred)"
python3 "$S/apify_enrich_brands.py" \
  --in "$DATA/hiring_companies_dk.csv" \
  --out "$DATA/hiring_enriched_dk.csv"

echo "▶ 3/4 resolve — encoded LinkedIn IDs → working vanity URLs"
python3 "$S/resolve_profile_urls.py" \
  --in "$DATA/hiring_enriched_dk.csv" \
  --out "$DATA/hiring_enriched_dk_resolved.csv"

echo "▶ 4/4 stage + load — collision-aware, auto-add net-new to campaign $CAMPAIGN"
python3 "$S/load_hiring_batch.py" \
  --in "$DATA/hiring_enriched_dk_resolved.csv" \
  --companies "$DATA/hiring_companies_dk.csv" \
  --sendpilot-campaign "$CAMPAIGN" \
  --trigger "$TRIGGER"

echo "✓ hiring pipeline complete ($TRIGGER)"
