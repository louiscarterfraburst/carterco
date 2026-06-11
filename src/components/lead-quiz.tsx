"use client";

import { useEffect, useRef, useState } from "react";
import { flexBookingUrl } from "@/lib/booking";
import { ICP_MIN, ICP_MAX } from "@/lib/scoping";

// Lead Flex scoping flow (CEO plan 2026-06-10-leadflex-website-cta).
// Replaced the lead-quiz content 2026-06-11; the modal shell (chapter-marker
// header, StepShell, PrimaryButton, escape-close, reset-on-open) is reused.
//
// Flow: icp → tried → book. Persist-then-book: clicking "Book mødet" POSTs
// the two answers to /api/quiz-submit first (anonymous scoping row), then
// redirects to cal.com with only a `scoping:<id>` token in the notes.
// Alternative exit on the book step: soft-capture (email + explicit consent)
// → "done" step. Honeypot field rides along on both submits.

type Locale = "da" | "en";

type Props = {
  open: boolean;
  onClose: () => void;
  locale?: Locale;
};

type StepLabelKey = "icp" | "tried" | "book" | "done";

type CopyT = {
  step: string;
  close: string;
  next: string;
  back: string;
  unknownError: string;
  sending: string;
  stepLabels: Record<StepLabelKey, string>;
  // ICP step
  icpQuestionBefore: string;
  icpQuestionAccent: string;
  icpQuestionAfter: string;
  icpHint: string;
  icpPlaceholder: string;
  // Tried step
  triedQuestion: string;
  triedHint: string;
  triedOptions: string[];
  // Book step
  bookQuestion: string;
  bookBody: string;
  bookCta: string;
  bookNote: string;
  softToggle: string;
  softEmailPlaceholder: string;
  softNamePlaceholder: string;
  softConsentLabel: string;
  softCta: string;
  // Done step (soft-capture confirmation)
  doneHeading: string;
  doneBody: string;
};

const COPY: Record<Locale, CopyT> = {
  da: {
    step: "Trin",
    close: "Luk",
    next: "Næste →",
    back: "← Tilbage",
    unknownError: "Ukendt fejl",
    sending: "Sender…",
    stepLabels: {
      icp: "Jeres købere",
      tried: "Erfaring",
      book: "Mødet",
      done: "Tak",
    },
    icpQuestionBefore: "Hvad sælger I, og til ",
    icpQuestionAccent: "hvem",
    icpQuestionAfter: "?",
    icpHint: "To linjer er nok. Det er det jeg bruger til at kortlægge jeres marked inden mødet.",
    icpPlaceholder: "Fx: Vi sælger engros rengøringsartikler til hoteller og kantiner i hele landet",
    triedQuestion: "Hvad har I prøvet for at skaffe leads?",
    triedHint: "Vælg alt det der passer. Det former hvad jeg viser jer.",
    triedOptions: [
      "Apollo eller lignende værktøj",
      "Bureau eller lead-leverandør",
      "Købte lister",
      "Selv på LinkedIn",
      "Ikke noget endnu",
    ],
    bookQuestion: "Så er jeg klar til at finde dem.",
    bookBody: "Book 30 minutter. Inden mødet kortlægger jeg jeres marked, og på mødet deler jeg skærm og viser jer køberne live, med en grund til at række ud for hver enkelt. I beholder listen.",
    bookCta: "Book mødet →",
    bookNote: "30 min på Google Meet",
    softToggle: "Vil du hellere have det på skrift først?",
    softEmailPlaceholder: "Email",
    softNamePlaceholder: "Navn (valgfrit)",
    softConsentLabel: "I må kontakte mig på mail om det her.",
    softCta: "Skriv til mig →",
    doneHeading: "Tak. Du hører fra mig.",
    doneBody: "Jeg kigger på jeres marked og vender tilbage på mail inden for et par dage.",
  },
  en: {
    step: "Step",
    close: "Close",
    next: "Next →",
    back: "← Back",
    unknownError: "Unknown error",
    sending: "Sending…",
    stepLabels: {
      icp: "Your buyers",
      tried: "Experience",
      book: "The meeting",
      done: "Thanks",
    },
    icpQuestionBefore: "What do you sell, and to ",
    icpQuestionAccent: "whom",
    icpQuestionAfter: "?",
    icpHint: "Two lines is plenty. This is what I use to map your market before the meeting.",
    icpPlaceholder: "E.g.: We sell wholesale cleaning supplies to hotels and canteens nationwide",
    triedQuestion: "What have you tried for lead generation?",
    triedHint: "Pick everything that applies. It shapes what I show you.",
    triedOptions: [
      "Apollo or a similar tool",
      "An agency or lead vendor",
      "Bought lists",
      "LinkedIn ourselves",
      "Nothing yet",
    ],
    bookQuestion: "Then I'm ready to find them.",
    bookBody: "Book 30 minutes. Before the meeting I map your market, and on the call I share my screen and show you the buyers live, each with a reason to reach out. The list is yours to keep.",
    bookCta: "Book the meeting →",
    bookNote: "30 min on Google Meet",
    softToggle: "Rather get it in writing first?",
    softEmailPlaceholder: "Email",
    softNamePlaceholder: "Name (optional)",
    softConsentLabel: "You may contact me by email about this.",
    softCta: "Write to me →",
    doneHeading: "Thanks. You'll hear from me.",
    doneBody: "I'll look at your market and get back to you by email within a few days.",
  },
};

const STEP_KEYS = ["icp", "tried", "book", "done"] as const;

type StepKey = (typeof STEP_KEYS)[number];

const EMAIL_RE_CLIENT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LeadQuiz({ open, onClose, locale = "da" }: Props) {
  const t = COPY[locale];
  const [stepIndex, setStepIndex] = useState(0);
  const [icp, setIcp] = useState("");
  const [tried, setTried] = useState<string[]>([]);
  const [softOpen, setSoftOpen] = useState(false);
  const [softEmail, setSoftEmail] = useState("");
  const [softName, setSoftName] = useState("");
  const [consent, setConsent] = useState(false);
  // Honeypot — humans never see or fill this.
  const [website, setWebsite] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const currentStepKey: StepKey = STEP_KEYS[stepIndex];
  const isDoneStep = currentStepKey === "done";
  const totalInputSteps = STEP_KEYS.length - 1; // exclude done

  // Reset to first step when modal transitions from closed → open.
  // Ref-tracked transition so the effect's setState only fires on the edge,
  // not on every render.
  const wasOpenRef = useRef(open);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setStepIndex(0);
      setSoftOpen(false);
      setSubmitError(null);
    }
    wasOpenRef.current = open;
  }, [open]);

  // Escape closes
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  function next() {
    setStepIndex((i) => Math.min(i + 1, STEP_KEYS.length - 1));
  }
  function back() {
    setStepIndex((i) => Math.max(0, i - 1));
  }

  function toggleTried(option: string) {
    setTried((prev) =>
      prev.includes(option)
        ? prev.filter((o) => o !== option)
        : [...prev, option],
    );
  }

  // Persist-then-book: save the answers first, then send the visitor to
  // cal.com with only the scoping token in the notes. cal.com collects
  // name/email itself on the booking page.
  async function submitBooking() {
    if (submitting) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/quiz-submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "booking",
          icp: icp.trim(),
          tried,
          locale,
          website,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        id?: string;
      };
      if (!res.ok) {
        setSubmitError(data.error || `HTTP ${res.status}`);
        return;
      }
      if (!data.id) {
        setSubmitError(t.unknownError);
        return;
      }
      window.location.href = flexBookingUrl({
        scopingId: data.id,
        utm_source: "carterco.dk",
        utm_medium: "scoping",
      });
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : t.unknownError);
    } finally {
      setSubmitting(false);
    }
  }

  async function submitSoftCapture() {
    if (submitting) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/quiz-submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "soft_capture",
          icp: icp.trim(),
          tried,
          email: softEmail.trim(),
          name: softName.trim() || undefined,
          consent,
          locale,
          website,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setSubmitError(data.error || `HTTP ${res.status}`);
        return;
      }
      next();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : t.unknownError);
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        aria-hidden
        className="absolute inset-0 bg-black/80 backdrop-blur-md"
      />
      <div className="relative z-10 flex max-h-[92vh] w-[calc(100%-2rem)] max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--cream)]/10 bg-[#14110d] text-[var(--cream)] shadow-[0_40px_120px_rgba(0,0,0,0.6)]">
        {/* Header — editorial chapter marker. Big serif italic numeral +
            mono caption (kept from the quiz shell). On the done step we drop
            the numeral and just show the step label. */}
        <div className="flex items-baseline justify-between px-8 pt-6">
          {isDoneStep ? (
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.3em] text-[var(--cream)]/55">
              {t.stepLabels.done}
            </span>
          ) : (
            <div className="flex items-baseline gap-3">
              <span className="font-display text-3xl italic leading-none text-[var(--cream)]/25 sm:text-[2.25rem]">
                {String(stepIndex + 1).padStart(2, "0")}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-[var(--cream)]/30">
                / {totalInputSteps}
              </span>
              <span className="ml-1 font-mono text-[10px] font-bold uppercase tracking-[0.3em] text-[var(--cream)]/55">
                · {t.stepLabels[currentStepKey]}
              </span>
            </div>
          )}
          <button
            type="button"
            aria-label={t.close}
            onClick={onClose}
            className="rounded-full border border-[var(--cream)]/15 p-2 text-[var(--cream)]/50 transition hover:border-[#ff6b2c] hover:text-[#ff6b2c]"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M3 3l10 10M13 3L3 13" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div
          key={currentStepKey}
          className="flex flex-1 flex-col overflow-y-auto px-6 pb-8 pt-6 sm:px-8 sm:pt-8"
        >
          {currentStepKey === "icp" && (
            <IcpStep value={icp} onChange={setIcp} onSubmit={next} t={t} />
          )}
          {currentStepKey === "tried" && (
            <TriedStep
              selected={tried}
              onToggle={toggleTried}
              onSubmit={next}
              t={t}
            />
          )}
          {currentStepKey === "book" && (
            <BookStep
              onBook={submitBooking}
              softOpen={softOpen}
              onSoftToggle={() => setSoftOpen((v) => !v)}
              softEmail={softEmail}
              softName={softName}
              consent={consent}
              onSoftEmailChange={setSoftEmail}
              onSoftNameChange={setSoftName}
              onConsentChange={setConsent}
              onSoftSubmit={submitSoftCapture}
              website={website}
              onWebsiteChange={setWebsite}
              submitting={submitting}
              error={submitError}
              t={t}
            />
          )}
          {currentStepKey === "done" && (
            <div className="flex flex-col gap-5">
              <h2 className="font-display text-[1.75rem] leading-[1.1] tracking-tight text-[var(--cream)] sm:text-[2.5rem]">
                {t.doneHeading}
              </h2>
              <p className="text-[14px] leading-[1.65] text-[var(--cream)]/70">
                {t.doneBody}
              </p>
            </div>
          )}

          {/* Back button */}
          {!isDoneStep && stepIndex > 0 && (
            <button
              type="button"
              onClick={back}
              className="mt-6 self-start text-[11px] font-bold uppercase tracking-[0.25em] text-[var(--cream)]/45 transition hover:text-[var(--cream)]"
            >
              {t.back}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Step components
// ─────────────────────────────────────────────────────────────────────

function StepShell({
  question,
  hint,
  children,
  footer,
}: {
  question: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col gap-7">
      <div>
        <h2 className="font-display text-3xl leading-[1.05] tracking-tight sm:text-[2.5rem]">
          {question}
        </h2>
        {hint && (
          <p className="mt-2 text-[13px] text-[var(--cream)]/55">{hint}</p>
        )}
      </div>
      {children}
      {footer && <div className="mt-auto pt-2">{footer}</div>}
    </div>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
  type,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type ?? "button"}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-3 self-start rounded-full bg-[var(--cream)] px-9 py-4 text-center text-xs font-bold uppercase leading-snug tracking-[0.2em] text-[#14110d] shadow-[0_18px_50px_-16px_rgba(0,0,0,0.6)] transition hover:-translate-y-0.5 hover:bg-white hover:shadow-[0_24px_60px_-16px_rgba(0,0,0,0.7)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0 sm:text-[13px] sm:tracking-[0.28em]"
    >
      {children}
    </button>
  );
}

function IcpStep({
  value,
  onChange,
  onSubmit,
  t,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  t: CopyT;
}) {
  const valid = value.trim().length >= ICP_MIN;
  return (
    <StepShell
      question={
        <>
          {t.icpQuestionBefore}
          <em className="bg-gradient-to-b from-[#ffb86b] via-[#ff6b2c] to-[#c93c0a] bg-clip-text italic text-transparent">
            {t.icpQuestionAccent}
          </em>
          {t.icpQuestionAfter}
        </>
      }
      hint={t.icpHint}
      footer={
        <PrimaryButton type="button" onClick={onSubmit} disabled={!valid}>
          {t.next}
        </PrimaryButton>
      }
    >
      <textarea
        autoFocus
        value={value}
        maxLength={ICP_MAX}
        rows={3}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t.icpPlaceholder}
        className="w-full resize-none border-b border-[var(--cream)]/20 bg-transparent pb-3 text-[17px] leading-relaxed text-[var(--cream)] placeholder:text-[var(--cream)]/30 focus:border-[#ff6b2c] focus:outline-none sm:text-[19px]"
      />
    </StepShell>
  );
}

function TriedStep({
  selected,
  onToggle,
  onSubmit,
  t,
}: {
  selected: string[];
  onToggle: (option: string) => void;
  onSubmit: () => void;
  t: CopyT;
}) {
  const valid = selected.length > 0;
  return (
    <StepShell
      question={t.triedQuestion}
      hint={t.triedHint}
      footer={
        <PrimaryButton onClick={onSubmit} disabled={!valid}>
          {t.next}
        </PrimaryButton>
      }
    >
      <div className="flex flex-wrap gap-2.5">
        {t.triedOptions.map((option) => {
          const active = selected.includes(option);
          return (
            <button
              key={option}
              type="button"
              aria-pressed={active}
              onClick={() => onToggle(option)}
              className={`rounded-full border px-5 py-2.5 text-[13px] transition ${
                active
                  ? "border-[#ff6b2c] bg-[#ff6b2c]/10 text-[var(--cream)]"
                  : "border-[var(--cream)]/15 text-[var(--cream)]/65 hover:border-[var(--cream)]/40 hover:text-[var(--cream)]"
              }`}
            >
              {option}
            </button>
          );
        })}
      </div>
    </StepShell>
  );
}

function BookStep({
  onBook,
  softOpen,
  onSoftToggle,
  softEmail,
  softName,
  consent,
  onSoftEmailChange,
  onSoftNameChange,
  onConsentChange,
  onSoftSubmit,
  website,
  onWebsiteChange,
  submitting,
  error,
  t,
}: {
  onBook: () => void;
  softOpen: boolean;
  onSoftToggle: () => void;
  softEmail: string;
  softName: string;
  consent: boolean;
  onSoftEmailChange: (v: string) => void;
  onSoftNameChange: (v: string) => void;
  onConsentChange: (v: boolean) => void;
  onSoftSubmit: () => void;
  website: string;
  onWebsiteChange: (v: string) => void;
  submitting: boolean;
  error: string | null;
  t: CopyT;
}) {
  const softValid = EMAIL_RE_CLIENT.test(softEmail.trim()) && consent;
  return (
    <StepShell question={t.bookQuestion}>
      <p className="-mt-3 max-w-xl text-[14px] leading-[1.7] text-[var(--cream)]/70">
        {t.bookBody}
      </p>

      {/* Honeypot — visually hidden; bots fill it, humans never see it. */}
      <input
        type="text"
        name="website"
        value={website}
        onChange={(e) => onWebsiteChange(e.target.value)}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute -left-[9999px] h-px w-px opacity-0"
      />

      <div className="flex flex-col items-start gap-3">
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:gap-5">
          <PrimaryButton onClick={onBook} disabled={submitting}>
            {t.bookCta}
          </PrimaryButton>
          <span className="text-[11px] uppercase tracking-[0.2em] text-[var(--cream)]/40">
            {t.bookNote}
          </span>
        </div>

        <button
          type="button"
          onClick={onSoftToggle}
          className="mt-4 self-start text-[12px] text-[var(--cream)]/55 underline decoration-[var(--cream)]/25 underline-offset-4 transition hover:text-[var(--cream)]"
        >
          {t.softToggle}
        </button>

        {softOpen && (
          <div className="mt-2 flex w-full max-w-md flex-col gap-3">
            <input
              type="email"
              autoComplete="email"
              inputMode="email"
              value={softEmail}
              onChange={(e) => onSoftEmailChange(e.target.value)}
              placeholder={t.softEmailPlaceholder}
              className="w-full border-b border-[var(--cream)]/20 bg-transparent pb-2 text-[16px] text-[var(--cream)] placeholder:text-[var(--cream)]/25 focus:border-[#ff6b2c] focus:outline-none"
            />
            <input
              type="text"
              autoComplete="name"
              value={softName}
              onChange={(e) => onSoftNameChange(e.target.value)}
              placeholder={t.softNamePlaceholder}
              className="w-full border-b border-[var(--cream)]/20 bg-transparent pb-2 text-[16px] text-[var(--cream)] placeholder:text-[var(--cream)]/25 focus:border-[#ff6b2c] focus:outline-none"
            />
            <label className="flex cursor-pointer items-start gap-2.5 text-[13px] leading-relaxed text-[var(--cream)]/65">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => onConsentChange(e.target.checked)}
                className="mt-0.5 accent-[#ff6b2c]"
              />
              {t.softConsentLabel}
            </label>
            <button
              type="button"
              onClick={onSoftSubmit}
              disabled={!softValid || submitting}
              className="self-start rounded-full border border-[var(--cream)]/25 px-6 py-3 text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--cream)]/80 transition hover:border-[#ff6b2c] hover:text-[var(--cream)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t.softCta}
            </button>
          </div>
        )}

        {error && <p className="mt-2 text-[12px] text-[#ff6b2c]">{error}</p>}
        {submitting && (
          <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.25em] text-[var(--cream)]/55">
            {t.sending}
          </p>
        )}
      </div>
    </StepShell>
  );
}
