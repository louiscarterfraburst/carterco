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
  it("includes ICP and the customer-source free text", () => {
    const note = formatFlexNote({
      icp: "Vi sælger engros til hoteller",
      customerSource: "Mest henvisninger, vi har 300 gamle kunder i CRM'et",
    });
    expect(note).toContain("Flex-møde booket via carterco.dk");
    expect(note).toContain("ICP: Vi sælger engros til hoteller");
    expect(note).toContain("Kunder kommer fra: Mest henvisninger, vi har 300 gamle kunder i CRM'et");
  });

  it("falls back to the old tried line for pre-pivot rows", () => {
    const note = formatFlexNote({
      icp: "ICP-tekst her",
      customerSource: null,
      tried: ["Købte lister", "Selv på LinkedIn"],
    });
    expect(note).toContain("Har prøvet: Købte lister, Selv på LinkedIn");
    expect(note).not.toContain("Kunder kommer fra");
  });

  it("prefers customerSource over tried when both exist", () => {
    const note = formatFlexNote({
      icp: "ICP-tekst her",
      customerSource: "Kold opsøgning",
      tried: ["Købte lister"],
    });
    expect(note).toContain("Kunder kommer fra: Kold opsøgning");
    expect(note).not.toContain("Har prøvet");
  });

  it("omits the source line when both are empty", () => {
    const note = formatFlexNote({ icp: "ICP-tekst her", customerSource: "", tried: [] });
    expect(note).not.toContain("Kunder kommer fra");
    expect(note).not.toContain("Har prøvet");
  });
});
