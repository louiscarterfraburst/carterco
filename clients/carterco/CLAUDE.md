# Carter & Co (carterco.dk)

**Status:** live (this is also us — workspace + the firm)
**Owner contact:** Louis Carter <louis@carterco.dk>
**Workspace ID:** `1e067f9a-d453-41a7-8bc4-9fdb5644a5fa`
**Outreach style:** video-render (SendSpark)

## Deal context

This is Carter & Co's own workspace — the firm dogfooding the system on itself. Outbound goes to DK SMB founders where Louis can show the three-machines pitch (Outbound / Speed-to-Lead / Post-Meeting) and convert into a scoping call.

Carter & Co is a service, not a product — every CTA on carterco.dk leads to a conversation, never to signup/trial/pricing. Differentiation is direct access + hands-on, not "solo." Pricing is hours + thin infra base, never retainer.

## Active workstreams

<!-- Keep current. Delete shipped items. -->

- carterco.dk site restructure on branch `site/three-machines` — 3 equal-weight sections replacing the 4-stage funnel (agreed 2026-05-15)

## Key files in this dir

- `agent-brief.md` — canonical brief for the AI drafter (mirror in `../../supabase/functions/_shared/draft-first-message.ts`)
- `data/` — Carter & Co's own lead lists / exports

## Cross-cutting notes

- The site itself (`../../src/app/page.tsx`, `../../src/app/outreach/page.tsx`, etc.) is Carter & Co's marketing surface — edits there ship to carterco.dk. Treat as production marketing, not internal tooling.
- `DESIGN.md` at repo root is the source of truth for the three-machines structure.
