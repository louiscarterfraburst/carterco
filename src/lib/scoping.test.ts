import { describe, expect, it } from "vitest";
import { formatScopingNote } from "./scoping";

describe("formatScopingNote", () => {
  it("includes ICP and the customer-source answer", () => {
    const note = formatScopingNote(
      "Vi sælger engros til hoteller",
      "Mest henvisninger, vi har 300 gamle kunder i CRM'et",
    );
    expect(note).toContain("ICP: Vi sælger engros til hoteller");
    expect(note).toContain("Kunder kommer fra: Mest henvisninger, vi har 300 gamle kunder i CRM'et");
  });

  it("omits the source line when empty", () => {
    const note = formatScopingNote("ICP-tekst her", "");
    expect(note).not.toContain("Kunder kommer fra");
  });
});
