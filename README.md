# CarterCo

A self-serve back office for **outbound outreach + lead follow-up**, built as a Next.js static site on top of Supabase. Multi-tenant: every user gets their own workspace and only sees their own data.

The system has four surfaces:

- **`/`** — public marketing landing page with a lead-capture form
- **`/leads`** — inbox for inbound leads with one-tap calling, outcome tracking, auto-retries, push notifications, and Calendly bookings
- **`/outreach`** — LinkedIn outreach pipeline (SendPilot ↔ SendSpark) with reply classification
- **`/meetings`** — bookings rolled up from Calendly
- **`/settings`** — per-user calendar, identity tokens (display name, company, signoff), and Google iCal

## Stack

| Layer | Tech |
|---|---|
| Frontend | Next.js 16 with `output: "export"` (static HTML/JS, no server) |
| Hosting | GitHub Pages (built by GitHub Actions on push to `main`) |
| Auth | Supabase Auth (email-OTP, magic link) |
| Database | Supabase Postgres with Row-Level Security |
| Background jobs | Supabase Edge Functions + `pg_cron` + `pg_net` |
| Push notifications | Web Push API + VAPID |
| Outbound video | SendPilot (LinkedIn DMs) + SendSpark (personalised video) |
| Calendar | Google Calendar via private iCal URL |
| Bookings | Calendly via webhook |

---

## Quick start (local dev)

```bash
git clone https://github.com/louiscarterfraburst/carterco.git
cd carterco
npm install
cp .env.example .env.local
# fill in the values in .env.local — see the Self-hosting section below
npm run dev
```

Open http://localhost:3000.

---

## Self-hosting setup

If you want to run your own copy from scratch.

### 1. Create a Supabase project

1. Sign up at [supabase.com](https://supabase.com) and create a new project. Pick a region close to your users (Frankfurt for EU).
2. From the project dashboard, grab:
   - **Project URL** (e.g. `https://xxxxx.supabase.co`) → `NEXT_PUBLIC_SUPABASE_URL`
   - **anon (publishable) key** → `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - **service_role (secret) key** → only used server-side and by edge functions
3. Under **Authentication → Providers → Email**, enable email auth with magic links + OTP.

### 2. Run the SQL migrations

In the Supabase SQL editor, run these files in order. Each is idempotent — safe to re-run.

```
supabase/notifications.sql        # push subscriptions table
supabase/leads.sql                # leads table + public-form RLS
supabase/calendar.sql             # user_settings + user_busy_intervals + suggest_slots RPCs + cal-poll cron
supabase/retry_scheduler.sql      # auto-retry cron for unanswered leads
supabase/outreach.sql             # outreach pipeline tables (skip if you only use /leads)
supabase/outreach_engagement.sql  # SendSpark engagement audit + cron (skip if no outreach)
supabase/workspaces.sql           # multi-tenant foundation (workspaces, members, auto-create trigger)
supabase/multi_tenant_cutover.sql # final RLS rewrite — must run AFTER workspaces.sql
```

After running them all:

```sql
-- Look up your CarterCo workspace UUID — you'll need it for the env vars below
select id from workspaces where owner_email = 'louis@carterco.dk';
```

If you want to rename the seeded workspace, edit `supabase/workspaces.sql` line 53 before running it.

### 3. Configure environment variables

Copy `.env.example` to `.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx
NEXT_PUBLIC_VAPID_PUBLIC_KEY=                            # see step 5
NEXT_PUBLIC_CARTERCO_WORKSPACE_ID=                       # UUID from step 2
```

Set the **same four values** in `.github/workflows/deploy-pages.yml` under the `Build static site` env block — that's what the GitHub Pages build uses. `NEXT_PUBLIC_*` values are baked into the client bundle at build time, so the workflow needs them too.

### 4. Deploy edge functions

The edge functions live under `supabase/functions/`. Deploy each one:

```bash
# Install Supabase CLI first
npx supabase login
npx supabase link --project-ref xxxxx       # your project ref

npx supabase functions deploy cal-poll
npx supabase functions deploy calendly-webhook
npx supabase functions deploy notify-new-lead
npx supabase functions deploy notify-pending-approval
npx supabase functions deploy outreach-ai
npx supabase functions deploy outreach-approve
npx supabase functions deploy outreach-engagement-tick
npx supabase functions deploy sendpilot-webhook
npx supabase functions deploy sendspark-webhook
```

Set the function secrets (Dashboard → Edge Functions → Secrets):

| Secret | What it's for |
|---|---|
| `CARTERCO_DEFAULT_WORKSPACE_ID` | Calendly-webhook fallback (same UUID as the env var above) |
| `CALENDLY_WEBHOOK_SIGNING_KEY` | If you use Calendly, set this from Calendly's webhook config |
| `SENDPILOT_WEBHOOK_SECRET` | Svix signing secret for SendPilot webhooks (outreach only) |
| `SENDPILOT_API_KEY` | SendPilot API key for sending DMs (outreach only) |
| `SENDSPARK_API_KEY` / `SENDSPARK_API_SECRET` | SendSpark video render API (outreach only) |
| `SENDSPARK_WORKSPACE` / `SENDSPARK_DYNAMIC` | SendSpark workspace + dynamic IDs (outreach only) |
| `OPENAI_API_KEY` | Used by `outreach-ai` for reply classification (outreach only) |
| `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web Push credentials — see step 5 |

You can skip all the outreach secrets if you only want `/leads`.

### 5. Generate VAPID keys (for push notifications)

```bash
npx web-push generate-vapid-keys
```

- Public key → `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (in both `.env.local` and the GitHub Action)
- Private key → `VAPID_PRIVATE_KEY` Supabase secret
- `VAPID_SUBJECT` → e.g. `mailto:you@yourdomain.com`

### 6. Deploy the frontend (GitHub Pages)

The repo already has `.github/workflows/deploy-pages.yml`. To enable:

1. GitHub repo → **Settings → Pages → Source: GitHub Actions**.
2. Push to `main`. The workflow builds with `output: "export"`, uploads `./out`, and deploys.

If you want a custom domain (like `carterco.dk`):
- Settings → Pages → Custom domain → enter your domain.
- Add a `CNAME` DNS record pointing to `<github-username>.github.io`.

### 7. (Optional) Calendly webhook

If you want bookings to auto-mark leads as "Booked":

1. In Calendly developer settings, create a webhook subscription for `invitee.created` and `invitee.canceled` events.
2. Point it at `https://<your-supabase-ref>.supabase.co/functions/v1/calendly-webhook`.
3. Copy the signing key into the `CALENDLY_WEBHOOK_SIGNING_KEY` secret.

### 8. (Optional) Outreach pipeline

The `/outreach` page assumes you have:
- A SendPilot account with API access (handles LinkedIn connection-request automation)
- A SendSpark account with a "Dynamic" video template
- Webhook endpoints configured in both pointing at `sendpilot-webhook` and `sendspark-webhook`

If you're just running `/leads`, ignore this section.

---

## Onboarding the first user

1. Visit `/leads` on your deployed site.
2. Enter your email → click "Send login-link".
3. Open the email, click the magic link or paste the OTP.
4. The `handle_new_user_workspace` trigger creates a workspace owned by you the first time you sign in.
5. Visit `/settings` to fill in your identity tokens (display name, company, Calendly URL, signoff) and paste your Google Calendar's private iCal URL.
6. Click "Synkronisér nu" to verify cal-poll picks up your busy intervals.

To onboard another user, just send them the URL. The same trigger gives them their own empty workspace, fully isolated from yours.

---

## Customisation

| What | Where |
|---|---|
| Marketing copy on `/` | `src/app/page.tsx` |
| Email + SMS templates used in `/leads` | `buildSmsBody` / `buildEmailDraft` in `src/app/leads/page.tsx` |
| Retry ladder (2h → 24h → 3d → 7d) | `RETRY_LADDER_MS` in `src/app/leads/page.tsx` and `next_retry_due` in `supabase/retry_scheduler.sql` |
| Business hours (09–17 Mon–Fri) | `src/utils/businessHours.ts` and `clamp_business_hours` in `supabase/retry_scheduler.sql` |
| Outcome list (booked / customer / interested / …) | `Outcome` type + check constraint in `supabase/leads.sql` |
| Default outreach video template | `OUTREACH_MESSAGE_TEMPLATE` env or `DEFAULT_TEMPLATE` in `supabase/functions/sendspark-webhook/index.ts` |
| Engagement sequences (post-send follow-up rules) | `supabase/functions/_shared/sequences.ts` |

---

## Architecture notes

- **Row-Level Security** is the source of truth for tenant isolation. Every workspace-scoped table has a policy `using (workspace_id in (select public.auth_workspace_ids()))`. Edge functions use the service role key and bypass RLS.
- **Auto-create trigger** (`handle_new_user_workspace` in `supabase/workspaces.sql`) fires on `auth.users` insert and gives each new sign-up a workspace. No invite flow needed.
- **Public lead form** uses an anon insert policy that requires `workspace_id = public.carterco_workspace_id()` so leaked anon keys can't write to other tenants.
- **Cron jobs** are scheduled via `pg_cron` inside SQL files: `cal-poll` every 15 min, `outreach-engagement-scan` every 5 min, `dispatch_due_retries` for `/leads` follow-ups. They call edge functions via `pg_net.http_post`.
- **Realtime** subscriptions on `/outreach` filter by `workspace_id` so each tenant only hears their own pipeline events.

## Repo layout

```
src/
  app/
    page.tsx              # public landing + lead form
    leads/page.tsx        # /leads cockpit
    outreach/page.tsx     # /outreach pipeline
    meetings/page.tsx     # bookings list
    settings/page.tsx     # per-user calendar + identity
  utils/
    businessHours.ts
    workspace.ts          # useWorkspace hook
    supabase/
      client.ts           # browser Supabase client
supabase/
  *.sql                   # schema + RLS, run via dashboard SQL editor
  functions/              # edge functions, deploy via Supabase CLI
public/                   # static assets
.github/workflows/        # GitHub Pages deploy workflow
```

---

## Troubleshooting

- **400 from `leads` insert with `code: 22P02 invalid input syntax for type uuid: ""`** — the `NEXT_PUBLIC_CARTERCO_WORKSPACE_ID` env var is empty in the production build. It must be in the GitHub Action's env block AND `.env.local` for dev.
- **400 with `code: 42P10 no unique constraint matches`** — the `leads_draft_session_id_key` index is partial. Check that you're running the latest `supabase/leads.sql` which uses a non-partial unique index.
- **42501 row-level security policy violation on the public form** — `public.carterco_workspace_id()` needs `security definer`. Check that `multi_tenant_cutover.sql` ran successfully.
- **Push notifications work on Android, fail on iOS** — iOS requires the site to be added to the Home Screen and opened as a PWA. Standard Safari tabs can't receive push.
- **`/settings → Synkronisér nu` returns "fetch HTTP 404"** — the Google iCal URL has expired. Reset it in Google Calendar → Settings → Integrate calendar → Reset secret address.

---

## License

Proprietary — internal use only. Contact louis@carterco.dk for licensing.
