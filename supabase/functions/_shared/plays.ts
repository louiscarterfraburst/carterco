// Play registry loader. The `outreach_plays` table is the single source of
// truth for which plays exist and how they behave — edge functions must never
// branch on a play-name string literal. Resolution mirrors outreach_sequences:
// a row with workspace_id=NULL is a global play; a row with a real
// workspace_id overrides the global for that workspace by matching `id`.
//
// The default play (what a lead falls back to when its enrichment row carries
// none) is registry data too: outreach_plays.is_default, resolved
// workspace-over-global by the outreach_default_play() SQL function. The DB
// trigger outreach_resolve_play applies it on insert, so writers that don't
// know a lead's play simply omit the column — they must NOT invent one.
//
// Adding a play = INSERT into outreach_plays. No code changes, no redeploy.
// (Caveat: follow-up SEQUENCES are not yet play-aware — trigger_sequence_id
// is recorded but nothing consumes it; see TODOS.md.)
//
// Failure policy: a lookup that ERRORS is not the same as a play that has no
// registry row. Lookups distinguish the two ({ ok: false } vs config: null),
// and the hook decision fails CLOSED on error — a missing personalization is
// benign, sending a hook a play banned is not.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.103.3";

export type PlayConfig = {
    id: string;
    workspace_id: string | null;
    label: string;
    status: "active" | "paused";
    is_default: boolean;
    trigger_sequence_id: string | null;
    // First-DM template for this play ({firstName} {company} {website} {role}
    // {videoLink}). NULL = the workspace/campaign default template path.
    dm_template: string | null;
    // Whether this play's leads get the Becc bucket-hook personalization
    // (enrich-buckets at accept + personalized_hook at render time).
    use_personalized_hook: boolean;
    // Whether a cold accept fires the SendSpark render immediately instead of
    // parking in pending_pre_render for manual operator release.
    auto_render: boolean;
};

// ok:false = the QUERY failed (treat as unknown, fail closed where it
// matters). ok:true + config:null = the registry genuinely has no row.
export type PlayLookup =
    | { ok: true; config: PlayConfig | null }
    | { ok: false };

const PLAY_COLUMNS =
    "id, workspace_id, label, status, is_default, trigger_sequence_id, dm_template, use_personalized_hook, auto_render";

// The registry is near-static (rows change when a play is added or an
// operator edits config), and getPlayConfig sits on webhook hot paths —
// Deno isolates persist across requests, so a short TTL cache removes the
// per-event round trips. Failures get a short NEGATIVE cache so a registry
// outage costs ~one failed query per key per few seconds instead of one per
// pipeline row (the engagement-tick scan touches up to 500 rows).
const CACHE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 10_000;
const cache = new Map<string, { at: number; lookup: PlayLookup }>();

// Play ids and workspace ids are interpolated into a PostgREST .or() filter
// string; a value containing , ( ) would rewrite the filter. Registry ids are
// operator-authored and row.play can carry legacy junk, so validate shape
// instead of trusting either.
const SAFE_PLAY_ID = /^[a-zA-Z0-9_-]+$/;
const SAFE_UUID = /^[0-9a-fA-F-]{36}$/;

// Resolve one play's config for a workspace. playId NULL/empty = resolve the
// workspace's default play (what the DB trigger would stamp). One round trip:
// fetch rows matching the id OR carrying is_default, then resolve
// workspace-over-global in JS. A NAMED id with no registry row resolves to
// config:null (the "no row" contract) — it does NOT inherit the default
// play's config, or pausing the default would pause unregistered-play leads.
export async function getPlayConfig(
    supabase: SupabaseClient,
    playId: string | null | undefined,
    workspaceId: string | null | undefined,
): Promise<PlayLookup> {
    const ws = workspaceId ?? null;
    const id = (playId ?? "").trim();
    if (id && !SAFE_PLAY_ID.test(id)) {
        console.warn("getPlayConfig: malformed play id, treating as unregistered", { playId: id });
        return { ok: true, config: null };
    }
    if (ws && !SAFE_UUID.test(ws)) {
        console.error("getPlayConfig: malformed workspace id", { ws });
        return { ok: false };
    }
    const key = `${ws}:${id}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < (hit.lookup.ok ? CACHE_TTL_MS : NEGATIVE_TTL_MS)) {
        return hit.lookup;
    }

    const idFilter = id ? `id.eq.${id},is_default.eq.true` : `is_default.eq.true`;
    const { data: rows, error } = await supabase
        .from("outreach_plays")
        .select(PLAY_COLUMNS)
        .or(idFilter)
        .or(ws ? `workspace_id.eq.${ws},workspace_id.is.null` : "workspace_id.is.null");
    if (error) {
        console.error("getPlayConfig query failed", { playId: id || "(default)", ws, error: error.message });
        const lookup: PlayLookup = { ok: false };
        cache.set(key, { at: Date.now(), lookup });
        return lookup;
    }
    const all = (rows ?? []) as PlayConfig[];
    // Workspace-specific override wins over the global row.
    const pick = (matches: PlayConfig[]) =>
        matches.find((r) => r.workspace_id !== null) ?? matches.find((r) => r.workspace_id === null) ?? null;
    const config = id
        ? pick(all.filter((r) => r.id === id))
        : pick(all.filter((r) => r.is_default));
    const lookup: PlayLookup = { ok: true, config };
    cache.set(key, { at: Date.now(), lookup });
    return lookup;
}

// The workspace's default play id, for "is this row still default-tagged"
// comparisons (outreach-approve repair rule). Cached like getPlayConfig;
// returns null on error or no-default — callers must treat null as "could not
// determine" and skip, loudly.
export async function getDefaultPlayId(
    supabase: SupabaseClient,
    workspaceId: string | null | undefined,
): Promise<string | null> {
    const lookup = await getPlayConfig(supabase, null, workspaceId);
    if (!lookup.ok) return null;
    return lookup.config?.id ?? null;
}

// Single home for the hook policy: registry rows opt OUT of the Becc
// bucket-hook (use_personalized_hook=false); a play with no registry row
// behaves like a default play (hook on); a FAILED lookup fails closed (hook
// off) — see the failure policy in the header.
export function hookAllowed(lookup: PlayLookup): boolean {
    if (!lookup.ok) return false;
    return lookup.config?.use_personalized_hook ?? true;
}

// Auto-render gate: registry rows opt IN (auto_render=true); a play with no
// registry row keeps the manual pre-render gate; a FAILED lookup fails closed
// (manual gate stays) — an extra human step is benign, an unwanted render
// burning SendSpark credits is not.
export function autoRenderEnabled(lookup: PlayLookup): boolean {
    if (!lookup.ok) return false;
    return lookup.config?.auto_render ?? false;
}

// Pause gate for automated outbound work (renders, hook enrichment, sequence
// sends). A paused play keeps INTAKE (rows are still recorded and tagged) but
// stops automation; manual operator actions (outreach-approve) stay allowed —
// a human override beats the pause. Fails OPEN on lookup error: a transient
// registry blip must not stall every active play's automation.
export function playPaused(lookup: PlayLookup): boolean {
    if (!lookup.ok) return false;
    return lookup.config?.status === "paused";
}

// Cache-BYPASSING pause check for the one place where stale config is unsafe:
// the send drainer. The per-isolate 60s TTL cache means a pause flipped in
// the registry isn't seen by warm isolates for up to a minute — fine for
// hook/render gating, not fine for the kill switch in front of irreversible
// DM sends. One cheap SELECT per drained row. Fails OPEN like playPaused
// (same rationale: a registry blip must not stall every play), but logs.
export async function playPausedLive(
    supabase: SupabaseClient,
    playId: string | null | undefined,
    workspaceId: string | null | undefined,
): Promise<boolean> {
    const id = (playId ?? "").trim();
    const ws = workspaceId ?? null;
    if (!id || !SAFE_PLAY_ID.test(id) || (ws && !SAFE_UUID.test(ws))) return false;
    const { data, error } = await supabase
        .from("outreach_plays")
        .select("status, workspace_id")
        .eq("id", id)
        .or(ws ? `workspace_id.eq.${ws},workspace_id.is.null` : "workspace_id.is.null");
    if (error) {
        console.error("playPausedLive query failed — failing open", { id, ws, error: error.message });
        return false;
    }
    const rows = (data ?? []) as { status: string; workspace_id: string | null }[];
    const row = rows.find((r) => r.workspace_id !== null) ?? rows.find((r) => r.workspace_id === null);
    return row?.status === "paused";
}

// The play tag to stamp on an outreach_pipeline upsert, derived from the
// enrichment row. Spread into the upsert payload:
//
//   await supabase.from("outreach_pipeline").upsert({ ..., ...playStamp(lead) }, ...)
//
// When the lead (or its play) is unknown the column is OMITTED — on insert the
// DB trigger fills the registry default; on conflict the existing row's tag is
// left untouched. Including play: null/undefined instead would clobber a real
// tag on conflict, so don't.
export function playStamp(
    lead: { play?: string | null } | null | undefined,
): { play: string } | Record<string, never> {
    const play = (lead?.play ?? "").trim();
    return play ? { play } : {};
}
