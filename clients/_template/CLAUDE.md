# {{CLIENT_NAME}}

**Status:** {{STATUS}}  <!-- prospect | scoping | live | paused | offboarded -->
**Owner contact:** {{OWNER_NAME}} <{{OWNER_EMAIL}}>
**Workspace ID:** {{WORKSPACE_ID}}  <!-- "n/a" until provisioned -->
**Outreach style:** {{OUTREACH_STYLE}}  <!-- video-render | ai-drafted-dm | none-yet -->
**Onboarded:** {{ONBOARDED_DATE}}

## Deal context

<!--
Why this client exists, what they actually want, and what's in flight right now.
Keep this section current — it's the first thing Claude reads when you cd in here.
Examples:
- the ICP and the specific pain you're solving
- channels (DK LinkedIn? SE/NO/FI Apollo? IG mining?)
- pricing/contract status (tilbud sent, verbal yes, signed, paused)
- what they're blocking on you for and what you're blocking on them for
-->

## Active workstreams

<!--
Bullet list of in-flight workstreams with status. Delete when shipped.
- [ ] e.g. DanDomain integration — waiting on API credentials
- [ ] e.g. Voice playbook for outbound — drafted, awaiting client sign-off
-->

## Key files in this dir

<!--
- agent-brief.md — canonical brief for the AI drafter (mirror in supabase/functions/_shared/draft-first-message.ts)
- data/ — client-specific lead lists, exports
- tilbud.md — proposal/offer
- databehandleraftale.md — DPA
-->

## Cross-cutting notes

<!--
Anything Claude needs to know that isn't obvious from the code:
- "Don't touch X in the shared sequence — this client uses a fork"
- "Their owner replies via WhatsApp not email"
- "DPA requires data to stay in EU region"
-->
