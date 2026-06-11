import { describe, expect, it } from "vitest";
import { briefForWorkspace } from "./draft-first-message";
import {
  BIKENOR_WORKSPACE_ID,
  CARTERCO_WORKSPACE_ID,
  isAiDraftedDmWorkspace,
  ODAGROUP_WORKSPACE_ID,
  workspaceLabel,
} from "./workspaces";

describe("briefForWorkspace", () => {
  it("returns the Bikenor/PUKY brief for the Bikenor workspace", () => {
    const brief = briefForWorkspace(BIKENOR_WORKSPACE_ID);
    expect(brief).not.toBeNull();
    // The brief must carry PUKY positioning + the single strategy key, since
    // the validator (VALID_STRATEGIES) and the AI both rely on them.
    expect(brief).toContain("PUKY");
    expect(brief).toContain("kids_assortment");
  });

  it("keeps the existing OdaGroup and CarterCo briefs wired", () => {
    expect(briefForWorkspace(ODAGROUP_WORKSPACE_ID)).not.toBeNull();
    expect(briefForWorkspace(CARTERCO_WORKSPACE_ID)).not.toBeNull();
  });

  it("returns null for an unknown workspace (no brief bundled)", () => {
    expect(briefForWorkspace("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("workspaceLabel", () => {
  it("labels the Bikenor workspace", () => {
    expect(workspaceLabel(BIKENOR_WORKSPACE_ID)).toBe("Bikenor");
  });
});

describe("isAiDraftedDmWorkspace", () => {
  it("is true for the AI-drafted-DM workspaces (OdaGroup, Bikenor)", () => {
    // These two skip the SendSpark/website path in both accept handlers
    // (sendpilot-webhook + sendpilot-poll) and go to draftFirstMessage.
    expect(isAiDraftedDmWorkspace(ODAGROUP_WORKSPACE_ID)).toBe(true);
    expect(isAiDraftedDmWorkspace(BIKENOR_WORKSPACE_ID)).toBe(true);
  });

  it("is false for video-render workspaces and null/unknown", () => {
    expect(isAiDraftedDmWorkspace(CARTERCO_WORKSPACE_ID)).toBe(false);
    expect(isAiDraftedDmWorkspace(null)).toBe(false);
    expect(isAiDraftedDmWorkspace(undefined)).toBe(false);
    expect(isAiDraftedDmWorkspace("00000000-0000-0000-0000-000000000000")).toBe(false);
  });
});
