#!/usr/bin/env sh
set -eu

: "${SUPABASE_FUNCTION_URL:?Set SUPABASE_FUNCTION_URL to the notify-new-lead URL}"
: "${LEAD_WEBHOOK_SECRET:?Set LEAD_WEBHOOK_SECRET to the webhook secret}"

curl -sS -X POST "$SUPABASE_FUNCTION_URL" \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: $LEAD_WEBHOOK_SECRET" \
  -d '{
    "name": "Test Lead",
    "company": "CarterCo",
    "email": "test@example.com",
    "phone": "+4512345678",
    "monthly_leads": "50-250",
    "response_time": "Under 5 min"
  }'
