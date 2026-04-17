"use client";

import { FormEvent, KeyboardEvent, useEffect, useState } from "react";

type StepKey =
  | "name"
  | "company"
  | "email"
  | "phone"
  | "monthlyLeads"
  | "responseTime"
  | "note";

type Step =
  | {
      key: StepKey;
      index: string;
      question: string;
      type: "text" | "email" | "tel" | "textarea";
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
    question: "Hvad hedder du?",
    type: "text",
    placeholder: "Dit fulde navn",
    required: true,
  },
  {
    key: "company",
    index: "02",
    question: "Hvor arbejder du?",
    type: "text",
    placeholder: "Firmanavn",
    required: true,
  },
  {
    key: "email",
    index: "03",
    question: "Hvad er din e-mail?",
    type: "email",
    placeholder: "navn@firma.dk",
    required: true,
  },
  {
    key: "phone",
    index: "04",
    question: "Og dit telefonnummer?",
    type: "tel",
    placeholder: "+45 12 34 56 78",
    required: true,
  },
  {
    key: "monthlyLeads",
    index: "05",
    question: "Hvor mange leads får I om måneden?",
    type: "choice",
    options: ["Under 50", "50–250", "250–1.000", "1.000+"],
    required: true,
  },
  {
    key: "responseTime",
    index: "06",
    question: "Hvor hurtigt kontaktes nye leads i dag?",
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
  {
    key: "note",
    index: "07",
    question: "Hvad vil du helst have løst?",
    type: "textarea",
    placeholder: "F.eks. vi taber for mange leads på Meta-annoncer inden de bliver ringet op.",
    required: false,
  },
];

type FormState = Record<StepKey, string>;

const initial: FormState = {
  name: "",
  company: "",
  email: "",
  phone: "",
  monthlyLeads: "",
  responseTime: "",
  note: "",
};

export default function Home() {
  const [open, setOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);
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
    setOpen(true);
  }

  function advance() {
    if (!canAdvance) return;
    if (isLast) {
      submit();
    } else {
      setStepIdx((i) => i + 1);
    }
  }

  function back() {
    if (stepIdx > 0) setStepIdx((i) => i - 1);
  }

  function submit() {
    const body = `Navn: ${form.name}
Firma: ${form.company}
E-mail: ${form.email}
Telefon: ${form.phone}
Leads pr. måned: ${form.monthlyLeads}
Nuværende responstid: ${form.responseTime}

${form.note || "(ingen besked)"}`;
    window.location.href = `mailto:louis@carterco.dk?subject=${encodeURIComponent(
      `Book et opkald — ${form.company || form.name}`,
    )}&body=${encodeURIComponent(body)}`;
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
          <span className="text-xs font-bold uppercase tracking-[0.4em] text-[var(--cream)]/80">
            CARTER &amp; CO
          </span>
        </div>
        <a
          href="mailto:louis@carterco.dk"
          className="group flex items-center gap-2 text-xs font-bold uppercase tracking-[0.3em] text-[var(--cream)]/70 transition hover:text-[var(--cream)]"
        >
          louis@carterco.dk
          <span className="inline-block transition group-hover:translate-x-1">
            →
          </span>
        </a>
      </nav>

      <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col justify-center px-8 sm:px-12">
        <h1 className="font-display text-[15vw] leading-[0.82] tracking-[-0.05em] sm:text-[13vw] lg:text-[11vw]">
          Smed mens
          <br />
          jernet er{" "}
          <span className="relative inline-block">
            <span className="absolute inset-0 -z-10 scale-125 bg-[radial-gradient(ellipse_at_center,rgba(255,107,44,0.45),transparent_65%)] blur-2xl" />
            <span className="bg-gradient-to-b from-[#ffb86b] via-[#ff6b2c] to-[#c93c0a] bg-clip-text italic text-transparent">
              varmt.
            </span>
          </span>
        </h1>

        <div className="mt-14 flex flex-col items-start justify-between gap-10 lg:flex-row lg:items-end">
          <div className="max-w-xl">
            <p className="text-lg leading-relaxed text-[var(--cream)]/70 sm:text-xl">
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
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/signature.png"
              alt="Louis Carter"
              draggable={false}
              onContextMenu={(e) => e.preventDefault()}
              className="pointer-events-none -mt-4 h-32 w-auto select-none sm:h-40"
              style={{
                filter: "invert(1)",
                mixBlendMode: "screen",
                WebkitUserDrag: "none",
              } as React.CSSProperties}
            />
          </div>

          <button
            type="button"
            onClick={resetAndOpen}
            className="group inline-flex items-center gap-4 border-b border-[var(--cream)]/30 pb-2 text-sm font-bold uppercase tracking-[0.3em] transition hover:border-[#ff6b2c]"
          >
            <span className="transition group-hover:text-[#ff6b2c]">
              Book et opkald
            </span>
            <span className="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--cream)]/30 transition group-hover:border-[#ff6b2c] group-hover:bg-[#ff6b2c] group-hover:text-[#0f0d0a]">
              →
            </span>
          </button>
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-[1400px] items-center justify-between px-8 pb-8 text-[11px] font-bold uppercase tracking-[0.3em] text-[var(--cream)]/40 sm:px-12">
        <span>København</span>
        <a
          href="https://25649.fs1.hubspotusercontent-na2.net/hub/25649/file-13535879-pdf/docs/mit_study.pdf"
          target="_blank"
          rel="noopener noreferrer"
          className="hidden transition hover:text-[#ff6b2c] sm:inline"
        >
          Kilde · MIT / InsideSales Lead Response Study (Oldroyd, 2007)
        </a>
        <span>MMXXVI</span>
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
            <div className="flex items-center justify-between px-8 pt-6">
              <div className="flex items-center gap-3">
                <span className="h-1.5 w-1.5 rounded-full bg-[#ff6b2c] shadow-[0_0_8px_rgba(255,107,44,0.9)]" />
                <span className="text-[10px] font-bold uppercase tracking-[0.35em] text-[var(--cream)]/60">
                  Carter &amp; Co · Book et opkald
                </span>
              </div>
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

            <div className="mt-5 px-8">
              <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.3em] text-[var(--cream)]/40">
                <span>
                  {submitted
                    ? "Klar"
                    : `Spørgsmål ${stepIdx + 1} af ${total}`}
                </span>
                <span>{Math.round(progress)}%</span>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--cream)]/10">
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
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#ff6b2c]">
                      {step.index}
                      {step.required ? " · Påkrævet" : " · Valgfri"}
                    </p>
                    <h2 className="font-display mt-3 text-3xl leading-tight tracking-tight sm:text-4xl">
                      {step.question}
                    </h2>
                  </div>

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

                  {step.type === "textarea" ? (
                    <textarea
                      autoFocus
                      rows={4}
                      value={currentValue}
                      onChange={(e) =>
                        setForm({ ...form, [step.key]: e.target.value })
                      }
                      placeholder={step.placeholder}
                      className="w-full resize-none border-b border-[var(--cream)]/20 bg-transparent pb-3 text-lg leading-relaxed text-[var(--cream)] placeholder:text-[var(--cream)]/25 focus:border-[#ff6b2c] focus:outline-none"
                    />
                  ) : null}

                  {step.type === "choice" ? (
                    <div className="flex flex-col gap-3">
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
                            className={`group flex items-center justify-between rounded-xl border px-5 py-4 text-left transition ${
                              selected
                                ? "border-[#ff6b2c] bg-[#ff6b2c]/10 text-[var(--cream)]"
                                : "border-[var(--cream)]/15 bg-black/20 text-[var(--cream)]/80 hover:border-[var(--cream)]/40 hover:bg-black/40"
                            }`}
                          >
                            <span className="text-base sm:text-lg">{opt}</span>
                            <span
                              className={`ml-4 flex h-7 w-7 items-center justify-center rounded-full border text-xs transition ${
                                selected
                                  ? "border-[#ff6b2c] bg-[#ff6b2c] text-[#0f0d0a]"
                                  : "border-[var(--cream)]/30 text-transparent group-hover:border-[var(--cream)]/60"
                              }`}
                            >
                              ✓
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>

                <div className="mt-10 flex items-center justify-between border-t border-[var(--cream)]/10 pt-5">
                  <button
                    type="button"
                    onClick={back}
                    disabled={stepIdx === 0}
                    className="text-[11px] font-bold uppercase tracking-[0.3em] text-[var(--cream)]/50 transition hover:text-[var(--cream)] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:text-[var(--cream)]/50"
                  >
                    ← Tilbage
                  </button>

                  <button
                    type="submit"
                    disabled={!canAdvance}
                    className="inline-flex items-center gap-3 rounded-full bg-[#ff6b2c] px-6 py-3 text-xs font-bold uppercase tracking-[0.25em] text-[#0f0d0a] shadow-[0_18px_50px_rgba(255,107,44,0.35)] transition hover:-translate-y-0.5 hover:bg-[#ff8244] disabled:cursor-not-allowed disabled:bg-[var(--cream)]/10 disabled:text-[var(--cream)]/30 disabled:shadow-none disabled:hover:translate-y-0"
                  >
                    {isLast ? "Send forespørgsel" : "Næste"}
                    <span>→</span>
                  </button>
                </div>

                <p className="mt-3 text-[10px] uppercase tracking-[0.25em] text-[var(--cream)]/30">
                  Tryk Enter for at fortsætte
                </p>
              </form>
            ) : (
              <div className="flex flex-col items-center gap-4 px-8 py-14 text-center">
                <p className="text-[11px] font-bold uppercase tracking-[0.3em] text-[#ff6b2c]">
                  Modtaget
                </p>
                <h3 className="font-display text-3xl leading-tight tracking-tight">
                  Tak — jeg vender tilbage inden for 24 timer.
                </h3>
                <p className="max-w-sm text-sm text-[var(--cream)]/60">
                  Din e-mailklient skulle nu åbne med din forespørgsel. Hvis
                  ikke, så skriv direkte til{" "}
                  <a
                    href="mailto:louis@carterco.dk"
                    className="text-[var(--cream)] underline decoration-[#ff6b2c]"
                  >
                    louis@carterco.dk
                  </a>
                  .
                </p>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="mt-4 text-[11px] font-bold uppercase tracking-[0.3em] text-[var(--cream)]/60 hover:text-[var(--cream)]"
                >
                  Luk
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
