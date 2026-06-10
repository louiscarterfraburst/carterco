import { describe, expect, it } from "vitest";
import {
  activeArms,
  buildTreeEdges,
  buildTreeNodes,
  classifyNode,
  lookupSeqStep,
  nodeLabel,
  scopeSequencesToPlay,
  OUTCOME_DEFS,
  playStats,
  resolvePlays,
  type FlowRow,
  type NodeDef,
  type SeqLite,
} from "./flow";

// A contact with no signals at all — classifyNode's fallthrough is "invited".
function row(overrides: Partial<FlowRow> = {}): FlowRow {
  return {
    status: "invited",
    sent_at: null,
    last_reply_at: null,
    last_reply_intent: null,
    sequence_id: null,
    sequence_step: null,
    sequence_completed_at: null,
    first_dm_variant: null,
    ...overrides,
  };
}

const SEQUENCES: SeqLite[] = [
  {
    id: "hiring_signal_v1",
    workspace_id: null,
    steps: [{ id: "opfolgning_1" }, { id: "opfolgning_2" }],
  },
];

describe("classifyNode", () => {
  it("puts a replied contact in its intent bucket, outranking everything else", () => {
    const r = row({
      status: "failed", // a 500 can be a false failure that still delivered
      last_reply_at: "2026-06-01T00:00:00Z",
      last_reply_intent: "interested",
    });
    expect(classifyNode(r)).toBe("reply:interested");
  });

  it("maps unknown reply intents to reply:other", () => {
    const r = row({ last_reply_at: "2026-06-01T00:00:00Z", last_reply_intent: "banana" });
    expect(classifyNode(r)).toBe("reply:other");
  });

  it("treats a completed sequence as terminal even when step pointers remain", () => {
    const r = row({
      sequence_id: "hiring_signal_v1",
      sequence_step: 1,
      sequence_completed_at: "2026-06-01T00:00:00Z",
    });
    expect(classifyNode(r)).toBe("sequence_completed");
  });

  it("places an in-sequence contact at its exact step node", () => {
    const r = row({ status: "sent", sequence_id: "hiring_signal_v1", sequence_step: 1 });
    expect(classifyNode(r)).toBe("seq:hiring_signal_v1:1");
  });

  it("lets an assigned A/B arm own the lead through its pre-send life", () => {
    const r = row({ status: "pending_pre_render", first_dm_variant: "v3_video" });
    expect(classifyNode(r)).toBe("arm:v3_video");
  });

  it("falls through plain statuses to their own node, unknown to invited", () => {
    expect(classifyNode(row({ status: "pending_approval" }))).toBe("pending_approval");
    expect(classifyNode(row({ status: "something_new" }))).toBe("invited");
  });
});

describe("nodeLabel", () => {
  it("uses the sequence step's own id when the definition is loaded", () => {
    expect(nodeLabel("seq:hiring_signal_v1:0", SEQUENCES)).toBe("opfolgning_1");
  });

  it("falls back to 'trin N' for steps with no loaded definition", () => {
    expect(nodeLabel("seq:unknown_seq:2", SEQUENCES)).toBe("trin 2");
  });

  it("labels arms, statuses and outcomes with the Flow tree's wording", () => {
    expect(nodeLabel("arm:v1_long", [])).toBe("V1 · lang tekst");
    expect(nodeLabel("sent", [])).toBe("Sendt");
    expect(nodeLabel("reply:interested", [])).toBe("Interesseret");
  });

  it("passes unknown ids through unchanged instead of crashing", () => {
    expect(nodeLabel("some_future_node", [])).toBe("some_future_node");
  });

  it("falls back to 'trin N' when a loaded step has an empty id", () => {
    const seqs: SeqLite[] = [{ id: "blank_steps", workspace_id: null, steps: [{ id: "" }] }];
    expect(nodeLabel("seq:blank_steps:0", seqs)).toBe("trin 0");
  });

  it("labels an arm outside ARM_META with its raw variant name", () => {
    expect(nodeLabel("arm:v9_custom", [])).toBe("v9_custom");
  });
});

// A/B workspace fixture: one arm carries leads, the other only has a matched
// follow-up sequence — both must appear in the tree.
const ARM_SEQUENCES: SeqLite[] = [
  {
    id: "v2_followups",
    workspace_id: null,
    match_first_dm_variant: "v2_short",
    steps: [{ id: "fu_1" }, { id: "fu_2" }],
  },
  // No match_first_dm_variant: in arm mode this sequence has no parent arm and
  // must not leak into the tree.
  { id: "unmatched_seq", workspace_id: null, steps: [{ id: "x_1" }] },
];

describe("classifyNode (terminal + pre-send statuses)", () => {
  it("gives every pre-send status its own tree node", () => {
    for (const status of [
      "sent", "pending_approval", "pending_alt_review", "rendered", "rendering",
      "pending_pre_render", "pending_ai_draft", "pre_connected", "accepted",
    ]) {
      expect(classifyNode(row({ status }))).toBe(status);
    }
  });

  it("buckets terminal statuses and a reply with no intent into outcomes", () => {
    expect(classifyNode(row({ status: "rejected" }))).toBe("rejected");
    expect(classifyNode(row({ status: "rejected_by_icp" }))).toBe("rejected_by_icp");
    expect(classifyNode(row({ status: "failed" }))).toBe("failed");
    // A reply whose intent was never classified still counts as a reply.
    expect(classifyNode(row({ last_reply_at: "2026-06-01T00:00:00Z" }))).toBe("reply:other");
  });
});

describe("OUTCOME_DEFS", () => {
  it("has a strip bucket for every outcome id classifyNode can return", () => {
    const defined = new Set(OUTCOME_DEFS.map((o) => o.id));
    const reachable = [
      ...["interested", "question", "referral", "ooo", "decline", "banana"].map((intent) =>
        classifyNode(row({ last_reply_at: "2026-06-01T00:00:00Z", last_reply_intent: intent })),
      ),
      classifyNode(row({ status: "rejected" })),
      classifyNode(row({ status: "rejected_by_icp" })),
      classifyNode(row({ status: "failed" })),
      classifyNode(row({ sequence_completed_at: "2026-06-01T00:00:00Z" })),
    ];
    for (const id of reachable) expect(defined).toContain(id);
  });
});

describe("buildTreeNodes", () => {
  it("builds the non-arm spine with each sequence chained below Sendt", () => {
    const nodes = buildTreeNodes(SEQUENCES, [row()], []);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const id of ["invited", "accepted", "pending_approval", "sent"]) {
      expect(byId.has(id)).toBe(true);
    }
    // Steps stack straight down their own lane: col 5 + stepIndex.
    expect(byId.get("seq:hiring_signal_v1:0")).toMatchObject({ col: 5, kind: "sequence", label: "opfolgning_1" });
    expect(byId.get("seq:hiring_signal_v1:1")).toMatchObject({ col: 6, label: "opfolgning_2" });
  });

  it("synthesizes a node for rows at a step with no loaded definition, but not for completed ones", () => {
    const rows = [
      row({ sequence_id: "ghost_seq", sequence_step: 2 }),
      row({ sequence_id: "done_seq", sequence_step: 0, sequence_completed_at: "2026-06-01T00:00:00Z" }),
    ];
    const nodes = buildTreeNodes([], rows, []);
    const ghost = nodes.find((n) => n.id === "seq:ghost_seq:2");
    expect(ghost).toMatchObject({ label: "trin 2", col: 7, kind: "sequence" });
    expect(nodes.some((n) => n.id.startsWith("seq:done_seq"))).toBe(false);
  });

  it("switches to arm mode: invited forks into arms, each arm chains its own follow-ups", () => {
    const rows = [row({ first_dm_variant: "v1_long" })];
    const nodes = buildTreeNodes(ARM_SEQUENCES, rows, []);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get("arm:v1_long")?.kind).toBe("arm");
    expect(byId.get("arm:v2_short")?.kind).toBe("arm");
    // v2's follow-ups live in v2's lane, stacked below the arm.
    expect(byId.get("seq:v2_followups:0")).toMatchObject({ col: 2, arm: "v2_short", lane: 1 });
    expect(byId.get("seq:v2_followups:1")).toMatchObject({ col: 3, arm: "v2_short" });
    // No render spine, no stray Sendt, no orphan sequence.
    expect(byId.has("sent")).toBe(false);
    expect(byId.has("accepted")).toBe(false);
    expect(nodes.some((n) => n.id.startsWith("seq:unmatched_seq"))).toBe(false);
  });

  it("spreads multiple sequences in one arm across sub-lanes around the arm's lane", () => {
    const twoSeqs: SeqLite[] = [
      { id: "seq_a", workspace_id: null, match_first_dm_variant: "v1_long", steps: [{ id: "a_1" }] },
      { id: "seq_b", workspace_id: null, match_first_dm_variant: "v1_long", steps: [{ id: "b_1" }] },
    ];
    const nodes = buildTreeNodes(twoSeqs, [], []);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // armIdx 0 ± 0.25 — both chains stay visually attached to their arm.
    expect(byId.get("seq:seq_a:0")?.lane).toBe(-0.25);
    expect(byId.get("seq:seq_b:0")?.lane).toBe(0.25);
  });

  it("renders an arm outside ARM_META with its raw variant name and empty sublabel", () => {
    const nodes = buildTreeNodes([], [row({ first_dm_variant: "v9_custom" })], []);
    const arm = nodes.find((n) => n.id === "arm:v9_custom");
    expect(arm).toMatchObject({ label: "v9_custom", sublabel: "", kind: "arm" });
  });
});

describe("buildTreeEdges", () => {
  it("wires the non-arm spine through approval into Sendt and its sequence chains", () => {
    const nodes = buildTreeNodes(SEQUENCES, [], []);
    const ids = buildTreeEdges(nodes, SEQUENCES).map((e) => e.id);
    expect(ids).toContain("invited=>accepted");
    expect(ids).toContain("rendered=>pending_approval");
    expect(ids).toContain("pending_approval=>sent");
    expect(ids).toContain("sent=>seq:hiring_signal_v1:0");
    expect(ids).toContain("seq:hiring_signal_v1:0=>seq:hiring_signal_v1:1");
  });

  it("in arm mode forks invited into every arm and chains each arm's matched sequence", () => {
    const nodes = buildTreeNodes(ARM_SEQUENCES, [row({ first_dm_variant: "v1_long" })], []);
    const ids = buildTreeEdges(nodes, ARM_SEQUENCES).map((e) => e.id);
    expect(ids).toContain("invited=>arm:v1_long");
    expect(ids).toContain("invited=>arm:v2_short");
    expect(ids).toContain("arm:v2_short=>seq:v2_followups:0");
    expect(ids).toContain("seq:v2_followups:0=>seq:v2_followups:1");
    // The unmatched sequence has no arm parent — no dangling edge to it.
    expect(ids.some((id) => id.includes("unmatched_seq"))).toBe(false);
  });

  it("never emits an edge to a node that is not in the tree", () => {
    const spineOnly: NodeDef[] = [
      { id: "invited", label: "Inviteret", col: 0, tone: "neutral", kind: "status" },
      { id: "accepted", label: "Accepteret", col: 1, tone: "neutral", kind: "status" },
    ];
    const edges = buildTreeEdges(spineOnly, SEQUENCES);
    expect(edges.map((e) => e.id)).toEqual(["invited=>accepted"]);
  });
});

describe("lookupSeqStep", () => {
  it("resolves a seq node id back to its sequence, step and index", () => {
    const hit = lookupSeqStep("seq:hiring_signal_v1:1", SEQUENCES);
    expect(hit?.seq.id).toBe("hiring_signal_v1");
    expect(hit?.step.id).toBe("opfolgning_2");
    expect(hit?.index).toBe(1);
  });

  it("returns null for non-seq ids, unknown sequences and out-of-range steps", () => {
    expect(lookupSeqStep("arm:v1_long", SEQUENCES)).toBeNull();
    expect(lookupSeqStep("seq:unknown_seq:0", SEQUENCES)).toBeNull();
    expect(lookupSeqStep("seq:hiring_signal_v1:9", SEQUENCES)).toBeNull();
  });
});

describe("activeArms", () => {
  it("unions arms from rows, stats and sequences in canonical order", () => {
    const rows = [row({ first_dm_variant: "v3_video" })];
    const stats = [{ first_dm_variant: "v1_long", assigned: 1, sent: 1, replied: 0, reply_pct: 0 }];
    const seqs: SeqLite[] = [
      { id: "s", workspace_id: null, steps: [], match_first_dm_variant: "v2_short" },
    ];
    expect(activeArms(seqs, rows, stats)).toEqual(["v1_long", "v2_short", "v3_video"]);
  });

  it("returns empty when no arm exists anywhere (non-arm workspaces)", () => {
    expect(activeArms([], [row()], [])).toEqual([]);
  });

  it("appends arms outside the canonical order after the known ones", () => {
    const rows = [row({ first_dm_variant: "v9_custom" }), row({ first_dm_variant: "v1_long" })];
    expect(activeArms([], rows, [])).toEqual(["v1_long", "v9_custom"]);
  });
});

describe("nodeLabel ↔ buildTreeNodes sync", () => {
  it("labels every status node with the exact wording the Flow tree uses", () => {
    // The Kontakter step column and Plays roster name positions via
    // nodeLabel; the tree names them via NodeDef labels. They must agree.
    const nodes = buildTreeNodes([], [], []);
    for (const n of nodes.filter((n) => n.kind === "status")) {
      expect(nodeLabel(n.id, [])).toBe(n.label);
    }
  });
});

describe("resolvePlays", () => {
  const global = { id: "video_loop", workspace_id: null, position: 100, label: "Global" };
  const override = { id: "video_loop", workspace_id: "ws-1", position: 100, label: "Override" };
  const hiring = { id: "hiring_signal", workspace_id: null, position: 50, label: "Hiring" };

  it("lets a workspace row override the global with the same id, in either arrival order", () => {
    expect(resolvePlays([global, override]).map((p) => p.label)).toEqual(["Override"]);
    expect(resolvePlays([override, global]).map((p) => p.label)).toEqual(["Override"]);
  });

  it("sorts the resolved set by position", () => {
    expect(resolvePlays([global, hiring]).map((p) => p.id)).toEqual(["hiring_signal", "video_loop"]);
  });
});

describe("playStats", () => {
  const statRow = (overrides: Partial<FlowRow> & { play: string | null }) => ({
    ...row(), ...overrides,
  });

  it("counts a replied contact as svar but not aktiv", () => {
    const rows = [statRow({ play: "p1", sent_at: "2026-06-01T00:00:00Z", last_reply_at: "2026-06-02T00:00:00Z" })];
    expect(playStats(["p1"], rows).get("p1")).toMatchObject({ sent: 1, replied: 1, active: 0 });
  });

  it("excludes terminal and sequence-completed rows from aktiv", () => {
    const rows = [
      statRow({ play: "p1", status: "rejected" }),
      statRow({ play: "p1", status: "failed" }),
      statRow({ play: "p1", status: "sent", sequence_completed_at: "2026-06-01T00:00:00Z" }),
      statRow({ play: "p1", status: "pending_approval" }),
    ];
    expect(playStats(["p1"], rows).get("p1")).toMatchObject({ active: 1 });
  });

  it("drops rows whose play is not in the requested set", () => {
    const rows = [statRow({ play: "ghost_play", status: "sent" })];
    const m = playStats(["p1"], rows);
    expect(m.get("p1")).toMatchObject({ pipe: [], active: 0 });
    expect(m.has("ghost_play")).toBe(false);
  });
});

describe("scopeSequencesToPlay", () => {
  const seqs: SeqLite[] = [
    { id: "watched_followup_v1", workspace_id: null, steps: [{ id: "nysgerrig" }] },
    { id: "unwatched_followup_v1", workspace_id: null, steps: [{ id: "qualifier" }] },
    { id: "hiring_signal_v1", workspace_id: null, steps: [{ id: "opfolgning_1" }] },
  ];

  it("keeps only lanes holding the scoped contacts", () => {
    const scoped = [{ sequence_id: "watched_followup_v1" }, { sequence_id: null }];
    expect(scopeSequencesToPlay(seqs, scoped).map((s) => s.id)).toEqual(["watched_followup_v1"]);
  });

  it("keeps the play's trigger sequence even with zero enrolled contacts", () => {
    expect(scopeSequencesToPlay(seqs, [], "hiring_signal_v1").map((s) => s.id)).toEqual([
      "hiring_signal_v1",
    ]);
  });

  it("drops every lane for a play with no sequences and no trigger (hiring today)", () => {
    expect(scopeSequencesToPlay(seqs, [{ sequence_id: null }], null)).toEqual([]);
  });
});
