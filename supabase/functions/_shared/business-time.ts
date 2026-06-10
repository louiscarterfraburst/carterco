// Business-time math in Europe/Copenhagen — used by the sequence engine to
// keep follow-ups off Saturdays, Sundays, Danish public holidays, and
// after-hours times.
//
// Semantics:
//   addBusinessHours(start, hours)
//     - Whole 24h chunks count as "one business day" — weekends and DK
//       helligdage are SKIPPED, not consumed. waitHours=72 on a Friday
//       means "wait 3 business days," i.e. resume Wednesday.
//     - Remainder hours (e.g. waitHours=12) are added wall-clock, then
//       the result is clamped forward to the next business-hours window.
//   clampToBusinessTime(d)
//     - If d falls on a weekend, DK holiday, or outside 09:00–17:00 CPH,
//       slide forward to the next business-hours start (next weekday
//       09:00 in CPH). Otherwise return d unchanged.
//
// All TZ math goes through Intl with timeZone='Europe/Copenhagen' so DST
// transitions are handled automatically.

const TZ = "Europe/Copenhagen";
const BUSINESS_START_HOUR = 9;
const BUSINESS_END_HOUR = 17;
const DAY_MS = 24 * 3600_000;

type CphParts = {
    y: number;
    m: number;
    day: number;
    weekday: number; // 0 = Sun, 1 = Mon, ..., 6 = Sat
    hour: number;
    minute: number;
};

const partsFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
});

const WEEKDAY_MAP: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function getCphParts(d: Date): CphParts {
    const parts = partsFmt.formatToParts(d);
    const get = (k: string) => parts.find((p) => p.type === k)?.value ?? "";
    return {
        y: Number(get("year")),
        m: Number(get("month")),
        day: Number(get("day")),
        weekday: WEEKDAY_MAP[get("weekday")] ?? 0,
        hour: Number(get("hour")),
        minute: Number(get("minute")),
    };
}

// Construct a UTC Date such that, viewed in Europe/Copenhagen, the
// wall-clock reads (y, m, d, h, mi). Handles both winter (+01) and summer
// (+02) by computing the actual local offset of a guess and correcting it.
function cphLocalToUtc(y: number, m: number, d: number, h: number, mi: number): Date {
    const targetUtcMs = Date.UTC(y, m - 1, d, h, mi, 0);
    let u = new Date(targetUtcMs);
    for (let i = 0; i < 2; i++) {
        const p = getCphParts(u);
        const localAsUtcMs = Date.UTC(p.y, p.m - 1, p.day, p.hour, p.minute, 0);
        const offsetMs = localAsUtcMs - u.getTime();
        const next = new Date(targetUtcMs - offsetMs);
        if (next.getTime() === u.getTime()) return next;
        u = next;
    }
    return u;
}

// Meeus/Jones/Butcher Gregorian Easter algorithm. Returns the month/day of
// Easter Sunday for the given year.
function easterSunday(year: number): { m: number; d: number } {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const mm = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * mm + 114) / 31);
    const day = ((h + l - 7 * mm + 114) % 31) + 1;
    return { m: month, d: day };
}

// Build the DK helligdag set for a year as MM-DD strings (UTC-based since
// holidays are full calendar days regardless of DST).
//
// Includes: Nytårsdag, Skærtorsdag, Langfredag, Påskedag, 2. Påskedag,
// Kr. Himmelfart, Pinsedag, 2. Pinsedag, Juleaftensdag, Juledag,
// 2. Juledag, Nytårsaftensdag. Store Bededag (abolished 2024) is NOT
// included. Christmas/New Year's Eve are treated as holidays — standard
// DK business practice closes both half/full days.
const holidayCache = new Map<number, Set<string>>();
function dkHolidays(year: number): Set<string> {
    const cached = holidayCache.get(year);
    if (cached) return cached;

    const easter = easterSunday(year);
    const easterUtc = Date.UTC(year, easter.m - 1, easter.d);
    const fmt = (ms: number) => {
        const d = new Date(ms);
        return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${
            String(d.getUTCDate()).padStart(2, "0")
        }`;
    };

    const set = new Set<string>([
        "01-01",
        fmt(easterUtc - 3 * DAY_MS),
        fmt(easterUtc - 2 * DAY_MS),
        fmt(easterUtc),
        fmt(easterUtc + 1 * DAY_MS),
        fmt(easterUtc + 39 * DAY_MS),
        fmt(easterUtc + 49 * DAY_MS),
        fmt(easterUtc + 50 * DAY_MS),
        "12-24",
        "12-25",
        "12-26",
        "12-31",
    ]);
    holidayCache.set(year, set);
    return set;
}

function isDkHoliday(p: CphParts): boolean {
    const key = `${String(p.m).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
    return dkHolidays(p.y).has(key);
}

function isWeekend(p: CphParts): boolean {
    return p.weekday === 0 || p.weekday === 6;
}

function isBusinessDay(p: CphParts): boolean {
    return !isWeekend(p) && !isDkHoliday(p);
}

// Slide d forward to the start of the next window (startHour–endHour CPH on
// a business day) if it's outside one. If d is already inside, returns d
// unchanged. The send queue uses a wider window (08–18) than the sequence
// engine's default (09–17), hence the parameters.
export function clampToWindow(d: Date, startHour: number, endHour: number): Date {
    let cur = d;
    for (let i = 0; i < 30; i++) {
        const p = getCphParts(cur);
        if (!isBusinessDay(p)) {
            cur = cphLocalToUtc(p.y, p.m, p.day, startHour, 0);
            cur = new Date(cur.getTime() + DAY_MS);
            continue;
        }
        if (p.hour < startHour) {
            cur = cphLocalToUtc(p.y, p.m, p.day, startHour, 0);
            continue;
        }
        if (p.hour >= endHour) {
            const tomorrow = new Date(
                cphLocalToUtc(p.y, p.m, p.day, startHour, 0).getTime() + DAY_MS,
            );
            cur = tomorrow;
            continue;
        }
        return cur;
    }
    return cur;
}

// Slide d forward to the start of the next business-hours window if it's
// outside one. If d is already within 09:00–17:00 CPH on a business day,
// returns d unchanged.
export function clampToBusinessTime(d: Date): Date {
    return clampToWindow(d, BUSINESS_START_HOUR, BUSINESS_END_HOUR);
}

// Calendar-day key (YYYY-MM-DD) as seen in Copenhagen — the send queue's
// daily cap counts sends per CPH day, not per UTC day.
export function cphDayKey(d: Date): string {
    const p = getCphParts(d);
    return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

// Advance d by exactly one business day in CPH: +24h, then keep adding 24h
// until we land on a non-weekend, non-holiday calendar day.
function addOneBusinessDay(d: Date): Date {
    let next = new Date(d.getTime() + DAY_MS);
    for (let i = 0; i < 14; i++) {
        const p = getCphParts(next);
        if (isBusinessDay(p)) return next;
        next = new Date(next.getTime() + DAY_MS);
    }
    return next;
}

// Add `hours` of business time to `start`. Whole 24h chunks each consume
// one business day (weekends/holidays skipped, not consumed); leftover
// hours are added wall-clock, then the result is clamped to a business-
// hours window.
export function addBusinessHours(start: Date, hours: number): Date {
    if (hours <= 0) return clampToBusinessTime(start);

    const wholeDays = Math.floor(hours / 24);
    const remainderHours = hours - wholeDays * 24;

    let cur = start;
    for (let i = 0; i < wholeDays; i++) cur = addOneBusinessDay(cur);
    if (remainderHours > 0) {
        cur = new Date(cur.getTime() + remainderHours * 3600_000);
    }
    return clampToBusinessTime(cur);
}
