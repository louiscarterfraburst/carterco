"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  type Channel,
  type FollowupQuality,
  type LeadOriginMix,
  type OutboundQuality,
  type QuizInputs,
  type ResponseTime,
  type SalesCycle,
  ALL_CHANNELS,
  CHANNEL_LABELS,
  FOLLOWUP_QUALITY_LABELS,
  FOLLOWUP_QUALITY_OPTIONS,
  LEAD_ORIGIN_LABELS,
  LEAD_ORIGIN_OPTIONS,
  OUTBOUND_QUALITY_LABELS,
  OUTBOUND_QUALITY_OPTIONS,
  RESPONSE_TIME_LABELS,
  SALES_CYCLE_LABELS,
  SALES_CYCLE_OPTIONS,
  computeLoss,
  formatKr,
  formatRange,
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

type Props = {
  open: boolean;
  onClose: () => void;
  onConvert: () => void;
};

// Step order maps to the three machines: leads/deal/close = baseline inputs,
// then outbound questions (channels, outbound-quality), then hastighed (speed),
// then opfølgning (followup-quality), then contact + result.
const STEP_KEYS = [
  "url",
  "leads",
  "deal",
  "close",
  "cycle",
  "origin",
  "channels",
  "outbound-quality",
  "speed",
  "followup-quality",
  "contact",
  "result",
] as const;

type StepKey = (typeof STEP_KEYS)[number];

const STEP_LABELS: Record<StepKey, string> = {
  url: "Hjemmeside",
  leads: "Leads",
  deal: "Aftaleværdi",
  close: "Lukkerate",
  cycle: "Salgs-cyklus",
  origin: "Inbound/outbound",
  channels: "Kanaler",
  "outbound-quality": "Outbound",
  speed: "Hastighed",
  "followup-quality": "Opfølgning",
  contact: "Kontakt",
  result: "Resultat",
};

const RESPONSE_OPTIONS: ResponseTime[] = ["lt5m", "5to30m", "30mto1h", "gt1h"];

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

export function LeadQuiz({ open, onClose, onConvert }: Props) {
  const [stepIndex, setStepIndex] = useState(0);
  const [url, setUrl] = useState("");
  const [monthlyLeads, setMonthlyLeads] = useState("50");
  const [dealValue, setDealValue] = useState("25000");
  const [closeRate, setCloseRate] = useState("15"); // 0..100
  const [responseTime, setResponseTime] = useState<ResponseTime>("30mto1h");
  const [channels, setChannels] = useState<Channel[]>(["linkedin"]);
  const [outboundQuality, setOutboundQuality] =
    useState<OutboundQuality>("light");
  const [followupQuality, setFollowupQuality] =
    useState<FollowupQuality>("manual");
  const [salesCycle, setSalesCycle] = useState<SalesCycle>("2to8w");
  const [leadOriginMix, setLeadOriginMix] = useState<LeadOriginMix>("mix");
  const [analysis, setAnalysis] = useState<AnalysisState>({ status: "idle" });
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
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

  function toggleChannel(c: Channel) {
    setChannels((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c],
    );
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
        message: err instanceof Error ? err.message : "Ukendt fejl",
      });
    }
  }

  function handleNextFromUrl() {
    if (url.trim()) startAnalysis(url);
    next();
  }

  async function submitContact() {
    if (submitting) return;
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
      next();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Ukendt fejl");
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
        {/* Header */}
        <div className="flex items-center justify-between px-8 pt-6">
          <span className="font-mono text-[10px] font-bold uppercase tracking-[0.3em] text-[var(--cream)]/55">
            {isResultStep
              ? "Resultat"
              : `Trin ${stepIndex + 1}/${totalInputSteps} · ${STEP_LABELS[currentStepKey]}`}
          </span>
          <button
            type="button"
            aria-label="Luk"
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

        {/* Progress bar */}
        <div className="mt-4 px-8">
          <div className="h-1 overflow-hidden rounded-full bg-[var(--cream)]/10">
            <div
              className="h-full bg-gradient-to-r from-[#ffb86b] via-[#ff6b2c] to-[#c93c0a] transition-all duration-500 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

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
            />
          )}
          {currentStepKey === "leads" && (
            <NumberStep
              question="Leads om måneden?"
              hint="Formular, opkald, DM."
              value={monthlyLeads}
              onChange={setMonthlyLeads}
              onSubmit={next}
              suffix="leads"
            />
          )}
          {currentStepKey === "deal" && (
            <NumberStep
              question="Hvad er en kunde værd?"
              hint="Gennemsnit i kr · årsomsætning hvis abonnement."
              value={dealValue}
              onChange={setDealValue}
              onSubmit={next}
              suffix="kr"
            />
          )}
          {currentStepKey === "close" && (
            <SliderStep
              question="Hvor mange % af dine leads lukker?"
              value={closeRate}
              onChange={setCloseRate}
              onSubmit={next}
              min={0}
              max={100}
              suffix="%"
            />
          )}
          {currentStepKey === "cycle" && (
            <ChoiceStep
              question="Hvor lang tid tager en typisk handel?"
              value={salesCycle}
              onChange={(v) => setSalesCycle(v as SalesCycle)}
              options={SALES_CYCLE_OPTIONS.map((v) => ({
                value: v,
                label: SALES_CYCLE_LABELS[v],
              }))}
              onSubmit={next}
            />
          )}
          {currentStepKey === "origin" && (
            <ChoiceStep
              question="Hvor kommer jeres leads typisk fra?"
              value={leadOriginMix}
              onChange={(v) => setLeadOriginMix(v as LeadOriginMix)}
              options={LEAD_ORIGIN_OPTIONS.map((v) => ({
                value: v,
                label: LEAD_ORIGIN_LABELS[v],
              }))}
              onSubmit={next}
            />
          )}
          {currentStepKey === "speed" && (
            <ChoiceStep
              question="Hvor hurtigt ringer I tilbage?"
              value={responseTime}
              onChange={(v) => setResponseTime(v as ResponseTime)}
              options={RESPONSE_OPTIONS.map((v) => ({
                value: v,
                label: RESPONSE_TIME_LABELS[v],
              }))}
              onSubmit={next}
            />
          )}
          {currentStepKey === "channels" && (
            <MultiChoiceStep
              question="Hvor får du leads fra?"
              values={channels}
              onToggle={toggleChannel}
              options={ALL_CHANNELS.map((c) => ({
                value: c,
                label: CHANNEL_LABELS[c],
              }))}
              onSubmit={next}
              submitLabel="Næste →"
            />
          )}
          {currentStepKey === "outbound-quality" && (
            <ChoiceStep
              question="Hvor personlig er jeres outbound?"
              value={outboundQuality}
              onChange={(v) => setOutboundQuality(v as OutboundQuality)}
              options={OUTBOUND_QUALITY_OPTIONS.map((v) => ({
                value: v,
                label: OUTBOUND_QUALITY_LABELS[v],
              }))}
              onSubmit={next}
            />
          )}
          {currentStepKey === "followup-quality" && (
            <ChoiceStep
              question="Hvad sker der med leads der ikke køber nu?"
              value={followupQuality}
              onChange={(v) => setFollowupQuality(v as FollowupQuality)}
              options={FOLLOWUP_QUALITY_OPTIONS.map((v) => ({
                value: v,
                label: FOLLOWUP_QUALITY_LABELS[v],
              }))}
              onSubmit={next}
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
              onSubmit={submitContact}
              submitting={submitting}
              error={submitError}
            />
          )}
          {currentStepKey === "result" && (
            <ResultStep
              result={result}
              inputs={inputs}
              analysis={analysis}
              onConvert={() => {
                onClose();
                onConvert();
              }}
            />
          )}

          {/* Back button */}
          {!isResultStep && stepIndex > 0 && (
            <button
              type="button"
              onClick={back}
              className="mt-6 self-start text-[11px] font-bold uppercase tracking-[0.25em] text-[var(--cream)]/45 transition hover:text-[var(--cream)]"
            >
              ← Tilbage
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
  question: string;
  hint?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col gap-7">
      <div>
        <h2 className="font-display text-2xl leading-tight tracking-tight sm:text-3xl">
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
      className="inline-flex items-center gap-3 self-start rounded-full bg-[var(--forest)] px-7 py-3.5 text-center text-[11px] font-bold uppercase leading-snug tracking-[0.18em] text-[#fff8ea] shadow-[0_18px_50px_-16px_rgba(25,70,58,0.5)] transition hover:-translate-y-0.5 hover:shadow-[0_24px_60px_-16px_rgba(25,70,58,0.6)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0 sm:text-xs sm:tracking-[0.25em]"
    >
      {children}
    </button>
  );
}

function UrlStep({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) {
  const valid = isUrlValid(value);
  return (
    <StepShell
      question="Din hjemmeside?"
      footer={
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:gap-5">
          <PrimaryButton
            type="button"
            onClick={onSubmit}
            disabled={!valid}
          >
            Næste →
          </PrimaryButton>
          <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-[var(--cream)]/45">
            3 min · du får et tal for hvor meget du taber
          </span>
        </div>
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
        placeholder="dinvirksomhed.dk"
        autoComplete="url"
        inputMode="url"
        className="w-full border-b border-[var(--cream)]/20 bg-transparent pb-3 font-display text-2xl text-[var(--cream)] placeholder:font-sans placeholder:text-base placeholder:text-[var(--cream)]/25 focus:border-[#ff6b2c] focus:outline-none sm:text-3xl"
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
}: {
  question: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  suffix: string;
}) {
  const valid = Number(value) > 0;
  return (
    <StepShell
      question={question}
      hint={hint}
      footer={
        <PrimaryButton onClick={onSubmit} disabled={!valid}>
          Næste →
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

function SliderStep({
  question,
  hint,
  value,
  onChange,
  onSubmit,
  min,
  max,
  suffix,
}: {
  question: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  min: number;
  max: number;
  suffix: string;
}) {
  return (
    <StepShell
      question={question}
      hint={hint}
      footer={<PrimaryButton onClick={onSubmit}>Næste →</PrimaryButton>}
    >
      <div className="flex flex-col gap-5">
        <div className="flex items-baseline gap-3">
          <span className="font-display text-5xl text-[var(--cream)] sm:text-6xl">
            {value}
          </span>
          <span className="font-mono text-[11px] font-bold uppercase tracking-[0.25em] text-[var(--cream)]/55">
            {suffix}
          </span>
        </div>
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full accent-[#ff6b2c]"
        />
      </div>
    </StepShell>
  );
}

function ChoiceStep<T extends string>({
  question,
  value,
  onChange,
  options,
  onSubmit,
}: {
  question: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  onSubmit: () => void;
}) {
  return (
    <StepShell
      question={question}
      footer={<PrimaryButton onClick={onSubmit}>Næste →</PrimaryButton>}
    >
      <div className="flex flex-col gap-2">
        {options.map((opt) => {
          const active = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              className={`flex items-center justify-between rounded-xl border px-4 py-3 text-left text-[15px] transition ${
                active
                  ? "border-[#ff6b2c] bg-[#ff6b2c]/10 text-[var(--cream)]"
                  : "border-[var(--cream)]/15 text-[var(--cream)]/75 hover:border-[var(--cream)]/35 hover:text-[var(--cream)]"
              }`}
            >
              <span>{opt.label}</span>
              {active && (
                <span aria-hidden className="text-[#ff6b2c]">
                  ✓
                </span>
              )}
            </button>
          );
        })}
      </div>
    </StepShell>
  );
}

function MultiChoiceStep<T extends string>({
  question,
  hint,
  values,
  onToggle,
  options,
  onSubmit,
  submitLabel,
}: {
  question: string;
  hint?: string;
  values: T[];
  onToggle: (v: T) => void;
  options: { value: T; label: string }[];
  onSubmit: () => void;
  submitLabel?: string;
}) {
  return (
    <StepShell
      question={question}
      hint={hint}
      footer={
        <PrimaryButton onClick={onSubmit}>
          {submitLabel ?? "Næste →"}
        </PrimaryButton>
      }
    >
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const active = values.includes(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onToggle(opt.value)}
              className={`rounded-full border px-4 py-2 text-[13px] transition ${
                active
                  ? "border-[#ff6b2c] bg-[#ff6b2c]/15 text-[var(--cream)]"
                  : "border-[var(--cream)]/20 text-[var(--cream)]/75 hover:border-[var(--cream)]/40 hover:text-[var(--cream)]"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </StepShell>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Contact gate (before result)
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
  submitting,
  error,
}: {
  name: string;
  email: string;
  phone: string;
  onNameChange: (v: string) => void;
  onEmailChange: (v: string) => void;
  onPhoneChange: (v: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  error: string | null;
}) {
  const valid =
    name.trim().length > 1 &&
    EMAIL_RE_CLIENT.test(email.trim()) &&
    PHONE_RE_CLIENT.test(phone.trim());
  return (
    <StepShell
      question="Et sidste skridt"
      footer={
        <div className="flex flex-col items-start gap-3">
          <PrimaryButton
            type="button"
            onClick={onSubmit}
            disabled={!valid || submitting}
          >
            {submitting ? "Sender…" : "Vis mit resultat →"}
          </PrimaryButton>
          {error && (
            <p className="text-[12px] text-[#ff6b2c]">{error}</p>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <input
          autoFocus
          type="text"
          autoComplete="name"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Navn"
          className="w-full border-b border-[var(--cream)]/20 bg-transparent pb-2 text-[18px] text-[var(--cream)] placeholder:text-[var(--cream)]/25 focus:border-[#ff6b2c] focus:outline-none"
        />
        <input
          type="email"
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={(e) => onEmailChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && valid && !submitting) {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder="Email"
          className="w-full border-b border-[var(--cream)]/20 bg-transparent pb-2 text-[18px] text-[var(--cream)] placeholder:text-[var(--cream)]/25 focus:border-[#ff6b2c] focus:outline-none"
        />
        <input
          type="tel"
          autoComplete="tel"
          inputMode="tel"
          value={phone}
          onChange={(e) => onPhoneChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && valid && !submitting) {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder="Telefon"
          className="w-full border-b border-[var(--cream)]/20 bg-transparent pb-2 text-[18px] text-[var(--cream)] placeholder:text-[var(--cream)]/25 focus:border-[#ff6b2c] focus:outline-none"
        />
        <p className="text-[12px] leading-relaxed text-[var(--cream)]/55">
          Jeg ringer dig op inden for 24t med en 15-min gennemgang af dine
          huller.
        </p>
      </div>
    </StepShell>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Result
// ─────────────────────────────────────────────────────────────────────

function ResultStep({
  result,
  inputs,
  analysis,
  onConvert,
}: {
  result: ReturnType<typeof computeLoss>;
  inputs: QuizInputs;
  analysis: AnalysisState;
  onConvert: () => void;
}) {
  const missingLabels = result.missingChannels.map((c) => CHANNEL_LABELS[c]);

  return (
    <div className="flex flex-col gap-7">
      <div>
        <p className="font-mono text-[10px] font-bold uppercase tracking-[0.3em] text-[#ff6b2c]/85">
          Du taber omkring
        </p>
        <p className="mt-1 font-display text-[1.75rem] leading-[1.05] tracking-tight text-[var(--cream)] tabular-nums sm:text-[3.5rem]">
          <span className="bg-gradient-to-b from-[#ffb86b] via-[#ff6b2c] to-[#c93c0a] bg-clip-text italic text-transparent">
            {formatRange(result.totalLoss)}
          </span>
        </p>
        <p className="mt-2 text-[13px] text-[var(--cream)]/55">
          om måneden, baseret på dine tal. Spændet afspejler at lukkerate og volumen er estimater.
        </p>
      </div>

      {/* AI section */}
      {analysis.status === "loading" && (
        <div className="rounded-xl border border-[var(--cream)]/12 bg-[var(--cream)]/[0.03] px-5 py-4 text-[13px] text-[var(--cream)]/65">
          Analyserer din side…
        </div>
      )}
      {analysis.status === "ready" && (
        <div className="rounded-xl border border-[var(--cream)]/12 bg-[var(--cream)]/[0.03] px-5 py-4">
          <p className="font-mono text-[9px] font-bold uppercase tracking-[0.3em] text-[var(--cream)]/55">
            Læst af AI
          </p>
          <p className="mt-2 text-[14px] leading-relaxed text-[var(--cream)]/85">
            {analysis.data.notes || analysis.data.icp}
          </p>
          {analysis.data.currentChannels.length > 0 && (
            <p className="mt-3 text-[12px] text-[var(--cream)]/65">
              <span className="font-bold uppercase tracking-[0.2em] text-[var(--cream)]/45">
                Bruger:
              </span>{" "}
              {analysis.data.currentChannels.join(", ")}
            </p>
          )}
          {analysis.data.missingChannels.length > 0 && (
            <p className="mt-1 text-[12px] text-[var(--cream)]/65">
              <span className="font-bold uppercase tracking-[0.2em] text-[var(--cream)]/45">
                Mangler:
              </span>{" "}
              {analysis.data.missingChannels.join(", ")}
            </p>
          )}
        </div>
      )}

      {/* Loss breakdown — three machine-labeled rows, each anchored to one
          of the three GTM machines on the site. Replaces the previous
          speed-centric "Hvor det går galt" framing. */}
      <div className="border-t border-[var(--cream)]/10 pt-6">
        <p className="font-mono text-[10px] font-bold uppercase tracking-[0.3em] text-[var(--cream)]/55">
          Tre maskiner, tre lækager
        </p>
        <ul className="mt-5 flex flex-col gap-5 text-[14px] leading-relaxed">
          {/* OUTBOUND */}
          <li className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
            <div className="flex items-baseline gap-3 sm:min-w-[14rem]">
              <span className="text-[9px] font-bold uppercase tracking-[0.3em] text-[var(--clay)]">
                Outbound
              </span>
              <span className="font-display text-base font-semibold tabular text-[#ff6b2c]">
                {formatRange(result.outboundLoss)}
              </span>
            </div>
            <span className="flex-1 text-[var(--cream)]/72">
              {inputs.outboundQuality === "templated"
                ? "Mass-templates rammer ikke beslutningstagere"
                : inputs.outboundQuality === "none"
                ? "Ingen outbound, ingen nye samtaler"
                : result.missingChannels.length > 0
                ? `Mangler ${missingLabels.join(", ")}`
                : "Tæt på fuld dækning — kun lille spild her"}
              .
            </span>
          </li>

          {/* HASTIGHED */}
          <li className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
            <div className="flex items-baseline gap-3 sm:min-w-[14rem]">
              <span className="text-[9px] font-bold uppercase tracking-[0.3em] text-[#ff6b2c]">
                Hastighed
              </span>
              <span className="font-display text-base font-semibold tabular text-[#ff6b2c]">
                {formatRange(result.hastighedLoss)}
              </span>
            </div>
            <span className="flex-1 text-[var(--cream)]/72">
              21× lavere kvalitet over 5 min,{" "}
              <a
                href="https://25649.fs1.hubspotusercontent-na2.net/hub/25649/file-13535879-pdf/docs/mit_study.pdf"
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-[#ff6b2c]/50 decoration-2 underline-offset-2 hover:decoration-[#ff6b2c]"
              >
                iflg. MIT-studiet
              </a>
              .
            </span>
          </li>

          {/* OPFØLGNING */}
          <li className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
            <div className="flex items-baseline gap-3 sm:min-w-[14rem]">
              <span className="text-[9px] font-bold uppercase tracking-[0.3em] text-[var(--forest)]">
                Opfølgning
              </span>
              <span className="font-display text-base font-semibold tabular text-[#ff6b2c]">
                {formatRange(result.opfølgningLoss)}
              </span>
            </div>
            <span className="flex-1 text-[var(--cream)]/72">
              {inputs.followupQuality === "manual" || inputs.followupQuality === "none"
                ? "Leads der ikke køber nu, glemmes"
                : inputs.followupQuality === "partial"
                ? "Halvautomatisk pleje, deals tabes i støjen"
                : `Lukkerate ${Math.round(inputs.closeRate * 100)}%, B2B-benchmark 25%`}
              .
            </span>
          </li>
        </ul>
      </div>

      {/* CTA — system-level, not speed-leak-flavored */}
      <div className="flex flex-col items-start gap-3 border-t border-[var(--cream)]/10 pt-6 sm:flex-row sm:items-center">
        <PrimaryButton onClick={onConvert}>
          Få en 30-min GTM-snak →
        </PrimaryButton>
        <span className="text-[11px] uppercase tracking-[0.2em] text-[var(--cream)]/40">
          30 min · uforpligtende
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function useCountUp(target: number, durationMs = 900): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const from = 0;
    const tick = (now: number) => {
      const elapsed = Math.min(1, (now - start) / durationMs);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - elapsed, 3);
      setValue(from + (target - from) * eased);
      if (elapsed < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return value;
}
