import { describe, expect, it } from "vitest";
import {
  nextSendSlot,
  QUEUE_DAILY_CAP,
  QUEUE_MAX_GAP_MS,
  QUEUE_MIN_GAP_MS,
  QUEUE_WINDOW_END_HOUR,
  QUEUE_WINDOW_START_HOUR,
} from "./send-queue";
import { clampToWindow, cphDayKey } from "./business-time";

// June 2026: Copenhagen is CEST (UTC+2). 2026-06-10 is a Wednesday,
// 2026-06-12 a Friday, 2026-06-15 the following Monday. No DK holidays.
const WED_NOON_CPH = new Date("2026-06-10T10:00:00Z"); // 12:00 CPH
const midRandom = () => 0.5; // jitter = 8 min
const MID_JITTER_MS = QUEUE_MIN_GAP_MS + 0.5 * (QUEUE_MAX_GAP_MS - QUEUE_MIN_GAP_MS);

function cphHour(d: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Copenhagen",
      hour: "2-digit",
      hour12: false,
    }).format(d),
  );
}

describe("nextSendSlot", () => {
  it("schedules now + jitter when the queue is empty inside the window", () => {
    const slot = nextSendSlot([], WED_NOON_CPH, midRandom);
    expect(slot.getTime()).toBe(WED_NOON_CPH.getTime() + MID_JITTER_MS);
  });

  it("spaces after the latest future claim, not after now", () => {
    const queued = new Date(WED_NOON_CPH.getTime() + 30 * 60_000);
    const slot = nextSendSlot([{ at: queued }], WED_NOON_CPH, midRandom);
    expect(slot.getTime()).toBe(queued.getTime() + MID_JITTER_MS);
    expect(slot.getTime() - queued.getTime()).toBeGreaterThanOrEqual(QUEUE_MIN_GAP_MS);
  });

  it("ignores past claims for spacing (they only matter for the cap)", () => {
    const sentEarlier = new Date(WED_NOON_CPH.getTime() - 2 * 3600_000);
    const slot = nextSendSlot([{ at: sentEarlier }], WED_NOON_CPH, midRandom);
    expect(slot.getTime()).toBe(WED_NOON_CPH.getTime() + MID_JITTER_MS);
  });

  it("clamps an after-hours approval to the next morning window", () => {
    const lateEvening = new Date("2026-06-10T18:30:00Z"); // 20:30 CPH
    const slot = nextSendSlot([], lateEvening, midRandom);
    expect(cphDayKey(slot)).toBe("2026-06-11");
    expect(cphHour(slot)).toBe(QUEUE_WINDOW_START_HOUR);
  });

  it("rolls a Friday-evening approval over the weekend to Monday", () => {
    const fridayEvening = new Date("2026-06-12T16:55:00Z"); // 18:55 CPH, after window
    const slot = nextSendSlot([], fridayEvening, midRandom);
    expect(cphDayKey(slot)).toBe("2026-06-15"); // Monday
  });

  it("pushes past a day that already carries the daily cap", () => {
    const claims = Array.from({ length: QUEUE_DAILY_CAP }, (_, i) => ({
      at: new Date(WED_NOON_CPH.getTime() - i * 60_000),
    }));
    const slot = nextSendSlot(claims, WED_NOON_CPH, midRandom);
    expect(cphDayKey(slot)).toBe("2026-06-11");
  });

  it("never lands outside the send window", () => {
    // Sweep approvals across a full day at random jitter; every slot must be
    // a weekday between window start and end in CPH.
    for (let h = 0; h < 24; h++) {
      const t = new Date(Date.UTC(2026, 5, 13, h, 17)); // a Saturday
      const slot = nextSendSlot([], t, Math.random);
      const hour = cphHour(slot);
      expect(hour).toBeGreaterThanOrEqual(QUEUE_WINDOW_START_HOUR);
      expect(hour).toBeLessThan(QUEUE_WINDOW_END_HOUR);
      expect(["2026-06-13", "2026-06-14"]).not.toContain(cphDayKey(slot));
    }
  });
});

describe("clampToWindow / cphDayKey", () => {
  it("keeps an in-window time unchanged", () => {
    const d = new Date("2026-06-10T10:00:00Z");
    expect(clampToWindow(d, 8, 18).getTime()).toBe(d.getTime());
  });

  it("uses the Copenhagen calendar day, not UTC", () => {
    // 23:30 UTC on the 10th is 01:30 CPH on the 11th.
    expect(cphDayKey(new Date("2026-06-10T23:30:00Z"))).toBe("2026-06-11");
  });
});
