"use client";

import { useState } from "react";

// Extracted from page.tsx so the pick/clear state machine is unit-testable.
//
// INVARIANT: nothing is written until the receptionist confirms. The old
// implementation cleared the outcome the moment the (selected) button was
// tapped — "so the UI shows the picker" — which nulled next_action_at and
// changed which list the lead lives in WHILE the picker was open: the row
// unmounted mid-pick (the "lead disappears while choosing a callback time"
// bug), and Afbryd silently lost the existing aftale. Now the picker is
// gated on local state only; OK commits via onPick, Afbryd is lossless, and
// removing the aftale is its own explicit action (onClear).

export type CallbackTone = { dot: string; text: string; surface: string };

export function toDatetimeLocal(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function CallbackOutcomeButton({
  selected,
  callbackAt,
  formatTime,
  tone,
  onPick,
  onClear,
}: {
  selected: boolean;
  callbackAt: string | null;
  formatTime: (iso: string) => string;
  tone: CallbackTone;
  onPick: (isoTime: string) => void;
  onClear: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const [draftValue, setDraftValue] = useState("");

  if (picking) {
    return (
      <div className="col-span-2 flex flex-col gap-2 rounded-sm border border-[var(--clay)]/40 bg-[var(--clay)]/[0.06] p-3">
        <label className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--clay)]">
          Ring tilbage — vælg tidspunkt
        </label>
        <div className="flex items-center gap-2">
          <input
            type="datetime-local"
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
            className="focus-cream flex-1 rounded-sm border border-[var(--ink)]/15 bg-transparent px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--clay)]"
          />
          <button
            type="button"
            onClick={() => {
              if (!draftValue) return;
              const iso = new Date(draftValue).toISOString();
              onPick(iso);
              setPicking(false);
            }}
            disabled={!draftValue}
            className="rounded-sm bg-[var(--forest)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--cream)] transition hover:bg-[#2f5e4e] disabled:opacity-40"
          >
            OK
          </button>
          <button
            type="button"
            onClick={() => {
              setPicking(false);
              setDraftValue("");
            }}
            className="rounded-sm border border-[var(--ink)]/15 px-3 py-2 text-[10px] uppercase tracking-[0.2em] text-[var(--ink)]/60 transition hover:text-[var(--ink)]"
          >
            Afbryd
          </button>
        </div>
        {selected ? (
          <button
            type="button"
            onClick={() => {
              onClear();
              setPicking(false);
              setDraftValue("");
            }}
            className="self-start text-[10px] uppercase tracking-[0.2em] text-[var(--clay)]/80 underline-offset-4 transition hover:text-[var(--clay)] hover:underline"
          >
            Fjern aftalen
          </button>
        ) : null}
      </div>
    );
  }

  if (selected) {
    return (
      <button
        type="button"
        onClick={() => {
          setPicking(true);
          setDraftValue(callbackAt ? toDatetimeLocal(callbackAt) : "");
        }}
        className={`focus-cream flex items-center justify-between gap-3 rounded-sm border border-transparent ${tone.surface} ${tone.text} px-3 py-3 text-left text-[11px] uppercase tracking-[0.16em] transition`}
      >
        <span className="flex flex-col items-start">
          <span>Ring tilbage</span>
          {callbackAt ? (
            <span className="tabular mt-0.5 text-[9px] text-[var(--ink)]/55 normal-case tracking-normal">
              {formatTime(callbackAt)}
            </span>
          ) : null}
        </span>
        <span
          aria-hidden
          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`}
        />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setPicking(true)}
      className="focus-cream flex items-center justify-between gap-3 rounded-sm border border-[var(--ink)]/10 px-3 py-3 text-left text-[11px] uppercase tracking-[0.16em] text-[var(--ink)]/65 transition hover:border-[var(--ink)]/30 hover:text-[var(--ink)]"
    >
      <span>Ring tilbage</span>
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ink)]/15"
      />
    </button>
  );
}
