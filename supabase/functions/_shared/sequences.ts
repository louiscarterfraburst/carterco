// Sequence contract + the live sequence list. The engine
// (outreach-engagement-tick) walks a lead through one sequence at a time:
// trigger → step 0 → wait → branch → step 1 → ... → done.
//
// Adding a new sequence = appending to SEQUENCES below + updating the
// "Current sequences" table in docs/outreach-playbook.md.

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
    id: string;            // stable; audit log writes "<sequence>::<step>"
    description: string;
    trigger: SequenceTrigger;
    excludesGlobal?: Signal[]; // checked at every step. Default: ["replied"]
    steps: SequenceStep[];
};

export const DEFAULT_GLOBAL_EXCLUDES: Signal[] = ["replied"];

// Active sequences. Order matters: enrolment picks the first matching one.
export const SEQUENCES: Sequence[] = [
    {
        id: "watched_followup_v1",
        description:
            "Lead watched the video to the end — react ~2 min later with a " +
            "concrete sparring offer. Single step, single branch, no fallback.",
        trigger: { signal: "watched_end" },
        steps: [
            {
                id: "watched_2min",
                waitHours: 2 / 60, // 2 minutes
                branches: [
                    {
                        action: {
                            type: "queue_approval",
                            template:
                                "Hej {firstName} — tak fordi du tog dig tid til hele videoen. Var der noget af det jeg nævnte der gav genklang for {company}? Jeg afsætter gerne en time til at gå mere konkret i dybden.",
                        },
                    },
                ],
            },
        ],
    },
];

// --- Pure helpers (no DB) ----------------------------------------------------

export function findSequence(id: string): Sequence | undefined {
    return SEQUENCES.find((s) => s.id === id);
}

export function effectiveExcludes(seq: Sequence, step: SequenceStep): Signal[] {
    const global = seq.excludesGlobal ?? DEFAULT_GLOBAL_EXCLUDES;
    const local = step.excludes ?? [];
    return [...global, ...local];
}
