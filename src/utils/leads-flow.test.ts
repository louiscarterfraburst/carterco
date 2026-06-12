import { describe, expect, it } from "vitest";
import { buildLeadsFlow } from "./leads-flow";

const SOHO_WS = "7f13f551-9514-4a5a-b1bf-98eb95c1a469";

const soho = {
  id: SOHO_WS,
  name: "Soho",
  booking_url: "https://sohonetwork.spaces.nexudus.com/bookings",
  signoff: "Soho",
  sms_enabled: false,
  outcome_preset: "meeting_room",
};

const klosterstraede = {
  id: "c61aaffb-518b-4995-ac31-5a2e7300b1f2",
  name: "Klosterstræde",
  booking_url: "https://soho.dk/da-dk/kontorer/klosterstraede",
  signoff: "Soho",
  sms_enabled: false,
  outcome_preset: "meeting_room",
};

const carterco = {
  id: "carterco-ws",
  name: "CarterCo",
  booking_url: null,
  signoff: null,
  sms_enabled: true,
  outcome_preset: "standard",
};

describe("buildLeadsFlow", () => {
  it("describes the Nexudus auto-book + CAPI loop only for connected workspaces", () => {
    const sohoBooket = buildLeadsFlow(soho)
      .find((s) => s.key === "outcome")!
      .branches!.find((b) => b.label === "Booket")!;
    expect(sohoBooket.detail).toContain("Nexudus");
    expect(sohoBooket.detail).toContain("CAPI");

    const k9Booket = buildLeadsFlow(klosterstraede)
      .find((s) => s.key === "outcome")!
      .branches!.find((b) => b.label === "Booket")!;
    expect(k9Booket.detail).not.toContain("Nexudus");
    expect(k9Booket.detail).toContain("manuelt");
  });

  it("uses the workspace booking link in the email step when set", () => {
    const step = buildLeadsFlow(klosterstraede).find((s) => s.key === "no_answer")!;
    expect(step.detail).toContain("https://soho.dk/da-dk/kontorer/klosterstraede");
    expect(step.detail).toContain("“Soho”");
  });

  it("falls back to the standard template note without a booking link", () => {
    const step = buildLeadsFlow(carterco).find((s) => s.key === "no_answer")!;
    expect(step.detail).toContain("standardskabelonen");
  });

  it("includes the SMS step only when the workspace has SMS enabled", () => {
    expect(buildLeadsFlow(carterco).some((s) => s.key === "sms")).toBe(true);
    expect(buildLeadsFlow(soho).some((s) => s.key === "sms")).toBe(false);
  });

  it("splits Soho into mødelokale- and kontor-outcomes (per-lead presets)", () => {
    const steps = buildLeadsFlow(soho);
    const office = steps.find((s) => s.key === "outcome_office");
    expect(office).toBeDefined();
    expect(office!.branches!.map((b) => b.label)).toEqual([
      "Fremvisning booket",
      "Lejet",
      "Interesseret",
      "Ring tilbage",
      "Ikke relevant",
    ]);
    expect(office!.branches!.filter((b) => b.closes).map((b) => b.label)).toEqual(["Ikke relevant"]);
    // Klosterstræde keeps a single outcome step.
    expect(buildLeadsFlow(klosterstraede).some((s) => s.key === "outcome_office")).toBe(false);
  });

  it("shows preset-specific outcome buttons and exactly one closing branch", () => {
    for (const ws of [soho, carterco]) {
      const outcome = buildLeadsFlow(ws).find((s) => s.key === "outcome")!;
      const closing = outcome.branches!.filter((b) => b.closes);
      expect(closing).toHaveLength(1);
      expect(closing[0].label).toBe("Ikke relevant");
    }
    const labels = (ws: Parameters<typeof buildLeadsFlow>[0]) =>
      buildLeadsFlow(ws).find((s) => s.key === "outcome")!.branches!.map((b) => b.label);
    expect(labels(soho)).toEqual(["Delt link", "Ring tilbage", "Booket", "Ikke relevant"]);
    expect(labels(carterco)).toEqual(["Booket", "Kunde", "Interesseret", "Ikke relevant"]);
  });
});
