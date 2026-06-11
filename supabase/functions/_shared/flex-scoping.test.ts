import { describe, expect, it } from "vitest";
import { extractScopingId, formatFlexNote } from "./flex-scoping";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("extractScopingId", () => {
  it("finds the token inside a raw webhook JSON body", () => {
    const raw = JSON.stringify({
      triggerEvent: "BOOKING_CREATED",
      payload: { additionalNotes: `scoping:${ID}`, uid: "x1" },
    });
    expect(extractScopingId(raw)).toBe(ID);
  });

  it("is case-insensitive and lowercases the id", () => {
    expect(extractScopingId(`SCOPING:${ID.toUpperCase()}`)).toBe(ID);
  });

  it("returns null when no token is present", () => {
    expect(extractScopingId(JSON.stringify({ payload: { additionalNotes: "hej" } }))).toBeNull();
  });

  it("returns null for a malformed id", () => {
    expect(extractScopingId("scoping:not-a-uuid")).toBeNull();
  });
});

describe("formatFlexNote", () => {
  it("includes ICP and tried channels", () => {
    const note = formatFlexNote("Vi sælger engros til hoteller", ["Købte lister", "Selv på LinkedIn"]);
    expect(note).toContain("Flex-møde booket via carterco.dk");
    expect(note).toContain("ICP: Vi sælger engros til hoteller");
    expect(note).toContain("Har prøvet: Købte lister, Selv på LinkedIn");
  });

  it("omits the tried line when empty", () => {
    const note = formatFlexNote("ICP-tekst her", []);
    expect(note).not.toContain("Har prøvet");
  });
});
