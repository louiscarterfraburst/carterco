import { describe, expect, it } from "vitest";
import { firstNameOf, smsAckDecision, toTelavoxNumber } from "./lead-sms-ack.ts";

const SOHO = "7f13f551-9514-4a5a-b1bf-98eb95c1a469";
const SOHO_EVENTS = "9d2a8cd2-ea01-4ab0-92c5-84e4256ccca7";
const KLOSTER = "c61aaffb-518b-4995-ac31-5a2e7300b1f2";

// Tuesday 2026-06-16 10:00 CPH (08:00 UTC, CEST) — inside reception hours.
const NOW = new Date("2026-06-16T08:00:00Z");

function lead(overrides: Partial<Parameters<typeof smsAckDecision>[0]> = {}) {
  return {
    id: "l1",
    workspace_id: SOHO,
    name: "Mette Hansen",
    phone: "+4520112233",
    source: "meta_leadgen",
    is_draft: false,
    call_status: null,
    outcome: null,
    created_at: new Date(NOW.getTime() - 10 * 60 * 1000).toISOString(), // 10 min old
    meta_form_id: null as string | null,
    ...overrides,
  };
}

const base = { now: NOW, hasContact: false, hasAckAttempt: false };

describe("smsAckDecision", () => {
  it("sends after the 5-minute gate when reception has not acted", () => {
    const d = smsAckDecision(lead(), base);
    expect(d).toEqual({
      action: "send",
      to: "004520112233",
      message: "Hej Mette, tak for din henvendelse til SOHO. Vi ringer til dig snarest fra 70 13 60 00.",
    });
  });

  it("holds inside the gate so reception can act first", () => {
    const young = lead({ created_at: new Date(NOW.getTime() - 3 * 60 * 1000).toISOString() });
    expect(smsAckDecision(young, base)).toEqual({ action: "skip", reason: "inside_gate" });
  });

  it("skips when reception already acted (dial click, call status or outcome)", () => {
    expect(smsAckDecision(lead(), { ...base, hasContact: true }).action).toBe("skip");
    expect(smsAckDecision(lead({ call_status: "no_answer" }), base).action).toBe("skip");
    expect(smsAckDecision(lead({ outcome: "booked" }), base).action).toBe("skip");
  });

  it("attempts at most once per lead, even after a failed send", () => {
    expect(smsAckDecision(lead(), { ...base, hasAckAttempt: true })).toEqual({
      action: "skip",
      reason: "already_attempted",
    });
  });

  it("only covers meta leads in enabled workspaces", () => {
    expect(smsAckDecision(lead({ source: "manual_test" }), base).reason).toBe("not_meta_lead");
    expect(smsAckDecision(lead({ workspace_id: "other-ws" }), base).reason).toBe("workspace_not_enabled");
  });

  it("never texts stale leads", () => {
    const old = lead({ created_at: new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString() });
    expect(smsAckDecision(old, base)).toEqual({ action: "skip", reason: "too_old" });
  });

  it("waits for reception hours (a 02:00 lead is not texted at night)", () => {
    const night = new Date("2026-06-16T00:30:00Z"); // 02:30 CPH
    const d = smsAckDecision(
      lead({ created_at: new Date(night.getTime() - 10 * 60 * 1000).toISOString() }),
      { ...base, now: night },
    );
    expect(d).toEqual({ action: "skip", reason: "outside_hours" });
  });

  it("covers Soho Events (Telavox-dialled) without a promised number", () => {
    const d = smsAckDecision(lead({ workspace_id: SOHO_EVENTS, name: "Jonas Holm" }), base);
    expect(d).toMatchObject({ action: "send" });
    expect((d as { message: string }).message).toContain("events hos SOHO");
    expect((d as { message: string }).message).not.toContain("70 13 60 00");
  });

  it("texts Klosterstræde leads with the Klosterstræde page link, no number promise", () => {
    const d = smsAckDecision(lead({ workspace_id: KLOSTER, name: "Camilla Friis" }), base);
    expect(d).toMatchObject({ action: "send" });
    const msg = (d as { message: string }).message;
    expect(msg).toContain("https://soho.dk/da-dk/kontorer/klosterstraede");
    expect(msg).not.toContain("70 13 60 00");
  });

  it("picks the link by lead type (form) within the Soho workspace", () => {
    const cr = smsAckDecision(lead({ meta_form_id: "1539910014404003" }), base);
    expect((cr as { message: string }).message).toContain("sohonetwork.spaces.nexudus.com/bookings");
    const office = smsAckDecision(lead({ meta_form_id: "997952706463015" }), base);
    expect((office as { message: string }).message).toContain("https://soho.dk/da-dk/kontorer/kodbyen");
    const k9 = smsAckDecision(lead({ workspace_id: KLOSTER, meta_form_id: "2837412979963112" }), base);
    expect((k9 as { message: string }).message).toContain("kontorer/klosterstraede");
  });

  it("a known form id never enables a disabled workspace", () => {
    const d = smsAckDecision(lead({ workspace_id: "other-ws", meta_form_id: "1539910014404003" }), base);
    expect(d).toEqual({ action: "skip", reason: "workspace_not_enabled" });
  });
});

describe("toTelavoxNumber", () => {
  it("normalizes Danish formats to 0045", () => {
    expect(toTelavoxNumber("+45 20 11 22 33")).toBe("004520112233");
    expect(toTelavoxNumber("004520112233")).toBe("004520112233");
    expect(toTelavoxNumber("20112233")).toBe("004520112233");
  });
  it("rejects non-Danish or malformed numbers", () => {
    expect(toTelavoxNumber("+4670812345")).toBeNull();
    expect(toTelavoxNumber("12345")).toBeNull();
    expect(toTelavoxNumber(null)).toBeNull();
  });
});

describe("firstNameOf", () => {
  it("greets by first name and survives junk values", () => {
    expect(firstNameOf("Mette Hansen")).toBe("Mette");
    expect(firstNameOf("<test lead: dummy data for fulde_navn>")).toBeNull();
    expect(firstNameOf(null)).toBeNull();
  });
});
