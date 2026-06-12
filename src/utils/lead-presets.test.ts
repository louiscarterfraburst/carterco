import { describe, expect, it } from "vitest";
import { leadOutcomePreset } from "./lead-presets";

describe("leadOutcomePreset", () => {
  it("maps Soho's mødelokale form to meeting_room", () => {
    expect(leadOutcomePreset("meeting_room", "1539910014404003")).toBe("meeting_room");
  });

  it("maps Soho's kontor form to office, overriding the workspace preset", () => {
    expect(leadOutcomePreset("meeting_room", "997952706463015")).toBe("office");
  });

  it("falls back to the workspace preset for unmapped forms", () => {
    expect(leadOutcomePreset("meeting_room", "2837412979963112")).toBe("meeting_room");
    expect(leadOutcomePreset("standard", "999")).toBe("standard");
  });

  it("falls back to the workspace preset when the lead has no form (manual/landing leads)", () => {
    expect(leadOutcomePreset("meeting_room", null)).toBe("meeting_room");
    expect(leadOutcomePreset("standard", undefined)).toBe("standard");
  });
});
