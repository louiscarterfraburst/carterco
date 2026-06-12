import { describe, expect, it } from "vitest";
import { buildSmsBody, firstName, type Branding, type Identity } from "./messages";

const OPERATOR: Identity = {
  displayName: "Louis",
  companyName: "Carter & Co",
  calendlyUrl: "https://cal.com/x",
  signoff: "Louis",
};

const KLOSTERSTRAEDE: Branding = {
  bookingUrl: "https://soho.dk/da-dk/kontorer/klosterstraede",
  signoff: "Soho",
  companyName: "Klosterstræde",
  signerName: "Lee",
};

describe("firstName", () => {
  it("takes the first word", () => {
    expect(firstName("Mette Frederiksen")).toBe("Mette");
  });
  it("falls back to 'der' when missing", () => {
    expect(firstName(null)).toBe("der");
    expect(firstName("")).toBe("der");
  });
});

describe("buildSmsBody", () => {
  it("uses the operator identity when no workspace branding applies", () => {
    expect(buildSmsBody("Mette Frederiksen", OPERATOR)).toBe(
      "Hej Mette, det er Louis fra Carter & Co - jeg prøvede lige at ringe. /Louis",
    );
  });

  it("introduces the workspace brand + receptionist on client panels", () => {
    expect(buildSmsBody("Mette Frederiksen", OPERATOR, undefined, KLOSTERSTRAEDE)).toBe(
      "Hej Mette, det er Lee fra Soho - jeg prøvede lige at ringe. /Lee",
    );
  });

  it("never leaks the operator's company on a client panel, even when the operator taps the button", () => {
    // Regression: Louis (Carter & Co identity) working a Klosterstræde lead
    // must not produce a "fra Carter & Co" SMS.
    const body = buildSmsBody("Mette", OPERATOR, undefined, {
      ...KLOSTERSTRAEDE,
      signerName: null, // no roster name → fall back to the person, not the company
    });
    expect(body).toContain("fra Soho");
    expect(body).not.toContain("Carter & Co");
  });

  it("falls back to workspace name as brand when signoff is unset", () => {
    const body = buildSmsBody("Mette", OPERATOR, undefined, {
      ...KLOSTERSTRAEDE,
      signoff: null,
    });
    expect(body).toContain("fra Klosterstræde");
  });

  it("appends the slots line when provided", () => {
    const body = buildSmsBody("Mette", OPERATOR, "i morgen kl. 10 eller 13");
    expect(body).toContain("Hvordan ser din kalender ud i morgen kl. 10 eller 13?");
  });

  it("treats branding without a booking link as a non-client panel", () => {
    const body = buildSmsBody("Mette", OPERATOR, undefined, {
      bookingUrl: null,
      signoff: null,
      companyName: "Bikenor",
      signerName: "Nikolaj",
    });
    expect(body).toContain("det er Louis fra Carter & Co");
  });
});
