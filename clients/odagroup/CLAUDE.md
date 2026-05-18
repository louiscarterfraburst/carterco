# Oda Group

**Status:** live
**Owner contact:** <kontakt@odagroup.dk>
**Workspace ID:** `cdfd80d8-33bb-4b64-b778-0a2c5ab78cc6`
**Outreach style:** ai-drafted-dm (no video render — per-strategy AI message generation)

## Deal context

Oda Group is the canonical AI-drafted-DM client and the reference model for any future DM-style client (see `../README.md` "Adding a new client" — step 1 splits video-render vs AI-drafted-DM, and the latter clones this flow).

## Active workstreams

<!-- Keep current. Delete shipped items. -->

## Key files in this dir

- `agent-brief.md` — **canonical** brief edited by humans. Mirror lives in `../../supabase/functions/_shared/draft-first-message.ts`. Sync after edits with:

  ```bash
  python3 ../../scripts/sync_odagroup_brief.py
  ```

- `data/` — Oda-specific lead lists / exports

## Cross-cutting notes

- The brief mirror in `draft-first-message.ts` is bundled into the edge function at deploy time — edits here don't take effect until `sync_odagroup_brief.py` runs **and** the edge function is redeployed.
- Because Oda is the reference AI-drafted-DM client, the README's checklist for new DM-style clients explicitly mirrors this dir's structure — treat changes here as setting precedent.
