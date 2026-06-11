// Stable, human-readable labels for workspace IDs. Used to prefix push
// notification titles so the recipient can tell at a glance which client /
// workspace fired the alert.

export const ODAGROUP_WORKSPACE_ID = "cdfd80d8-33bb-4b64-b778-0a2c5ab78cc6";
export const CARTERCO_WORKSPACE_ID = "1e067f9a-d453-41a7-8bc4-9fdb5644a5fa";
// Bikenor (PUKY) moved into the multi-tenant cockpit 2026-06-11 — see the
// "2026-06-11 pivot" note in clients/bikenor/CLAUDE.md (reversible).
export const BIKENOR_WORKSPACE_ID = "c1db9fd3-2568-464f-8551-20630094b5d9";

const WORKSPACE_LABELS: Record<string, string> = {
  "1e067f9a-d453-41a7-8bc4-9fdb5644a5fa": "CarterCo",
  "2740ba1f-d5d5-4008-bf43-b45367c73134": "Tresyv",
  "f4777612-4615-4734-94de-4745eade3318": "Haugefrom",
  "cdfd80d8-33bb-4b64-b778-0a2c5ab78cc6": "OdaGroup",
  "c1db9fd3-2568-464f-8551-20630094b5d9": "Bikenor",
};

export function workspaceLabel(id: string | null | undefined): string {
  if (!id) return "?";
  return WORKSPACE_LABELS[id] ?? id.slice(0, 8);
}

// Workspaces whose first cold DM is AI-drafted (draftFirstMessage) instead of
// a SendSpark video render. The accept handlers (sendpilot-webhook + the poll
// backfill) branch on this: AI-drafted workspaces skip the video/website path
// and go straight to pending_ai_draft → draftFirstMessage → pending_approval.
// Keep in sync with WORKSPACE_OUTREACH_STYLE in the Next client-config route.
const AI_DRAFTED_DM_WORKSPACES = new Set([
  ODAGROUP_WORKSPACE_ID,
  BIKENOR_WORKSPACE_ID,
]);

export function isAiDraftedDmWorkspace(id: string | null | undefined): boolean {
  return !!id && AI_DRAFTED_DM_WORKSPACES.has(id);
}

// Looks up the canonical (active) SendPilot sender for a workspace via the
// workspace_senders table. ALL send paths (outreach-approve, invite-alt-
// contact, outreach-engagement-tick) call this and use the result as the
// source of truth — never trust the pipeline row's sendpilot_sender_id
// blindly, since a stale or wrongly-stamped value could cause a message
// to go from the wrong LinkedIn account.
//
// Returns { senderId, mismatch? } so callers can decide how loud to log.
// deno-lint-ignore no-explicit-any
export async function canonicalSenderFor(supabase: any, workspaceId: string | null | undefined): Promise<string | null> {
  if (!workspaceId) return null;
  const { data, error } = await supabase.rpc("canonical_sender_for", { p_workspace_id: workspaceId });
  if (error) {
    console.error("canonical_sender_for rpc failed", workspaceId, error);
    return null;
  }
  return typeof data === "string" ? data : null;
}
