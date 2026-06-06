# Meta ads automation — Carter & Co

How Claude is used to run CarterCo's Meta (Facebook/Instagram) lead-gen ads.

The workflow is split in two on purpose:

- **Build** is deterministic → a committed, config-driven script. Repeatable,
  version-controlled, idempotent, reusable per client.
- **Optimize** is judgment on live numbers → Claude reading the Meta MCP weekly.

```
┌─ BUILD (committed script, deterministic) ──────────────┐
│  clients/<client>/meta-campaign.json   ← the only edit  │
│  node scripts/meta/setup-campaign.mjs <config>          │
│    → campaign (OUTCOME_LEADS)                            │
│    → ad set (targeting / budget / optimization)         │
│    → upload creatives                                   │
│    → lead form                                          │
│    → ads                                  ALL PAUSED    │
└────────────────────────────────────────────────────────┘
            ▲                                   │ you un-pause
   new creative variants                        ▼ in Ads Manager
┌─ OPTIMIZE (Claude + Meta MCP, weekly) ─────────────────┐
│  "How are the CarterCo ads doing?"                      │
│    → ads_insights_* : CPL per creative × placement      │
│    → kill losers, scale winner, brief new creative      │
└────────────────────────────────────────────────────────┘
```

## Build layer

**One command, driven by one config file. Nothing spends money** — campaign, ad
set, and ads are all created `PAUSED`. You un-pause in Ads Manager when ready.

```bash
node scripts/meta/setup-campaign.mjs clients/carterco/meta-campaign.json
```

- Script: `scripts/meta/setup-campaign.mjs`
- Config: `clients/carterco/meta-campaign.json` (account/page, campaign, ad set
  targeting+budget, lead form, ad copy, the 3 creatives)
- Idempotent: a per-client manifest `.meta-setup-manifest-carterco.json`
  (gitignored) caches campaign id / ad set id / image hashes / form id / ad ids.
  Re-runs skip done work. To rebuild from scratch: `rm` the manifest and re-run.

It's the layer **above** the older `scripts/meta/upload_carterco_leadgen.mjs`,
which only creates ads under a hand-made ad set. `setup-campaign.mjs` creates the
campaign and ad set too, and is config-driven so the same engine serves other
clients (Cleanstep, Soho, Bikenor) by dropping a new `meta-campaign.json`.

### Token (the thing that bites)

The script reads `META_ACCESS_TOKEN` from `.env.local`. This is the **ads** token
(scopes: `ads_management`, `leads_retrieval`, `pages_manage_ads`,
`pages_read_engagement`) — **not** `META_CAPI_ACCESS_TOKEN`, which is the
dataset-scoped Conversions API token and will not work here.

As of writing, `META_ACCESS_TOKEN` is **not** in `.env.local` — add it before the
first run. A standard user token from the Graph API Explorer expires in ~60 days
and fails silently when it lapses; prefer a **System User token** (non-expiring)
from Business Settings for anything you lean on.

### Live entity ids (carterco)

- Ad account: `882167586766471`
- Page: `1138136299380303`
- Existing ad set (pre-script, hand-made): `120248410702800782` — "Carter & Co — DK B2B broad"
- CAPI dataset: `2174079616765417` (env `META_CAPI_*`)

## Optimize layer

Weekly, in a Claude session with the Meta MCP, ask for performance and act on it:

> "How are the CarterCo ads doing this week? CPL per creative and per placement."

Claude pulls `ads_insights_*` and proposes the kill/scale/refresh calls. You
approve; Claude never un-pauses or changes a live budget on its own. When a
creative fatigues, brief new text → regenerate with
`scripts/make_carterco_fb_ads_sharp.mjs` → add it to the config → re-run the build
script (new ad lands PAUSED) → you un-pause.

This is a natural `/schedule` job once it's earning its keep: a remote weekly
Claude run that drafts the recommendations for you to approve.

## Guardrails

1. **Real money, hard to reverse.** Everything is created `PAUSED`.
   Un-pausing / setting live budget is a human-only action. Claude must confirm
   before any `ads_activate_entity`.
2. **DK B2B targeting is weak by nature.** Play broad + strong creative + the
   `moeder_per_uge` qualifying form question + a CAPI quality signal. Don't build
   lookalikes until there's lead volume to seed them.
3. **Optimization goal.** Start on `LEAD_GENERATION` (form fills). Graduate to
   optimizing on a CAPI "qualified/booked" event only past ~50 of those/week —
   below that Meta can't learn on it. It's a one-line config change later.
4. **No invented numbers.** Performance reported is only what `ads_insights_*`
   returns — never a guessed CPL.

## First run checklist

1. Add `META_ACCESS_TOKEN` (ads scopes) to `.env.local`.
2. `node scripts/meta/setup-campaign.mjs clients/carterco/meta-campaign.json`
3. Review in Ads Manager (link printed at the end), un-pause the ad set + ads on
   a 100–150 DKK/day cap.
4. After 4–5 days, run the weekly optimize loop against real CPL.
