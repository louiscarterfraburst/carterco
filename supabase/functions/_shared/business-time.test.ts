import { describe, expect, it } from "vitest";
import { clampToBusinessTime, clampToWindow, cphDayKey } from "./business-time";

// Regression guard for the 20260610 refactor: clampToBusinessTime used to own
// the clamp loop with hardcoded 09–17; it now delegates to the parameterized
// clampToWindow (which the send queue calls with 08–18). The sequence
// engine's semantics must be byte-identical to before the refactor.

function cphHour(d: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Copenhagen",
      hour: "2-digit",
      hour12: false,
    }).format(d),
  );
}

describe("clampToBusinessTime (post-refactor regression)", () => {
  it("keeps a weekday time inside 09:00–17:00 CPH unchanged", () => {
    const d = new Date("2026-06-10T10:00:00Z"); // Wed 12:00 CPH
    expect(clampToBusinessTime(d).getTime()).toBe(d.getTime());
  });

  it("still clamps to the sequence engine's 09:00 start, not the queue's 08:00", () => {
    const early = new Date("2026-06-10T05:30:00Z"); // Wed 07:30 CPH
    const clamped = clampToBusinessTime(early);
    expect(cphDayKey(clamped)).toBe("2026-06-10");
    expect(cphHour(clamped)).toBe(9);
  });

  it("still rolls 17:00+ to the next weekday morning, not 18:00", () => {
    const evening = new Date("2026-06-10T15:30:00Z"); // Wed 17:30 CPH
    const clamped = clampToBusinessTime(evening);
    expect(cphDayKey(clamped)).toBe("2026-06-11");
    expect(cphHour(clamped)).toBe(9);
  });

  it("slides a weekend time to Monday 09:00 CPH", () => {
    const saturday = new Date("2026-06-13T10:00:00Z");
    const clamped = clampToBusinessTime(saturday);
    expect(cphDayKey(clamped)).toBe("2026-06-15"); // Monday
    expect(cphHour(clamped)).toBe(9);
  });
});

describe("clampToWindow (holiday handling for the send queue)", () => {
  it("skips the DK Christmas block to the next business day at window start", () => {
    // 2026-12-24 (Thu) through 12-26 (Sat) are holidays, 12-27 a Sunday —
    // the first business day is Monday 12-28.
    const juleaften = new Date("2026-12-24T11:00:00Z"); // 12:00 CPH, juleaftensdag
    const clamped = clampToWindow(juleaften, 8, 18);
    expect(cphDayKey(clamped)).toBe("2026-12-28");
    expect(cphHour(clamped)).toBe(8);
  });

  it("respects a custom window's own start hour when clamping", () => {
    const early = new Date("2026-06-10T04:30:00Z"); // Wed 06:30 CPH
    const clamped = clampToWindow(early, 8, 18);
    expect(cphDayKey(clamped)).toBe("2026-06-10");
    expect(cphHour(clamped)).toBe(8);
  });
});
