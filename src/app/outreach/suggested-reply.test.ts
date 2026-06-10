import { describe, expect, it } from "vitest";
import { resolveGenerateOutcome } from "./suggested-reply";

// Regression: 2026-06-10 — "Generér svar" looked dead because a successful
// triage with draft=null (hard decline → priority "done") produced no inline
// feedback. Every branch of the outcome contract is pinned here.
describe("resolveGenerateOutcome", () => {
  it("returns the draft when generation produced one", () => {
    const out = resolveGenerateOutcome({ ok: true, draft: "Hej Peter\n\nTak for dit svar.", action: "Svar Peter" });
    expect(out).toEqual({ kind: "draft", draft: "Hej Peter\n\nTak for dit svar." });
  });

  it("trims whitespace-only drafts down to the no-draft notice", () => {
    const out = resolveGenerateOutcome({ ok: true, draft: "   \n ", action: null });
    expect(out.kind).toBe("no_draft");
  });

  it("surfaces the triage action when the AI skipped the draft", () => {
    const out = resolveGenerateOutcome({
      ok: true,
      draft: null,
      action: "Jesper takkede høfligt og bliver hos sit bureau",
    });
    expect(out.kind).toBe("no_draft");
    if (out.kind !== "no_draft") throw new Error("unreachable");
    expect(out.notice).toContain("intet svar er nødvendigt");
    expect(out.notice).toContain("Jesper takkede høfligt");
  });

  it("falls back to a generic no-draft notice when action is missing", () => {
    const out = resolveGenerateOutcome({ ok: true, draft: null, action: null });
    expect(out.kind).toBe("no_draft");
    if (out.kind !== "no_draft") throw new Error("unreachable");
    expect(out.notice).toBe("AI'en vurderer at intet svar er nødvendigt her.");
  });

  it("maps failed generation to an inline error notice", () => {
    const out = resolveGenerateOutcome({ ok: false, draft: null, action: null });
    expect(out.kind).toBe("error");
    if (out.kind !== "error") throw new Error("unreachable");
    expect(out.notice).toContain("fejlede");
  });
});
