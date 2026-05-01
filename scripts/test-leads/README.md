# Lead-response testing system

Submit real form leads from a single persona email to companies we want to outreach to. Track who responds, how fast, on what channel. Use the per-company response data as the personalization hook in Sendspark outreach.

## Pieces

```
leads_to_enrich (already populated)
        │
        ▼  seed_submissions.py
test_submissions  ─── one row per company we'll test, with ref_code + domain
        │
        ▼  YOU manually fill out their contact form using:
                · the persona email
                · ref_code in the message body (e.g. "Looking for X · ref RX-7K3J")
                · then click "Submitted" in /test-leads admin UI
        │
        ▼  Salesperson replies → persona Gmail
        │
        ▼  poll_inbox.py (runs continuously)
test_responses   ─── attributed via domain match → ref_code → manual queue
        │
        ▼  Admin UI shows time-to-respond per company; warmth pill (≤5m / ≤1h / >1h)
```

## One-time setup

### 1. Apply the schema
Open Supabase SQL Editor, paste `supabase/test_leads.sql`, run.

### 2. Persona Gmail
Pick a Gmail account you control (a real-looking persona, e.g. `kasper.lindberg@gmail.com`). On that account:

1. Enable 2FA — https://myaccount.google.com/security
2. Generate an **App Password** — https://myaccount.google.com/apppasswords
   - "Mail" / "Other (Custom name)" / "carterco-lead-test"
3. Copy the 16-char app password.

### 3. Env vars
Add to `.env.local`:

```
PERSONA_GMAIL_ADDRESS=...@gmail.com
PERSONA_GMAIL_APP_PWD=xxxxxxxxxxxxxxxx
```

`SUPABASE_SERVICE_ROLE_KEY` and `NEXT_PUBLIC_SUPABASE_URL` are already there.

## Run

```bash
cd scripts/test-leads
set -a; source ../../.env.local; set +a

# 1. Seed test_submissions from enriched leads (idempotent, dedupes by domain)
python3 seed_submissions.py --dry-run        # preview
python3 seed_submissions.py                  # commit

# 2. Start the inbox poller (Ctrl-C to stop)
python3 poll_inbox.py --watch

# 3a. AUTOMATED submission (Playwright + Claude Sonnet vision)
#     Install once:
pip install playwright anthropic
playwright install chromium
#     Then:
python3 auto_submit.py --limit 5 --dry-run   # fill but don't submit (smoke test)
python3 auto_submit.py --limit 50            # fire 50 real submissions
python3 auto_submit.py --only-ref RX-7K3JM2  # debug one specific company

# 3b. MANUAL submission via the admin UI at http://localhost:3000/test-leads:
#     - Worklist tab → pull a row, paste the ref_code into their contact form
#     - Click "Submitted" to stamp submitted_at
```

## Auto-submit details

`auto_submit.py` opens each pending company's website in a real Chromium (not headless by default — anti-bot detection is much higher in headless), tries common contact paths (`/kontakt`, `/contact`, etc.), and falls back to scanning nav links for "Kontakt"/"Contact" anchors. Once it lands on a page with a form, it screenshots + asks Claude Sonnet to map the form fields to CSS selectors, fills them with persona data + ref code, clicks submit, and watches for a success indicator.

- Each attempt drops `data/screenshots/<refcode>.png` (before submit) and `<refcode>_after.png` (after) for audit.
- Failures are recorded with `status='failed'` and `notes` explaining why (cookie banner blocked, no form found, captcha, submit gave no signal, etc.).
- Expect ~30–60% success rate. Forms vary wildly; modern anti-bot (Cloudflare, hCaptcha, reCAPTCHA invisible) blocks a chunk silently.
- Run with `--dry-run` first on 3-5 companies to spot-check the field mapping before unleashing on hundreds.

## Attribution (in order)

1. **Ref code** — the `RX-XXXXXX` in your form message survives in quoted replies. Most specific, wins on conflict.
2. **Sender domain** — if the reply comes from `@<submission.domain>`, attribute. Skips `gmail.com`/`hotmail.com`/etc.
3. **Unmatched** — `submission_id IS NULL`. Surfaced in the admin UI for manual assign.

## Warmth definitions

| Bucket | Threshold |
|---|---|
| 🔥 Warm | response within 5 min |
| ☕ Lukewarm | within 1 hour |
| ❄️ Cold | over 1 hour |
| 💀 No response | nothing within 7 days |

(MIT speed-to-lead: leads are 21× more qualified when contacted within 5 minutes.)

## Auditing

```sql
-- Submissions that have responded
SELECT
  company,
  domain,
  submitted_at,
  first_response_at,
  EXTRACT(EPOCH FROM (first_response_at - submitted_at))/60 AS minutes_to_respond
FROM test_submissions
WHERE submitted_at IS NOT NULL AND first_response_at IS NOT NULL
ORDER BY minutes_to_respond ASC;

-- Warmth distribution
WITH r AS (
  SELECT
    CASE
      WHEN first_response_at IS NULL THEN 'no_response_yet'
      WHEN EXTRACT(EPOCH FROM (first_response_at - submitted_at)) <= 300 THEN 'warm'
      WHEN EXTRACT(EPOCH FROM (first_response_at - submitted_at)) <= 3600 THEN 'lukewarm'
      ELSE 'cold'
    END AS bucket
  FROM test_submissions
  WHERE submitted_at IS NOT NULL
)
SELECT bucket, COUNT(*) FROM r GROUP BY 1 ORDER BY 1;

-- Unattributed replies (need manual assign)
SELECT received_at, from_address, subject, body_excerpt
FROM test_responses
WHERE submission_id IS NULL
ORDER BY received_at DESC;
```
