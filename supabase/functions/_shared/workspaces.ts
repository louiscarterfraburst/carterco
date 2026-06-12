// Stable, human-readable labels for workspace IDs. Used to prefix push
// notification titles so the recipient can tell at a glance which client /
// workspace fired the alert.

export const ODAGROUP_WORKSPACE_ID = "cdfd80d8-33bb-4b64-b778-0a2c5ab78cc6";
export const CARTERCO_WORKSPACE_ID = "1e067f9a-d453-41a7-8bc4-9fdb5644a5fa";

const WORKSPACE_LABELS: Record<string, string> = {
  "1e067f9a-d453-41a7-8bc4-9fdb5644a5fa": "CarterCo",
  "2740ba1f-d5d5-4008-bf43-b45367c73134": "Tresyv",
  "f4777612-4615-4734-94de-4745eade3318": "Haugefrom",
  "cdfd80d8-33bb-4b64-b778-0a2c5ab78cc6": "OdaGroup",
};

export function workspaceLabel(id: string | null | undefined): string {
  if (!id) return "?";
  return WORKSPACE_LABELS[id] ?? id.slice(0, 8);
}

// Per-workspace first-message mechanism, read from workspaces.outreach_style
// (single source of truth, shared with /api/outreach/client-config). Cached
// per isolate like the play registry — the value changes when a client is
// onboarded, not per event. Fails to 'video_render' on error: the render path
// parks in pending_pre_render behind a manual gate, so a wrong fallback is an
// operator-visible stall, never an unreviewed AI DM.
export type OutreachStyle = "video_render" | "ai_drafted_dm";
const STYLE_CACHE_TTL_MS = 60_000;
const styleCache = new Map<string, { at: number; style: OutreachStyle }>();

// deno-lint-ignore no-explicit-any
export async function outreachStyleFor(supabase: any, workspaceId: string | null | undefined): Promise<OutreachStyle> {
  if (!workspaceId) return "video_render";
  const hit = styleCache.get(workspaceId);
  if (hit && Date.now() - hit.at < STYLE_CACHE_TTL_MS) return hit.style;
  const { data, error } = await supabase
    .from("workspaces")
    .select("outreach_style")
    .eq("id", workspaceId)
    .maybeSingle();
  if (error) {
    console.error("outreachStyleFor query failed — falling back to video_render", { workspaceId, error: error.message });
    return "video_render";
  }
  const style: OutreachStyle = data?.outreach_style === "ai_drafted_dm" ? "ai_drafted_dm" : "video_render";
  styleCache.set(workspaceId, { at: Date.now(), style });
  return style;
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
