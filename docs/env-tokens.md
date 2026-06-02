# Env tokens — what each unlocks

Catalogue of every secret in `.env.local` so future-you (or an agent) can answer "can I do X locally?" without reading code. If you ever say "I can't fire that API call" — check this first.

All tokens live in `.env.local`. Edge Functions read the same names from the Supabase dashboard (Functions → Secrets).

## Outbound / messaging

| Token | What it unlocks | Base URL | Used by |
|-------|-----------------|----------|---------|
| `SENDPILOT_API_KEY` | Send LinkedIn DMs, list inbox conversations, fire lead-database searches, invite via `/v1/inbox/connect`, fetch leads by campaign | `https://api.sendpilot.ai/v1` | `supabase/functions/_shared/sendpilot-client.ts`, `sendpilot-poll`, `sync-sendpilot-messages`, `invite-alt-contact`, `poll-alt-searches` |
| `LEMLIST_API` | Manage lemlist campaigns, sequences, leads, webhooks; mirror /outreach into lemlist as a parallel channel for CarterCo. HTTP **Basic** auth with empty user + key as password (`-u ":$LEMLIST_API"`). | `https://api.lemlist.com/api` (e.g. `GET /team`, `POST /campaigns`) | `scripts/lemlist/provision_carterco_campaign.mjs`, see `docs/lemlist.md` |
| `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + `TWILIO_NUMBER` | Send SMS via Twilio. Currently only used by `/leads` post-call no-response operator-fired step (see `feedback_outreach_sms_scope`). | `https://api.twilio.com/2010-04-01` | `src/app/api/twilio/sms/route.ts` |
| `TWILIO_BACKUP_CODE` | 2FA backup code for Twilio console (rarely needed) | — | — |
| `SMS_RELAY_PHONES` | Comma-sep list of phone numbers allowed to relay iMessages through the iPhone Shortcut | — | iMessage relay path |
| `SMS_SHORTCUT_WEBHOOK_TOKEN` | Bearer token the iPhone Shortcut sends with each iMessage forward — auth gate for the inbound webhook | — | iMessage inbound webhook |

## CRM / leads / enrichment

| Token | What it unlocks | Base URL | Used by |
|-------|-----------------|----------|---------|
| `ATTIO_API_KEY` | Read/write Attio deals, people, companies, tasks, lists. Webhook signing. | `https://api.attio.com/v2` | `attio-sync`, `attio-sync-deal`, `attio-webhook-deal` |
| `APIFY_API_TOKEN` | Trigger LinkedIn / IG / web scrapers, fetch dataset items, list actor runs | `https://api.apify.com/v2` | `scripts/lead-enrichment/apify_enrich_brands.py`, `find_linkedin_companies.py`, `mine_ig_leads.py` |
| `PROSPEO_API_KEY` | Email + phone enrichment by name+company; account balance check | `https://api.prospeo.io` (`/search-person`, `/account-information`) | `scripts/lead-enrichment/prospeo_enrich_brands.py`, `scout-phones`, `signal-scout-phones` |
| `BRAVE_SEARCH_API_KEY` | Web search results (used for company/brand discovery) | `https://api.search.brave.com/res/v1/web/search` | enrichment scripts, `signal-search-people` |
| `JINA_API_KEY` | Page-to-markdown reader (`r.jina.ai`) and search (`s.jina.ai`). Authenticated tier ~200+ RPM vs ~5 anon. | `https://r.jina.ai/`, `https://s.jina.ai/` | enrichment scripts, `track-job-postings` |

## LLMs

| Token | What it unlocks | Base URL | Used by |
|-------|-----------------|----------|---------|
| `ANTHROPIC_API_KEY` | Claude — used for reply classification, first-message drafting, AI triage, ICP tuning, referral parsing | `https://api.anthropic.com/v1` | `outreach-ai`, `ai-triage-reply`, `draft-first-message.ts`, `generate-icp-tuning-proposal`, `score-accepted-lead` |
| `OPENAI_API_KEY` | OpenAI — fallback / embeddings if used | `https://api.openai.com/v1` | (audit before relying on) |

## Infra

| Token | What it unlocks | Used by |
|-------|-----------------|---------|
| `SUPABASE_ACCESS_TOKEN` | CLI auth for `supabase` commands (deploy functions, push migrations, link projects) | `scripts/deploy_edge_function.py`, local supabase CLI |
| `SUPABASE_SERVICE_ROLE_KEY` | Full DB bypass-RLS access. Server-side only — never ship to the browser. | All Edge Functions, every script that talks to `public.*` |
| `NEXT_PUBLIC_SUPABASE_URL` | Public Supabase project URL — safe to ship to browser | Next.js client, scripts |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Public anon key — RLS-bound, safe to ship | Next.js client |
| `NEXT_PUBLIC_CARTERCO_WORKSPACE_ID` | CarterCo's own workspace UUID — used by client-side `/outreach` UI to scope queries | Next.js client |
| `VERCEL_TOKEN` | Trigger deploys, read deployment status, manage env | Vercel API, `mcp__claude_ai_Vercel__*` tools |
| `GITHUB_TOKEN` | gh CLI / GitHub API — PR comments, releases, workflow dispatch | `gh` CLI |
| `ADMIN_BASIC_AUTH` | `user:pass` for the site admin gate (basic auth header) | `src/proxy.ts` and admin-only routes |

## Persona (test/dev only)

`PERSONA_*` vars define a synthetic operator identity used by local test scripts that exercise the lead-inbox / outreach flows end-to-end. Not real customer data — purely a fixture.

| Token | Holds |
|-------|-------|
| `PERSONA_FIRST_NAME` / `PERSONA_LAST_NAME` / `PERSONA_FULL_NAME` | Test name |
| `PERSONA_COMPANY` | Test company |
| `PERSONA_GMAIL_ADDRESS` + `PERSONA_GMAIL_APP_PWD` | Test Gmail (app password, not OAuth) for poll/submit fixtures |
| `PERSONA_PHONE` | Test phone |

Used by: `scripts/test-leads/auto_submit.py`, `scripts/test-leads/poll_inbox.py`.

## Quick "can I do X?" lookup

- **Send a one-off LinkedIn DM** → `SENDPILOT_API_KEY` + `POST /v1/inbox/messages` (or use `/v1/inbox/connect` for a fresh invite+note)
- **Create / edit a lemlist campaign or sequence** → `LEMLIST_API` + `POST /campaigns` / `POST /sequences/{id}/steps` (Basic auth, see `docs/lemlist.md`)
- **Look up a phone number for a name+company** → `PROSPEO_API_KEY` (`/search-person`)
- **Pull a LinkedIn profile / company page as markdown** → `JINA_API_KEY` + `https://r.jina.ai/<url>`
- **Scrape a list of company employees** → `APIFY_API_TOKEN` + run a LinkedIn actor (see `find_linkedin_companies.py`)
- **Create/update an Attio task or deal** → `ATTIO_API_KEY` + `POST /v2/objects/{task,deals}/records`
- **Read prod DB / write to a table** → `SUPABASE_SERVICE_ROLE_KEY` (server-side), or Supabase MCP if available
- **Deploy an Edge Function** → `SUPABASE_ACCESS_TOKEN` + `supabase functions deploy <name>` (or `scripts/deploy_edge_function.py`)
- **Trigger a Vercel deploy / read logs** → `VERCEL_TOKEN`
- **Send SMS to a customer** → `TWILIO_*` (only for `/leads` post-call step — never cold)

## When you add a new token

1. Add it to `.env.example` (with placeholder value).
2. Add a row to the right table here.
3. If it's an API key, note the base URL and one example endpoint so the next reader doesn't have to grep.
