"use client";

import { useEffect, useState } from "react";

type Props = {
  onOpenQuiz: () => void;
  // Suppress the popup while another modal is open
  suppressed?: boolean;
};

const STORAGE_KEY = "carterco_exit_intent_shown";
const MIN_DWELL_MS = 20000; // 20s — only people who actually stayed
const MIN_SCROLL_RATIO = 0.3; // must have scrolled past ~30% of the page

function isCoarsePointer(): boolean {
  // Mobile/touch — no real exit-intent signal exists, so we skip entirely
  return window.matchMedia?.("(pointer: coarse)").matches ?? false;
}

export function ExitIntent({ onOpenQuiz, suppressed }: Props) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (suppressed) return;
    if (typeof window === "undefined") return;

    // ?exitintent=force bypasses every gate for testing
    const params = new URLSearchParams(window.location.search);
    const force = params.get("exitintent") === "force";

    if (!force) {
      // Skip touch/mobile — no reliable exit signal
      if (isCoarsePointer()) return;

      try {
        if (sessionStorage.getItem(STORAGE_KEY) === "1") {
          console.debug("[exit-intent] already shown this session");
          return;
        }
      } catch {
        // sessionStorage unavailable
      }
    }

    let dwellMet = force;
    let scrollMet = force;

    function checkArmed() {
      if (dwellMet && scrollMet) {
        console.debug("[exit-intent] armed (dwell + scroll met)");
      }
    }

    const armTimer = force
      ? null
      : setTimeout(() => {
          dwellMet = true;
          checkArmed();
        }, MIN_DWELL_MS);

    function onScroll() {
      if (scrollMet) return;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (max <= 0) {
        scrollMet = true;
        return;
      }
      const ratio = window.scrollY / max;
      if (ratio >= MIN_SCROLL_RATIO) {
        scrollMet = true;
        checkArmed();
      }
    }

    function trigger(reason: string) {
      if (!(dwellMet && scrollMet)) return;
      console.debug("[exit-intent] triggered:", reason);
      setOpen(true);
      try {
        sessionStorage.setItem(STORAGE_KEY, "1");
      } catch {
        /* ignore */
      }
      cleanup();
    }

    function onMouseOut(e: MouseEvent) {
      if (e.relatedTarget !== null) return;
      if (e.clientY <= 0) trigger("mouseout-top");
    }

    document.addEventListener("mouseout", onMouseOut);
    window.addEventListener("scroll", onScroll, { passive: true });

    if (force) {
      setTimeout(() => trigger("force"), 100);
    }

    function cleanup() {
      if (armTimer) clearTimeout(armTimer);
      document.removeEventListener("mouseout", onMouseOut);
      window.removeEventListener("scroll", onScroll);
    }

    return cleanup;
  }, [suppressed]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-4">
      <button
        type="button"
        aria-label="Luk"
        onClick={() => setOpen(false)}
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
      />
      <div className="relative z-10 flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-[var(--cream)]/10 bg-[#14110d] shadow-[0_40px_120px_rgba(0,0,0,0.6)]">
        <div className="flex items-center justify-end px-6 pt-5">
          <button
            type="button"
            aria-label="Luk"
            onClick={() => setOpen(false)}
            className="rounded-full border border-[var(--cream)]/15 p-2 text-[var(--cream)]/50 transition hover:border-[#ff6b2c] hover:text-[#ff6b2c]"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M1 1L13 13M13 1L1 13"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className="px-7 pb-8 pt-2 text-[var(--cream)]">
          <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--cream)]/45">
            Inden du går
          </p>
          <h2 className="font-display mt-3 text-3xl leading-[1.05]">
            Jeg har et tal til dig.
          </h2>
          <p className="mt-4 text-[15px] leading-relaxed text-[var(--cream)]/75">
            Svar på 5 spørgsmål — så regner jeg hvor meget du mister.
          </p>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onOpenQuiz();
            }}
            className="mt-6 inline-flex w-full items-center justify-center rounded-full bg-[#ff6b2c] px-5 py-3 text-sm font-medium text-[#14110d] transition hover:bg-[#ff8451]"
          >
            Tag lead-quizzen →
          </button>
        </div>
      </div>
    </div>
  );
}
