#!/usr/bin/env sh
set -eu

: "${SUPABASE_ACCESS_TOKEN:?Set SUPABASE_ACCESS_TOKEN from https://supabase.com/dashboard/account/tokens}"

PROJECT_REF="${PROJECT_REF:-znpaevzwlcfuzqxsbyie}"

curl -sS -X PATCH "https://api.supabase.com/v1/projects/$PROJECT_REF/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "site_url": "https://carterco.dk",
    "uri_allow_list": "https://carterco.dk,https://carterco.dk/leads",
    "mailer_subjects_magic_link": "Din CarterCo login-kode",
    "mailer_templates_magic_link_content": "<h2>CarterCo login</h2><p>Din login-kode er:</p><p style=\"font-size:32px;font-weight:700;letter-spacing:8px;\">{{ .Token }}</p><p>Indtast koden på CarterCo Leads.</p>"
  }'
