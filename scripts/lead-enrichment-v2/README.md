# Lead Enrichment v2

Enrich LinkedIn-extract CSVs with a company website. **One reader (Jina) + one model (Haiku).** No Serper, no scraping, no Clearbit.

## Pipeline

```
SendPilot CSV → leads_to_enrich (Supabase)
                       │
                       ▼
       ┌───── Pass A · Jina + LinkedIn ─────┐
       │ if currentCompanyLink in CSV:      │
       │   Jina-read it → Website field     │
       │ else:                              │
       │   Jina-read profile → company link │
       │   Jina-read it → Website field     │
       └─────────────┬──────────────────────┘
                     │ (still no website)
                     ▼
       ┌───── Pass B · Jina + Google + Haiku ┐
       │ Jina-read google.com/search?q=…    │
       │ Haiku picks the right URL          │
       └────────────────────────────────────┘
                     │
                     ▼
              leads_to_enrich.website populated
```

We trust Jina's extraction. Haiku is only used in Pass B to rank Google SERP results.

## Required env vars

In `.env.local` at the repo root:

- `NEXT_PUBLIC_SUPABASE_URL` (already set)
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase dashboard → Settings → API. Service role bypasses RLS so the script can write.
- `JINA_API_KEY` — https://jina.ai (free signup, ~200+ RPM authenticated vs ~5 anon).
- `ANTHROPIC_API_KEY` (already set) — used only in Pass B.

The script reads `.env.local` automatically if you source it before running, e.g.:

```bash
set -a; source ../../.env.local; set +a
```

## Run

```bash
cd scripts/lead-enrichment-v2

# 1. Import a SendPilot CSV (idempotent: re-runs upsert by linkedin_url)
python3 import_csv.py --csv ~/Downloads/leads.csv

# 2. Enrich. Pass A first, then B for the misses.
python3 enrich.py --workers 8

# Or just one pass:
python3 enrich.py --pass A --workers 8
python3 enrich.py --pass B --workers 4
```

## Resumability

- `import_csv.py` upserts on `linkedin_url`, so re-importing the same CSV is a no-op.
- `enrich.py` only picks rows where `website IS NULL` and `attempts < 3`. Stops, restarts, retries — all safe.
- Each lead's `attempts` and `error` are persisted, so you can audit failures with a single SQL query.

## Auditing

```sql
-- Coverage so far
SELECT
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE website IS NOT NULL) AS enriched,
  ROUND(100.0 * COUNT(*) FILTER (WHERE website IS NOT NULL) / NULLIF(COUNT(*),0), 1) AS pct
FROM leads_to_enrich;

-- Breakdown by pass
SELECT website_pass, COUNT(*)
FROM leads_to_enrich
WHERE website IS NOT NULL
GROUP BY 1;

-- Failures, grouped
SELECT split_part(error, ':', 1) AS reason, COUNT(*)
FROM leads_to_enrich
WHERE error IS NOT NULL AND website IS NULL
GROUP BY 1
ORDER BY 2 DESC;
```

## Why this is better than v1

- v1 used Jina anonymous (~5 RPM) and Serper free tier (2,500 lifetime queries — depleted). v2 uses authenticated Jina (200+ RPM) so 1,600 leads finishes in minutes instead of hours.
- v1 needed three CLI scripts + JSONL progress files. v2 is two scripts and Supabase is the source of truth.
- v1 used Claude in the discovery loop. v2 trusts Jina and only invokes Haiku as a final tie-breaker.
