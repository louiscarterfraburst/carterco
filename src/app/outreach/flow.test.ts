import { describe, expect, it } from "vitest";
import {
  activeArms,
  classifyNode,
  nodeLabel,
  type FlowRow,
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
});
