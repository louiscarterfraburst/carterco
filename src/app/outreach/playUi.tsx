"use client";

// Play filter pills shared by the Flow and Kontakter tabs. Extracted from
// page.tsx so the visibility/count rules are unit-testable (page.tsx itself
// can't export non-page symbols under the app router).

export type PlayPillItem = { id: string; label: string };

export function PlayPills({ plays, value, onChange, countFor }: {
  plays: PlayPillItem[];
  value: string;
  onChange: (playId: string) => void;
  countFor: (playId: string) => number;
}) {
  if (plays.length < 2 && value === "all") return null;
  const pill = (id: string, label: string, count: number) => (
    <button key={id} type="button" onClick={() => onChange(id)}
      className={`focus-cream tabular rounded-full border px-2.5 py-1 text-[11px] uppercase tracking-[0.12em] transition ${
        value === id
          ? "border-[var(--ink)]/40 bg-[var(--sand)]/60 text-[var(--ink)]"
          : "border-[var(--ink)]/15 text-[var(--ink)]/50 hover:border-[var(--ink)]/30"
      }`}>
      {label}<span className="ml-1.5 text-[var(--ink)]/40">{count}</span>
    </button>
  );
  return (
    <div className="mb-4 flex flex-wrap items-center gap-1.5">
      <span className="tabular mr-1 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/40">Play</span>
      {pill("all", "Alle", countFor("all"))}
      {plays.map((p) => pill(p.id, p.label, countFor(p.id)))}
    </div>
  );
}
