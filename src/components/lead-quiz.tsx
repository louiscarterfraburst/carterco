"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { bookingUrl } from "@/lib/booking";
import {
  type Channel,
  type FollowupQuality,
  type LeadOriginMix,
  type OutboundQuality,
  type QuizInputs,
  type ResponseTime,
  type SalesCycle,
  computeLoss,
} from "@/lib/quiz-calc";

type WebsiteAnalysis = {
  icp: string;
  currentChannels: string[];
  missingChannels: string[];
  notes: string;
};

type AnalysisState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: WebsiteAnalysis }
  | { status: "error"; message: string };

type Locale = "da" | "en";

type Props = {
  open: boolean;
  onClose: () => void;
  onConvert: () => void;
  locale?: Locale;
};

type StepLabelKey =
  | "url"
  | "volume"
  | "contact"
  | "path"
  | "result";

type CopyT = {
  result: string;
  step: string;
  close: string;
  next: string;
  back: string;
  unknownError: string;
  stepLabels: Record<StepLabelKey, string>;
  urlQuestionBefore: string;
  urlQuestionAccent: string;
  urlQuestionAfter: string;
  urlHint: string;
  urlPlaceholder: string;
  // Volume step (combined leads + deal value)
  volumeQuestion: string;
  volumeHint: string;
  volumeLeadsLabel: string;
  volumeLeadsSuffix: string;
  volumeDealLabel: string;
  volumeDealSuffix: string;
  // Contact step
  contactQuestion: string;
  contactNamePlaceholder: string;
  contactEmailPlaceholder: string;
  contactPhonePlaceholder: string;
  contactSubmit: string;
  contactSending: string;
  // Path step
  pathQuestion: string;
  pathHint: string;
  pathLoomLabel: string;
  pathLoomDescription: string;
  pathMeetingLabel: string;
  pathMeetingDescription: string;
  // AI prose (shown on Loom result when analysis succeeded)
  aiLoading: string;
  aiUsesPhrase: string;
  // Loom result page
  heroBefore: string;
  heroAccent: string;
  heroAfter: string;
  cta: string;
  ctaNote: string;
};

const COPY: Record<Locale, CopyT> = {
  da: {
    result: "Næste skridt",
    step: "Trin",
    close: "Luk",
    next: "Næste →",
    back: "← Tilbage",
    unknownError: "Ukendt fejl",
    stepLabels: {
      url: "Hjemmeside",
      volume: "Tal",
      contact: "Kontakt",
      path: "Format",
      result: "Næste skridt",
    },
    urlQuestionBefore: "",
    urlQuestionAccent: "Jeres",
    urlQuestionAfter: " hjemmeside?",
    urlHint: "Bruges i jeres audit.",
    urlPlaceholder: "dinvirksomhed.dk",
    volumeQuestion: "To hurtige tal.",
    volumeHint: "Hjælper mig vurdere om jeg er den rette.",
    volumeLeadsLabel: "Leads om måneden",
    volumeLeadsSuffix: "leads",
    volumeDealLabel: "Aftaleværdi",
    volumeDealSuffix: "kr",
    contactQuestion: "Et sidste skridt",
    contactNamePlaceholder: "Navn",
    contactEmailPlaceholder: "Email",
    contactPhonePlaceholder: "Telefon",
    contactSubmit: "Næste →",
    contactSending: "Sender…",
    pathQuestion: "Hvordan vil du gå frem?",
    pathHint: "Vælg den vej der passer jer bedst.",
    pathLoomLabel: "Lyn-audit",
    pathLoomDescription: "Send view-only CRM-adgang. I får et 10-min Loom inden for 48 timer. Ingen møde.",
    pathMeetingLabel: "Snak først",
    pathMeetingDescription: "30 minutter denne uge. Vi tager det sammen.",
    aiLoading: "Analyserer din side…",
    aiUsesPhrase: "I bruger",
    heroBefore: "Et 10-min",
    heroAccent: "Loom",
    heroAfter: " inden for 48 timer.",
    cta: "Send view-only CRM-adgang og få jeres 10-min Loom →",
    ctaNote: "Ingen møde nødvendigt",
  },
  en: {
    result: "Next step",
    step: "Step",
    close: "Close",
    next: "Next →",
    back: "← Back",
    unknownError: "Unknown error",
    stepLabels: {
      url: "Website",
      volume: "Numbers",
      contact: "Contact",
      path: "Format",
      result: "Next step",
    },
    urlQuestionBefore: "Your ",
    urlQuestionAccent: "website",
    urlQuestionAfter: "?",
    urlHint: "Used in your audit.",
    urlPlaceholder: "yourcompany.com",
    volumeQuestion: "Two quick numbers.",
    volumeHint: "Helps me decide if I'm the right fit.",
    volumeLeadsLabel: "Leads per month",
    volumeLeadsSuffix: "leads",
    volumeDealLabel: "Deal value",
    volumeDealSuffix: "kr",
    contactQuestion: "One last step",
    contactNamePlaceholder: "Name",
    contactEmailPlaceholder: "Email",
    contactPhonePlaceholder: "Phone",
    contactSubmit: "Next →",
    contactSending: "Sending…",
    pathQuestion: "How do you want to proceed?",
    pathHint: "Pick the path that works best for you.",
    pathLoomLabel: "Quick audit",
    pathLoomDescription: "Send view-only CRM access. Get a 10-min Loom within 48h. No meeting.",
    pathMeetingLabel: "Talk first",
    pathMeetingDescription: "30 minutes this week. We walk through it together.",
    aiLoading: "Analyzing your site…",
    aiUsesPhrase: "You use",
    heroBefore: "A 10-min",
    heroAccent: "Loom",
    heroAfter: " in 48 hours.",
    cta: "Send view-only CRM access and get your 10-min Loom →",
    ctaNote: "No meeting required",
  },
};

// Public booking link is centralized in src/lib/booking.ts (BOOKING_URL / bookingUrl).

// Lean intake flow (5 screens, 2026-05-21 redesign):
//   url → volume (leads + deal value) → contact → path (Loom or meeting) → result
// Earlier diagnostic questions (close/cycle/channels/outbound/speed/followup)
// were cut after the office-hours session — Louis asks them in the meeting
// or reads them from CRM data when the prospect shares access.
const STEP_KEYS = [
  "url",
  "volume",
  "contact",
  "path",
  "result",
] as const;

type StepKey = (typeof STEP_KEYS)[number];

function isUrlValid(raw: string): boolean {
  if (!raw.trim()) return false;
  try {
    const withProtocol = raw.includes("://") ? raw : `https://${raw}`;
    const u = new URL(withProtocol);
    return Boolean(u.hostname && u.hostname.includes("."));
  } catch {
    return false;
  }
}

function normalizeUrl(raw: string): string {
  if (!raw.trim()) return raw;
  return raw.includes("://") ? raw : `https://${raw}`;
}

export function LeadQuiz({ open, onClose, onConvert, locale = "da" }: Props) {
  const t = COPY[locale];
  const [stepIndex, setStepIndex] = useState(0);
  const [url, setUrl] = useState("");
  const [monthlyLeads, setMonthlyLeads] = useState("50");
  const [dealValue, setDealValue] = useState("25000");
  // Diagnostic questions removed from UI (close/cycle/channels/outbound/speed/
  // followup/origin). Defaults kept so computeLoss continues to populate
  // DB columns; Louis reads the real values from CRM or asks in the meeting.
  const closeRate = "15";
  const responseTime: ResponseTime = "30mto1h";
  const channels: Channel[] = ["linkedin"];
  const outboundQuality: OutboundQuality = "light";
  const followupQuality: FollowupQuality = "manual";
  const salesCycle: SalesCycle = "2to8w";
  const leadOriginMix: LeadOriginMix = "mix";
  const [analysis, setAnalysis] = useState<AnalysisState>({ status: "idle" });
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [path, setPath] = useState<"loom" | "meeting" | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const currentStepKey = STEP_KEYS[stepIndex];
  const isResultStep = currentStepKey === "result";
  const totalInputSteps = STEP_KEYS.length - 1; // exclude result
  const progress = isResultStep
    ? 100
    : Math.round(((stepIndex + 1) / totalInputSteps) * 100);

  // Reset to first step when modal transitions from closed → open.
  // Ref-tracked transition so the effect's setState only fires on the edge,
  // not on every render.
  const wasOpenRef = useRef(open);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setStepIndex(0);
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

  const inputs = useMemo<QuizInputs>(
    () => ({
      monthlyLeads: Number(monthlyLeads) || 0,
      dealValue: Number(dealValue) || 0,
      closeRate: (Number(closeRate) || 0) / 100,
      responseTime,
      channels,
      outboundQuality,
      followupQuality,
      salesCycle,
      leadOriginMix,
    }),
    [
      monthlyLeads,
      dealValue,
      closeRate,
      responseTime,
      channels,
      outboundQuality,
      followupQuality,
      salesCycle,
      leadOriginMix,
    ],
  );

  const result = useMemo(() => computeLoss(inputs), [inputs]);

  function next() {
    setStepIndex((i) => Math.min(i + 1, STEP_KEYS.length - 1));
  }
  function back() {
    setStepIndex((i) => Math.max(0, i - 1));
  }

  // Kick off AI analysis when URL step is submitted (fire-and-forget; result waits if needed)
  async function startAnalysis(rawUrl: string) {
    const url = normalizeUrl(rawUrl);
    if (!isUrlValid(url)) {
      setAnalysis({ status: "idle" });
      return;
    }
    setAnalysis({ status: "loading" });
    try {
      const res = await fetch("/api/quiz-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        setAnalysis({ status: "error", message: text || `HTTP ${res.status}` });
        return;
      }
      const data = (await res.json()) as WebsiteAnalysis;
      setAnalysis({ status: "ready", data });
    } catch (err) {
      setAnalysis({
        status: "error",
        message: err instanceof Error ? err.message : t.unknownError,
      });
    }
  }

  function handleNextFromUrl() {
    if (url.trim()) startAnalysis(url);
    next();
  }

  // Submission happens at the path step (when user picks Loom or meeting).
  // Loom path → advance to the in-modal result. Meeting path → redirect
  // to Calendly with the visitor's info prefilled (a1 = company stays
  // blank since the lean intake doesn't ask for it).
  async function submitWithPath(chosenPath: "loom" | "meeting") {
    if (submitting) return;
    setPath(chosenPath);
    setSubmitError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/quiz-submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: contactName.trim(),
          email: contactEmail.trim(),
          phone: contactPhone.trim() || undefined,
          url: url.trim() || undefined,
          path: chosenPath,
          monthlyLeads: inputs.monthlyLeads,
          dealValue: inputs.dealValue,
          closeRate: inputs.closeRate,
          responseTime: inputs.responseTime,
          channels: inputs.channels,
          outboundQuality: inputs.outboundQuality,
          followupQuality: inputs.followupQuality,
          totalLoss: result.totalLoss,
          hastighedLoss: result.hastighedLoss,
          outboundLoss: result.outboundLoss,
          opfølgningLoss: result.opfølgningLoss,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) {
        setSubmitError(data.error || `HTTP ${res.status}`);
        return;
      }
      if (chosenPath === "meeting") {
        window.location.href = bookingUrl({
          name: contactName.trim(),
          email: contactEmail.trim(),
          phone: contactPhone.trim(),
          utm_source: "carterco.dk",
          utm_medium: "lead_quiz",
        });
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
        {/* Header — editorial chapter marker. Big serif italic numeral
            ("01" through "10") + mono caption replaces the wizard-style
            "TRIN N/M · LABEL" pattern. On the result step, we drop the
            numeral and just show the result eyebrow. */}
        <div className="flex items-baseline justify-between px-8 pt-6">
          {isResultStep ? (
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.3em] text-[var(--cream)]/55">
              {t.result}
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

        {/* Progress bar removed 2026-05-21 — the editorial chapter
            marker ("01 / 10") signals progress without wizard chrome. */}

        {/* Body */}
        <div
          key={currentStepKey}
          className="flex flex-1 flex-col overflow-y-auto px-6 pb-8 pt-6 sm:px-8 sm:pt-8"
        >
          {currentStepKey === "url" && (
            <UrlStep
              value={url}
              onChange={setUrl}
              onSubmit={handleNextFromUrl}
              t={t}
            />
          )}
          {currentStepKey === "volume" && (
            <VolumeStep
              leadsValue={monthlyLeads}
              dealValue={dealValue}
              onLeadsChange={setMonthlyLeads}
              onDealChange={setDealValue}
              onSubmit={next}
              t={t}
            />
          )}
          {currentStepKey === "contact" && (
            <ContactStep
              name={contactName}
              email={contactEmail}
              phone={contactPhone}
              onNameChange={setContactName}
              onEmailChange={setContactEmail}
              onPhoneChange={setContactPhone}
              onSubmit={next}
              t={t}
            />
          )}
          {currentStepKey === "path" && (
            <PathStep
              onChoose={submitWithPath}
              submitting={submitting}
              error={submitError}
              t={t}
            />
          )}
          {currentStepKey === "result" && (
            <ResultStep
              analysis={analysis}
              path={path}
              t={t}
            />
          )}

          {/* Back button */}
          {!isResultStep && stepIndex > 0 && (
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

function UrlStep({
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
  const valid = isUrlValid(value);
  return (
    <StepShell
      question={
        <>
          {t.urlQuestionBefore}
          <em className="bg-gradient-to-b from-[#ffb86b] via-[#ff6b2c] to-[#c93c0a] bg-clip-text italic text-transparent">
            {t.urlQuestionAccent}
          </em>
          {t.urlQuestionAfter}
        </>
      }
      hint={t.urlHint}
      footer={
        <PrimaryButton
          type="button"
          onClick={onSubmit}
          disabled={!valid}
        >
          {t.next}
        </PrimaryButton>
      }
    >
      <input
        autoFocus
        type="url"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && valid) {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder={t.urlPlaceholder}
        autoComplete="url"
        inputMode="url"
        className="w-full border-b border-[var(--cream)]/20 bg-transparent pb-3 font-display text-2xl text-[var(--cream)] placeholder:font-sans placeholder:text-base placeholder:text-[var(--cream)]/40 focus:border-[#ff6b2c] focus:outline-none sm:text-3xl"
      />
    </StepShell>
  );
}

function NumberStep({
  question,
  hint,
  value,
  onChange,
  onSubmit,
  suffix,
  nextLabel,
}: {
  question: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  suffix: string;
  nextLabel: string;
}) {
  const valid = Number(value) > 0;
  return (
    <StepShell
      question={question}
      hint={hint}
      footer={
        <PrimaryButton onClick={onSubmit} disabled={!valid}>
          {nextLabel}
        </PrimaryButton>
      }
    >
      <div className="flex items-baseline gap-3">
        <input
          autoFocus
          type="text"
          inputMode="numeric"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ""))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && valid) {
              e.preventDefault();
              onSubmit();
            }
          }}
          className="w-full max-w-[12ch] border-b border-[var(--cream)]/20 bg-transparent pb-3 font-display text-3xl text-[var(--cream)] tabular-nums placeholder:text-[var(--cream)]/25 focus:border-[#ff6b2c] focus:outline-none sm:text-5xl"
        />
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.25em] text-[var(--cream)]/55">
          {suffix}
        </span>
      </div>
    </StepShell>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Volume step — leads + deal value on a single screen
// ─────────────────────────────────────────────────────────────────────

function VolumeStep({
  leadsValue,
  dealValue,
  onLeadsChange,
  onDealChange,
  onSubmit,
  t,
}: {
  leadsValue: string;
  dealValue: string;
  onLeadsChange: (v: string) => void;
  onDealChange: (v: string) => void;
  onSubmit: () => void;
  t: CopyT;
}) {
  const valid = Number(leadsValue) > 0 && Number(dealValue) > 0;
  return (
    <StepShell
      question={t.volumeQuestion}
      hint={t.volumeHint}
      footer={
        <PrimaryButton onClick={onSubmit} disabled={!valid}>
          {t.next}
        </PrimaryButton>
      }
    >
      <div className="flex flex-col gap-7">
        <div>
          <label className="block font-mono text-[10px] font-bold uppercase tracking-[0.25em] text-[var(--cream)]/45">
            {t.volumeLeadsLabel}
          </label>
          <div className="mt-2 flex items-baseline gap-3">
            <input
              autoFocus
              type="text"
              inputMode="numeric"
              value={leadsValue}
              onChange={(e) => onLeadsChange(e.target.value.replace(/[^\d]/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && valid) {
                  e.preventDefault();
                  onSubmit();
                }
              }}
              className="w-full max-w-[10ch] border-b border-[var(--cream)]/20 bg-transparent pb-2 font-display text-3xl text-[var(--cream)] tabular-nums focus:border-[#ff6b2c] focus:outline-none sm:text-4xl"
            />
            <span className="font-mono text-[11px] font-bold uppercase tracking-[0.25em] text-[var(--cream)]/55">
              {t.volumeLeadsSuffix}
            </span>
          </div>
        </div>
        <div>
          <label className="block font-mono text-[10px] font-bold uppercase tracking-[0.25em] text-[var(--cream)]/45">
            {t.volumeDealLabel}
          </label>
          <div className="mt-2 flex items-baseline gap-3">
            <input
              type="text"
              inputMode="numeric"
              value={dealValue}
              onChange={(e) => onDealChange(e.target.value.replace(/[^\d]/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && valid) {
                  e.preventDefault();
                  onSubmit();
                }
              }}
              className="w-full max-w-[12ch] border-b border-[var(--cream)]/20 bg-transparent pb-2 font-display text-3xl text-[var(--cream)] tabular-nums focus:border-[#ff6b2c] focus:outline-none sm:text-4xl"
            />
            <span className="font-mono text-[11px] font-bold uppercase tracking-[0.25em] text-[var(--cream)]/55">
              {t.volumeDealSuffix}
            </span>
          </div>
        </div>
      </div>
    </StepShell>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Path step — Loom or meeting. Click submits the form + advances.
// ─────────────────────────────────────────────────────────────────────

function PathStep({
  onChoose,
  submitting,
  error,
  t,
}: {
  onChoose: (path: "loom" | "meeting") => void;
  submitting: boolean;
  error: string | null;
  t: CopyT;
}) {
  return (
    <StepShell question={t.pathQuestion} hint={t.pathHint}>
      <div className="flex flex-col gap-3">
        <PathCard
          label={t.pathLoomLabel}
          description={t.pathLoomDescription}
          accent="orange"
          disabled={submitting}
          onClick={() => onChoose("loom")}
        />
        <PathCard
          label={t.pathMeetingLabel}
          description={t.pathMeetingDescription}
          accent="cream"
          disabled={submitting}
          onClick={() => onChoose("meeting")}
        />
        {error && (
          <p className="mt-2 text-[12px] text-[#ff6b2c]">{error}</p>
        )}
        {submitting && (
          <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.25em] text-[var(--cream)]/55">
            {t.contactSending}
          </p>
        )}
      </div>
    </StepShell>
  );
}

function PathCard({
  label,
  description,
  accent,
  disabled,
  onClick,
}: {
  label: string;
  description: string;
  accent: "orange" | "cream";
  disabled: boolean;
  onClick: () => void;
}) {
  const borderHover =
    accent === "orange"
      ? "hover:border-[#ff6b2c] hover:bg-[#ff6b2c]/[0.04]"
      : "hover:border-[var(--cream)]/40 hover:bg-[var(--cream)]/[0.03]";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`group flex items-start gap-4 rounded-xl border border-[var(--cream)]/15 px-5 py-4 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${borderHover}`}
    >
      <div className="flex-1">
        <div className="font-display text-xl leading-tight text-[var(--cream)] sm:text-2xl">
          {label}
        </div>
        <p className="mt-1 text-[13px] leading-relaxed text-[var(--cream)]/65">
          {description}
        </p>
      </div>
      <span
        aria-hidden
        className="mt-1 text-lg text-[var(--cream)]/40 transition group-hover:translate-x-1 group-hover:text-[var(--cream)]"
      >
        →
      </span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Contact step — just collects data; no API call here
// ─────────────────────────────────────────────────────────────────────

const EMAIL_RE_CLIENT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PHONE_RE_CLIENT = /^\+?[\d\s-]{8,}$/;

function ContactStep({
  name,
  email,
  phone,
  onNameChange,
  onEmailChange,
  onPhoneChange,
  onSubmit,
  t,
}: {
  name: string;
  email: string;
  phone: string;
  onNameChange: (v: string) => void;
  onEmailChange: (v: string) => void;
  onPhoneChange: (v: string) => void;
  onSubmit: () => void;
  t: CopyT;
}) {
  const valid =
    name.trim().length > 1 &&
    EMAIL_RE_CLIENT.test(email.trim()) &&
    PHONE_RE_CLIENT.test(phone.trim());
  return (
    <StepShell
      question={t.contactQuestion}
      footer={
        <PrimaryButton type="button" onClick={onSubmit} disabled={!valid}>
          {t.contactSubmit}
        </PrimaryButton>
      }
    >
      <div className="flex flex-col gap-4">
        <input
          autoFocus
          type="text"
          autoComplete="name"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t.contactNamePlaceholder}
          className="w-full border-b border-[var(--cream)]/20 bg-transparent pb-2 text-[18px] text-[var(--cream)] placeholder:text-[var(--cream)]/25 focus:border-[#ff6b2c] focus:outline-none"
        />
        <input
          type="email"
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={(e) => onEmailChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && valid) {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder={t.contactEmailPlaceholder}
          className="w-full border-b border-[var(--cream)]/20 bg-transparent pb-2 text-[18px] text-[var(--cream)] placeholder:text-[var(--cream)]/25 focus:border-[#ff6b2c] focus:outline-none"
        />
        <input
          type="tel"
          autoComplete="tel"
          inputMode="tel"
          value={phone}
          onChange={(e) => onPhoneChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && valid) {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder={t.contactPhonePlaceholder}
          className="w-full border-b border-[var(--cream)]/20 bg-transparent pb-2 text-[18px] text-[var(--cream)] placeholder:text-[var(--cream)]/25 focus:border-[#ff6b2c] focus:outline-none"
        />
      </div>
    </StepShell>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Result
// ─────────────────────────────────────────────────────────────────────

// Result step renders only for the Loom path. Meeting path redirects
// to Calendly from submitWithPath() before this step is reached.
function ResultStep({
  analysis,
  t,
}: {
  analysis: AnalysisState;
  path: "loom" | "meeting" | null;
  t: CopyT;
}) {
  const aiReady = analysis.status === "ready" ? analysis.data : null;
  return (
    <div className="flex flex-col gap-8">
      <h2 className="font-display text-[1.75rem] leading-[1.1] tracking-tight text-[var(--cream)] sm:text-[2.5rem]">
        {t.heroBefore}{" "}
        <em className="bg-gradient-to-b from-[#ffb86b] via-[#ff6b2c] to-[#c93c0a] bg-clip-text italic text-transparent">
          {t.heroAccent}
        </em>
        {t.heroAfter}
      </h2>

      {analysis.status === "loading" && (
        <p className="text-[14px] leading-[1.65] text-[var(--cream)]/55">
          {t.aiLoading}
        </p>
      )}
      {aiReady && (
        <p className="text-[14px] leading-[1.65] text-[var(--cream)]/75">
          {aiReady.notes || aiReady.icp}
          {aiReady.currentChannels.length > 0 && (
            <>
              {" "}
              {t.aiUsesPhrase}{" "}
              <span className="text-[var(--cream)]">
                {aiReady.currentChannels.join(", ")}
              </span>
              .
            </>
          )}
        </p>
      )}

      <div className="flex flex-col items-start border-t border-[var(--cream)]/10 pt-7">
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:gap-5">
          <a
            href="mailto:louis@carterco.dk?subject=Loom-audit%20%E2%80%94%20%2010-min%20gennemgang%20af%20lead-flow&body=Hej%20Louis%2C%0A%0AJeg%20vil%20gerne%20have%20et%2010-min%20Loom-audit%20af%20vores%20lead-flow.%0A%0AHvordan%20deler%20jeg%20view-only%20CRM-adgang%3F"
            className="inline-flex items-center gap-3 self-start rounded-full bg-[var(--forest)] px-7 py-3.5 text-center text-[11px] font-bold uppercase leading-snug tracking-[0.18em] text-[#fff8ea] shadow-[0_18px_50px_-16px_rgba(25,70,58,0.5)] transition hover:-translate-y-0.5 hover:shadow-[0_24px_60px_-16px_rgba(25,70,58,0.6)] sm:text-xs sm:tracking-[0.25em]"
          >
            {t.cta}
          </a>
          <span className="text-[11px] uppercase tracking-[0.2em] text-[var(--cream)]/40">
            {t.ctaNote}
          </span>
        </div>
      </div>
    </div>
  );
}
