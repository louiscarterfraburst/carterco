import { describe, expect, it } from "vitest";
import { sendpilotKeyFor } from "./sendpilot-creds";
import { BIKENOR_WORKSPACE_ID, CARTERCO_WORKSPACE_ID } from "./workspaces";

const env = (map: Record<string, string>) => (k: string) => map[k];

describe("sendpilotKeyFor", () => {
  it("uses Nikolaj's own key for the Bikenor workspace", () => {
    const reader = env({
      SENDPILOT_API_KEY: "sp_carterco",
      SENDPILOT_API_KEY_BIKENOR: "sp_nikolaj",
    });
    expect(sendpilotKeyFor(BIKENOR_WORKSPACE_ID, reader)).toBe("sp_nikolaj");
  });

  it("returns '' for Bikenor when its key is unset — never the global key", () => {
    // Critical safety: a missing Bikenor key must BLOCK the send (empty string),
    // not silently fall back to CarterCo's account and send from the wrong LinkedIn.
    const reader = env({ SENDPILOT_API_KEY: "sp_carterco" });
    expect(sendpilotKeyFor(BIKENOR_WORKSPACE_ID, reader)).toBe("");
  });

  it("uses the global key for existing tenants", () => {
    const reader = env({
      SENDPILOT_API_KEY: "sp_carterco",
      SENDPILOT_API_KEY_BIKENOR: "sp_nikolaj",
    });
    expect(sendpilotKeyFor(CARTERCO_WORKSPACE_ID, reader)).toBe("sp_carterco");
  });

  it("uses the global key for a null/unknown workspace", () => {
    const reader = env({ SENDPILOT_API_KEY: "sp_carterco" });
    expect(sendpilotKeyFor(null, reader)).toBe("sp_carterco");
    expect(sendpilotKeyFor("00000000-0000-0000-0000-000000000000", reader)).toBe("sp_carterco");
  });
});
