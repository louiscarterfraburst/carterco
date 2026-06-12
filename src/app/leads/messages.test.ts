import { describe, expect, it } from "vitest";
import {
  buildSmsBody,
  firstName,
  renderSmsTemplate,
  type Branding,
  type Identity,
} from "./messages";

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
  smsTemplate: null,
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
      smsTemplate: null,
    });
    expect(body).toContain("det er Louis fra Carter & Co");
  });

  it("a workspace sms_template owns the message outright", () => {
    const body = buildSmsBody("Mette Frederiksen", OPERATOR, undefined, {
      ...KLOSTERSTRAEDE,
      smsTemplate:
        "Hej {fornavn}, det er {medarbejder} fra Soho - jeg prøvede lige at ringe ang. jeres forespørgsel om mødelokale i Klosterstræde. Du kan booke direkte her: {booking} - eller ring/skriv når det passer dig. /{medarbejder}",
    });
    expect(body).toBe(
      "Hej Mette, det er Lee fra Soho - jeg prøvede lige at ringe ang. jeres forespørgsel om mødelokale i Klosterstræde. Du kan booke direkte her: https://soho.dk/da-dk/kontorer/klosterstraede - eller ring/skriv når det passer dig. /Lee",
    );
  });

  it("template wins even without a booking link, with operator-name fallback", () => {
    const body = buildSmsBody("Mette", OPERATOR, undefined, {
      bookingUrl: null,
      signoff: null,
      companyName: "Bikenor",
      signerName: null,
      smsTemplate: "Hej {fornavn}, {medarbejder} fra {brand} her. /{medarbejder}",
    });
    expect(body).toBe("Hej Mette, Louis fra Bikenor her. /Louis");
  });
});

describe("renderSmsTemplate", () => {
  const VARS = {
    fornavn: "Mette",
    medarbejder: "Lee",
    brand: "Soho",
    booking: null,
    slots: null,
  };

  it("drops the {slots} token cleanly when no slots are configured", () => {
    const out = renderSmsTemplate("Hej {fornavn}. {slots} /{medarbejder}", VARS);
    expect(out).toBe("Hej Mette. /Lee");
  });

  it("renders the calendar question when slots exist", () => {
    const out = renderSmsTemplate("Hej {fornavn}. {slots} /{medarbejder}", {
      ...VARS,
      slots: "i morgen kl. 10",
    });
    expect(out).toBe("Hej Mette. Hvordan ser din kalender ud i morgen kl. 10? /Lee");
  });

  it("substitutes an empty string for {booking} when the workspace has none", () => {
    const out = renderSmsTemplate("Book her: {booking} /{medarbejder}", VARS);
    expect(out).toBe("Book her: /Lee");
  });
});
