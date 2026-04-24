const COPENHAGEN_TZ = "Europe/Copenhagen";

type CphParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

function toCphParts(date: Date): CphParts {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: COPENHAGEN_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const p = Object.fromEntries(
    fmt.formatToParts(date).map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  const wd: Record<string, number> = {
    Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
  };
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: p.hour === "24" ? 0 : Number(p.hour),
    minute: Number(p.minute),
    weekday: wd[p.weekday] ?? 1,
  };
}

// Return the offset (ms) between UTC and Copenhagen local at the given instant.
function cphOffsetMs(at: Date): number {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: COPENHAGEN_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const p = Object.fromEntries(
    fmt.formatToParts(at).map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  const asLocalUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour === "24" ? "0" : p.hour), Number(p.minute), Number(p.second),
  );
  return asLocalUtc - at.getTime();
}

function cphLocalToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const trial = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const offset1 = cphOffsetMs(trial);
  const first = new Date(trial.getTime() - offset1);
  const offset2 = cphOffsetMs(first);
  return new Date(trial.getTime() - offset2);
}

function addDays(parts: CphParts, days: number): CphParts {
  const anchor = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0),
  );
  anchor.setUTCDate(anchor.getUTCDate() + days);
  const next = toCphParts(anchor);
  return next;
}

export function clampToBusinessHours(iso: string): string {
  const input = new Date(iso);
  if (Number.isNaN(input.getTime())) return iso;
  const parts = toCphParts(input);
  const hourFloat = parts.hour + parts.minute / 60;

  const at9 = (p: CphParts) =>
    cphLocalToUtc(p.year, p.month, p.day, 9, 0).toISOString();

  if (parts.weekday === 6) return at9(addDays(parts, 2));
  if (parts.weekday === 7) return at9(addDays(parts, 1));
  if (hourFloat < 9) return at9(parts);
  if (hourFloat >= 17) {
    let next = addDays(parts, 1);
    if (next.weekday === 6) next = addDays(next, 2);
    else if (next.weekday === 7) next = addDays(next, 1);
    return at9(next);
  }
  return input.toISOString();
}

export function wasClamped(originalIso: string, clampedIso: string): boolean {
  return new Date(originalIso).getTime() !== new Date(clampedIso).getTime();
}
