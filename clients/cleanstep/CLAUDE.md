# Cleanstep

**Status:** scoping (verbal yes, scope-of-work in flight)
**Owner contact:** Co-owner (TBD — fill in name + email when signed)
**Workspace ID:** n/a (provision after signature)
**Outreach style:** none-yet — this is an order-automation engagement, not an outbound client

## Deal context

DK rengørings-engros, ~17M DKK gross revenue in 2024, ~50 orders/day through DanDomain. No automated order follow-up, no central view of top-customer buying patterns, no systematic handling of customers who fall out of their normal ordering rhythm.

Co-owner gave verbal yes on the full vision on **2026-05-15**. Tilbud (`tilbud.md`) is on the table; DPA (`databehandleraftale.md`) prepared. Scoping the contract now.

The build is **DanDomain v2 API → isolated Cleanstep tenant in Carter & Co's Supabase → ordreautomatisering**. Carter & Co runs the infra; Cleanstep is the data source and the consumer.

Pricing: hours + thin infra base (never retainer / subscription / fixed-fee, even if they anchor a monthly budget).

## Active workstreams

- [ ] Sign tilbud + DPA
- [ ] DanDomain API credentials from Cleanstep
- [ ] Provision Cleanstep workspace (Supabase tenant + members + voice playbook row — see `../README.md` checklist)
- [ ] Initial historical import (orders, customers, product catalog) then 15-min poll loop

## Key files in this dir

- `tilbud.md` — proposal/offer document
- `databehandleraftale.md` — DPA (data processing agreement)

## Cross-cutting notes

- This is an **integration engagement**, not outreach. The standard outbound stack (`../../scripts/lead-enrichment*`, sequences, voice playbooks) doesn't apply to Cleanstep's own work. Their data lives in an isolated tenant alongside the outbound clients' workspaces.
- EU data residency expected — confirm Supabase project region before importing real customer data.
