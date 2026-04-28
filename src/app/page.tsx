"use client";

import { FormEvent, KeyboardEvent, ReactNode, useEffect, useRef, useState } from "react";
import { createClient } from "@/utils/supabase/client";

const DRAFT_STORAGE_KEY = "carterco.lead_draft_id";
const DRAFT_DEBOUNCE_MS = 1200;
const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "https://znpaevzwlcfuzqxsbyie.supabase.co";
const SUPABASE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  "sb_publishable_rKCrGrKGUr48lEhjqWj3dw_V0kAEKQl";

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
type FieldErrors = Partial<Record<StepKey, string>>;

const calendlyUrl = "https://calendly.com/louis-carterco/30min";

// Logos render at a default height. Square/stacked marks need more height
// than wordmarks to read at the same visual weight — override per logo.
// Multi-color logos that shouldn't be flattened to cream set preserveColor.
const logoFiles: {
  file: string;
  sizeClass?: string;
  offsetClass?: string;
  preserveColor?: boolean;
}[] = [
  { file: "logo-mavico.png" },
  { file: "logo-tresyv.svg", sizeClass: "h-10 w-auto sm:h-12" },
  { file: "logo-murph.png" },
  { file: "logo-burst.png", sizeClass: "h-7 w-auto sm:h-9", offsetClass: "mb-3 sm:mb-4" },
  { file: "logo-wono.png" },
  { file: "logo-studio404.png", sizeClass: "h-6 w-auto sm:h-7" },
  { file: "logo-swob.png", sizeClass: "h-9 w-auto sm:h-11" },
  {
    file: "logo-vinduespudserskolen.png",
    sizeClass: "h-10 w-auto sm:h-12",
    preserveColor: true,
  },
];

const DEFAULT_LOGO_CLASS = "h-5 w-auto sm:h-7";

const cases: {
  metric: string;
  metricLabel: string;
  copy: string;
  client: string;
  industry?: string;
  kind: "heat" | "won";
  url?: string;
  logo?: string;
  logoClass?: string;
}[] = [
  {
    metric: "31×",
    metricLabel: "outreach-volumen",
    copy: "Vi byggede et AI-system der genererer personlig video-outreach til hver enkelt prospect — hver besked føles optaget kun til dem, men kører i en skala et team aldrig kunne ramme manuelt.",
    client: "Tresyv",
    kind: "heat",
    logo: "/logos/logo-tresyv.svg",
    logoClass: "h-11",
  },
  {
    metric: "<3 min",
    metricLabel: "gennemsnitlig responstid",
    copy: "Hvert nyt lead pinger sælgeren direkte på telefonen — med navn, firma og kontekst. Ring op eller følg op med ét tryk, uden at åbne CRM'et.",
    client: "Murph",
    url: "https://www.trymurph.com/",
    logo: "/logos/logo-murph.png",
    logoClass: "h-6",
    kind: "heat",
  },
  {
    metric: "4×",
    metricLabel: "lead-konvertering",
    copy: "Vi byggede et intro-tilbud der var uimodståeligt for målgruppen, finpudsede annoncerne så de ramte de rigtige mennesker, og lagde et email- og SMS-flow oven på der svarer hvert lead personligt inden for få minutter.",
    client: "Burst",
    kind: "won",
    url: "https://burstcreators.com",
    logo: "/logos/logo-burst.png",
  },
];

type JourneyStage = {
  n: string;
  verb: string;
  title: string;
  titleAccent: string;
  body: string;
  proof?: { metric: string; unit: string; note: string };
  visual: "outbound" | "pipeline" | "sms";
};

const journey: JourneyStage[] = [
  {
    n: "01",
    verb: "Fange",
    title: "Vi henter dem ind",
    titleAccent: "der hvor de allerede er.",
    body: "Målrettede beskeder på LinkedIn og email til dem der bestemmer, og Meta-annoncer der rammer lige præcis dem du gerne vil have fat i. Ingen spam — kun leads der matcher din ideelle kunde.",
    visual: "outbound",
  },
  {
    n: "02",
    verb: "Føre",
    title: "Saml dem op",
    titleAccent: "i ét fælles overblik.",
    body: "Vi bygger CRM'et op fra bunden — eller rydder op i det du allerede har. Hver lead lander det rigtige sted, hos den rigtige sælger, med fuld kontekst. Helt af sig selv.",
    visual: "pipeline",
  },
  {
    n: "03",
    verb: "Lukke",
    title: "Hold dem varme —",
    titleAccent: "også når du sover.",
    body: "Automatiske SMS-flows der svarer inden for 60 sekunder, følger op på udeblivelser og henter de leads tilbage der ellers var faldet fra. Med en menneskelig tone.",
    visual: "sms",
  },
];

const outboundCards = [
  {
    type: "linkedin" as const,
    name: "Sara El-Khouri",
    title: "Adm. direktør · Tagværk ApS",
    initials: "SE",
    preview:
      "Hej Sara — så at I lige har vundet udbuddet på Frederiksberg. Hvis I vil have flere lignende leads, har vi…",
    chip: "2. grads",
  },
  {
    type: "meta" as const,
    sponsor: "Sponsoreret · Carter & Co",
    headline: "Få varme leads inden for 60 sekunder.",
    body: "Vi bygger systemet. Du lukker aftalerne.",
    cta: "Book demo",
  },
];

const pipelineColumns = [
  { key: "ny", label: "Ny", count: 12, accent: "bg-[var(--cream)]/40" },
  { key: "kontaktet", label: "Kontaktet", count: 7, accent: "bg-[#ffb86b]" },
  { key: "booket", label: "Booket", count: 4, accent: "bg-[#ff6b2c]" },
  { key: "vundet", label: "Vundet", count: 2, accent: "bg-[var(--forest)]" },
] as const;

const pipelineCards = [
  { col: 0, name: "Mette Sørensen", company: "Nordlys A/S", source: "LinkedIn", initials: "MS" },
  { col: 1, name: "Jonas Holm", company: "Bygma Vest", source: "Meta", initials: "JH" },
  { col: 1, name: "Sara El-Khouri", company: "Tagværk", source: "LinkedIn", initials: "SE" },
  { col: 2, name: "Anders Kjær", company: "Boligformidling", source: "Meta", initials: "AK", note: "I morgen 10:00" },
  { col: 3, name: "Lise Damgaard", company: "Kompas Tag", source: "LinkedIn", initials: "LD", note: "32.500 kr" },
];

const smsThread = [
  {
    from: "us" as const,
    text: "Hej Mette — tak for din interesse i Nordlys-pakken. Har du tid til en kort snak i morgen kl. 10?",
    time: "14:32",
  },
  { from: "them" as const, text: "Ja, det passer fint :)", time: "14:34" },
  {
    from: "us" as const,
    text: "Perfekt — jeg sender en kalenderinvitation nu.",
    time: "14:35",
  },
];

type IntegrationTile = {
  id: string;
  x: number;
  y: number;
  size: number;
  rot: number;
  bg: string;
  border?: string;
  iconSrc?: string;   // path to local SVG (preferred — used for SimpleIcons brands)
  glyph?: ReactNode;  // inline JSX fallback (used when no canonical SVG available)
};

const integrationTiles: IntegrationTile[] = [
  // — Top arc —
  {
    // Monday: stylized rainbow vertical bars (their actual mark is colored bars; we render mono)
    id: "monday",
    x: 14, y: 16, size: 64, rot: -6, bg: "#FF3D57",
    glyph: (
      <g fill="white">
        <rect x="5" y="8" width="3.4" height="8" rx="1.7" />
        <rect x="10.3" y="6" width="3.4" height="12" rx="1.7" />
        <rect x="15.6" y="9" width="3.4" height="6" rx="1.7" />
      </g>
    ),
  },
  {
    // Pipedrive: stylized P with internal pipe — mirrors the brand's "P with a tail" mark
    id: "pipedrive",
    x: 28, y: 6, size: 72, rot: 4, bg: "#017737",
    glyph: (
      <g fill="white">
        <path d="M 8 4 L 13 4 a 5 5 0 0 1 0 10 L 11 14 L 11 20 L 8 20 Z M 11 7 L 11 11 L 13 11 a 2 2 0 0 0 0 -4 Z" />
      </g>
    ),
  },
  {
    // HubSpot: real SimpleIcons sprocket
    id: "hubspot",
    x: 50, y: 4, size: 68, rot: -3, bg: "#FF7A59",
    iconSrc: "/icons/integrations/hubspot.svg",
  },
  {
    // Salesforce: cloud silhouette (their iconic mark)
    id: "salesforce",
    x: 72, y: 8, size: 76, rot: 5, bg: "#00A1E0",
    glyph: (
      <g fill="white">
        <path d="M 6.5 16.5 a 3 3 0 0 1 -0.4 -5.9 a 3.8 3.8 0 0 1 1.6 -2.3 a 4 4 0 0 1 6.4 0.9 a 3.5 3.5 0 0 1 4.6 2 a 2.7 2.7 0 0 1 -1 5.3 Z" />
      </g>
    ),
  },
  // — Middle band —
  {
    // Microsoft Dynamics 365: 4-square Microsoft-style grid
    id: "dynamics",
    x: 6, y: 44, size: 68, rot: 6, bg: "#0078D4",
    glyph: (
      <g fill="white">
        <rect x="4" y="4" width="7.5" height="7.5" rx="0.5" />
        <rect x="12.5" y="4" width="7.5" height="7.5" rx="0.5" />
        <rect x="4" y="12.5" width="7.5" height="7.5" rx="0.5" />
        <rect x="12.5" y="12.5" width="7.5" height="7.5" rx="0.5" />
      </g>
    ),
  },
  {
    // ActiveCampaign: triangle play-arrow with horizontal accent (their signature shape)
    id: "activecampaign",
    x: 90, y: 48, size: 72, rot: 5, bg: "#356AE6",
    glyph: (
      <g fill="white">
        <path d="M 5 19 L 12 5 L 19 19 L 16 19 L 12 11 L 8 19 Z" />
        <rect x="10.5" y="14" width="6" height="1.8" rx="0.4" />
      </g>
    ),
  },

  // — Lower band —
  {
    // LinkedIn: classic boxy "in" letterform
    id: "linkedin",
    x: 12, y: 76, size: 72, rot: -5, bg: "#0A66C2",
    glyph: (
      <g fill="white">
        <rect x="4" y="9" width="3.5" height="11" rx="0.3" />
        <circle cx="5.75" cy="5.5" r="1.9" />
        <path d="M 10 9 L 13 9 L 13 10.6 Q 14.5 8.7 17 8.7 Q 20.5 8.7 20.5 13 L 20.5 20 L 17 20 L 17 13.5 Q 17 11.6 15.4 11.6 Q 13.5 11.6 13.5 14 L 13.5 20 L 10 20 Z" />
      </g>
    ),
  },
  {
    // Zapier: real SimpleIcons asterisk-cross
    id: "zapier",
    x: 30, y: 88, size: 76, rot: 3, bg: "#FF4A00",
    iconSrc: "/icons/integrations/zapier.svg",
  },
  {
    // Google: multi-color G (kept inline since SimpleIcons single-color version isn't iconic)
    id: "google",
    x: 50, y: 92, size: 64, rot: -4, bg: "#FFFFFF", border: "#E5E0D5",
    glyph: (
      <g>
        <path d="M 12 5 a 7 7 0 0 1 5 2 L 15 9 a 4.5 4.5 0 1 0 1.3 4.5 L 12 13.5 L 12 11 L 19 11 a 7 7 0 1 1 -7 -6 Z" fill="#4285F4" />
        <path d="M 12 19 a 7 7 0 0 0 5.5 -2.5 L 14.8 14 a 4.5 4.5 0 0 1 -2.8 1 Z" fill="#34A853" />
        <path d="M 7.5 13 a 4.5 4.5 0 0 1 0 -2 L 5 9 a 7 7 0 0 0 0 6 Z" fill="#FBBC05" />
        <path d="M 7.5 11 a 4.5 4.5 0 0 1 4.5 -3 a 4.5 4.5 0 0 1 3 1 L 17 7 a 7 7 0 0 0 -12 2 Z" fill="#EA4335" />
      </g>
    ),
  },
  {
    // Make (formerly Integromat): real SimpleIcons mark
    id: "make",
    x: 70, y: 86, size: 68, rot: 5, bg: "#6D00CC",
    iconSrc: "/icons/integrations/make.svg",
  },
  {
    // Meta: real SimpleIcons swirl
    id: "meta",
    x: 88, y: 78, size: 72, rot: -3, bg: "#0866FF",
    iconSrc: "/icons/integrations/meta.svg",
  },
];

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
  const [errors, setErrors] = useState<FieldErrors>({});
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const formRef = useRef(form);

  useEffect(() => {
    formRef.current = form;
  }, [form]);

  useEffect(() => {
    function flush() {
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
      }
      flushDraft(formRef.current);
    }
    function onVisibility() {
      if (document.visibilityState === "hidden") flush();
    }
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
      }
    };
  }, []);

  const step = steps[stepIdx];
  const total = steps.length;
  const progress = submitted ? 100 : ((stepIdx + 1) / total) * 100;
  const currentValue = form[step.key];
  const canAdvance =
    !submitting && (step.required ? currentValue.trim().length > 0 : true);
  const isLast = stepIdx === total - 1;
  const currentError = errors[step.key];

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
    setErrors({});
    setStepIdx(0);
    setSubmitted(false);
    setSubmitError(null);
    setSubmitting(false);
    setOpen(true);
  }

  function advance() {
    if (!canAdvance || submitting) return;
    const error = validateField(step.key, currentValue);
    if (error) {
      setErrors((current) => ({ ...current, [step.key]: error }));
      return;
    }

    setErrors((current) => {
      const next = { ...current };
      delete next[step.key];
      return next;
    });

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

    const cleaned = cleanForm(form);
    const formErrors = validateForm(cleaned);
    if (Object.keys(formErrors).length > 0) {
      setErrors(formErrors);
      setSubmitting(false);
      const firstInvalidStep = steps.findIndex((item) => formErrors[item.key]);
      setStepIdx(firstInvalidStep >= 0 ? firstInvalidStep : 0);
      return;
    }

    const params = new URLSearchParams({
      name: cleaned.name,
      email: cleaned.email,
      a1: cleaned.company,
      a2: cleaned.phone,
      a3: cleaned.monthlyLeads,
      a4: cleaned.responseTime,
      utm_source: "carterco.dk",
      utm_medium: "hero_form",
    });

    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }

    try {
      const supabase = createClient();
      const leadPayload = {
        name: cleaned.name,
        company: cleaned.company,
        email: cleaned.email,
        phone: cleaned.phone,
        monthly_leads: cleaned.monthlyLeads,
        response_time: cleaned.responseTime,
        source: "carterco.dk",
        page_url: window.location.href,
        user_agent: window.navigator.userAgent,
      };
      const { error } = await supabase.from("leads").insert(leadPayload);

      if (error) {
        console.error("Supabase lead insert failed", error);
        setSubmitError(`${error.code ?? "Supabase"}: ${error.message}`);
        setSubmitting(false);
        return;
      }

      // Notifications fire automatically via the leads_notify_new_lead
      // trigger — no need to invoke the function explicitly.

      const draftId =
        typeof window !== "undefined"
          ? window.localStorage.getItem(DRAFT_STORAGE_KEY)
          : null;
      if (draftId) {
        void supabase.from("leads").delete().eq("draft_session_id", draftId);
        window.localStorage.removeItem(DRAFT_STORAGE_KEY);
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

  function updateField(key: StepKey, value: string) {
    const nextForm = { ...form, [key]: value };
    setForm(nextForm);
    if (errors[key]) {
      setErrors((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }

    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      draftTimerRef.current = null;
      void saveDraft(nextForm);
    }, DRAFT_DEBOUNCE_MS);
  }

  return (
    <main className="relative flex min-h-screen flex-col bg-[#0f0d0a] text-[var(--cream)]">
      <section className="relative flex min-h-screen flex-col overflow-hidden">
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
            className="max-w-2xl -translate-y-[40px] text-lg leading-relaxed text-[var(--cream)]/70 sm:max-w-4xl sm:text-xl"
            style={{ textWrap: "pretty" }}
          >
            Når et lead skriver sig op, køler interessen ned på få minutter.
            <br className="hidden sm:block" /> De første 5 minutter er det{" "}
            <a
              href="https://25649.fs1.hubspotusercontent-na2.net/hub/25649/file-13535879-pdf/docs/mit_study.pdf"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-[var(--cream)] underline decoration-[#ff6b2c]/60 decoration-2 underline-offset-4 transition hover:decoration-[#ff6b2c]"
            >
              21× mere tilbøjelige til at blive kvalificeret
              <sup className="ml-0.5 text-xs font-bold text-[#ff6b2c]">↗</sup>
            </a>
            .
            <br className="hidden sm:block" />{" "}
            <span className="sm:whitespace-nowrap">
              Jeg bygger systemet, der fanger dem varme — og ikke slipper før de er lukket.
            </span>
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
      </section>

      <section className="relative border-t border-[var(--cream)]/5 bg-[#0f0d0a] py-16 sm:py-20">
        <p className="text-center text-[10px] font-bold uppercase tracking-[0.3em] text-[var(--clay)]">
          Bag systemet hos
        </p>
        <div className="mt-10 overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_10%,black_90%,transparent)] [-webkit-mask-image:linear-gradient(to_right,transparent,black_10%,black_90%,transparent)]">
          <div className="flex w-max animate-marquee">
            {[0, 1].map((dup) => (
              <div
                key={dup}
                aria-hidden={dup === 1}
                className="flex shrink-0 items-center gap-16 pr-16 sm:gap-24 sm:pr-24"
              >
                {logoFiles.map(({ file, sizeClass, offsetClass, preserveColor }) => (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    key={file}
                    src={`/logos/${file}`}
                    alt=""
                    draggable={false}
                    className={`${sizeClass ?? DEFAULT_LOGO_CLASS} ${offsetClass ?? ""} shrink-0 opacity-70 transition hover:opacity-100`}
                    style={
                      preserveColor
                        ? undefined
                        : { filter: "brightness(0) invert(1)" }
                    }
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="relative overflow-hidden bg-[#f6efe4] py-28 text-[#29261f] sm:py-36">
        <div aria-hidden className="paper-grain" />

        {/* EmberSpark — top: bridges down from dark marquee */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-[linear-gradient(180deg,rgba(255,107,44,0.18),transparent)]" />
        <div aria-hidden className="pointer-events-none absolute left-1/2 top-0 h-[2px] w-[min(680px,60%)] -translate-x-1/2 bg-[linear-gradient(90deg,transparent,#ff6b2c_30%,#ff6b2c_70%,transparent)] shadow-[0_0_28px_rgba(255,107,44,0.7)]" />

        {/* EmberSpark — bottom: bridges up to dark process */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-[linear-gradient(0deg,rgba(255,107,44,0.18),transparent)]" />
        <div aria-hidden className="pointer-events-none absolute bottom-0 left-1/2 h-[2px] w-[min(680px,60%)] -translate-x-1/2 bg-[linear-gradient(90deg,transparent,#ff6b2c_30%,#ff6b2c_70%,transparent)] shadow-[0_0_28px_rgba(255,107,44,0.7)]" />

        <div className="relative z-[1] mx-auto w-full max-w-[1400px] px-8 sm:px-12">
          <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-[var(--clay)]">
            Resultater · udvalgte
          </p>
          <h2 className="mt-4 font-display text-[10vw] leading-[0.9] tracking-[-0.04em] text-[#29261f] sm:text-6xl lg:text-7xl">
            Varme leads,
            <br />
            <span className="italic text-[var(--clay)]">lukkede aftaler.</span>
          </h2>

          <div className="mt-16 grid gap-px overflow-hidden rounded-2xl border border-[#29261f]/12 bg-[#29261f]/12 sm:mt-20 sm:grid-cols-3">
            {cases.map((c) => (
              <article
                key={c.client}
                className="group relative flex flex-col gap-6 bg-[#f6efe4] p-10 transition hover:bg-[#efe6d6] sm:p-12"
              >
                <div className="flex flex-col gap-2">
                  <span className="font-display text-6xl italic leading-none tracking-tight sm:text-7xl">
                    <span
                      className={`bg-clip-text text-transparent ${
                        c.kind === "won"
                          ? "bg-gradient-to-b from-[#3d8a6c] via-[#19463a] to-[#0c2a22]"
                          : "bg-gradient-to-b from-[#ffb86b] via-[#ff6b2c] to-[#c93c0a]"
                      }`}
                    >
                      {c.metric}
                    </span>
                  </span>
                  <span className="text-[11px] font-bold uppercase tracking-[0.25em] text-[#29261f]/60">
                    {c.metricLabel}
                  </span>
                </div>

                <p className="text-base leading-relaxed text-[#29261f]/75">
                  {c.copy}
                </p>

                <div className="mt-auto flex items-center gap-3 pt-6">
                  {c.logo ? (
                    c.url ? (
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={c.client}
                        className="group/link inline-flex items-center gap-2 opacity-80 transition hover:opacity-100"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={c.logo}
                          alt={c.client}
                          className={`${c.logoClass ?? "h-7"} w-auto`}
                          style={{ filter: "brightness(0)" }}
                        />
                        <span className="text-[12px] text-[#29261f]/55 transition group-hover/link:text-[#29261f]">↗</span>
                      </a>
                    ) : (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={c.logo}
                        alt={c.client}
                        className={`${c.logoClass ?? "h-7"} w-auto opacity-80`}
                        style={{ filter: "brightness(0)" }}
                      />
                    )
                  ) : c.url ? (
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-display text-lg italic text-[#29261f] decoration-[var(--clay)] decoration-2 underline-offset-4 transition hover:underline"
                    >
                      {c.client} ↗
                    </a>
                  ) : (
                    <span className="font-display text-lg italic text-[#29261f]">
                      {c.client}
                    </span>
                  )}
                  {c.industry && (
                    <span className="text-[10px] font-bold uppercase tracking-[0.3em] text-[#29261f]/50">
                      {c.industry}
                    </span>
                  )}
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="relative overflow-hidden bg-[#0a0907] py-32 sm:py-40">
        {/* Atmospheric backdrop */}
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          <div className="absolute left-1/2 top-[12%] h-[700px] w-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(255,107,44,0.10),transparent_65%)] blur-2xl" />
          <div className="absolute bottom-0 left-0 right-0 h-[40%] bg-[linear-gradient(180deg,transparent,#0a0907)]" />
        </div>

        <div className="mx-auto w-full max-w-[1400px] px-8 sm:px-12">
          {/* Header */}
          <div>
            <div className="flex items-center gap-3">
              <span aria-hidden className="h-px w-10 bg-[#ff6b2c]" />
              <p className="text-[10px] font-bold uppercase tracking-[0.4em] text-[#ff6b2c]">
                Sådan virker det · i tre takter
              </p>
            </div>
            <h2 className="mt-7 font-display text-[13vw] leading-[0.86] tracking-[-0.045em] sm:text-7xl lg:text-[7.25rem]">
              Fra fremmede,
              <br />
              <span className="italic text-[var(--clay)]/85">til fans, til</span>
              <br />
              <span className="bg-gradient-to-b from-[#ffb86b] via-[#ff6b2c] to-[#c93c0a] bg-clip-text text-transparent">
                faste kunder.
              </span>
            </h2>
          </div>

          {/* Stages with continuous wire */}
          <div className="relative mt-28 sm:mt-36">
            {/* Wire down the left side */}
            <div
              aria-hidden
              className="absolute left-2 top-0 hidden h-full w-px bg-[linear-gradient(180deg,transparent,rgba(185,112,65,0.55)_6%,rgba(185,112,65,0.55)_50%,rgba(25,70,58,0.6)_94%,transparent)] sm:block"
            />
            <div
              aria-hidden
              className="absolute left-[5px] top-0 hidden h-full w-[2px] sm:block"
              style={{ ["--wire-length" as string]: "100%" }}
            >
              <span className="wire-travel block h-2 w-2 -translate-x-[3px] rounded-full bg-[#ff6b2c] shadow-[0_0_18px_3px_rgba(255,107,44,0.55)]" />
            </div>

            <div className="flex flex-col gap-28 sm:gap-36">
              {journey.map((stage, i) => {
                const isReverse = i === 1;
                return (
                  <article
                    key={stage.n}
                    className="relative grid gap-12 sm:grid-cols-12 sm:gap-12 sm:pl-14"
                  >
                    {/* Rail node */}
                    <span
                      aria-hidden
                      className="absolute -left-1 top-2 hidden h-3.5 w-3.5 rounded-full bg-[#ff6b2c] ring-4 ring-[#0a0907] sm:block"
                    />
                    <span
                      aria-hidden
                      className="glow-pulse absolute -left-[14px] top-[-3px] hidden h-7 w-7 rounded-full bg-[#ff6b2c]/30 blur-md sm:block"
                    />

                    {/* Ghost numeral */}
                    <span
                      aria-hidden
                      className="ghost-numeral pointer-events-none absolute -top-16 right-0 select-none text-[18rem] leading-none sm:-top-24 sm:right-auto sm:left-[-1rem] sm:text-[22rem]"
                    >
                      {stage.n}
                    </span>

                    {/* Copy column */}
                    <div
                      className={`relative ${isReverse ? "sm:col-span-5 sm:col-start-8" : "sm:col-span-5"} flex flex-col`}
                    >
                      <span className="font-display text-6xl italic leading-none tracking-tight sm:text-7xl">
                        <span className="bg-gradient-to-b from-[#ffb86b] via-[#ff6b2c] to-[#c93c0a] bg-clip-text text-transparent">
                          {stage.verb}
                        </span>
                        <span className="text-[#ff6b2c]">.</span>
                      </span>

                      <h3 className="mt-7 font-display text-3xl leading-[1.08] tracking-tight sm:text-4xl lg:text-[2.75rem]">
                        {stage.title}{" "}
                        <span className="italic text-[var(--clay)]/90">
                          {stage.titleAccent}
                        </span>
                      </h3>
                      <p className="mt-5 max-w-md text-[15px] leading-relaxed text-[var(--cream)]/72">
                        {stage.body}
                      </p>

                      {/* Proof point — replaces the 4-bullet list */}
                      {stage.proof && (
                        <div className="mt-9 flex items-baseline gap-5 border-t border-[var(--cream)]/10 pt-7">
                          <span className="font-display text-5xl italic leading-none tracking-tight text-[var(--cream)] sm:text-6xl">
                            {stage.proof.metric}
                          </span>
                          <div className="min-w-0">
                            <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-[var(--clay)]">
                              {stage.proof.unit}
                            </div>
                            <div className="mt-1.5 text-[13px] leading-snug text-[var(--cream)]/55">
                              {stage.proof.note}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Visual column */}
                    <div
                      className={`relative ${isReverse ? "sm:col-span-6 sm:col-start-1 sm:row-start-1" : "sm:col-span-6 sm:col-start-7"} flex items-start justify-center pt-4`}
                    >
                      {stage.visual === "outbound" && (
                        <div className="relative h-[28rem] w-full max-w-[34rem] sm:h-[30rem]">
                          {/* LinkedIn DM card — back, tilted left */}
                          <div
                            className="subtle-float-slow absolute right-0 top-0 w-[80%] origin-bottom-left"
                            style={{ ["--float-base" as string]: "rotate(-2.5deg)" }}
                          >
                            <div className="rounded-2xl border border-[#29261f]/12 bg-[#fff8ea]/98 p-5 shadow-[0_40px_80px_-30px_rgba(0,0,0,0.55)] backdrop-blur-sm">
                              <div className="flex items-center gap-3">
                                <div className="grid h-10 w-10 place-items-center rounded-full bg-[linear-gradient(135deg,#3a4654,#525e6c)] font-display text-sm text-[#fff8ea]">
                                  {outboundCards[0].initials}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-sm text-[#29261f]">
                                    {outboundCards[0].name}
                                  </div>
                                  <div className="truncate text-[11px] text-[#29261f]/55">
                                    {outboundCards[0].title}
                                  </div>
                                </div>
                                <span className="rounded-full border border-[var(--clay)]/45 bg-[var(--clay)]/12 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--clay)]">
                                  in · {outboundCards[0].chip}
                                </span>
                              </div>
                              <p className="mt-4 text-[13px] leading-relaxed text-[#29261f]/80">
                                {outboundCards[0].preview}
                              </p>
                              <div className="mt-4 flex gap-2">
                                <button
                                  type="button"
                                  className="rounded-full border border-[#29261f]/15 bg-[#29261f]/5 px-4 py-1.5 text-[11px] font-semibold text-[#29261f]/80"
                                >
                                  Forbind
                                </button>
                                <button
                                  type="button"
                                  className="rounded-full bg-[var(--clay)] px-4 py-1.5 text-[11px] font-semibold text-[#fff8ea]"
                                >
                                  Send besked
                                </button>
                              </div>
                            </div>
                          </div>

                          {/* Meta ad card — front, tilted right */}
                          <div
                            className="subtle-float absolute bottom-0 left-0 w-[72%] origin-top-right"
                            style={{
                              ["--float-base" as string]: "rotate(2.5deg)",
                              animationDelay: "1.5s",
                            }}
                          >
                            <div className="overflow-hidden rounded-2xl border border-[#29261f]/12 bg-[#fff8ea] shadow-[0_40px_80px_-30px_rgba(0,0,0,0.55)]">
                              <div className="flex items-center justify-between border-b border-[#29261f]/10 px-4 py-2.5">
                                <div className="flex items-center gap-2">
                                  <div className="grid h-7 w-7 place-items-center rounded-full bg-[linear-gradient(135deg,#1877f2,#42a5f5)] text-[10px] font-bold text-white">
                                    f
                                  </div>
                                  <div className="text-[11px] text-[#29261f]/60">
                                    {outboundCards[1].sponsor}
                                  </div>
                                </div>
                                <span className="text-[#29261f]/35">···</span>
                              </div>
                              <div className="relative aspect-[16/9] bg-[radial-gradient(ellipse_at_30%_40%,rgba(255,107,44,0.45),transparent_60%),radial-gradient(ellipse_at_75%_70%,rgba(25,70,58,0.55),transparent_65%),linear-gradient(135deg,#14110d,#0a0907)]">
                                <div className="absolute inset-0 grid place-items-center">
                                  <span className="font-display text-3xl italic tracking-tight text-[var(--cream)]/85">
                                    Smed mens jernet er <em className="not-italic text-[#ff6b2c]">varmt</em>.
                                  </span>
                                </div>
                              </div>
                              <div className="px-4 py-3.5">
                                <div className="text-[13px] font-semibold text-[#29261f]">
                                  {outboundCards[1].headline}
                                </div>
                                <div className="mt-0.5 text-[11px] text-[#29261f]/60">
                                  {outboundCards[1].body}
                                </div>
                                <button
                                  type="button"
                                  className="mt-3 w-full rounded-md bg-[#29261f]/8 py-2 text-[11px] font-semibold text-[#29261f] transition hover:bg-[#29261f]/12"
                                >
                                  {outboundCards[1].cta}  →
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}

                      {stage.visual === "pipeline" && (
                        <div className="w-full max-w-[42rem]">
                          <div className="rounded-2xl border border-[#29261f]/12 bg-[#fff8ea] p-5 shadow-[0_50px_100px_-40px_rgba(0,0,0,0.55)] sm:p-6">
                            <div className="mb-5 flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                <div className="grid h-7 w-7 place-items-center rounded-md bg-[#ff6b2c]/15">
                                  <span className="h-2 w-2 rounded-full bg-[#ff6b2c] dot-pulse" />
                                </div>
                                <div>
                                  <div className="text-[12px] font-semibold text-[#29261f]">
                                    Pipeline · København
                                  </div>
                                  <div className="text-[10px] uppercase tracking-[0.2em] text-[#29261f]/55">
                                    25 åbne · live
                                  </div>
                                </div>
                              </div>
                              <span className="tabular text-[10px] text-[#29261f]/55">
                                opdateret 14:32
                              </span>
                            </div>

                            <div className="relative grid grid-cols-4 gap-3">
                              {/* Animated ghost card moving across columns */}
                              <div
                                aria-hidden
                                className="pipeline-glide pointer-events-none absolute left-0 top-9 z-10 w-[calc(25%-0.5625rem)]"
                              >
                                <div className="rounded-lg border border-[#ff6b2c]/45 bg-[#fff3df] p-2.5 shadow-[0_20px_40px_-15px_rgba(255,107,44,0.30)]">
                                  <div className="flex items-center gap-2">
                                    <div className="grid h-5 w-5 place-items-center rounded-full bg-[#ff6b2c]/20 text-[9px] font-bold text-[#ff6b2c]">
                                      KH
                                    </div>
                                    <div className="text-[10px] text-[#29261f]">
                                      Karen Hjort
                                    </div>
                                  </div>
                                  <div className="mt-1 text-[9px] text-[#29261f]/55">
                                    Tagteam Aps
                                  </div>
                                </div>
                              </div>

                              {pipelineColumns.map((col, ci) => (
                                <div key={col.key} className="flex min-w-0 flex-col">
                                  <div className="mb-2 flex items-center justify-between">
                                    <div className="flex items-center gap-1.5">
                                      <span className={`h-1.5 w-1.5 rounded-full ${col.accent}`} />
                                      <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-[#29261f]/65">
                                        {col.label}
                                      </span>
                                    </div>
                                    <span className="tabular text-[9px] text-[#29261f]/45">
                                      {col.count}
                                    </span>
                                  </div>
                                  <div className="flex flex-col gap-1.5">
                                    {pipelineCards
                                      .filter((c) => c.col === ci)
                                      .map((card, ki) => (
                                        <div
                                          key={card.name}
                                          className="ledger-row rounded-lg border border-[#29261f]/10 bg-[#f6efe4] p-2.5 transition hover:border-[#29261f]/18"
                                          style={{ animationDelay: `${(ci * 2 + ki) * 0.08}s` }}
                                        >
                                          <div className="flex items-center gap-1.5">
                                            <div className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[#29261f]/10 text-[9px] font-bold text-[#29261f]/75">
                                              {card.initials}
                                            </div>
                                            <div className="min-w-0 flex-1 truncate text-[10px] text-[#29261f]">
                                              {card.name}
                                            </div>
                                          </div>
                                          <div className="mt-1 truncate text-[9px] text-[#29261f]/55">
                                            {card.company}
                                          </div>
                                          {card.note && (
                                            <div className={`mt-1.5 truncate text-[9px] ${ci === 3 ? "tabular text-[var(--forest)]" : "text-[#ff6b2c]"}`}>
                                              {ci === 3 ? "✓ " : "→ "}
                                              {card.note}
                                            </div>
                                          )}
                                        </div>
                                      ))}
                                  </div>
                                </div>
                              ))}
                            </div>

                            <div className="mt-5 flex items-center justify-between border-t border-[#29261f]/10 pt-4 text-[10px] text-[#29261f]/55">
                              <span className="flex items-center gap-2">
                                <span className="h-1.5 w-1.5 rounded-full bg-[var(--forest)] dot-pulse" />
                                Fordeling aktiv · Postnr. 1000–2999
                              </span>
                              <span className="tabular">⌘K</span>
                            </div>
                          </div>
                        </div>
                      )}

                      {stage.visual === "sms" && (
                        <div className="relative">
                          {/* Phone-frame chrome */}
                          <div className="relative w-[19rem] rounded-[2.5rem] border border-[#29261f]/15 bg-gradient-to-b from-[#fff8ea] to-[#f6efe4] p-2 shadow-[0_60px_120px_-40px_rgba(0,0,0,0.55)]">
                            <div className="rounded-[2rem] bg-[#fff8ea] px-4 pb-5 pt-9">
                              {/* Status bar */}
                              <div className="mb-3 flex items-center justify-between text-[10px] text-[#29261f]/65">
                                <span className="tabular">14:35</span>
                                <span className="flex items-center gap-1">
                                  <span className="h-1.5 w-1.5 rounded-full bg-[#29261f]/65" />
                                  <span className="h-2 w-3 rounded-sm border border-[#29261f]/55" />
                                </span>
                              </div>
                              {/* Contact header */}
                              <div className="mb-4 flex flex-col items-center gap-1.5 border-b border-[#29261f]/10 pb-4">
                                <div className="grid h-10 w-10 place-items-center rounded-full bg-[#29261f]/10 font-display text-xs text-[#29261f]/75">
                                  MS
                                </div>
                                <div className="text-[12px] text-[#29261f]">
                                  Mette Sørensen
                                </div>
                                <div className="text-[9px] uppercase tracking-[0.2em] text-[#29261f]/50">
                                  Nordlys A/S · sms
                                </div>
                              </div>

                              {/* Bubbles */}
                              <div className="flex flex-col gap-2.5">
                                {smsThread.map((m, k) => (
                                  <div
                                    key={k}
                                    className={`bubble-in flex flex-col ${m.from === "us" ? "items-end" : "items-start"}`}
                                    style={{ animationDelay: `${k * 0.45 + 0.2}s` }}
                                  >
                                    <div
                                      className={`max-w-[80%] rounded-2xl px-3 py-2 text-[12px] leading-snug ${
                                        m.from === "us"
                                          ? "bg-[var(--forest)] text-[#fff8ea]"
                                          : "bg-[#29261f]/10 text-[#29261f]"
                                      }`}
                                    >
                                      {m.text}
                                    </div>
                                    <span className="mt-0.5 px-1 text-[9px] tabular text-[#29261f]/45">
                                      {m.time}
                                    </span>
                                  </div>
                                ))}

                                {/* Typing indicator */}
                                <div
                                  className="bubble-in flex items-center gap-1 self-start rounded-2xl bg-[#29261f]/10 px-3 py-2"
                                  style={{ animationDelay: "1.7s" }}
                                >
                                  <span className="typing-dot h-1.5 w-1.5 rounded-full bg-[#29261f]/55" style={{ animationDelay: "0s" }} />
                                  <span className="typing-dot h-1.5 w-1.5 rounded-full bg-[#29261f]/55" style={{ animationDelay: "0.18s" }} />
                                  <span className="typing-dot h-1.5 w-1.5 rounded-full bg-[#29261f]/55" style={{ animationDelay: "0.36s" }} />
                                </div>

                                {/* Booket confirmation chip */}
                                <div
                                  className="bubble-in mt-2 flex items-center gap-2 self-center rounded-full border border-[var(--forest)]/45 bg-[var(--forest)]/12 px-3 py-1.5 text-[10px] text-[#29261f]"
                                  style={{ animationDelay: "2.1s" }}
                                >
                                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--forest)]" />
                                  Booket møde · I morgen 10:00
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Floating timing chip */}
                          <div
                            className="subtle-float absolute -right-6 top-20 hidden rounded-xl border border-[#29261f]/12 bg-[#fff8ea] px-3 py-2 shadow-[0_30px_60px_-25px_rgba(0,0,0,0.55)] sm:block"
                            style={{ animationDelay: "0.8s" }}
                          >
                            <div className="text-[9px] uppercase tracking-[0.2em] text-[#29261f]/55">
                              Svartid
                            </div>
                            <div className="font-display text-2xl leading-none">
                              <span className="bg-gradient-to-b from-[#5fae8b] to-[var(--forest)] bg-clip-text text-transparent">
                                42s
                              </span>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>

            {/* Closing flourish — wire terminates in green (closed/won) */}
            <div aria-hidden className="relative mt-10 hidden h-8 sm:block">
              <span className="absolute left-0 top-0 h-3.5 w-3.5 rounded-full bg-[var(--forest)] ring-4 ring-[#0a0907]" />
              <span className="glow-pulse absolute -left-3 -top-2.5 h-8 w-8 rounded-full bg-[var(--forest)]/45 blur-md" />
            </div>
          </div>
        </div>
      </section>

      <section className="relative overflow-hidden bg-[#f6efe4] py-32 text-[#29261f] sm:py-44">
        <div aria-hidden className="paper-grain" />

        {/* EmberSpark — top: bridges down from dark process */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-[linear-gradient(180deg,rgba(255,107,44,0.18),transparent)]" />
        <div aria-hidden className="pointer-events-none absolute left-1/2 top-0 h-[2px] w-[min(680px,60%)] -translate-x-1/2 bg-[linear-gradient(90deg,transparent,#ff6b2c_30%,#ff6b2c_70%,transparent)] shadow-[0_0_28px_rgba(255,107,44,0.7)]" />

        {/* EmberSpark — bottom: bridges up to dark footer */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-[linear-gradient(0deg,rgba(255,107,44,0.18),transparent)]" />
        <div aria-hidden className="pointer-events-none absolute bottom-0 left-1/2 h-[2px] w-[min(680px,60%)] -translate-x-1/2 bg-[linear-gradient(90deg,transparent,#ff6b2c_30%,#ff6b2c_70%,transparent)] shadow-[0_0_28px_rgba(255,107,44,0.7)]" />

        <div className="relative z-[1] mx-auto h-[min(820px,90vh)] w-full max-w-[1280px] px-8 sm:px-12">
          {/* Centered headline + CTA — anchors the scatter */}
          <div className="absolute left-1/2 top-1/2 z-[3] w-[calc(100%-4rem)] max-w-[40rem] -translate-x-1/2 -translate-y-1/2 text-center sm:w-[calc(100%-7.5rem)]">
            <p className="text-[10px] font-bold uppercase tracking-[0.4em] text-[var(--clay)]">
              Plumbing · ikke platform
            </p>
            <h2 className="mt-6 font-display text-4xl leading-[0.96] tracking-[-0.035em] sm:text-5xl lg:text-[3.75rem]">
              Du beholder alt du har.
              <br />
              <span className="italic text-[var(--clay)]">Vi får det bare til at tale sammen.</span>
            </h2>
            <p className="mx-auto mt-6 max-w-[28rem] text-[15px] leading-relaxed text-[#29261f]/70">
              Annonce → CRM → kalender. Vi forbinder dine værktøjer og lægger dem oven på systemet — uden migrering, uden ny stack.
            </p>

            {/* CTA stack — forest-green pill (won-color CTA on paper) + email link */}
            <div className="mt-9 flex flex-col items-center gap-4">
              <button
                type="button"
                onClick={resetAndOpen}
                className="inline-flex items-center gap-3 rounded-full bg-[var(--forest)] px-8 py-4 text-xs font-bold uppercase tracking-[0.25em] text-[#fff8ea] shadow-[0_18px_50px_-16px_rgba(25,70,58,0.5)] transition hover:-translate-y-0.5 hover:shadow-[0_24px_60px_-16px_rgba(25,70,58,0.6)]"
              >
                Book et opkald <span aria-hidden>→</span>
              </button>
              <a
                href="mailto:louis@carterco.dk"
                className="text-[10px] font-bold uppercase tracking-[0.25em] text-[#29261f]/55 transition hover:text-[#29261f]"
              >
                louis@carterco.dk →
              </a>
            </div>

            <p className="mt-8 text-[10px] font-bold uppercase tracking-[0.3em] text-[#29261f]/45">
              + 30 andre · Calendly · Twilio · Gmail · Outlook · Aircall · Slack · Notion · …
            </p>
          </div>

          {/* Scattered tiles — desktop only (mobile gets the text caption above as substitute) */}
          <div aria-hidden className="hidden sm:block">
            {integrationTiles.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-label={t.id}
                className="absolute z-[2] grid origin-center place-items-center transition-transform duration-300"
                style={{
                  left: `${t.x}%`,
                  top: `${t.y}%`,
                  width: t.size,
                  height: t.size,
                  borderRadius: t.size * 0.22,
                  background: t.bg,
                  border: t.border ? `1px solid ${t.border}` : undefined,
                  transform: `translate(-50%, -50%) rotate(${t.rot}deg)`,
                  boxShadow: `0 ${t.size * 0.18}px ${t.size * 0.4}px -${t.size * 0.12}px rgba(41,38,31,0.18)`,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform =
                    "translate(-50%, -50%) rotate(0deg) scale(1.08)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = `translate(-50%, -50%) rotate(${t.rot}deg)`;
                }}
              >
                {t.iconSrc ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={t.iconSrc}
                    alt=""
                    width={t.size * 0.55}
                    height={t.size * 0.55}
                    className="select-none"
                    draggable={false}
                  />
                ) : (
                  <svg viewBox="0 0 24 24" width={t.size * 0.55} height={t.size * 0.55} aria-hidden>
                    {t.glyph}
                  </svg>
                )}
              </button>
            ))}
          </div>
        </div>
      </section>

      <footer className="border-t border-[var(--cream)]/5 py-12">
        <div className="mx-auto flex w-full max-w-[1400px] flex-col items-center justify-center gap-2 px-8 text-center text-[10px] font-bold uppercase tracking-[0.3em] text-[var(--cream)]/40 sm:flex-row sm:gap-6 sm:px-12">
          <span>© 2026 Carter &amp; Co</span>
          <span className="hidden sm:inline">·</span>
          <span>København</span>
          <span className="hidden sm:inline">·</span>
          <a
            href="mailto:louis@carterco.dk"
            className="transition hover:text-[var(--cream)]"
          >
            louis@carterco.dk
          </a>
        </div>
      </footer>

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
                        updateField(step.key, e.target.value)
                      }
                      onKeyDown={onInputKey}
                      placeholder={step.placeholder}
                      autoComplete={autoCompleteFor(step.key)}
                      inputMode={
                        step.type === "tel"
                          ? "tel"
                          : step.type === "email"
                            ? "email"
                            : "text"
                      }
                      required={step.required}
                      aria-invalid={Boolean(currentError)}
                      aria-describedby={
                        currentError ? `${step.key}-error` : undefined
                      }
                      className={`w-full border-b bg-transparent pb-3 text-2xl text-[var(--cream)] placeholder:text-[var(--cream)]/25 focus:outline-none sm:text-3xl ${
                        currentError
                          ? "border-[#ff6b2c] focus:border-[#ff6b2c]"
                          : "border-[var(--cream)]/20 focus:border-[#ff6b2c]"
                      }`}
                    />
                  ) : null}

                  {currentError ? (
                    <p
                      id={`${step.key}-error`}
                      className="-mt-4 text-sm leading-relaxed text-[#ffb86b]"
                    >
                      {currentError}
                    </p>
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
                              updateField(step.key, opt);
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

function getOrCreateDraftSessionId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const existing = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    if (existing) return existing;
    const fresh =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `draft-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(DRAFT_STORAGE_KEY, fresh);
    return fresh;
  } catch {
    return null;
  }
}

function draftReady(form: FormState) {
  const email = form.email.trim();
  const phoneDigits = form.phone.replace(/\D/g, "");
  return email.length > 0 || phoneDigits.length >= 4;
}

function buildDraftPayload(form: FormState, sessionId: string) {
  const cleaned = cleanForm(form);
  return {
    source: "carterco.dk",
    is_draft: true,
    draft_session_id: sessionId,
    draft_updated_at: new Date().toISOString(),
    name: cleaned.name || null,
    company: cleaned.company || null,
    email: cleaned.email || null,
    phone: cleaned.phone || null,
    monthly_leads: cleaned.monthlyLeads || null,
    response_time: cleaned.responseTime || null,
    page_url:
      typeof window !== "undefined" ? window.location.href : null,
    user_agent:
      typeof window !== "undefined" ? window.navigator.userAgent : null,
  };
}

async function saveDraft(form: FormState) {
  if (!draftReady(form)) return;
  const sessionId = getOrCreateDraftSessionId();
  if (!sessionId) return;
  try {
    const supabase = createClient();
    const payload = buildDraftPayload(form, sessionId);
    const { error } = await supabase
      .from("leads")
      .upsert(payload, { onConflict: "draft_session_id" });
    if (error) console.warn("Draft save failed", error);
  } catch (err) {
    console.warn("Draft save failed", err);
  }
}

function flushDraft(form: FormState) {
  if (!draftReady(form)) return;
  const sessionId = getOrCreateDraftSessionId();
  if (!sessionId) return;
  const payload = buildDraftPayload(form, sessionId);
  try {
    fetch(`${SUPABASE_URL}/rest/v1/leads?on_conflict=draft_session_id`, {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(payload),
    }).catch(() => {
      /* keepalive requests can't be awaited on unload; swallow errors */
    });
  } catch {
    /* noop */
  }
}

function autoCompleteFor(key: StepKey) {
  const values: Record<StepKey, string> = {
    name: "name",
    company: "organization",
    email: "email",
    phone: "tel",
    monthlyLeads: "off",
    responseTime: "off",
  };

  return values[key];
}

function cleanForm(form: FormState): FormState {
  return {
    name: normalizeText(form.name),
    company: normalizeText(form.company),
    email: form.email.trim().toLowerCase(),
    phone: normalizePhone(form.phone),
    monthlyLeads: form.monthlyLeads.trim(),
    responseTime: form.responseTime.trim(),
  };
}

function normalizeText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizePhone(value: string) {
  const trimmed = value.trim().replace(/[^\d+]/g, "");
  if (trimmed.startsWith("+")) return `+${trimmed.slice(1).replace(/\D/g, "")}`;

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 8) return `+45${digits}`;
  return digits;
}

function validateForm(form: FormState) {
  return steps.reduce<FieldErrors>((result, item) => {
    const error = validateField(item.key, form[item.key]);
    if (error) result[item.key] = error;
    return result;
  }, {});
}

function validateField(key: StepKey, value: string) {
  const cleanValue =
    key === "email"
      ? value.trim().toLowerCase()
      : key === "phone"
        ? normalizePhone(value)
        : normalizeText(value);

  if (!cleanValue) return "Udfyld feltet for at fortsætte.";

  if (key === "name") {
    if (cleanValue.length < 2) return "Skriv et rigtigt navn.";
    if (!/[a-zæøå]/i.test(cleanValue)) return "Navnet skal indeholde bogstaver.";
    if (looksLikeGarbage(cleanValue)) return "Skriv et rigtigt navn.";
  }

  if (key === "company") {
    if (cleanValue.length < 2) return "Skriv et rigtigt firmanavn.";
    if (!/[a-zæøå0-9]/i.test(cleanValue))
      return "Firmanavnet skal indeholde bogstaver eller tal.";
    if (looksLikeGarbage(cleanValue)) return "Skriv et rigtigt firmanavn.";
  }

  if (key === "email") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(cleanValue))
      return "Skriv en gyldig e-mailadresse.";
    if (/(test|fake|asdf|qwerty|example)\@/i.test(cleanValue))
      return "Brug en rigtig e-mailadresse.";
  }

  if (key === "phone") {
    const digits = cleanValue.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15)
      return "Skriv et telefonnummer, der kan ringes op.";
    if (/^(\d)\1+$/.test(digits)) return "Skriv et rigtigt telefonnummer.";
  }

  if (key === "monthlyLeads") {
    const step = steps.find((item) => item.key === key);
    if (step?.type === "choice" && !step.options.includes(cleanValue))
      return "Vælg en af mulighederne.";
  }

  if (key === "responseTime") {
    const step = steps.find((item) => item.key === key);
    if (step?.type === "choice" && !step.options.includes(cleanValue))
      return "Vælg en af mulighederne.";
  }

  return null;
}

function looksLikeGarbage(value: string) {
  const compact = value.toLowerCase().replace(/[^a-zæøå0-9]/gi, "");
  if (compact.length < 3) return false;
  if (/^(.)\1+$/.test(compact)) return true;
  if (/(asdf|qwer|test|fake|lorem|foobar)/i.test(compact)) return true;

  const vowels = compact.match(/[aeiouyæøå]/gi)?.length ?? 0;
  const letters = compact.match(/[a-zæøå]/gi)?.length ?? 0;
  return letters >= 5 && vowels === 0;
}
