import { describe, expect, it } from "vitest";
import { playStats, resolvePlays, type PlayLite, type PlayStatRow } from "./flow";

// These two functions produce the Plays tab headline numbers (aktive / sendt /
// svar). page.tsx leans on them being correct — the counting rules live here,
// not in the component.

function play(id: string, workspace_id: string | null, position: number): PlayLite {
  return { id, workspace_id, position };
}

function row(overrides: Partial<PlayStatRow> = {}): PlayStatRow {
  return {
    play: "lead_flow",
    status: "sent",
    sent_at: null,
    last_reply_at: null,
    sequence_completed_at: null,
    ...overrides,
  };
}

describe("resolvePlays", () => {
  it("lets a workspace row override the global row with the same id, global first", () => {
    const resolved = resolvePlays([play("hiring", null, 1), play("hiring", "ws1", 1)]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].workspace_id).toBe("ws1");
  });

  it("lets a workspace row override regardless of arrival order, workspace first", () => {
    const resolved = resolvePlays([play("hiring", "ws1", 1), play("hiring", null, 1)]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].workspace_id).toBe("ws1");
  });

  it("never downgrades a workspace row back to a later global duplicate", () => {
    const resolved = resolvePlays([
      play("hiring", "ws1", 1),
      play("hiring", null, 1),
      play("hiring", null, 1),
    ]);
    expect(resolved[0].workspace_id).toBe("ws1");
  });

  it("sorts the resolved set by position", () => {
    const resolved = resolvePlays([play("b", null, 2), play("c", null, 3), play("a", null, 1)]);
    expect(resolved.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });
});

describe("playStats", () => {
  it("counts sent and replied independently", () => {
    const stats = playStats(["lead_flow"], [
      row({ sent_at: "2026-06-01T10:00:00Z" }),
      row({ sent_at: "2026-06-01T10:00:00Z", last_reply_at: "2026-06-02T10:00:00Z" }),
    ]);
    const s = stats.get("lead_flow")!;
    expect(s.sent).toBe(2);
    expect(s.replied).toBe(1);
  });

  it("a replied contact is svar but NOT aktiv — the reply ends the automated flow", () => {
    const stats = playStats(["lead_flow"], [
      row({ last_reply_at: "2026-06-02T10:00:00Z" }),
    ]);
    const s = stats.get("lead_flow")!;
    expect(s.replied).toBe(1);
    expect(s.active).toBe(0);
  });

  it("terminal statuses and sequence-completed rows are not aktive", () => {
    const stats = playStats(["lead_flow"], [
      row({ status: "rejected" }),
      row({ status: "rejected_by_icp" }),
      row({ status: "failed" }),
      row({ sequence_completed_at: "2026-06-03T10:00:00Z" }),
      row({ status: "invited" }),
    ]);
    const s = stats.get("lead_flow")!;
    expect(s.active).toBe(1);
    expect(s.pipe).toHaveLength(5);
  });

  it("drops rows whose play is unknown or null instead of misattributing them", () => {
    const stats = playStats(["lead_flow"], [
      row({ play: "retired_play" }),
      row({ play: null }),
      row(),
    ]);
    expect(stats.get("lead_flow")!.pipe).toHaveLength(1);
    expect(stats.has("retired_play")).toBe(false);
  });

  it("returns zeroed buckets for plays with no rows", () => {
    const stats = playStats(["hiring"], []);
    expect(stats.get("hiring")).toEqual({ pipe: [], active: 0, sent: 0, replied: 0 });
  });
});
