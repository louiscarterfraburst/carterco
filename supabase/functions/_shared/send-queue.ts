// Slot assignment for the approved-DM drip queue. Approving a DM never sends
// it — outreach-approve stamps status='approved_queued' and a
// scheduled_send_at computed here; the outreach-send-queue cron drains due
// rows one per sender per tick. Cadence chosen by Louis (office-hours
// 2026-06-10, D5=B): 6–10 min jitter, weekdays 08:00–18:00
// Europe/Copenhagen, max 25 sends per sender per CPH day. Rationale: a batch
// approval must never produce a burst from his personal LinkedIn account.
//
// Pure logic (no Deno APIs) so vitest covers it — see send-queue.test.ts.
import { clampToWindow, cphDayKey } from "./business-time.ts";

export const QUEUE_WINDOW_START_HOUR = 8;
export const QUEUE_WINDOW_END_HOUR = 18;
export const QUEUE_MIN_GAP_MS = 6 * 60_000;
export const QUEUE_MAX_GAP_MS = 10 * 60_000;
export const QUEUE_DAILY_CAP = 25;

// One existing claim on the sender's outbox: a queued (not yet sent) slot or
// an already-sent DM. Both push the next slot; sent ones also count toward
// the daily cap.
export type SlotClaim = { at: Date };

// Compute the next send slot for a sender.
//   claims  — every approved_queued scheduled_send_at AND every sent_at from
//             today onward for this sender (past sent_at values matter only
//             for the daily cap; future queued ones also enforce spacing).
//   now     — clock injection for tests.
//   random  — [0,1) injection for tests; jitter = MIN_GAP + r*(MAX-MIN).
export function nextSendSlot(
  claims: SlotClaim[],
  now: Date,
  random: () => number = Math.random,
): Date {
  const jitter = () =>
    QUEUE_MIN_GAP_MS + random() * (QUEUE_MAX_GAP_MS - QUEUE_MIN_GAP_MS);

  const latestClaim = claims.reduce<Date | null>(
    (max, c) => (max === null || c.at > max ? c.at : max),
    null,
  );

  // Base: after the latest existing claim (spacing) or after now — whichever
  // is later — plus jitter, clamped into the send window.
  const base = latestClaim && latestClaim > now ? latestClaim : now;
  let slot = clampToWindow(new Date(base.getTime() + jitter()), QUEUE_WINDOW_START_HOUR, QUEUE_WINDOW_END_HOUR);

  // Daily cap: if the slot's CPH day already carries QUEUE_DAILY_CAP claims,
  // push to the next window start until a day with headroom is found. Bounded
  // walk — 30 iterations covers a month of fully-booked days, which the play's
  // volume (~5–15/week) never approaches.
  for (let i = 0; i < 30; i++) {
    const day = cphDayKey(slot);
    const used = claims.filter((c) => cphDayKey(c.at) === day).length;
    if (used < QUEUE_DAILY_CAP) return slot;
    // Advance one CPH day: +24h keeps the same Copenhagen wall-clock (±1h on
    // a DST boundary, which clampToWindow absorbs). NEVER floor to UTC
    // midnight here — the cap counter (cphDayKey) is Copenhagen-keyed, and
    // mixing a UTC day boundary into the walk mis-meters the cap around
    // midnight and DST transitions.
    slot = clampToWindow(
      new Date(slot.getTime() + 24 * 3600_000 + jitter()),
      QUEUE_WINDOW_START_HOUR,
      QUEUE_WINDOW_END_HOUR,
    );
  }
  return slot;
}
