"use client";

import { FormEvent, KeyboardEvent, useEffect, useState } from "react";
import { createClient } from "@/utils/supabase/client";

type StepKey =
  | "name"
  | "company"
  | "email"
  | "phone"
  | "monthlyLeads"
  | "responseTime";

type Step =
  | {
      key: StepKey;
      index: string;
      question: string;
      type: "text" | "email" | "tel";
      placeholder: string;
      required: boolean;
    }
  | {
      key: StepKey;
      index: string;
      question: string;
      type: "choice";
      options: string[];
      required: boolean;
    };

const steps: Step[] = [
  {
    key: "name",
    index: "01",
    question: "Navn",
    type: "text",
    placeholder: "",
    required: true,
  },
  {
    key: "company",
    index: "02",
    question: "Firma",
    type: "text",
    placeholder: "",
    required: true,
  },
  {
    key: "email",
    index: "03",
    question: "E-mail",
    type: "email",
    placeholder: "",
    required: true,
  },
  {
    key: "phone",
    index: "04",
    question: "Telefon",
    type: "tel",
    placeholder: "",
    required: true,
  },
  {
    key: "monthlyLeads",
    index: "05",
    question: "Leads pr. måned",
    type: "choice",
    options: ["Under 50", "50–250", "250–1.000", "1.000+"],
    required: true,
  },
  {
    key: "responseTime",
    index: "06",
    question: "Nuværende responstid",
    type: "choice",
    options: [
      "Under 5 min",
      "5–30 min",
      "30 min – 2 timer",
      "Mere end 2 timer",
      "Ved ikke",
    ],
    required: true,
  },
];

type FormState = Record<StepKey, string>;

const calendlyUrl = "https://calendly.com/louis-carterco/30min";

const initial: FormState = {
  name: "",
  company: "",
  email: "",
  phone: "",
  monthlyLeads: "",
  responseTime: "",
};

export default function Home() {
  const [open, setOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  const [form, setForm] = useState<FormState>(initial);

  const step = steps[stepIdx];
  const total = steps.length;
  const progress = submitted ? 100 : ((stepIdx + 1) / total) * 100;
  const currentValue = form[step.key];
  const canAdvance = step.required ? currentValue.trim().length > 0 : true;
  const isLast = stepIdx === total - 1;

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    if (open) {
      window.addEventListener("keydown", onKey);
      document.body.style.overflow = "hidden";
    }
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  function resetAndOpen() {
    setForm(initial);
    setStepIdx(0);
    setSubmitted(false);
    setSubmitError(null);
    setSubmitting(false);
    setOpen(true);
  }

  function advance() {
    if (!canAdvance || submitting) return;
    if (isLast) {
      void submit();
    } else {
      setStepIdx((i) => i + 1);
    }
  }

  function back() {
    if (stepIdx > 0) setStepIdx((i) => i - 1);
  }

  async function submit() {
    setSubmitError(null);
    setSubmitting(true);

    const params = new URLSearchParams({
      name: form.name,
      email: form.email,
      a1: form.company,
      a2: form.phone,
      a3: form.monthlyLeads,
      a4: form.responseTime,
      utm_source: "carterco.dk",
      utm_medium: "hero_form",
    });

    try {
      const supabase = createClient();
      const { error } = await supabase.from("leads").insert({
        name: form.name,
        company: form.company,
        email: form.email,
        phone: form.phone,
        monthly_leads: form.monthlyLeads,
        response_time: form.responseTime,
        source: "carterco.dk",
        page_url: window.location.href,
        user_agent: window.navigator.userAgent,
      });

      if (error) {
        console.error("Supabase lead insert failed", error);
        setSubmitError(`${error.code ?? "Supabase"}: ${error.message}`);
        setSubmitting(false);
        return;
      }
    } catch (error) {
      console.error("Supabase lead insert failed", error);
      setSubmitError(
        error instanceof Error ? error.message : "Supabase lead insert failed",
      );
      setSubmitting(false);
      return;
    }

    window.location.href = `${calendlyUrl}?${params.toString()}`;
    setSubmitted(true);
  }

  function onInputKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      advance();
    }
  }

  function onFormSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    advance();
  }

  return (
    <main className="relative flex h-screen flex-col overflow-hidden bg-[#0f0d0a] text-[var(--cream)]">
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_75%_60%,rgba(218,96,34,0.32),transparent_55%),radial-gradient(ellipse_at_15%_10%,rgba(25,70,58,0.28),transparent_50%)]" />
      <div
        className="pointer-events-none absolute inset-0 -z-10 opacity-[0.06] mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")",
        }}
      />

      <nav className="mx-auto flex w-full max-w-[1400px] items-center justify-between px-8 pt-8 sm:px-12">
        <div className="flex items-center gap-3">
          <span className="h-2 w-2 animate-pulse rounded-full bg-[#ff6b2c] shadow-[0_0_12px_rgba(255,107,44,0.9)]" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.png"
            alt="Carter &amp; Co"
            className="h-5 w-auto sm:h-6"
          />
          <span className="ml-3 hidden text-[10px] font-bold uppercase tracking-[0.3em] text-[var(--cream)]/40 sm:inline">
            København
          </span>
        </div>
        <a
          href="mailto:louis@carterco.dk"
          className="group flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--cream)]/70 transition hover:text-[var(--cream)] sm:text-xs sm:tracking-[0.3em]"
        >
          <span className="hidden sm:inline">louis@carterco.dk</span>
          <span className="sm:hidden">E-mail</span>
          <span className="inline-block transition group-hover:translate-x-1">
            →
          </span>
        </a>
      </nav>

      <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col justify-center px-8 pt-16 sm:px-12 sm:pt-20">
        <h1 className="font-display text-[14vw] leading-[0.82] tracking-[-0.05em] sm:text-[12vw] lg:text-[10vw]">
          <span className="relative inline-block">
            Smed
            <span
              className="pointer-events-none absolute left-[8%] bottom-full mb-[0.05em] hidden items-center gap-[0.2em] whitespace-nowrap text-[0.28em] font-normal leading-none tracking-normal text-[var(--cream)]/95 sm:inline-flex"
              style={{
                fontFamily: "var(--font-handwritten)",
                transform: "translate(1.4em, 0.6em) rotate(-4deg)",
              }}
            >
              Sælg
              <span
                aria-hidden
                className="inline-block h-[0.8em] w-[0.8em] shrink-0 bg-[#ff6b2c]"
                style={{
                  maskImage: "url(/annotation-arrow.png)",
                  maskSize: "contain",
                  maskRepeat: "no-repeat",
                  maskPosition: "center",
                  WebkitMaskImage: "url(/annotation-arrow.png)",
                  WebkitMaskSize: "contain",
                  WebkitMaskRepeat: "no-repeat",
                  WebkitMaskPosition: "center",
                  transform: "translate(0.12em, 0.24em)",
                }}
              />
            </span>
          </span>{" "}
          mens
          <br />
          <span className="relative inline-block">
            jernet
            <span
              className="pointer-events-none absolute left-[12%] top-full mt-[0.05em] hidden items-center gap-[0.2em] whitespace-nowrap text-[0.28em] font-normal leading-none tracking-normal text-[var(--cream)]/95 sm:inline-flex"
              style={{
                fontFamily: "var(--font-handwritten)",
                transform: "rotate(-3deg)",
              }}
            >
              leadet
              <span
                aria-hidden
                className="inline-block h-[0.8em] w-[0.8em] shrink-0 bg-[#ff6b2c]"
                style={{
                  maskImage: "url(/annotation-arrow.png)",
                  maskSize: "contain",
                  maskRepeat: "no-repeat",
                  maskPosition: "center",
                  WebkitMaskImage: "url(/annotation-arrow.png)",
                  WebkitMaskSize: "contain",
                  WebkitMaskRepeat: "no-repeat",
                  WebkitMaskPosition: "center",
                  transform: "scaleY(-1)",
                }}
              />
            </span>
          </span>{" "}
          er{" "}
          <span className="relative inline-block">
            <span className="absolute inset-0 -z-10 scale-125 bg-[radial-gradient(ellipse_at_center,rgba(255,107,44,0.45),transparent_65%)] blur-2xl" />
            <span className="bg-gradient-to-b from-[#ffb86b] via-[#ff6b2c] to-[#c93c0a] bg-clip-text italic text-transparent">
              varmt.
            </span>
          </span>
        </h1>

        <div className="mt-16 flex flex-col gap-10 pb-10 sm:mt-[120px]">
          <p
            className="max-w-2xl -translate-y-[40px] text-lg leading-relaxed text-[var(--cream)]/70 sm:text-xl"
            style={{ textWrap: "pretty" }}
          >
            Leads kontaktet inden for 5 minutter er{" "}
            <a
              href="https://25649.fs1.hubspotusercontent-na2.net/hub/25649/file-13535879-pdf/docs/mit_study.pdf"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-[var(--cream)] underline decoration-[#ff6b2c]/60 decoration-2 underline-offset-4 transition hover:decoration-[#ff6b2c]"
            >
              21× mere tilbøjelige til at blive kvalificeret
              <sup className="ml-0.5 text-xs font-bold text-[#ff6b2c]">↗</sup>
            </a>
            . Jeg bygger systemet, der fanger dem varme — og ikke slipper før de er lukket.
          </p>

          <div className="flex flex-col-reverse items-start justify-between gap-8 sm:flex-row sm:items-end">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/signature.png"
              alt="Louis Carter"
              draggable={false}
              onContextMenu={(e) => e.preventDefault()}
              className="pointer-events-none h-16 w-auto -translate-y-[40px] select-none sm:h-20"
              style={{
                filter: "invert(1)",
                mixBlendMode: "screen",
                WebkitUserDrag: "none",
              } as React.CSSProperties}
            />

            <button
              type="button"
              onClick={resetAndOpen}
              className="group inline-flex -translate-y-[50px] items-center gap-4 rounded-full bg-[#ff6b2c] px-8 py-5 text-sm font-bold uppercase tracking-[0.25em] text-[#0f0d0a] shadow-[0_18px_60px_rgba(255,107,44,0.35)] transition hover:-translate-y-[54px] hover:bg-[#ff8244] hover:shadow-[0_24px_80px_rgba(255,107,44,0.5)]"
            >
              <span>Book et opkald</span>
              <span className="text-lg">→</span>
            </button>
          </div>
        </div>
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <button
            type="button"
            aria-label="Luk"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/80 backdrop-blur-md"
          />
          <div className="relative z-10 flex max-h-[92vh] w-[calc(100%-2rem)] max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--cream)]/10 bg-[#14110d] shadow-[0_40px_120px_rgba(0,0,0,0.6)]">
            <div className="flex items-center justify-end px-8 pt-6">
              <button
                type="button"
                aria-label="Luk"
                onClick={() => setOpen(false)}
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

            <div className="mt-4 px-8">
              <div className="h-1 overflow-hidden rounded-full bg-[var(--cream)]/10">
                <div
                  className="h-full bg-gradient-to-r from-[#ffb86b] via-[#ff6b2c] to-[#c93c0a] transition-all duration-500 ease-out"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>

            {!submitted ? (
              <form
                onSubmit={onFormSubmit}
                className="flex flex-1 flex-col justify-between overflow-y-auto px-8 pb-6 pt-10"
                key={step.key}
              >
                <div className="flex flex-col gap-8">
                  <h2 className="font-display text-3xl leading-tight tracking-tight sm:text-4xl">
                    {step.question}
                  </h2>

                  {step.type === "text" ||
                  step.type === "email" ||
                  step.type === "tel" ? (
                    <input
                      autoFocus
                      type={step.type}
                      value={currentValue}
                      onChange={(e) =>
                        setForm({ ...form, [step.key]: e.target.value })
                      }
                      onKeyDown={onInputKey}
                      placeholder={step.placeholder}
                      required={step.required}
                      className="w-full border-b border-[var(--cream)]/20 bg-transparent pb-3 text-2xl text-[var(--cream)] placeholder:text-[var(--cream)]/25 focus:border-[#ff6b2c] focus:outline-none sm:text-3xl"
                    />
                  ) : null}

                  {step.type === "choice" ? (
                    <div className="flex flex-col gap-2">
                      {step.options.map((opt) => {
                        const selected = currentValue === opt;
                        return (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => {
                              setForm({ ...form, [step.key]: opt });
                              setTimeout(() => {
                                setStepIdx((i) =>
                                  i < total - 1 ? i + 1 : i,
                                );
                              }, 160);
                            }}
                            className={`flex items-center justify-between rounded-xl border px-5 py-4 text-left text-base transition ${
                              selected
                                ? "border-[#ff6b2c] bg-[#ff6b2c]/10"
                                : "border-[var(--cream)]/15 bg-black/20 text-[var(--cream)]/80 hover:border-[var(--cream)]/40 hover:bg-black/40"
                            }`}
                          >
                            {opt}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}

                  {submitError ? (
                    <div className="rounded-xl border border-[#ff6b2c]/40 bg-[#ff6b2c]/10 p-4 text-sm leading-relaxed text-[var(--cream)]/80">
                      <p className="font-bold text-[#ffb86b]">
                        Supabase kunne ikke gemme leadet.
                      </p>
                      <p className="mt-2 break-words font-mono text-xs text-[var(--cream)]/65">
                        {submitError}
                      </p>
                      <a
                        href={calendlyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-3 inline-flex text-xs font-bold uppercase tracking-[0.25em] text-[#ffb86b] underline decoration-[#ff6b2c]/70 underline-offset-4"
                      >
                        Fortsæt til kalender →
                      </a>
                    </div>
                  ) : null}
                </div>

                <div className="mt-10 flex items-center justify-between pt-5">
                  <button
                    type="button"
                    onClick={back}
                    disabled={stepIdx === 0}
                    className="text-[11px] font-bold uppercase tracking-[0.3em] text-[var(--cream)]/50 transition hover:text-[var(--cream)] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:text-[var(--cream)]/50"
                  >
                    ←
                  </button>

                  <button
                    type="submit"
                    disabled={!canAdvance || submitting}
                    className="inline-flex items-center gap-3 rounded-full bg-[#ff6b2c] px-6 py-3 text-xs font-bold uppercase tracking-[0.25em] text-[#0f0d0a] shadow-[0_18px_50px_rgba(255,107,44,0.35)] transition hover:-translate-y-0.5 hover:bg-[#ff8244] disabled:cursor-not-allowed disabled:bg-[var(--cream)]/10 disabled:text-[var(--cream)]/30 disabled:shadow-none disabled:hover:translate-y-0"
                  >
                    {submitting ? "Gemmer" : isLast ? "Book" : "Næste"}
                    <span>→</span>
                  </button>
                </div>
              </form>
            ) : (
              <div className="flex flex-col items-center gap-3 px-8 py-14 text-center">
                <h3 className="font-display text-3xl leading-tight tracking-tight">
                  Vælg et tidspunkt.
                </h3>
                <a
                  href={calendlyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-bold uppercase tracking-[0.3em] text-[var(--cream)]/60 underline decoration-[#ff6b2c] hover:text-[var(--cream)]"
                >
                  Åbn kalender →
                </a>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
