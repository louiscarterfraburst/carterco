# Lead Enrichment Pipeline

Enrich SendPilot-extracted LinkedIn leads with company websites (and optionally push into a SendPilot campaign with `customFields.website` populated).

## Pipeline

```
raw CSV (from SendPilot Lead Extractor)
    │
    ▼
  enrich_li.py          LinkedIn company page → Website field via Jina Reader
    │
    ▼
  retry_misses.py       slow retry for flaky fetches
    │
    ▼
  find_co_link.py       for rows with no currentCompanyLink:
                        Serper → LinkedIn company page → Haiku-verify → Website
    │
    ▼
  build_master.py       combine all passes into one master.csv
    │
    ▼
  clean_names.py        cleanup polluted firstName/lastName (emojis, taglines)
    │
    ▼
  clean_multi_first.py  normalize "FirstName MiddleName" → just first given name
    │
    ▼
  master CSV (ready for outreach)
```

## Env vars

These must be set in your shell (e.g. `.env.local` read by your shell, or exported directly). Scripts read from `process.env` / `os.environ`:

- `SENDPILOT_API_KEY` — SendPilot workspace key
- `SERPER_API_KEY` — Serper.dev Google Search API
- `ANTHROPIC_API_KEY` — Claude API (used by Haiku for verification + name cleanup)

## Typical run

```bash
cd scripts/lead-enrichment

# 1. Enrich using LinkedIn company pages (fast, concurrent)
python3 enrich_li.py \
  --csv ~/Downloads/my-leads.csv \
  --campaign <sendpilot_campaign_id> \
  --workers 5

# 2. Slow retry to pick up flaky fetches
python3 retry_misses.py \
  --csv ~/Downloads/my-leads.csv \
  --progress data/progress_li.jsonl

# 3. Serper+Haiku fallback for leads missing currentCompanyLink
# First generate the misses CSV from master (build it once to find misses):
python3 build_master.py --csv ~/Downloads/my-leads.csv --out data/master.csv
# Then export misses from that master (shell one-liner):
python3 -c "import csv; rows=list(csv.DictReader(open('data/master.csv'))); \
  m=[r for r in rows if not r['website']]; \
  w=csv.DictWriter(open('data/misses.csv','w'), fieldnames=['linkedinUrl','firstName','lastName','company','title']); \
  w.writeheader(); [w.writerow({k:r[k] for k in w.fieldnames}) for r in m]"

python3 find_co_link.py --all \
  --csv ~/Downloads/my-leads.csv \
  --misses data/misses.csv

# 4. Rebuild master with all 3 passes merged
python3 build_master.py --csv ~/Downloads/my-leads.csv --out data/master.csv

# 5. Clean polluted names (emojis, taglines)
python3 clean_names.py --in data/master.csv --out data/master_v2.csv

# 6. Normalize multi-word first names (~1.3s/row, rate-limited by Anthropic)
python3 clean_multi_first.py --in data/master_v2.csv --out data/master_final.csv
```

## Data layout

Everything under `data/` is gitignored — holds raw CSVs, progress JSONL files,
and intermediate outputs.

```
data/
  progress_li.jsonl        pass 1 progress
  recovered.json           pass 2 retry results
  progress_find_co.jsonl   pass 3 progress
  name_progress.jsonl      name cleanup progress (resumable)
  master.csv               combined master
  master_final.csv         after name cleanup
```

## Notes

- **SendPilot API can't PATCH `customFields` on existing leads.** `customFields` is write-once at lead-creation time. If you need to add website to leads that already exist in a campaign, you must create a new campaign and POST fresh.
- **Jina Reader rate-limits anonymously** — pass 1 runs 5 concurrent; pass 2 (retry) drops to 2.
- **Anthropic tier 1 = 50 RPM Haiku** — `clean_multi_first.py` runs serially with 1.3s delay to stay under.
- **Serper free tier = 2,500 queries/account.** Plenty for one 2,500-lead batch.
