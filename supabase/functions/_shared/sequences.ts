// Sequence contract + DB-backed loader. The engine
// (outreach-engagement-tick) walks a lead through one sequence at a time:
// trigger → step 0 → wait → branch → step 1 → ... → done.
//
// Storage: `outreach_sequences` table. A row with workspace_id=NULL is a
// global default; a row with a real workspace_id overrides the global for
// that workspace by matching `id`. Resolution per lead = (global rows whose
// `id` is not also overridden for this workspace) + (workspace-specific
// rows), ordered by `position`.
//
// Adding a new sequence:
//   - global:        INSERT into outreach_sequences with workspace_id=NULL
//   - workspace-only: INSERT with workspace_id=<uuid>
//   - workspace override of a global: INSERT with workspace_id=<uuid> and the
//     same `id` as the global row
// No code changes required, no redeploy.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.103.3";
import type { Signal, Action } from "./engagement-rules.ts";

export type SequenceBranch = {
    requires?: Signal[];   // all must be present at eval time; omit/empty = always match (use as fallback)
    action: Action;        // auto_send | queue_approval | push_only
};

export type SequenceStep = {
    id: string;            // stable; audit log writes "<sequence>::<step>"
    waitHours: number;     // hours after step entry before the engine evaluates branches
    excludes?: Signal[];   // step-local exit (in addition to sequence.excludesGlobal)
    branches: SequenceBranch[];
    // After this many hours since step entry, if no branch matched, advance
    // silently (no action, no audit row). Defaults to waitHours, i.e. the
    // step is evaluated exactly once and then advances.
    maxWaitHours?: number;
};

export type SequenceTrigger = { signal: Signal };

export type Sequence = {
    id: string;                       // stable; audit log writes "<sequence>::<step>"
    description: string;
    trigger: SequenceTrigger;
    excludesGlobal?: Signal[];        // checked at every step. Default: ["replied"]
    steps: SequenceStep[];
    // Resolution metadata. NULL = global default; non-null = override for
    // that workspace. Engine logic doesn't depend on these, but the page
    // surfaces them so you can tell "this client uses the global flow" vs
    // "this client has a custom flow".
    workspaceId: string | null;
    position: number;
};

export const DEFAULT_GLOBAL_EXCLUDES: Signal[] = ["replied"];

// One DB row.
type SequenceRow = {
    id: string;
    workspace_id: string | null;
    description: string;
    trigger_signal: string;
    excludes_global: string[];
    steps: SequenceStep[];
    position: number;
};

// Load every active sequence row in one query. Engine calls this once per
// tick, then partitions by workspace via resolveSequencesForWorkspace.
export async function loadAllSequences(sb: SupabaseClient): Promise<Sequence[]> {
    const { data, error } = await sb
        .from("outreach_sequences")
        .select("id, workspace_id, description, trigger_signal, excludes_global, steps, position")
        .eq("is_active", true)
        .order("position", { ascending: true });
    if (error) {
        console.error("loadAllSequences error", error);
        return [];
    }
    return ((data ?? []) as SequenceRow[]).map(rowToSequence);
}

function rowToSequence(r: SequenceRow): Sequence {
    return {
        id: r.id,
        description: r.description,
        trigger: { signal: r.trigger_signal as Signal },
        excludesGlobal: (r.excludes_global ?? []) as Signal[],
        steps: r.steps ?? [],
        workspaceId: r.workspace_id,
        position: r.position,
    };
}

// Resolve which sequences apply to a given workspace. Workspace-specific
// rows take precedence over globals when ids collide. Ordering matches the
// pre-DB order in code: lowest `position` first, which means watched_followup
// (100) wins enrolment over unwatched_followup (200) when both triggers match.
export function resolveSequencesForWorkspace(
    all: Sequence[],
    workspaceId: string | null,
): Sequence[] {
    const byId = new Map<string, Sequence>();
    for (const seq of all) {
        if (seq.workspaceId === null) byId.set(seq.id, seq);
    }
    if (workspaceId) {
        for (const seq of all) {
            if (seq.workspaceId === workspaceId) byId.set(seq.id, seq);
        }
    }
    return Array.from(byId.values()).sort((a, b) => a.position - b.position);
}

// --- Pure helpers (no DB) ----------------------------------------------------

export function findSequenceIn(seqs: Sequence[], id: string): Sequence | undefined {
    return seqs.find((s) => s.id === id);
}

export function effectiveExcludes(seq: Sequence, step: SequenceStep): Signal[] {
    const global = seq.excludesGlobal ?? DEFAULT_GLOBAL_EXCLUDES;
    const local = step.excludes ?? [];
    return [...global, ...local];
}
