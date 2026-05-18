# Client work — shared rules

When you're inside `clients/<name>/`, you're scoped to that client's work. The rules below apply to **all** client work regardless of which subdir you're in. Client-specific facts (deal stage, workspace ID, contacts) live in the per-client `CLAUDE.md` next to this file.

## Positioning (do not violate)

- **Service, not SaaS.** Louis builds and runs systems for clients. No signup, trial, features, or pricing pages. CTAs lead to a conversation. Visuals show the process, not a product UI.
- **Not solo.** Differentiate on substance — direct access, no juniors, hands-on — never on "solo / én mand / bare mig" framing.
- **Hours + thin infra base.** Quote in hours plus a small infrastructure pass-through. Never retainer, subscription, or fixed-fee, even when the client anchors a monthly budget.
- **No fabricated proof.** Never invent testimonials, logos, case-study numbers, or stats. If a section calls for proof we don't have, push back and offer a fact-based alternative.
- **Walk the funnel before adding friction-reducer copy.** "No booking / no signup / no X" captions must be verified against the actual flow. On carterco every CTA leads to a conversation per `DESIGN.md` — so "ingen møde-booking" framings are structurally false.

## Where shared infra lives

You are at `clients/<name>/`. Cross-client code is one or two directories up:

- `../../scripts/lead-enrichment/` — IG mining, brand cleanup, Prospeo enrichment
- `../../scripts/lead-enrichment-v2/` — newer pipeline
- `../../scripts/sequences/` — sequence definitions
- `../../supabase/functions/_shared/` — shared edge-function code (workspaces, draft-first-message, etc.)
- `../../supabase/migrations/` — DB schema
- `../../src/app/outreach/` — Next.js outreach UI (multi-tenant by workspace)

## Edit scope

By default, only edit files inside this client's `clients/<name>/` dir. Touching shared infra (`scripts/`, `supabase/`, `src/`) affects every client — call it out explicitly before editing and confirm the change is intended to ship to all tenants. Use `/freeze clients/<name>` if you want a hard guarantee.

## Onboarding workflow

The canonical end-to-end "add a new client" checklist lives in `clients/README.md` (workspace provisioning, voice playbook, sequence config, edge-function wiring). Refer to it before doing setup work on a fresh client.
