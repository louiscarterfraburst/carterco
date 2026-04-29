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
// Order matters: enrolment picks the first matching sequence. Watched MUST
// come first so a lead with both `sent` and `played` lands in the watched
// flow rather than the unwatched flow.
export const SEQUENCES: Sequence[] = [
    {
        id: "watched_followup_v1",
        description:
            "Lead played the video — react fast (20 min), then bump 3 days later if no reply.",
        trigger: { signal: "played" },
        steps: [
            {
                id: "nysgerrig",
                waitHours: 20 / 60, // 20 minutes
                branches: [
                    {
                        action: {
                            type: "queue_approval",
                            template:
                                "Hej {firstName}\n\nEr nysgerrig på din vurdering – er det noget, I kan genkende?\n\nJeg kan sende et par forslag til tider, hvis det giver mening at tage den videre",
                        },
                    },
                ],
            },
            {
                id: "kalender",
                waitHours: 72, // 3 days after step 0 fired
                branches: [
                    {
                        action: {
                            type: "queue_approval",
                            template:
                                "Hej {firstName}, vender tilbage på denne — er det noget vi skal sætte i kalenderen?",
                        },
                    },
                ],
            },
        ],
    },
    {
        id: "unwatched_followup_v1",
        description:
            "Lead got the video but hasn't played it. Qualify quickly (24h) then a final graceful exit at +3d.",
        trigger: { signal: "sent" },
        // Exit if they reply OR play. Played leads get re-enrolled in the
        // watched flow by the engine's re-enrolment path.
        excludesGlobal: ["replied", "played"],
        steps: [
            {
                id: "qualifier",
                waitHours: 24,
                branches: [
                    {
                        action: {
                            type: "queue_approval",
                            template:
                                "Hej {firstName} — hurtigt spørgsmål: er du den rigtige hos {company} at tale med om dette, eller skal jeg fange en anden? Sig også til hvis det ikke er relevant.",
                        },
                    },
                ],
            },
            {
                id: "graceful_exit",
                waitHours: 72, // 3 days after qualifier fired
                branches: [
                    {
                        action: {
                            type: "queue_approval",
                            template:
                                "Vender tilbage en sidste gang — siger ikke mere herefter. Sig endelig til hvis det giver mening senere.",
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
