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
        id: "post_send_followup_v1",
        description:
            "After we send the video, react to engagement. cta_clicked fires " +
            "instantly via the lead-mode bypassWait path; the rest waits 48h " +
            "and branches on watch state.",
        trigger: { signal: "sent" },
        steps: [
            {
                id: "followup_48h",
                waitHours: 48,
                branches: [
                    // cta_clicked is the strongest intent we get; instant DB
                    // trigger + bypassWait makes this fire the moment the
                    // SendSpark webhook lands, even before 48h elapses.
                    {
                        requires: ["cta_clicked"],
                        action: {
                            type: "queue_approval",
                            template:
                                "Hej {firstName}, jeg kunne se du klikkede dig videre fra videoen — vil du sætte 15 min af så vi kan tale konkret om {company}?",
                        },
                    },
                    {
                        requires: ["watched_end"],
                        action: {
                            type: "queue_approval",
                            template:
                                "Hej {firstName}, jeg så at du tog dig tid til at se hele videoen — har du nogen spørgsmål?",
                        },
                    },
                    {
                        requires: ["played"],
                        action: {
                            type: "queue_approval",
                            template:
                                "Hej {firstName}, jeg ville lige følge op på videoen — gav den mening?",
                        },
                    },
                    { action: { type: "push_only" } },
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
