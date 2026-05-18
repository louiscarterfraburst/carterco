# Clients

Per-client content + briefs for the multi-tenant outreach system.

Each client = one Supabase workspace + one row in `outreach_voice_playbooks` + (for AI-drafted-message clients) one bundled agent brief in the edge functions. **Follow-up sequences** live in the `outreach_sequences` DB table — see "Per-workspace sequence overrides" below.

```
clients/
  odagroup/
    agent-brief.md          # canonical brief, edited by humans
                            # mirror lives in supabase/functions/_shared/draft-first-message.ts
                            # sync via: python3 scripts/sync_odagroup_brief.py
```

Quick read-only overview of every client's flow lives at `/outreach/clients` in the Next app (workspace selector, voice playbook, ICP, agent brief, outbound flow + sequences, pipeline status, file refs).

## Live workspaces

| Name        | Workspace ID                              | Owner email              | Outreach style |
|-------------|-------------------------------------------|--------------------------|----------------|
| CarterCo    | `1e067f9a-d453-41a7-8bc4-9fdb5644a5fa`    | `louis@carterco.dk`      | SendSpark video render |
| Tresyv      | `2740ba1f-d5d5-4008-bf43-b45367c73134`    | `rm@tresyv.dk`           | SendSpark video render |
| Haugefrom   | `f4777612-4615-4734-94de-4745eade3318`    | `haugefrom@haugefrom.com`| SendSpark video render |
| OdaGroup    | `cdfd80d8-33bb-4b64-b778-0a2c5ab78cc6`    | `kontakt@odagroup.dk`    | AI-drafted DM (no video) |

---

## Adding a new client

Checklist for onboarding a new client workspace. ~30 minutes end-to-end.
Replace `<NEW_NAME>`, `<NEW_EMAIL>`, `<NEW_UUID>` as you go.

### 1. Decide the outreach style

- **Video render** — clone the CarterCo flow. Most existing infra works as-is.
- **AI-drafted DM** — clone the OdaGroup flow (the model below). Per-strategy AI message generation, no video.

The rest of this checklist assumes AI-drafted DM. For video, only steps 2–4 apply.

### 2. Provision the workspace in DB

```sql
WITH new_ws AS (
  INSERT INTO workspaces (id, name, owner_email)
  VALUES (gen_random_uuid(), '<NEW_NAME>', '<NEW_EMAIL>')
  RETURNING id
), m1 AS (
  INSERT INTO workspace_members (workspace_id, user_email, role)
  SELECT id, '<NEW_EMAIL>', 'owner' FROM new_ws
), m2 AS (
  INSERT INTO workspace_members (workspace_id, user_email, role)
  SELECT id, 'louis@carterco.dk', 'member' FROM new_ws
), pb AS (
  INSERT INTO outreach_voice_playbooks
    (workspace_id, owner_first_name, value_prop, guidelines, cta_preference, booking_link)
  SELECT id, '<OWNER_FIRST_NAME>',
    '<one-paragraph value prop>',
    '<voice guidelines, used by reply-drafter>',
    'soft_discovery',  -- or 'no_cta' / 'booking_link'
    NULL
  FROM new_ws
)
SELECT id AS new_workspace_id FROM new_ws;
```

Save the returned UUID — you'll wire it into code in step 5.

### 3. Add the workspace label

Edit `supabase/functions/_shared/workspaces.ts`:

```ts
const WORKSPACE_LABELS: Record<string, string> = {
  // ...existing entries...
  "<NEW_UUID>": "<NEW_NAME>",
};
```

This shows up in push notification titles so users see which client triggered the alert.

### 4. Add the user to ALLOWED_USERS

Edit `supabase/functions/outreach-ai/index.ts`:

```ts
const ALLOWED_USERS = new Set([
  // ...existing entries...
  "<NEW_EMAIL>",
]);
```

Without this, calls to `outreach-ai` from the user's JWT get a 403.

### 5. (AI-drafted clients only) Author the agent brief

Create `clients/<new-name>/agent-brief.md`. Use `clients/odagroup/agent-brief.md` as the model. Sections:

1. **The core idea** — one-line philosophy of how messages get personalized
2. **Client context** — company, founder, product, positioning, anchor proof point
3. **Voice** — reference sample (real message the owner has written), traits to replicate
4. **The strategies** — N strategies, each with title triggers + pain bank + hook + phrase bank
5. **Inputs** — JSON shape passed to the agent
6. **Output format** — JSON envelope shape
7. **Hard rules** — length, banned phrases, language routing, CTA
8. **Reference outputs** — 1–2 calibration samples (mark as STRUCTURE & VOICE only, not templates)
9. **When in doubt** — fallback rules

### 6. (AI-drafted clients only) Wire the brief into the edge function

Edit `supabase/functions/_shared/draft-first-message.ts`:

```ts
import { ODAGROUP_WORKSPACE_ID, NEW_CLIENT_WORKSPACE_ID } from "./workspaces.ts";

// Add another String.raw constant alongside ODAGROUP_AGENT_BRIEF.
const NEW_CLIENT_AGENT_BRIEF = String.raw`<paste body of clients/<new-name>/agent-brief.md from '## 1.' onward>`;

function briefForWorkspace(workspaceId: string): string | null {
  if (workspaceId === ODAGROUP_WORKSPACE_ID) return ODAGROUP_AGENT_BRIEF;
  if (workspaceId === NEW_CLIENT_WORKSPACE_ID) return NEW_CLIENT_AGENT_BRIEF;
  return null;
}
```

Also export `NEW_CLIENT_WORKSPACE_ID` from `supabase/functions/_shared/workspaces.ts`.

> **TODO:** at N≥4 clients, refactor to load briefs from `outreach_voice_playbooks.agent_brief` text column at runtime instead of bundling per-client constants. The switch will get unwieldy. Follow the same pattern as `outreach_sequences` (see "Per-workspace sequence overrides" below): one DB column, no code change to add a new client's brief.

### 7. (AI-drafted clients only) Branch the connection.accepted handler

Edit `supabase/functions/sendpilot-webhook/index.ts` — add a branch alongside the OdaGroup branch:

```ts
if (workspaceId === NEW_CLIENT_WORKSPACE_ID) {
  // ...optional company blocklist check...
  await supabase.from("outreach_pipeline").upsert({
    /* same shape as OdaGroup branch */
    status: "pending_ai_draft",
  }, { onConflict: "sendpilot_lead_id" });
  const draft = await draftFirstMessage(supabase, leadId);
  // ...same error-handling as OdaGroup branch...
}
```

### 8. Deploy

```bash
# 1. Sync the brief from .md → .ts (AI-drafted clients only)
python3 scripts/sync_odagroup_brief.py   # or new equivalent for the new client

# 2. Deploy the two functions touched in this onboarding
#    (via Supabase CLI, MCP, or dashboard)
#    - outreach-ai
#    - sendpilot-webhook
```

### 9. Smoke test

For AI-drafted clients, run the smoke test against synthetic leads:

```bash
ANTHROPIC_API_KEY=... python3 scripts/lead-enrichment/smoke_test_odagroup.py
```

Adapt the test lead list to the new client's strategies.

For all clients: have the new user log into `/outreach`, confirm their workspace appears in the selector, and confirm their queue is empty (no leftover rows from setup).

---

## Editing an existing brief

For OdaGroup (and any future AI-drafted client):

1. Edit `clients/<client>/agent-brief.md`
2. Run `python3 scripts/sync_odagroup_brief.py` (or per-client equivalent) to mirror to the .ts
3. Redeploy `outreach-ai` and `sendpilot-webhook`

The `--check` flag on the sync script exits non-zero if the .md and .ts have drifted — wire it into pre-deploy CI to catch the silent-drift footgun.

---

## Per-workspace sequence overrides

Follow-up sequences (the auto-DMs the engine fires after the first message) live in the `outreach_sequences` DB table. The engine resolves which sequences apply to a lead from this table on every tick — no code change or redeploy needed when you change templates or add an override.

Schema:
- `workspace_id IS NULL` → global default, applies to every workspace
- `workspace_id = <uuid>` → workspace-specific override. If the `id` matches a global, the workspace row wins for that workspace.
- Resolution per workspace = (globals not overridden) ∪ (workspace rows), ordered by `position`.

Current state: two globals seeded (`watched_followup_v1`, `unwatched_followup_v1`). No workspace overrides exist yet — all four clients hit the globals.

### Recommended: use the CLI

Use `scripts/sequences/manage.py` for any change to a sequence. It validates the JSON shape against the engine's `SequenceStep` type, shows a diff, and prompts for confirmation. Catches the silent footgun where `wait_hours` (snake_case typo) freezes leads mid-flow.

```bash
# Look at what a client is on right now
python3 scripts/sequences/manage.py list --workspace odagroup

# Override one template for one client (most common case)
python3 scripts/sequences/manage.py set-template \
  --workspace odagroup --sequence unwatched_followup_v1 --step qualifier \
  --template "Hej {firstName}, vender lige tilbage på denne — er det noget i {company} har kigget på?"

# Replace the whole sequence for one client (from a JSON file)
python3 scripts/sequences/manage.py set-sequence \
  --workspace odagroup --sequence unwatched_followup_v1 --from path/to/seq.json

# Remove a workspace override — client falls back to global default
python3 scripts/sequences/manage.py reset \
  --workspace odagroup --sequence unwatched_followup_v1

# Validate a JSON file without touching the DB
python3 scripts/sequences/manage.py validate path/to/seq.json
```

Reads `SUPABASE_SERVICE_ROLE_KEY` from `.env.local` automatically. Pass `--yes` to skip the confirmation prompt in scripts. Templates accept `\n` and `\t` as escape sequences — they're decoded to real newlines/tabs before storage.

### What the CLI does in the DB

For reference / for cases the CLI doesn't cover, the underlying SQL operations are:

```sql
-- Override (workspace-specific row; same id as a global wins for that workspace)
INSERT INTO outreach_sequences (id, workspace_id, description, trigger_signal, excludes_global, steps, position)
VALUES ('unwatched_followup_v1', '<workspace-uuid>', '...', 'sent', ARRAY['replied'], '[...]'::jsonb, 200);

-- Edit a global (affects all clients without an override)
UPDATE outreach_sequences SET steps = '[...]'::jsonb
WHERE id = 'unwatched_followup_v1' AND workspace_id IS NULL;

-- Pause a sequence for one client (inactive override + empty steps shadows the global)
INSERT INTO outreach_sequences (id, workspace_id, description, trigger_signal, steps, is_active, position)
VALUES ('watched_followup_v1', '<workspace-uuid>', 'Disabled for this client.', 'played', '[]'::jsonb, false, 100);

-- Drop an override (workspace falls back to global)
DELETE FROM outreach_sequences WHERE workspace_id = '<workspace-uuid>' AND id = '<seq-id>';
```

The CLI maps to `INSERT … ON CONFLICT` (set-template, set-sequence) and `DELETE` (reset). For pause/edit-global, run the SQL directly.

After any change, refresh `/outreach/clients` to see the new state — the page shows a green "Workspace override" badge next to sequences that have a workspace-specific row, so you can tell at a glance which clients are on custom flows.

### Engine + UI references

- Loader + resolution logic: `supabase/functions/_shared/sequences.ts`
- Engine: `supabase/functions/outreach-engagement-tick/index.ts` (cron every 5 min; verify_jwt=false)
- Overview UI: `src/app/outreach/clients/page.tsx` (read-only)
- API route the overview reads from: `src/app/api/outreach/client-config/route.ts`

### Step JSON shape

```json
{
  "id": "qualifier",
  "waitHours": 72,
  "branches": [
    {
      "requires": ["played"],
      "action": { "type": "auto_send", "template": "Hej {firstName}..." }
    },
    {
      "action": { "type": "auto_send", "template": "fallback when no signal matches" }
    }
  ],
  "excludes": ["replied"],
  "maxWaitHours": 168
}
```

`branches` are evaluated in order; first one whose `requires` are all present wins. Omit `requires` for an unconditional fallback. Templates support `{firstName}`, `{company}`, `{videoLink}`.
