"use client";

import { FormEvent, KeyboardEvent, ReactNode, useEffect, useRef, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { LeadQuiz } from "@/components/lead-quiz";
import { ExitIntent } from "@/components/exit-intent";

declare global {
  interface Window {
    plausible?: (event: string, options?: { props?: Record<string, string | number | boolean> }) => void;
  }
}

const DRAFT_STORAGE_KEY = "carterco.lead_draft_id";
const DRAFT_DEBOUNCE_MS = 1200;
const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "https://znpaevzwlcfuzqxsbyie.supabase.co";
const SUPABASE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  "sb_publishable_rKCrGrKGUr48lEhjqWj3dw_V0kAEKQl";
// Multi-tenant: anonymous submissions from this marketing site always belong
// to the CarterCo workspace. The RLS policy "Anyone can submit CarterCo
// leads" requires this exact UUID.
const CARTERCO_WORKSPACE_ID = process.env.NEXT_PUBLIC_CARTERCO_WORKSPACE_ID ?? "";

type StepKey = "name" | "company" | "email" | "phone";

type Step = {
  key: StepKey;
  index: string;
  question: string;
  type: "text" | "email" | "tel";
  placeholder: string;
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
  { file: "logo-odagroup.png" },
  { file: "logo-tresyv.svg", sizeClass: "h-8 w-auto sm:h-10" },
  { file: "logo-murph.png" },
  { file: "logo-burst.png", sizeClass: "h-6 w-auto sm:h-7", offsetClass: "mb-2.5 sm:mb-3" },
  { file: "logo-wono.png" },
  { file: "logo-studio404.png", sizeClass: "h-5 w-auto sm:h-6" },
  { file: "logo-swob.png", sizeClass: "h-7 w-auto sm:h-9" },
  { file: "logo-gazella.png", sizeClass: "h-9 w-auto sm:h-11" },
  {
    file: "logo-vinduespudserskolen.png",
    sizeClass: "h-8 w-auto sm:h-10",
    preserveColor: true,
  },
];

const DEFAULT_LOGO_CLASS = "h-4 w-auto sm:h-6";

const cases: {
  metric: string;
  metricLabel: string;
  annotation?: string;
  copy: string;
  client: string;
  industry?: string;
  kind: "heat" | "won";
  url?: string;
  logo?: string;
  logoClass?: string;
  quote?: string;
  quoteAttribution?: string;
}[] = [
  {
    metric: "31×",
    metricLabel: "outreach-volumen",
    copy: "31× flere outreach-beskeder. Hver med en unik video til prospecten. Tresyv ramte en skala et team aldrig kunne nå — uden at det føltes som spam.",
    client: "Tresyv",
    kind: "heat",
    logo: "/logos/logo-tresyv.svg",
    logoClass: "h-11",
  },
  {
    metric: "<3 min",
    metricLabel: "gennemsnitlig responstid",
    annotation: "87× hurtigere",
    copy: "Murph rammer hvert nyt lead på under 3 minutter — fra annonceklik til opkald. Sælgeren får leadet på telefonen med navn, firma, kontekst. Ringer op uden at åbne CRM'et.",
    client: "Murph",
    url: "https://www.trymurph.com/",
    logo: "/logos/logo-murph.png",
    logoClass: "h-6",
    kind: "heat",
  },
  {
    metric: "4×",
    metricLabel: "lead-konvertering",
    copy: "4× flere lukkede aftaler. Samme målgruppe, samme budget. Et intro-tilbud der stikker af fra konkurrenternes, annoncer bygget på deres bedste kunder, og et SMS-flow der rammer før leadet er gået ud af brusebadet.",
    client: "Burst",
    kind: "won",
    url: "https://burstcreators.com",
    logo: "/logos/logo-burst.png",
  },
];

type SupportingClient = {
  // Placeholder until real logos/portraits land. Initials render in a round
  // avatar; name labels the circle. Anchor case has the metric attached;
  // supporting clients are just proof that "more than one client uses this."
  initials: string;
  name: string;
};

type JourneyStage = {
  n: string;
  eyebrow: string;            // "01 · OUTBOUND" style — replaces the gradient-italic verb (DESIGN.md reserves that for hero + founder)
  title: string;
  titleAccent: string;
  body: string;
  subpoints: string[];        // 4-6 lines showing depth — what the work actually is, not "features you get"
  proof?: { metric: string; unit: string; note: string; noteHref?: string };
  anchorClient: { name: string; line: string };          // Named anchor case + one-line attribution
  supportingClients: SupportingClient[];                  // 2-3 supporting clients as round-avatar placeholders
  visual: "outbound" | "pipeline" | "sms" | "flows";
};

const journey: JourneyStage[] = [
  {
    n: "01",
    eyebrow: "01 · OUTBOUND",
    title: "Hente dem ind,",
    titleAccent: "hvor de allerede er.",
    body: "Cold outreach der ikke føles cold. Hver besked har research, video og en grund til at læse den. Annoncerne rammer dem du faktisk vil have, ikke alle der ligner dem.",
    subpoints: [
      "Personlige LinkedIn-DMs på skala — én video pr. modtager",
      "Email-outreach uden om gatekeepere",
      "Meta- og Google-annoncer bygget på din ICP",
      "Manuel research per high-value lead",
      "Genaktivering af leads der ligger kolde i databasen",
    ],
    anchorClient: { name: "Tresyv", line: "Kører den i dag." },
    supportingClients: [
      { initials: "—", name: "TBD" },
      { initials: "—", name: "TBD" },
      { initials: "—", name: "TBD" },
    ],
    visual: "outbound",
  },
  {
    n: "02",
    eyebrow: "02 · SPEED-TO-LEAD",
    title: "Få dem på telefonen,",
    titleAccent: "før de glemmer dig.",
    body: "Sælgeren får leadet på skærmen samme sekund det lander — med navn, firma, kontekst. Ét tryk og du ringer op. Ingen CRM at åbne, ingen indbakke at scrolle.",
    subpoints: [
      "Lead lander → sælgeren har det på skærmen samme sekund",
      "Ét tryk = opkald (ingen CRM, ingen indbakke)",
      "SMS-bridge hvis ingen tager — kontekstuelt, ikke spammy",
      "Email og reaktivering hvis det stadig ikke flytter sig",
      "Push-notifikation til alle med adgang samtidig",
      "Lead-prioritering på ICP-score",
    ],
    proof: {
      metric: "21×",
      unit: "mere kvalificeret",
      note: "Når sælgeren svarer inden for 5 minutter — iflg. MIT-studiet.",
      noteHref:
        "https://25649.fs1.hubspotusercontent-na2.net/hub/25649/file-13535879-pdf/docs/mit_study.pdf",
    },
    anchorClient: { name: "Murph", line: "Rammer hvert lead på under 3 min — branchen tager 47 timer." },
    supportingClients: [
      { initials: "—", name: "TBD" },
      { initials: "—", name: "TBD" },
    ],
    visual: "sms",
  },
  {
    n: "03",
    eyebrow: "03 · POST-MEETING",
    title: "Holde dem varme.",
    titleAccent: "Lukke aftalen.",
    body: "Møder glipper. Aftaler forsvinder. Leads der stod stille for to uger siden bliver fanget. Pipelinen følger med dagen, ikke ugen — vundne aftaler hopper til 'lukket' samme dag.",
    subpoints: [
      "Outcome markeret samme dag — pipelinen følger med dagen",
      "Nurture-flows for \"ikke klar nu\"-leads",
      "Reaktiverings-flows for tabte deals",
      "Storkunde-fraled-opsporing — kunden der stopper med at bestille",
      "Attribution: hvilket lead blev til hvilken vundet aftale",
      "Talepunkter genereret før hver opfølgning",
    ],
    proof: {
      metric: "4×",
      unit: "lead-konvertering",
      note: "Samme målgruppe, samme budget — Burst på et SMS- og pleje-flow over 3 måneder.",
    },
    anchorClient: { name: "Burst", line: "4× på samme budget." },
    supportingClients: [
      { initials: "—", name: "TBD" },
      { initials: "—", name: "TBD" },
    ],
    visual: "pipeline",
  },
];

const outboundCards = [
  {
    type: "linkedin" as const,
    name: "Sara El-Khouri",
    title: "Adm. direktør · Tagværk ApS",
    initials: "SE",
    preview:
      "Hej Sara — så at I lige har vundet udbuddet på Frederiksberg. Hvis I vil have flere lignende leads, har jeg…",
    chip: "1. grads",
  },
  {
    type: "meta" as const,
    sponsor: "Sponsoreret · Carter & Co",
    headline: "Flere leads. Ringet op med det samme.",
    body: "Jeg bygger systemet. Du lukker aftalerne.",
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

type PhoneLead = {
  name: string;
  company: string;
  source: string;
  initials: string;
  callDoneAt: string;
  automationDate: string;
  inviteTime: string;
  bookingLabel: string;
  slots: { t: string; available: boolean }[];
  thread: { from: "us" | "them"; text: string; time: string }[];
  // "missed" → SMS bridge flow (sælger ringede → cal.check → SMS → Booket).
  // "answered" → human-closed flow (sælger talte → outcome marked).
  callPath: "missed" | "answered";
  // Only used when callPath === "answered" — duration on the talked chip.
  callDuration?: string;
  // Terminal outcome the cockpit lands on. Maps to OUTCOME_TONE keys in
  // src/app/leads/page.tsx:75–121.
  outcome: "booked" | "customer";
};

// Phone-scene loop. Cycle 1 plays the full intro (lockscreen → call → /leads).
// Cycles 2+ skip the intro and replay the /leads timeline with a new lead;
// an in-app "new lead" toast stands in for the lockscreen notification.
const leadsRotation: PhoneLead[] = [
  {
    name: "Mette Sørensen",
    company: "Nordlys A/S",
    source: "ad. Meta",
    initials: "MS",
    callDoneAt: "14:31",
    automationDate: "i_morgen",
    inviteTime: "10:00",
    bookingLabel: "I morgen · 10:00 · 30 min",
    slots: [
      { t: "09:00", available: false },
      { t: "09:30", available: false },
      { t: "10:00", available: true },
      { t: "10:30", available: false },
      { t: "11:00", available: false },
    ],
    thread: [
      { from: "us", text: "Hej Mette — tak for din interesse i Nordlys-pakken. Har du tid til en kort snak i morgen kl. 10?", time: "14:32" },
      { from: "them", text: "Ja, det passer fint :)", time: "14:34" },
      { from: "us", text: "Perfekt — jeg sender en kalenderinvitation nu.", time: "14:35" },
    ],
    callPath: "missed",
    outcome: "booked",
  },
  {
    name: "Jonas Holm",
    company: "Bygma Vest",
    source: "ad. Meta",
    initials: "JH",
    callDoneAt: "11:03",
    automationDate: "fredag",
    inviteTime: "13:30",
    bookingLabel: "Fredag · 13:30 · 30 min",
    slots: [
      { t: "12:30", available: false },
      { t: "13:00", available: false },
      { t: "13:30", available: true },
      { t: "14:00", available: false },
      { t: "14:30", available: false },
    ],
    thread: [
      { from: "us", text: "Hej Jonas — tak for snakken om Bygma-tilbuddet. Har du 20 min fredag kl. 13:30?", time: "11:04" },
      { from: "them", text: "Det fungerer fint", time: "11:06" },
      { from: "us", text: "Top — kalenderinvitation kommer nu.", time: "11:07" },
    ],
    callPath: "answered",
    callDuration: "3:42",
    outcome: "customer",
  },
  {
    name: "Sara El-Khouri",
    company: "Tagværk",
    source: "LinkedIn",
    initials: "SE",
    callDoneAt: "09:45",
    automationDate: "overmorgen",
    inviteTime: "09:30",
    bookingLabel: "Overmorgen · 09:30 · 20 min",
    slots: [
      { t: "08:30", available: false },
      { t: "09:00", available: false },
      { t: "09:30", available: true },
      { t: "10:00", available: false },
      { t: "10:30", available: false },
    ],
    thread: [
      { from: "us", text: "Hej Sara — så I kiggede på altan-pakken. Passer det med en snak overmorgen 09:30?", time: "09:46" },
      { from: "them", text: "Ja gerne", time: "09:48" },
      { from: "us", text: "Sender invite med det samme.", time: "09:49" },
    ],
    callPath: "missed",
    outcome: "booked",
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
    // Monday: real multi-color brand mark on white tile
    id: "monday",
    x: 14, y: 16, size: 64, rot: -6, bg: "#FFFFFF", border: "#E5E0D5",
    iconSrc: "/icons/integrations/monday.svg",
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
    // Salesforce: real SimpleIcons cloud
    id: "salesforce",
    x: 72, y: 8, size: 76, rot: 5, bg: "#00A1E0",
    iconSrc: "/icons/integrations/salesforce.svg",
  },
  // — Middle band —
  {
    // Microsoft Dynamics 365: real SimpleIcons mark
    id: "dynamics",
    x: 6, y: 44, size: 68, rot: 6, bg: "#0078D4",
    iconSrc: "/icons/integrations/dynamics.svg",
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
    // LinkedIn: real SimpleIcons "in" mark
    id: "linkedin",
    x: 12, y: 76, size: 72, rot: -5, bg: "#0A66C2",
    iconSrc: "/icons/integrations/linkedin.svg",
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
};

export default function Home() {
  const [open, setOpen] = useState(false);
  const [quizOpen, setQuizOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  const [form, setForm] = useState<FormState>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const formRef = useRef(form);
  const honeypotRef = useRef("");
  // Føre phone animation — time-based loop. Replays on scroll-into-view,
  // then ticks every ~8s while visible. Cycles 0–1 play the full intro
  // (lockscreen → call → /leads with Mette). Cycles 2+ skip the intro and
  // replay the /leads timeline with a new lead from leadsRotation, with an
  // in-app "new lead" toast standing in for the lockscreen notification.
  const phoneRef = useRef<HTMLDivElement | null>(null);
  const [smsCycle, setSmsCycle] = useState(0);
  // displayedLead lags currentLead by 3.4s on cycle 2+ — that's the toast +
  // call-screen window. So when cycle 2 starts, the previous lead's settled
  // SMS chat stays visible while the toast slides in over it. Phase 3 only
  // re-mounts (and fades in the new lead) once the call has visually ended.
  const [displayedLead, setDisplayedLead] = useState<PhoneLead>(leadsRotation[0]);
  useEffect(() => {
    const node = phoneRef.current;
    if (!node) return;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          setSmsCycle((n) => n + 1);
          if (intervalId === null) {
            intervalId = setInterval(() => setSmsCycle((n) => n + 1), 16000);
          }
        } else if (intervalId !== null) {
          clearInterval(intervalId);
          intervalId = null;
        }
      },
      { threshold: 0.4 },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      if (intervalId !== null) clearInterval(intervalId);
    };
  }, []);

  // Cycle 1 (intro): swap displayedLead immediately. Cycle 2+: hold the
  // previous lead in place for 3.4s (toast + call window), then swap once the
  // new lead's call has visually concluded.
  useEffect(() => {
    const lead = leadsRotation[Math.max(0, smsCycle - 1) % leadsRotation.length];
    // 2000ms — swap while Phase 2 (call screen) fully covers the phone, so
    // the previous lead's chat is never re-revealed as Phase 2 fades out.
    const delay = smsCycle <= 1 ? 0 : 2000;
    const t = setTimeout(() => setDisplayedLead(lead), delay);
    return () => clearTimeout(t);
  }, [smsCycle]);

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

  // Phone-scene loop: pick a lead per cycle. Cycle 1 plays the lockscreen
  // intro (chips wait until 3.4s, after the call); cycles 2+ swap the lockscreen
  // for an in-app toast and the chips begin animating in immediately at t=0
  // so the screen has live content behind the toast (rather than an empty
  // backdrop). Call screen still overlays at 1.6s and SMS view re-emerges
  // at 3.4s with the chips already settled.
  const isFirstCycle = smsCycle <= 1;
  const currentLead = leadsRotation[Math.max(0, smsCycle - 1) % leadsRotation.length];
  // Cycle 1: Phase 3 mounts at t=0, chips animate at 3.7s+ (after the call).
  // Cycle 2+: Phase 3 remounts at t=2.0s (mid-call). Offset = 1.4 so chips
  // still animate at 3.7s+ real-time, matching cycle 1's pacing.
  const phase3Base = isFirstCycle ? 3.4 : 1.4;

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
    if (typeof window !== "undefined" && typeof window.plausible === "function") {
      window.plausible("cta_click");
    }
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
      utm_source: "carterco.dk",
      utm_medium: "hero_form",
    });

    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }

    // Honeypot: if a bot filled the hidden field, silently drop the
    // Supabase insert but still proceed to Calendly so probes can't
    // distinguish a block from a pass.
    if (honeypotRef.current.trim().length > 0) {
      window.location.href = `${calendlyUrl}?${params.toString()}`;
      setSubmitted(true);
      return;
    }

    try {
      const supabase = createClient();
      const leadPayload = {
        name: cleaned.name,
        company: cleaned.company,
        email: cleaned.email,
        phone: cleaned.phone,
        source: "carterco.dk",
        workspace_id: CARTERCO_WORKSPACE_ID,
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

      if (typeof window !== "undefined" && typeof window.plausible === "function") {
        window.plausible("lead_submitted");
      }

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
      <section className="relative flex min-h-screen flex-col overflow-hidden lg:min-h-[min(100vh,860px)]">
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
        <h1 className="font-display text-[11.2vw] leading-[0.95] tracking-[-0.05em] sm:text-[9.6vw] lg:text-[clamp(3rem,6vw,5.5rem)]">
          <span className="relative inline-block">
            <span className="absolute inset-0 -z-10 scale-125 bg-[radial-gradient(ellipse_at_center,rgba(255,107,44,0.45),transparent_65%)] blur-2xl" />
            <span className="bg-gradient-to-b from-[#ffb86b] via-[#ff6b2c] to-[#c93c0a] bg-clip-text pe-[0.18em] italic text-transparent">
              Salgsinfrastruktur
            </span>
          </span>
          <br />
          til ambitiøse B2B teams
        </h1>

        <div className="mt-10 flex flex-col gap-14 pb-10 sm:mt-12 lg:mt-14">
          <p
            className="max-w-xl text-lg leading-relaxed text-[var(--cream)]/70 sm:max-w-2xl sm:text-xl"
            style={{ textWrap: "balance" }}
          >
            Tre dele af salgsinfrastrukturen, bygget og driftet på dit eget setup. Outbound. Speed-to-lead. Post-meeting. Det fulde billede eller bare den del der mangler.
          </p>

          <div className="flex flex-col-reverse items-start justify-between gap-8 sm:flex-row sm:items-end">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/signature.png"
              alt="Louis Carter"
              draggable={false}
              onContextMenu={(e) => e.preventDefault()}
              className="pointer-events-none h-16 w-auto select-none sm:h-20"
              style={{
                filter: "invert(1)",
                mixBlendMode: "screen",
                WebkitUserDrag: "none",
              } as React.CSSProperties}
            />

            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
              <button
                type="button"
                onClick={() => setQuizOpen(true)}
                className="group inline-flex items-center gap-4 rounded-full bg-[#ff6b2c] px-8 py-5 text-sm font-bold uppercase tracking-[0.25em] text-[#0f0d0a] shadow-[0_18px_60px_rgba(255,107,44,0.35)] transition hover:-translate-y-1 hover:bg-[#ff8244] hover:shadow-[0_24px_80px_rgba(255,107,44,0.5)]"
              >
                <span>Tag lead-quizzen</span>
                <span className="text-lg">→</span>
              </button>
            </div>
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
          <h2 className="text-center font-display text-[10vw] leading-[0.9] tracking-[-0.04em] text-[#29261f] sm:text-6xl lg:text-7xl">
            Forskellige brancher.
            <br />
            <span className="italic text-[var(--clay)]">Samme retning.</span>
          </h2>

          <div className="mt-16 grid gap-px overflow-hidden rounded-2xl border border-[#29261f]/12 bg-[#29261f]/12 sm:mt-20 sm:grid-cols-3">
            {cases.map((c) => (
              <article
                key={c.client}
                className="group relative flex flex-col gap-6 bg-[#f6efe4] p-10 transition hover:bg-[#efe6d6] sm:p-12"
              >
                <div className="flex flex-col gap-2">
                  <span className="relative inline-block whitespace-nowrap font-display text-6xl italic leading-none tracking-tight sm:text-7xl">
                    <span
                      className={`bg-clip-text text-transparent ${
                        c.kind === "won"
                          ? "bg-gradient-to-b from-[#3d8a6c] via-[#19463a] to-[#0c2a22]"
                          : "bg-gradient-to-b from-[#ffb86b] via-[#ff6b2c] to-[#c93c0a]"
                      }`}
                    >
                      {c.metric}
                    </span>
                    {c.annotation && (
                      <span
                        className="pointer-events-none absolute left-[40%] bottom-full mb-[0.1em] inline-flex items-center gap-[0.2em] whitespace-nowrap text-[0.3em] font-normal not-italic leading-none tracking-normal text-[#c93c0a]"
                        style={{
                          fontFamily: "var(--font-handwritten)",
                          transform: "translateX(60px) rotate(-4deg)",
                        }}
                      >
                        ({c.annotation})
                        <span
                          aria-hidden
                          className="inline-block h-[1.1em] w-[1.1em] shrink-0 bg-[#c93c0a]"
                          style={{
                            maskImage: "url(/annotation-arrow.png)",
                            maskSize: "contain",
                            maskRepeat: "no-repeat",
                            maskPosition: "center",
                            WebkitMaskImage: "url(/annotation-arrow.png)",
                            WebkitMaskSize: "contain",
                            WebkitMaskRepeat: "no-repeat",
                            WebkitMaskPosition: "center",
                            transform: "translate(-90px, 30px) rotate(80deg)",
                          }}
                        />
                      </span>
                    )}
                  </span>
                  <span className="text-[11px] font-bold uppercase tracking-[0.25em] text-[#29261f]/60">
                    {c.metricLabel}
                  </span>
                </div>

                <p className="text-base leading-relaxed text-[#29261f]/75">
                  {c.copy}
                </p>

                {c.quote ? (
                  <blockquote className="border-l-2 border-[var(--clay)]/45 pl-4 text-[15px] italic leading-relaxed text-[#29261f]/85">
                    &ldquo;{c.quote}&rdquo;
                    {c.quoteAttribution ? (
                      <footer className="mt-2 not-italic text-[10px] font-bold uppercase tracking-[0.25em] text-[#29261f]/55">
                        — {c.quoteAttribution}
                      </footer>
                    ) : null}
                  </blockquote>
                ) : null}

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

      <section className="relative overflow-hidden bg-[#0a0907] py-36 sm:py-48 lg:py-56">
        {/* Atmospheric backdrop — top-of-section warm glow */}
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          <div className="absolute left-1/2 top-[8%] h-[700px] w-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(255,107,44,0.10),transparent_65%)] blur-2xl" />
          <div className="absolute bottom-0 left-0 right-0 h-[40%] bg-[linear-gradient(180deg,transparent,#0a0907)]" />
        </div>

        <div className="mx-auto w-full max-w-[1400px] px-8 sm:px-12">
          {/* Header */}
          <div>
            <h2 className="font-display text-[11vw] leading-[0.88] tracking-[-0.045em] sm:text-7xl lg:text-[6rem]">
              Hele vejen fra
              <br />
              kontakt til kontrakt.
            </h2>
            <p className="mt-7 max-w-md text-[13px] uppercase tracking-[0.28em] text-[var(--cream)]/45">
              Tre dele · samme værksted
            </p>
          </div>

          {/* Three sections — no wire / no rail nodes. Each is its own beat;
              they read as a connected practice via the closing connective
              line below, not via a visual spine. EmberSpark dividers between
              stages give each machine its own poster moment. */}
          <div className="relative mt-32 sm:mt-44">
            <div className="flex flex-col gap-36 sm:gap-48 lg:gap-56">
              {journey.map((stage, i) => {
                const isReverse = i % 2 === 1;
                // Per-stage atmospheric tint: subtle radial in a unique
                // position + accent so each machine reads as its own poster
                // without leaving the ember theme.
                const stageBackdrop =
                  stage.n === "01"
                    ? (
                      <div aria-hidden className="pointer-events-none absolute inset-0 -z-[1]">
                        <div className="absolute -right-[10%] top-[5%] h-[420px] w-[520px] rounded-full bg-[radial-gradient(ellipse_at_center,rgba(185,112,65,0.22),transparent_70%)] blur-3xl" />
                      </div>
                    )
                    : stage.n === "02"
                    ? (
                      <div aria-hidden className="pointer-events-none absolute inset-0 -z-[1]">
                        <div className="absolute left-[8%] top-[20%] h-[480px] w-[600px] rounded-full bg-[radial-gradient(ellipse_at_center,rgba(255,107,44,0.18),transparent_65%)] blur-3xl" />
                      </div>
                    )
                    : (
                      <div aria-hidden className="pointer-events-none absolute inset-0 -z-[1]">
                        <div className="absolute right-[5%] bottom-[10%] h-[460px] w-[560px] rounded-full bg-[radial-gradient(ellipse_at_center,rgba(25,70,58,0.28),transparent_68%)] blur-3xl" />
                      </div>
                    );

                return (
                  <article key={stage.n} className="relative">
                    {stageBackdrop}
                    {/* Ghost numeral — keep editorial weight without the rail */}
                    <span
                      aria-hidden
                      className="ghost-numeral pointer-events-none absolute -top-16 right-0 select-none text-[18rem] leading-none sm:-top-24 sm:right-auto sm:left-[-1rem] sm:text-[22rem]"
                    >
                      {stage.n}
                    </span>

                    {/* Row 1 — copy + primary mockup, side-by-side. */}
                    <div className="grid gap-12 sm:grid-cols-12 sm:items-center sm:gap-12">
                    {/* Copy column */}
                    <div
                      className={`relative ${isReverse ? "sm:col-span-5 sm:col-start-7" : "sm:col-span-5 sm:col-start-2"} flex flex-col`}
                    >
                      <div className="flex items-center gap-3">
                        <span aria-hidden className="h-px w-10 bg-[#ff6b2c]" />
                        <p className="text-[10px] font-bold uppercase tracking-[0.32em] text-[#ff6b2c]">
                          {stage.eyebrow}
                        </p>
                      </div>

                      <h3 className="mt-7 font-display text-3xl leading-[1.08] tracking-tight sm:text-4xl lg:text-[2.75rem]">
                        {stage.title}{" "}
                        <span className="italic text-[var(--clay)]/90">
                          {stage.titleAccent}
                        </span>
                      </h3>
                      <p className="mt-5 max-w-md text-[15px] leading-relaxed text-[var(--cream)]/72">
                        {stage.body}
                      </p>

                      {/* Sub-points — show the breadth of work in this area,
                          editorial list (no SaaS-feature-grid). Each line is
                          a thing the operator actually does, not a feature
                          the buyer gets. */}
                      <ul className="mt-7 flex max-w-md flex-col gap-2.5 text-[14px] leading-snug text-[var(--cream)]/72">
                        {stage.subpoints.map((point) => (
                          <li key={point} className="flex items-start gap-3">
                            <span
                              aria-hidden
                              className="mt-2 inline-block h-px w-3 shrink-0 bg-[#ff6b2c]/55"
                            />
                            <span>{point}</span>
                          </li>
                        ))}
                      </ul>

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
                              {stage.proof.noteHref ? (
                                <a
                                  href={stage.proof.noteHref}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="underline decoration-[#ff6b2c]/60 decoration-2 underline-offset-4 transition hover:text-[var(--cream)]/85 hover:decoration-[#ff6b2c]"
                                >
                                  {stage.proof.note}
                                  <sup className="ml-0.5 text-[10px] font-bold text-[#ff6b2c]">↗</sup>
                                </a>
                              ) : (
                                stage.proof.note
                              )}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Anchor client + supporting circles — placeholders.
                          Real avatars/logos go in later; for now: the anchor
                          gets a named line, the supporting clients are round
                          initials-circles you swap to real portraits or
                          cropped logos. */}
                      <div className="mt-9 flex items-center gap-5 border-t border-[var(--cream)]/10 pt-6">
                        <div className="flex items-center gap-2.5">
                          <span
                            className="grid h-10 w-10 place-items-center rounded-full border border-[var(--clay)]/40 bg-[var(--clay)]/15 text-[11px] font-bold uppercase tracking-wider text-[var(--cream)]/80"
                            aria-label={`Anchor case: ${stage.anchorClient.name}`}
                          >
                            {stage.anchorClient.name.slice(0, 2)}
                          </span>
                          <div className="min-w-0">
                            <div className="text-[12px] font-bold uppercase tracking-[0.18em] text-[var(--cream)]/85">
                              {stage.anchorClient.name}
                            </div>
                            <div className="text-[12px] text-[var(--cream)]/55">
                              {stage.anchorClient.line}
                            </div>
                          </div>
                        </div>

                        <div className="ml-auto flex items-center -space-x-2">
                          {stage.supportingClients.map((c, idx) => {
                            // Empty slot: portrait silhouette placeholder.
                            // When real avatars / cropped logos land, just swap
                            // initials from "—" to the client's letters or drop
                            // in an <img>.
                            const isEmpty = c.initials === "—";
                            return (
                              <span
                                key={`${stage.n}-supporting-${idx}`}
                                className="relative grid h-9 w-9 place-items-center overflow-hidden rounded-full border border-[var(--cream)]/15 bg-[radial-gradient(ellipse_at_top,rgba(255,184,107,0.10),rgba(15,13,10,0.55))] text-[10px] font-bold uppercase tracking-wider text-[var(--cream)]/65 shadow-[0_3px_8px_rgba(0,0,0,0.35)]"
                                aria-label={isEmpty ? "Yderligere klient — kommer" : `Også: ${c.name}`}
                                title={c.name}
                              >
                                {isEmpty ? (
                                  <svg viewBox="0 0 24 24" className="h-4 w-4 text-[var(--cream)]/30" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                                    <circle cx="12" cy="8" r="3.5" />
                                    <path d="M4.5 20c0-3.6 3.4-6.5 7.5-6.5s7.5 2.9 7.5 6.5" />
                                  </svg>
                                ) : (
                                  c.initials
                                )}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    </div>

                    {/* Visual column */}
                    <div
                      className={`relative ${isReverse ? "sm:col-span-6 sm:col-start-1 sm:row-start-1" : "sm:col-span-6 sm:col-start-7"} flex items-start justify-center pt-4`}
                    >
                      {stage.visual === "outbound" && (
                        <div className="relative h-[32rem] w-full max-w-[34rem] sm:h-[34rem]">
                          {/* SendSpark video thumbnail — placeholder for the
                              video-personalization step. Sits middle-back as
                              the third card in the fan. Real thumbnail will
                              slot into the aspect-video shell. */}
                          <div
                            className="subtle-float absolute left-[10%] top-0 w-[62%] origin-bottom-right"
                            style={{
                              ["--float-base" as string]: "rotate(4deg)",
                              animationDelay: "0.8s",
                            }}
                          >
                            <div className="overflow-hidden rounded-2xl border border-[var(--cream)]/8 bg-[#14110d] shadow-[0_40px_80px_-30px_rgba(0,0,0,0.55)]">
                              <div className="relative aspect-[16/10]">
                                <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(255,184,107,0.22),rgba(0,0,0,0)_55%),linear-gradient(225deg,rgba(255,107,44,0.14),rgba(0,0,0,0)_60%),linear-gradient(180deg,#1a1612,#0f0d0a)]" />
                                {/* placeholder grid pattern to signal "image goes here" */}
                                <div
                                  className="absolute inset-0 opacity-[0.06]"
                                  style={{
                                    backgroundImage:
                                      "linear-gradient(45deg, #fff8ea 25%, transparent 25%), linear-gradient(-45deg, #fff8ea 25%, transparent 25%)",
                                    backgroundSize: "14px 14px",
                                    backgroundPosition: "0 0, 0 7px",
                                  }}
                                />
                                <div className="absolute inset-0 flex items-center justify-center">
                                  <div className="grid h-14 w-14 place-items-center rounded-full bg-[var(--cream)]/95 shadow-[0_4px_20px_rgba(0,0,0,0.45)]">
                                    <svg viewBox="0 0 24 24" className="ml-0.5 h-6 w-6 fill-[#0f0d0a]">
                                      <path d="M8 5v14l11-7z" />
                                    </svg>
                                  </div>
                                </div>
                                <div className="absolute bottom-2.5 right-2.5 rounded-md bg-[#0f0d0a]/85 px-1.5 py-0.5 text-[10px] font-medium text-[var(--cream)]/85">
                                  0:23
                                </div>
                                <div className="absolute bottom-2.5 left-2.5 rounded-md bg-[var(--clay)]/25 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.18em] text-[var(--cream)]/85">
                                  Personlig video
                                </div>
                              </div>
                              <div className="border-t border-[var(--cream)]/8 px-3.5 py-2.5">
                                <div className="flex items-center gap-2">
                                  <div className="grid h-5 w-5 place-items-center rounded-full bg-[#ff6b2c]/25 text-[10px] font-bold text-[#ff6b2c]">
                                    ▶
                                  </div>
                                  <div className="min-w-0 flex-1 truncate text-[11px] text-[var(--cream)]/72">
                                    Optaget af site · sara@tagværk.dk
                                  </div>
                                  <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--clay)]/85">
                                    Send
                                  </span>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Meta ad card — back, tilted right */}
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
                              <div className="relative aspect-[3/2] overflow-hidden bg-[#14110d]">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src="/ads/lead-varmt.png"
                                  alt="Sælg mens leadet er varmt"
                                  draggable={false}
                                  className="absolute inset-0 h-full w-full object-cover"
                                />
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

                          {/* LinkedIn DM card — front, tilted left */}
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
                                {(outboundCards[0]?.preview ?? "")
                                  .split(/(\([^)]+\))/g)
                                  .map((part, i) =>
                                    part.startsWith("(") && part.endsWith(")") ? (
                                      <span
                                        key={i}
                                        className="rounded-[4px] bg-[var(--clay)]/15 px-1 py-px font-mono text-[11px] font-semibold text-[var(--clay)]"
                                      >
                                        {part}
                                      </span>
                                    ) : (
                                      <span key={i}>{part}</span>
                                    ),
                                  )}
                              </p>
                              <div className="mt-4 flex gap-2">
                                <button
                                  type="button"
                                  className="rounded-full border border-[#29261f]/15 bg-[#29261f]/5 px-4 py-1.5 text-[11px] font-semibold text-[#29261f]/80"
                                >
                                  Profil
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
                        </div>
                      )}

                      {stage.visual === "flows" && (
                        <div className="relative w-full max-w-[30rem]">
                          {/* Flow builder card */}
                          <div className="w-full">
                            <div className="rounded-2xl border border-[#29261f]/12 bg-[#fff8ea] p-4 shadow-[0_40px_80px_-30px_rgba(0,0,0,0.55)] sm:p-5">
                              {/* Header */}
                              <div className="flex items-center justify-between border-b border-[#29261f]/10 pb-3">
                                <div className="flex items-center gap-2.5">
                                  <div className="grid h-7 w-7 place-items-center rounded-md bg-[#ff6b2c]/15">
                                    <span className="h-1.5 w-1.5 rounded-full bg-[#ff6b2c] dot-pulse" />
                                  </div>
                                  <div>
                                    <div className="text-[11px] font-semibold text-[#29261f]">
                                      Flow · Nurture varme leads
                                    </div>
                                    <div className="text-[9px] uppercase tracking-[0.18em] text-[#29261f]/55">
                                      412 aktive · live
                                    </div>
                                  </div>
                                </div>
                                <span className="rounded-full border border-[var(--forest)]/35 bg-[var(--forest)]/10 px-2 py-0.5 text-[8px] font-bold uppercase tracking-[0.2em] text-[var(--forest)]">
                                  Kører
                                </span>
                              </div>

                              {/* Nodes — relative for the silent lead chip overlay */}
                              <div className="relative mt-3.5">
                                {/* Trigger */}
                                <div className="rounded-lg border border-[var(--clay)]/35 bg-[var(--clay)]/10 px-3 py-2">
                                  <div className="flex items-center gap-2">
                                    <span className="grid h-5 w-5 place-items-center rounded-md bg-[var(--clay)]/25 text-[9px] font-bold text-[var(--clay)]">
                                      T
                                    </span>
                                    <span className="text-[11px] font-semibold text-[#29261f]">
                                      Trigger · Lead opted in
                                    </span>
                                  </div>
                                </div>
                                <div aria-hidden className="ml-[14px] h-2.5 w-px bg-[#29261f]/20" />

                                {/* Email */}
                                <div className="rounded-lg border border-[#29261f]/12 bg-[#f6efe4] px-3 py-2">
                                  <div className="flex items-center gap-2">
                                    <span className="grid h-5 w-5 place-items-center rounded-md bg-[#29261f]/12 text-[9px] font-bold text-[#29261f]/70">
                                      E
                                    </span>
                                    <span className="text-[11px] font-semibold text-[#29261f]">
                                      Email · Velkomst
                                    </span>
                                  </div>
                                </div>
                                <div aria-hidden className="ml-[14px] h-2.5 w-px bg-[#29261f]/20" />

                                {/* Wait */}
                                <div className="rounded-lg border border-dashed border-[#29261f]/18 px-3 py-2">
                                  <div className="flex items-center gap-2">
                                    <span className="grid h-5 w-5 place-items-center rounded-md text-[10px] text-[#29261f]/45">
                                      ◷
                                    </span>
                                    <span className="text-[11px] text-[#29261f]/65">Vent 2 dage</span>
                                  </div>
                                </div>
                                <div aria-hidden className="ml-[14px] h-2.5 w-px bg-[#29261f]/20" />

                                {/* SMS */}
                                <div className="rounded-lg border border-[#29261f]/12 bg-[#f6efe4] px-3 py-2">
                                  <div className="flex items-center gap-2">
                                    <span className="grid h-5 w-5 place-items-center rounded-md bg-[#29261f]/12 text-[9px] font-bold text-[#29261f]/70">
                                      S
                                    </span>
                                    <span className="text-[11px] font-semibold text-[#29261f]">
                                      SMS · Tjek-ind
                                    </span>
                                  </div>
                                </div>
                                <div aria-hidden className="ml-[14px] h-2.5 w-px bg-[#29261f]/20" />

                                {/* Last step · trigger an outbound call to the lead */}
                                <div className="rounded-lg border border-[#ff6b2c]/45 bg-[#ff6b2c]/10 px-3 py-2">
                                  <div className="flex items-center gap-2">
                                    <span className="grid h-5 w-5 place-items-center rounded-md bg-[#ff6b2c]/25 text-[10px] font-bold text-[#ff6b2c]">
                                      ☎
                                    </span>
                                    <span className="text-[11px] font-semibold text-[#29261f]">
                                      Opfølgende opkald
                                    </span>
                                  </div>
                                </div>

                                {/* Event 1 · Møde booket — appears when the call books a meeting */}
                                <div className="event-wrapper-1 overflow-hidden">
                                  <div aria-hidden className="event-connector-1 ml-[14px] h-2.5 w-px bg-[var(--forest)]/40" />
                                  <div className="event-node-1 rounded-lg border border-[var(--forest)]/35 bg-[var(--forest)]/10 px-3 py-2">
                                    <div className="flex items-center gap-2">
                                      <span className="grid h-5 w-5 place-items-center rounded-md bg-[var(--forest)]/25 text-[10px] font-bold text-[var(--forest)]">
                                        ✓
                                      </span>
                                      <span className="text-[11px] font-semibold text-[#29261f]">
                                        Møde · i morgen 10:00
                                      </span>
                                      <span className="ml-auto rounded-full border border-[var(--forest)]/35 bg-[var(--forest)]/15 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.18em] text-[var(--forest)]">
                                        + event
                                      </span>
                                    </div>
                                  </div>
                                </div>

                                {/* Event 2 · Kontrakt sendt — appears after the meeting */}
                                <div className="event-wrapper-2 overflow-hidden">
                                  <div aria-hidden className="event-connector-2 ml-[14px] h-2.5 w-px bg-[var(--forest)]/40" />
                                  <div className="event-node-2 rounded-lg border border-[var(--forest)]/35 bg-[var(--forest)]/10 px-3 py-2">
                                    <div className="flex items-center gap-2">
                                      <span className="grid h-5 w-5 place-items-center rounded-md bg-[var(--forest)]/25 text-[10px] font-bold text-[var(--forest)]">
                                        ✓
                                      </span>
                                      <span className="text-[11px] font-semibold text-[#29261f]">
                                        Kontrakt sendt · 32.500 kr
                                      </span>
                                      <span className="ml-auto rounded-full border border-[var(--forest)]/35 bg-[var(--forest)]/15 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.18em] text-[var(--forest)]">
                                        + event
                                      </span>
                                    </div>
                                  </div>
                                </div>

                                {/* Event 3 · Onboarding — appears after the deal closes */}
                                <div className="event-wrapper-3 overflow-hidden">
                                  <div aria-hidden className="event-connector-3 ml-[14px] h-2.5 w-px bg-[var(--forest)]/40" />
                                  <div className="event-node-3 rounded-lg border border-[var(--forest)]/35 bg-[var(--forest)]/10 px-3 py-2">
                                    <div className="flex items-center gap-2">
                                      <span className="grid h-5 w-5 place-items-center rounded-md bg-[var(--forest)]/25 text-[10px] font-bold text-[var(--forest)]">
                                        ✓
                                      </span>
                                      <span className="text-[11px] font-semibold text-[#29261f]">
                                        Onboarding · næste mandag
                                      </span>
                                      <span className="ml-auto rounded-full border border-[var(--forest)]/35 bg-[var(--forest)]/15 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.18em] text-[var(--forest)]">
                                        + event
                                      </span>
                                    </div>
                                  </div>
                                </div>

                                {/* Lead chip — refined avatar that travels through the nodes */}
                                <div
                                  aria-hidden
                                  className="lead-glide pointer-events-none absolute right-2 top-[6px] grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-[#3a342a] to-[#0f0d0a] shadow-[0_10px_24px_-8px_rgba(0,0,0,0.55)] ring-2 ring-[#fff8ea]"
                                >
                                  <span className="font-display text-[11px] italic font-semibold text-[#ffb86b]">
                                    MS
                                  </span>
                                </div>
                              </div>

                              {/* Lead-status — separate from the flow nodes */}
                              <div className="mt-4 rounded-lg bg-[#29261f]/[0.04] px-3 py-2.5">
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex min-w-0 items-center gap-2">
                                    <span className="grid h-6 w-6 place-items-center rounded-full bg-[#29261f]/10 text-[8px] font-bold text-[#29261f]/75">
                                      MS
                                    </span>
                                    <div className="min-w-0 leading-tight">
                                      <div className="truncate text-[10px] font-semibold text-[#29261f]">
                                        Mette Sørensen
                                      </div>
                                      <div className="text-[8px] uppercase tracking-[0.18em] text-[#29261f]/50">
                                        Lead-status
                                      </div>
                                    </div>
                                  </div>
                                  <span className="relative h-[18px] min-w-[10rem]">
                                    <span className="status-pill-tilmeldt absolute inset-0 flex items-center justify-end gap-1.5 whitespace-nowrap text-[9px] font-semibold uppercase tracking-[0.12em] text-[#29261f]/75">
                                      <span className="h-1.5 w-1.5 rounded-full bg-[#ffb86b]" />
                                      Tilmeldt
                                    </span>
                                    <span className="status-pill-booket absolute inset-0 flex items-center justify-end gap-1.5 whitespace-nowrap text-[9px] font-semibold uppercase tracking-[0.12em] text-[#29261f]">
                                      <span className="h-1.5 w-1.5 rounded-full bg-[#ff6b2c] dot-pulse" />
                                      Møde booket · 10:00
                                    </span>
                                    <span className="status-pill-vundet absolute inset-0 flex items-center justify-end gap-1.5 whitespace-nowrap text-[9px] font-semibold uppercase tracking-[0.12em] text-[var(--forest)]">
                                      <span className="h-1.5 w-1.5 rounded-full bg-[var(--forest)]" />
                                      Aftale lukket · 32.500 kr
                                    </span>
                                  </span>
                                </div>
                              </div>

                              {/* Footer */}
                              <div className="mt-4 flex items-center justify-end border-t border-[#29261f]/10 pt-3 text-[9px] text-[#29261f]/55">
                                <span className="tabular">+38 denne uge</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}

                      {stage.visual === "pipeline" && (
                        <div className="flex w-full max-w-[34rem] flex-col gap-5">
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

                            <div className="relative grid min-h-[180px] grid-cols-4 gap-3">
                              {/* Animated ghost card moving across columns. Anchored to the
                                  grid's bottom edge so it slides through a clean lane below
                                  the static cards instead of stacking on top of them. The
                                  grid's min-height reserves vertical room for that lane. */}
                              <div
                                aria-hidden
                                className="pipeline-glide pointer-events-none absolute bottom-0 left-0 z-10 w-[calc(25%-0.5625rem)]"
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

                          {/* Nurture / reaktiverings-flow preview — secondary
                              mockup under the kanban so post-meeting shows
                              both "pleje" (flows) AND "lukke" (pipeline).
                              Compact placeholder; real flow nodes can replace
                              the simple node-row later. */}
                          <div className="rounded-2xl border border-[var(--cream)]/8 bg-[#14110d] p-5 shadow-[0_30px_60px_-30px_rgba(0,0,0,0.55)] sm:p-6">
                            <div className="flex items-center justify-between border-b border-[var(--cream)]/8 pb-3">
                              <div className="flex items-center gap-2.5">
                                <div className="grid h-7 w-7 place-items-center rounded-md bg-[var(--clay)]/15">
                                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--clay)] dot-pulse" />
                                </div>
                                <div>
                                  <div className="text-[12px] font-semibold text-[var(--cream)]/90">
                                    Nurture-flow · &quot;ikke klar nu&quot;
                                  </div>
                                  <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--cream)]/45">
                                    7 dages reaktivering · 18 i flow
                                  </div>
                                </div>
                              </div>
                              <span className="rounded-full border border-[var(--forest)]/45 bg-[var(--forest)]/20 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.18em] text-[var(--forest)]">
                                Aktiv
                              </span>
                            </div>
                            <div className="mt-5 flex items-center gap-2.5 overflow-x-auto pb-1">
                              {[
                                { label: "Email 1", sub: "Tak for snakken", tone: "done" },
                                { label: "Vent 3d", sub: "auto", tone: "wait" },
                                { label: "SMS", sub: "Personlig note", tone: "queued" },
                                { label: "Email 2", sub: "Case-study", tone: "queued" },
                                { label: "Engageret?", sub: "→ sælger", tone: "branch" },
                              ].map((node, idx, arr) => (
                                <div key={node.label} className="flex shrink-0 items-center">
                                  <div
                                    className={`min-w-[100px] rounded-lg border px-3 py-2 ${
                                      node.tone === "done"
                                        ? "border-[var(--forest)]/45 bg-[var(--forest)]/15"
                                        : node.tone === "wait"
                                        ? "border-[var(--cream)]/12 bg-[var(--cream)]/[0.04]"
                                        : node.tone === "branch"
                                        ? "border-[#ff6b2c]/45 bg-[#ff6b2c]/12"
                                        : "border-[var(--clay)]/35 bg-[var(--clay)]/10"
                                    }`}
                                  >
                                    <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--cream)]/85">
                                      {node.label}
                                    </div>
                                    <div className="text-[10px] text-[var(--cream)]/55">
                                      {node.sub}
                                    </div>
                                  </div>
                                  {idx < arr.length - 1 && (
                                    <span aria-hidden className="px-1 text-[var(--cream)]/35">
                                      →
                                    </span>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}

                      {stage.visual === "sms" && (
                        <div
                          ref={phoneRef}
                          className="relative"
                          style={{ ["--phone-screen-in-delay" as string]: isFirstCycle ? "3.4s" : "0s" }}
                        >
                          {/* Phone-frame chrome — fixed height so phase swap doesn't reflow.
                              The frame is NOT re-keyed; instead Phase 1, 2 and the toast each
                              get key={smsCycle} (replay their entrance animations every cycle)
                              while Phase 3 is keyed by displayedLead.name (only re-mounts when
                              the displayed lead actually changes — i.e. after the call screen
                              finishes on cycle 2+). That's how the toast can overlay the
                              previous lead's settled SMS chat instead of an empty backdrop. */}
                          <div className="relative w-[19rem] rounded-[2.5rem] border border-[#29261f]/15 bg-gradient-to-b from-[#fff8ea] to-[#f6efe4] p-2 shadow-[0_60px_120px_-40px_rgba(0,0,0,0.55)]">
                            <div className="relative h-[34rem] overflow-hidden rounded-[2rem] bg-[#fff8ea]">
                              {/* Persistent status bar across phases */}
                              <div className="absolute inset-x-0 top-0 z-20 flex items-center justify-between px-5 pt-3 text-[10px] text-[#29261f]/65">
                                <span className="tabular">14:30</span>
                                <span className="flex items-center gap-1">
                                  <span className="h-1.5 w-1.5 rounded-full bg-[#29261f]/65" />
                                  <span className="h-2 w-3 rounded-sm border border-[#29261f]/55" />
                                </span>
                              </div>

                              {/* ── Phase 1: Lock screen + incoming notification (0–1.6s, first cycle only) ── */}
                              {isFirstCycle && (
                                <div key={`lockscreen-${smsCycle}`} className="phone-screen-out absolute inset-0 z-10 px-4 pb-5 pt-9">
                                  {/* Soft wallpaper ambience */}
                                  <div
                                    aria-hidden
                                    className="pointer-events-none absolute inset-0 -z-10"
                                    style={{
                                      background:
                                        "radial-gradient(ellipse at 20% 25%, rgba(255,107,44,0.18), transparent 55%), radial-gradient(ellipse at 75% 80%, rgba(25,70,58,0.20), transparent 55%), linear-gradient(180deg, #fff8ea, #efe6d6)",
                                    }}
                                  />
                                  {/* Big wallpaper clock */}
                                  <div className="mt-10 text-center">
                                    <div className="font-display text-[3.5rem] leading-none tracking-tight text-[#29261f]/85">
                                      14:30
                                    </div>
                                    <div className="mt-1 text-[10px] uppercase tracking-[0.3em] text-[#29261f]/55">
                                      Tirsdag · 28. apr
                                    </div>
                                  </div>

                                  {/* Incoming notification — drops in at 0.2s */}
                                  <div
                                    className="notification-drop relative mx-1 mt-10 rounded-2xl border border-[#29261f]/12 bg-[#fff8ea]/95 p-3.5 shadow-[0_30px_60px_-25px_rgba(0,0,0,0.55)] backdrop-blur-sm"
                                    style={{ animationDelay: "0.25s" }}
                                  >
                                    <div className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.2em] text-[#29261f]/55">
                                      <span className="grid h-4 w-4 place-items-center rounded-[5px] bg-[#ff6b2c] text-[8px] font-bold text-[#fff8ea]">
                                        C
                                      </span>
                                      Carter &amp; Co
                                      <span className="ml-auto tabular text-[#29261f]/40">nu</span>
                                    </div>
                                    <div className="mt-2 text-[12px] font-semibold leading-tight text-[#29261f]">
                                      Nyt lead · {currentLead.name}
                                    </div>
                                    <div className="mt-0.5 text-[11px] text-[#29261f]/65">
                                      {currentLead.company} · {currentLead.source}
                                    </div>

                                    {/* Tap ripple — fires just before screen swap */}
                                    <span
                                      aria-hidden
                                      className="tap-ripple pointer-events-none absolute right-6 top-1/2 h-9 w-9 -translate-y-1/2 rounded-full bg-[#ff6b2c]/55"
                                    />
                                  </div>
                                </div>
                              )}

                              {/* ── Phase 2: Calling screen (1.6s–3.4s, every cycle) ── */}
                              <div
                                key={`call-${smsCycle}`}
                                className="phone-screen-call absolute inset-0 z-10 flex flex-col items-center justify-between px-6 pb-8 pt-9"
                                style={{
                                  background:
                                    "radial-gradient(ellipse at 50% 30%, rgba(25,70,58,0.35), transparent 60%), linear-gradient(180deg, #1c3530, #0f2620)",
                                }}
                              >
                                {/* Top context — outgoing call from /leads */}
                                <div className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.3em] text-[#fff8ea]/65">
                                  <span aria-hidden>↗</span>
                                  Udgående · /leads
                                </div>

                                {/* Avatar with pulsing rings */}
                                <div className="mt-2 flex flex-col items-center">
                                  {/* Avatar + halos pinned inside their own 96×96 container so
                                      the rings are centered behind the avatar (not behind the
                                      whole name/company/status flex column below). */}
                                  <div className="relative grid h-24 w-24 place-items-center">
                                    <span aria-hidden className="absolute inset-0 rounded-full bg-[var(--cream)]/15" />
                                    <span
                                      aria-hidden
                                      className="call-ring-pulse absolute inset-0 rounded-full border border-[var(--cream)]/35"
                                    />
                                    <span
                                      aria-hidden
                                      className="call-ring-pulse absolute inset-0 rounded-full border border-[var(--cream)]/35"
                                      style={{ animationDelay: "0.55s" }}
                                    />
                                    <span
                                      aria-hidden
                                      className="call-ring-pulse absolute inset-0 rounded-full border border-[var(--cream)]/35"
                                      style={{ animationDelay: "1.1s" }}
                                    />
                                    <div className="relative grid h-24 w-24 place-items-center rounded-full bg-[#1a3a32] font-display text-3xl text-[#fff8ea] ring-2 ring-[var(--cream)]/15">
                                      {currentLead.initials}
                                    </div>
                                  </div>
                                  <div className="mt-5 font-display text-[1.4rem] tracking-tight text-[#fff8ea]">
                                    {currentLead.name}
                                  </div>
                                  <div className="mt-1 text-[10px] uppercase tracking-[0.3em] text-[#fff8ea]/60">
                                    {currentLead.company}
                                  </div>
                                  <div className="mt-3 flex items-center gap-1 text-[11px] text-[#fff8ea]/75">
                                    Ringer op
                                    <span className="typing-dot inline-block h-1 w-1 rounded-full bg-[#fff8ea]/75" style={{ animationDelay: "0s" }} />
                                    <span className="typing-dot inline-block h-1 w-1 rounded-full bg-[#fff8ea]/75" style={{ animationDelay: "0.18s" }} />
                                    <span className="typing-dot inline-block h-1 w-1 rounded-full bg-[#fff8ea]/75" style={{ animationDelay: "0.36s" }} />
                                  </div>
                                </div>

                                {/* Call controls — abstract, evocative */}
                                <div className="flex items-center justify-center gap-5">
                                  <span aria-hidden className="grid h-11 w-11 place-items-center rounded-full bg-[#fff8ea]/10 text-[#fff8ea]/80">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                                      <path d="M5 9.5h2.5l1.5-2h6l1.5 2H19a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17v-6A1.5 1.5 0 0 1 5 9.5Z" />
                                      <circle cx="12" cy="14" r="2.5" />
                                    </svg>
                                  </span>
                                  {/* Hang-up button */}
                                  <span aria-hidden className="grid h-12 w-12 place-items-center rounded-full bg-[#d63b2c] text-[#fff8ea] shadow-[0_8px_24px_-6px_rgba(214,59,44,0.6)]">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                                      <path d="M12 8c-3.5 0-6.7 1.1-9.3 3a1.5 1.5 0 0 0-.5 1.7l1 2.4c.3.7 1 1.1 1.7 1l3.4-.5c.6-.1 1.1-.6 1.2-1.2l.3-1.7c1.4-.5 2.8-.7 4.2-.7 1.4 0 2.8.2 4.2.7l.3 1.7c.1.6.6 1.1 1.2 1.2l3.4.5c.7.1 1.4-.3 1.7-1l1-2.4a1.5 1.5 0 0 0-.5-1.7C18.7 9.1 15.5 8 12 8Z" transform="rotate(135 12 12)" />
                                    </svg>
                                  </span>
                                  <span aria-hidden className="grid h-11 w-11 place-items-center rounded-full bg-[#fff8ea]/10 text-[#fff8ea]/80">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                                      <path d="M9 4.5h2v15H9zM13 7.5h2v9h-2z" />
                                    </svg>
                                  </span>
                                </div>
                              </div>

                              {/* In-app "new lead" toast — only on cycle 2+. Sibling of Phase 3
                                  (not nested inside it) so it's visible during the 0–1.6s window
                                  where Phase 3 is still opacity 0 — i.e. the slot the lockscreen
                                  occupies on cycle 1. The keyframe slides the toast back up out
                                  of frame ~1.5s, just before Phase 2 fades in at 1.6s. */}
                              {!isFirstCycle && (
                                <div
                                  key={`toast-${smsCycle}`}
                                  className="inapp-toast pointer-events-none absolute left-3 right-3 top-7 z-30 rounded-2xl border border-[#29261f]/12 bg-[#fff8ea]/95 p-3 shadow-[0_30px_60px_-25px_rgba(0,0,0,0.55)] backdrop-blur-sm"
                                  style={{ animationDelay: "0.2s" }}
                                >
                                  <div className="flex items-center gap-2 text-[8.5px] font-bold uppercase tracking-[0.2em] text-[#29261f]/55">
                                    <span className="grid h-3.5 w-3.5 place-items-center rounded-[4px] bg-[#ff6b2c] text-[7px] font-bold text-[#fff8ea]">
                                      C
                                    </span>
                                    Carter &amp; Co
                                    <span className="ml-auto tabular text-[#29261f]/40">nu</span>
                                  </div>
                                  <div className="mt-1.5 text-[11px] font-semibold leading-tight text-[#29261f]">
                                    Nyt lead · {currentLead.name}
                                  </div>
                                  <div className="mt-0.5 text-[10px] text-[#29261f]/60">
                                    {currentLead.company} · {currentLead.source}
                                  </div>
                                </div>
                              )}

                              {/* ── Phase 3: /leads view (fades in at 3.4s on every cycle) ── */}
                              <div
                                key={`sms-${displayedLead.name}`}
                                className="phone-screen-in absolute inset-0 flex flex-col px-4 pb-5 pt-9"
                              >
                                {/* App chrome — back arrow + route */}
                                <div className="mb-2 flex items-center text-[9px] uppercase tracking-[0.25em] text-[#29261f]/55">
                                  <span className="flex items-center gap-1.5">
                                    <span aria-hidden>←</span>
                                    /leads
                                  </span>
                                </div>

                                {/* Lead header */}
                                <div className="mb-3 flex items-center gap-3 border-b border-[#29261f]/10 pb-3">
                                  <div className="grid h-9 w-9 place-items-center rounded-full bg-[#29261f]/10 font-display text-xs text-[#29261f]/75">
                                    {displayedLead.initials}
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <div className="text-[12px] text-[#29261f]">
                                      {displayedLead.name}
                                    </div>
                                    <div className="text-[9px] uppercase tracking-[0.2em] text-[#29261f]/50">
                                      {displayedLead.company} · {displayedLead.source}
                                    </div>
                                  </div>
                                </div>

                                {/* Activity timeline. Branches on displayedLead.callPath:
                                    - "missed": sælger ringede → cal.check → SMS bubbles → outcome chip
                                    - "answered": sælger talte → outcome chip */}
                                <div className="flex flex-1 flex-col gap-2 overflow-hidden">
                                  {displayedLead.callPath === "missed" ? (
                                    <>
                                  {/* Sælger ringer chip — appears first */}
                                  <div
                                    className="bubble-in flex items-center gap-2 self-stretch rounded-xl border border-[#29261f]/12 bg-[#29261f]/[0.04] px-3 py-2"
                                    style={{ animationDelay: `${phase3Base + 0.5}s` }}
                                  >
                                    <span className="relative grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--forest)] text-[#fff8ea]">
                                      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                                        <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
                                      </svg>
                                    </span>
                                    <div className="min-w-0 flex-1">
                                      <div className="text-[10px] text-[#29261f]">
                                        Sælger ringede · ingen svar
                                      </div>
                                      <div className="text-[9px] text-[#29261f]/55">
                                        23 sek &middot; SMS-flow tager over
                                      </div>
                                    </div>
                                    <span className="tabular text-[9px] text-[#29261f]/45">{displayedLead.callDoneAt}</span>
                                  </div>

                                  {/* Calendar-check automation — compact slot picker.
                                      Three stacked rows: clay header tracing the agent's
                                      function call, a horizontal slot ribbon where the booked
                                      time sits in a forest pill (everything else greyed +
                                      struck through), and a forest result strip confirming
                                      the invite was sent. A subtle clay scanline sweeps once
                                      across the ribbon as it lands — reads as the agent
                                      checking the calendar in real time. */}
                                  <div
                                    className="bubble-in self-stretch overflow-hidden rounded-xl border border-[var(--clay)]/35 bg-[var(--cream)] shadow-[0_10px_24px_-14px_rgba(0,0,0,0.35)]"
                                    style={{ animationDelay: `${phase3Base + 1.0}s` }}
                                  >
                                    {/* Trace header */}
                                    <div className="flex items-center gap-1.5 border-b border-[var(--clay)]/20 bg-[var(--clay)]/[0.07] px-2.5 py-[5px]">
                                      <span className="grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[3px] bg-[var(--clay)] text-[var(--cream)]">
                                        <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                                          <path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" />
                                        </svg>
                                      </span>
                                      <span className="font-mono text-[8.5px] font-bold uppercase tracking-[0.25em] text-[var(--clay)]">
                                        Agent
                                      </span>
                                      <span className="truncate font-mono text-[8.5px] text-[#29261f]/55">
                                        <span className="text-[#29261f]/40">·</span>{" "}
                                        <span className="text-[#29261f]/70">cal.check</span>
                                        <span className="text-[#29261f]/35">{"("}</span>
                                        <span className="text-[var(--clay)]">{`"${displayedLead.automationDate}"`}</span>
                                        <span className="text-[#29261f]/35">{")"}</span>
                                      </span>
                                      <span className="dot-pulse ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--forest)]" />
                                    </div>

                                    {/* Evaluation trace — reads as agent log output, not a clickable picker.
                                        Each slot shows a × / ✓ status mark above its time. */}
                                    <div className="relative">
                                      {/* Scanline sweep — clay-tinted gradient bar travels
                                          left-to-right once when the chip enters. */}
                                      <span
                                        aria-hidden
                                        className="cal-scan pointer-events-none absolute inset-y-0 left-0 z-0 w-1/3 bg-gradient-to-r from-transparent via-[var(--clay)]/25 to-transparent"
                                        style={{ animationDelay: `${phase3Base + 1.6}s` }}
                                      />
                                      <div className="relative z-10 flex items-stretch justify-between gap-0.5 px-2.5 py-2 font-mono">
                                        {displayedLead.slots.map((slot) => (
                                          <div key={slot.t} className="flex flex-col items-center gap-1">
                                            <span
                                              aria-hidden
                                              className={`text-[9px] leading-none ${
                                                slot.available ? "text-[var(--forest)]" : "text-[#29261f]/35"
                                              }`}
                                            >
                                              {slot.available ? "✓" : "×"}
                                            </span>
                                            <span
                                              className={`tabular text-[9.5px] leading-none ${
                                                slot.available
                                                  ? "font-bold text-[var(--forest)]"
                                                  : "text-[#29261f]/35 line-through"
                                              }`}
                                            >
                                              {slot.t}
                                            </span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>

                                    {/* Result strip */}
                                    <div className="flex items-center gap-1.5 border-t border-[var(--forest)]/15 bg-[var(--forest)]/[0.06] px-2.5 py-[5px] font-mono">
                                      <span className="grid h-3 w-3 shrink-0 place-items-center rounded-full bg-[var(--forest)] text-[var(--cream)]">
                                        <svg width="6" height="6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                          <path d="M5 12.5l4 4 10-10" />
                                        </svg>
                                      </span>
                                      <span className="text-[8.5px] text-[var(--forest)]/85">
                                        <span className="font-bold">invite.send</span>
                                        <span className="text-[var(--forest)]/55">{"("}</span>
                                        <span className="text-[var(--clay)]">{`"${displayedLead.inviteTime}"`}</span>
                                        <span className="text-[var(--forest)]/55">{")"}</span>
                                      </span>
                                      <span className="ml-auto text-[8.5px] uppercase tracking-[0.22em] text-[var(--forest)]/70">
                                        sendt
                                      </span>
                                    </div>
                                  </div>

                                  {/* SMS bubbles — sent AFTER the automation finds a slot */}
                                  {displayedLead.thread.map((m, k) => (
                                    <div
                                      key={k}
                                      className={`bubble-in flex flex-col ${m.from === "us" ? "items-end" : "items-start"}`}
                                      style={{ animationDelay: `${phase3Base + 1.8 + k * 0.6}s` }}
                                    >
                                      <div
                                        className={`max-w-[82%] rounded-2xl px-3 py-2 text-[12px] leading-snug ${
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
                                    </>
                                  ) : (
                                    <>
                                      {/* Sælger talte chip — replaces the sælger ringede +
                                          automation + SMS chain on the answered path. Same
                                          chip shell as sælger ringede, different copy. */}
                                      <div
                                        className="bubble-in flex items-center gap-2 self-stretch rounded-xl border border-[#29261f]/12 bg-[#29261f]/[0.04] px-3 py-2"
                                        style={{ animationDelay: `${phase3Base + 0.5}s` }}
                                      >
                                        <span className="relative grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--forest)] text-[#fff8ea]">
                                          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                                            <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
                                          </svg>
                                        </span>
                                        <div className="min-w-0 flex-1">
                                          <div className="text-[10px] text-[#29261f]">
                                            Sælger talte med {displayedLead.name.split(" ")[0]}
                                          </div>
                                          <div className="text-[9px] text-[#29261f]/55">
                                            {displayedLead.callDuration} &middot; aftale lukket på opkald
                                          </div>
                                        </div>
                                        <span className="tabular text-[9px] text-[#29261f]/45">{displayedLead.callDoneAt}</span>
                                      </div>
                                    </>
                                  )}

                                  {/* Outcome chip — final state. Two visual variants keyed
                                      to displayedLead.outcome:
                                      - "booked": forest border/35 + bg/10, calendar icon
                                      - "customer": forest accent + ring-2, mirrors
                                        OUTCOME_TONE.customer in src/app/leads/page.tsx */}
                                  <div
                                    className={
                                      displayedLead.outcome === "customer"
                                        ? "bubble-in mt-1 flex items-center gap-2.5 self-stretch rounded-xl border border-[var(--forest)] bg-[var(--forest)]/[0.16] px-3 py-2.5 ring-2 ring-[var(--forest)]/15"
                                        : "bubble-in mt-1 flex items-center gap-2.5 self-stretch rounded-xl border border-[var(--forest)]/35 bg-[var(--forest)]/10 px-3 py-2.5"
                                    }
                                    style={{
                                      animationDelay: `${
                                        phase3Base +
                                        (displayedLead.callPath === "missed" ? 4.0 : 2.2)
                                      }s`,
                                    }}
                                  >
                                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-[var(--forest)]/15 text-[var(--forest)]">
                                      {displayedLead.outcome === "customer" ? (
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                          <path d="M5 12.5l4 4 10-10" />
                                        </svg>
                                      ) : (
                                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                          <rect x="3.5" y="5" width="17" height="15" rx="2" />
                                          <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" />
                                        </svg>
                                      )}
                                    </span>
                                    <div className="min-w-0 flex-1">
                                      <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-[var(--forest)]">
                                        {displayedLead.outcome === "customer" ? "Kunde" : "Booket"}
                                      </div>
                                      <div className="text-[11px] text-[#29261f]">
                                        {displayedLead.outcome === "customer"
                                          ? `Aftale lukket · ${displayedLead.bookingLabel}`
                                          : displayedLead.bookingLabel}
                                      </div>
                                    </div>
                                    <span className="text-[14px] text-[var(--forest)]">✓</span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>

                        </div>
                      )}
                    </div>
                    </div>

                    {/* Row 2 — supporting mockups. 3-4 smaller cards per
                        section showing breadth of work (ICP scoring, reply
                        classifier, alt-contacts, push notify, attribution,
                        churn detection, etc.). Real implementations live in
                        supabase/functions — these are visual proof. */}
                    <div className="mt-24 flex items-center gap-3 sm:mt-28">
                      <span aria-hidden className="h-px w-8 bg-[var(--clay)]/60" />
                      <p className="text-[10px] font-bold uppercase tracking-[0.32em] text-[var(--clay)]">
                        + andre dele af samme stack
                      </p>
                    </div>
                    <div className="mt-7 grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-6 lg:grid-cols-4">
                      {stage.n === "01" && (
                        <>
                          {/* AI-drafted DM (OdaGroup-style — no video, title-targeted) */}
                          <div className="rounded-2xl border border-[#29261f]/12 bg-[#fff8ea] p-4 shadow-[0_20px_40px_-20px_rgba(0,0,0,0.4)]">
                            <div className="mb-3 flex items-center gap-2">
                              <div className="grid h-7 w-7 place-items-center rounded-full bg-[linear-gradient(135deg,#3a4654,#525e6c)] text-[10px] font-bold text-[#fff8ea]">JS</div>
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-[11px] text-[#29261f]">Jonas Schmidt</div>
                                <div className="truncate text-[9px] text-[#29261f]/55">VP Sales · Bio-Pharma X</div>
                              </div>
                              <span className="rounded-full bg-[var(--clay)]/15 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-[var(--clay)]">AI</span>
                            </div>
                            <p className="text-[11px] leading-relaxed text-[#29261f]/82">
                              Hej Jonas — så at I ramper jeres pharma-felt-team. Mit korte input om hvad der virker for VP'er der lægger top of funnel oven på Veeva...
                            </p>
                            <div className="mt-3 flex items-center justify-between border-t border-[#29261f]/8 pt-2.5">
                              <span className="text-[9px] uppercase tracking-[0.18em] text-[#29261f]/45">Drafted · 12ms</span>
                              <span className="text-[9px] font-bold uppercase tracking-wider text-[var(--forest)]">Klar at sende</span>
                            </div>
                          </div>

                          {/* ICP-score panel */}
                          <div className="rounded-2xl border border-[var(--cream)]/8 bg-[#14110d] p-4 shadow-[0_20px_40px_-20px_rgba(0,0,0,0.5)]">
                            <div className="flex items-center justify-between">
                              <p className="text-[9px] font-bold uppercase tracking-[0.25em] text-[var(--clay)]">ICP-score</p>
                              <span className="text-[9px] text-[var(--cream)]/45">auto · Claude</span>
                            </div>
                            <div className="mt-3 grid grid-cols-2 gap-3">
                              <div>
                                <div className="text-[8px] uppercase tracking-wider text-[var(--cream)]/55">Firma</div>
                                <div className="mt-1 flex items-baseline gap-1">
                                  <span className="font-display text-2xl italic leading-none text-[var(--cream)]">8</span>
                                  <span className="text-[10px] text-[var(--cream)]/45">/10</span>
                                </div>
                              </div>
                              <div>
                                <div className="text-[8px] uppercase tracking-wider text-[var(--cream)]/55">Person</div>
                                <div className="mt-1 flex items-baseline gap-1">
                                  <span className="font-display text-2xl italic leading-none text-[var(--cream)]">9</span>
                                  <span className="text-[10px] text-[var(--cream)]/45">/10</span>
                                </div>
                              </div>
                            </div>
                            <p className="mt-3 border-t border-[var(--cream)]/8 pt-2.5 text-[10px] leading-snug text-[var(--cream)]/55">
                              B2B SaaS · 30–60 ansatte · CRO/COO med outbound-mandat
                            </p>
                          </div>

                          {/* Reply-intent classifier */}
                          <div className="rounded-2xl border border-[var(--cream)]/8 bg-[#14110d] p-4 shadow-[0_20px_40px_-20px_rgba(0,0,0,0.5)]">
                            <div className="flex items-center justify-between">
                              <p className="text-[9px] font-bold uppercase tracking-[0.25em] text-[var(--clay)]">Svar-intent</p>
                              <span className="text-[9px] text-[var(--cream)]/45">87 svar · 30d</span>
                            </div>
                            <div className="mt-3 space-y-1.5">
                              {[
                                { label: "Interesseret", count: 18, color: "var(--forest)" },
                                { label: "Spørgsmål", count: 24, color: "#ff6b2c" },
                                { label: "Henvist videre", count: 12, color: "var(--clay)" },
                                { label: "Afvist", count: 33, color: "#6c6254" },
                              ].map((r) => (
                                <div key={r.label} className="flex items-center gap-2 text-[10px]">
                                  <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: r.color }} />
                                  <span className="flex-1 text-[var(--cream)]/72">{r.label}</span>
                                  <span className="font-mono text-[var(--cream)]/55 tabular">{r.count}</span>
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* Alt-contact search */}
                          <div className="rounded-2xl border border-[#29261f]/12 bg-[#fff8ea] p-4 shadow-[0_20px_40px_-20px_rgba(0,0,0,0.4)]">
                            <div className="flex items-center justify-between">
                              <p className="text-[9px] font-bold uppercase tracking-[0.25em] text-[var(--clay)]">Alt-contact</p>
                              <span className="rounded-full bg-[var(--clay)]/15 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-[var(--clay)]">Auto</span>
                            </div>
                            <p className="mt-2.5 text-[11px] leading-snug text-[#29261f]/82">
                              <span className="font-medium">Justyna</span> henviste videre. Fundet kollega ved samme firma — klar til invite.
                            </p>
                            <div className="mt-3 flex items-center gap-2 rounded-lg border border-[#29261f]/10 bg-[#29261f]/5 p-2">
                              <div className="grid h-6 w-6 place-items-center rounded-full bg-[linear-gradient(135deg,#3a4654,#525e6c)] text-[9px] font-bold text-[#fff8ea]">MO</div>
                              <div className="min-w-0 flex-1 truncate text-[10px] text-[#29261f]">Morten Otto · TechSupply ApS</div>
                              <span className="text-[9px] font-bold uppercase tracking-wider text-[var(--forest)]">+ Invite</span>
                            </div>
                          </div>
                        </>
                      )}

                      {stage.n === "02" && (
                        <>
                          {/* Push-notification on mobile */}
                          <div className="rounded-2xl border border-[var(--cream)]/8 bg-[#14110d] p-4 shadow-[0_20px_40px_-20px_rgba(0,0,0,0.5)]">
                            <div className="flex items-center justify-between">
                              <p className="text-[9px] font-bold uppercase tracking-[0.25em] text-[var(--clay)]">Push · mobil</p>
                              <span className="text-[9px] text-[var(--cream)]/45">nu</span>
                            </div>
                            <div className="mt-3 rounded-xl border border-[var(--cream)]/10 bg-[var(--cream)]/[0.04] p-3">
                              <div className="flex items-center gap-2 text-[9px] uppercase tracking-wider text-[var(--cream)]/55">
                                <span className="h-1.5 w-1.5 rounded-full bg-[#ff6b2c]" />
                                Carter & Co · lige nu
                              </div>
                              <div className="mt-1.5 text-[12px] font-medium text-[var(--cream)]/92">
                                🔔 Nyt lead: Vela Wood
                              </div>
                              <div className="text-[10px] text-[var(--cream)]/65">
                                Copenhagen · 12 ansatte · ringer nu?
                              </div>
                            </div>
                            <div className="mt-2.5 flex gap-2">
                              <span className="flex-1 rounded-lg bg-[var(--forest)]/20 px-2 py-1.5 text-center text-[10px] font-bold uppercase tracking-wider text-[var(--forest)]">
                                Jeg ringer
                              </span>
                              <span className="rounded-lg border border-[var(--cream)]/15 px-2 py-1.5 text-[10px] text-[var(--cream)]/55">
                                Senere
                              </span>
                            </div>
                          </div>

                          {/* Lead-prioritetsliste */}
                          <div className="rounded-2xl border border-[#29261f]/12 bg-[#fff8ea] p-4 shadow-[0_20px_40px_-20px_rgba(0,0,0,0.4)]">
                            <div className="flex items-center justify-between">
                              <p className="text-[9px] font-bold uppercase tracking-[0.25em] text-[var(--clay)]">Prioritets-kø</p>
                              <span className="text-[9px] text-[#29261f]/55">ICP-sorteret</span>
                            </div>
                            <div className="mt-3 space-y-1.5">
                              {[
                                { name: "Mette Sørensen", company: "Nordlys A/S", score: 9 },
                                { name: "Jonas Holm", company: "Bagsika Møbler", score: 8 },
                                { name: "Anders Kjær", company: "Boligbranding", score: 7 },
                              ].map((l) => (
                                <div key={l.name} className="flex items-center gap-2.5 rounded-lg border border-[#29261f]/8 bg-[#29261f]/[0.03] px-2 py-1.5">
                                  <span className="font-display text-base italic leading-none text-[#29261f]">{l.score}</span>
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-[10px] font-medium text-[#29261f]">{l.name}</div>
                                    <div className="truncate text-[9px] text-[#29261f]/55">{l.company}</div>
                                  </div>
                                  <span className="text-[9px] uppercase tracking-wider text-[#ff6b2c]">→</span>
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* Outcome day-strip */}
                          <div className="rounded-2xl border border-[var(--cream)]/8 bg-[#14110d] p-4 shadow-[0_20px_40px_-20px_rgba(0,0,0,0.5)]">
                            <div className="flex items-center justify-between">
                              <p className="text-[9px] font-bold uppercase tracking-[0.25em] text-[var(--clay)]">I dag</p>
                              <span className="text-[9px] text-[var(--cream)]/45">14 opkald</span>
                            </div>
                            <div className="mt-3 grid grid-cols-2 gap-2">
                              {[
                                { label: "Booket", count: 4, color: "var(--forest)" },
                                { label: "Kunde", count: 1, color: "#ff6b2c" },
                                { label: "No svar", count: 7, color: "var(--cream)" },
                                { label: "Ikke int.", count: 2, color: "var(--clay)" },
                              ].map((o) => (
                                <div key={o.label} className="rounded-lg border border-[var(--cream)]/8 bg-[var(--cream)]/[0.03] p-2">
                                  <div className="flex items-baseline gap-1.5">
                                    <span className="font-display text-xl italic leading-none" style={{ color: o.color }}>{o.count}</span>
                                  </div>
                                  <div className="text-[9px] uppercase tracking-wider text-[var(--cream)]/55">{o.label}</div>
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* Phone-scout result */}
                          <div className="rounded-2xl border border-[#29261f]/12 bg-[#fff8ea] p-4 shadow-[0_20px_40px_-20px_rgba(0,0,0,0.4)]">
                            <div className="flex items-center justify-between">
                              <p className="text-[9px] font-bold uppercase tracking-[0.25em] text-[var(--clay)]">Phone-scout</p>
                              <span className="rounded-full bg-[var(--forest)]/15 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-[var(--forest)]">Fundet</span>
                            </div>
                            <p className="mt-2.5 text-[11px] leading-snug text-[#29261f]/82">
                              Direkte nummer på beslutningstager — uden om hovedomstilling.
                            </p>
                            <div className="mt-3 flex items-center gap-2 rounded-lg border border-[#29261f]/10 bg-[#29261f]/[0.04] p-2">
                              <span className="text-[14px]">📞</span>
                              <div className="min-w-0 flex-1">
                                <div className="font-mono text-[12px] tabular text-[#29261f]">+45 32 11 22 33</div>
                                <div className="text-[9px] text-[#29261f]/55">Karen Hjort · CFO</div>
                              </div>
                              <span className="text-[9px] font-bold uppercase tracking-wider text-[#ff6b2c]">Ring</span>
                            </div>
                          </div>
                        </>
                      )}

                      {stage.n === "03" && (
                        <>
                          {/* Storkunde-fraled alert (Cleanstep-pattern) */}
                          <div className="rounded-2xl border border-[#c93c0a]/35 bg-[#14110d] p-4 shadow-[0_20px_40px_-20px_rgba(0,0,0,0.5)]">
                            <div className="flex items-center justify-between">
                              <p className="text-[9px] font-bold uppercase tracking-[0.25em] text-[#ff6b2c]">⚠ Fraled-alert</p>
                              <span className="text-[9px] text-[var(--cream)]/45">i dag</span>
                            </div>
                            <p className="mt-2.5 text-[11px] leading-snug text-[var(--cream)]/85">
                              <span className="font-medium">Vela Wood</span> bestiller normalt hver 14. dag. Ikke set siden d. 24/4 — <span className="text-[#ff6b2c]">21 dage forsinket</span>.
                            </p>
                            <div className="mt-3 flex items-center gap-2 rounded-lg border border-[var(--cream)]/8 bg-[var(--cream)]/[0.03] p-2">
                              <span className="text-[14px]">📞</span>
                              <div className="min-w-0 flex-1 truncate text-[10px] text-[var(--cream)]/72">Forslag: ring CFO i dag</div>
                              <span className="text-[9px] font-bold uppercase tracking-wider text-[#ff6b2c]">→</span>
                            </div>
                          </div>

                          {/* Attribution mini-dashboard */}
                          <div className="rounded-2xl border border-[#29261f]/12 bg-[#fff8ea] p-4 shadow-[0_20px_40px_-20px_rgba(0,0,0,0.4)]">
                            <div className="flex items-center justify-between">
                              <p className="text-[9px] font-bold uppercase tracking-[0.25em] text-[var(--clay)]">Attribution · 30d</p>
                              <span className="text-[9px] text-[#29261f]/55">13 won</span>
                            </div>
                            <div className="mt-3 space-y-1.5">
                              {[
                                { source: "LinkedIn outbound", count: 8, value: "640 K" },
                                { source: "Meta ads", count: 3, value: "180 K" },
                                { source: "Reference", count: 2, value: "380 K" },
                              ].map((a) => (
                                <div key={a.source} className="flex items-center gap-2 text-[10px]">
                                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#ff6b2c]" />
                                  <span className="flex-1 truncate text-[#29261f]/80">{a.source}</span>
                                  <span className="font-mono tabular text-[#29261f]/55">{a.count} · {a.value}</span>
                                </div>
                              ))}
                            </div>
                            <div className="mt-2.5 border-t border-[#29261f]/8 pt-2 text-[10px] font-medium text-[#29261f]/82">
                              Pipeline: 1.2M DKK
                            </div>
                          </div>

                          {/* Pre-meeting talepunkter */}
                          <div className="rounded-2xl border border-[var(--cream)]/8 bg-[#14110d] p-4 shadow-[0_20px_40px_-20px_rgba(0,0,0,0.5)]">
                            <div className="flex items-center justify-between">
                              <p className="text-[9px] font-bold uppercase tracking-[0.25em] text-[var(--clay)]">Pre-meeting brief</p>
                              <span className="rounded-full bg-[var(--clay)]/15 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-[var(--clay)]">AI</span>
                            </div>
                            <p className="mt-2.5 text-[10px] text-[var(--cream)]/55">
                              Klar 15 min før opkald · Maria, Nordlys A/S
                            </p>
                            <ul className="mt-3 space-y-1.5 text-[10px] leading-snug text-[var(--cream)]/72">
                              {[
                                "Sidste interaktion: takkede for tilbud, ville se intern brief",
                                "Bestilte 32K DKK i Q4 — typisk køber kvartalsvis",
                                "Bemærk: just shipped ny e-shop — mention som anker",
                              ].map((p) => (
                                <li key={p} className="flex items-start gap-2">
                                  <span aria-hidden className="mt-1 h-px w-2 shrink-0 bg-[#ff6b2c]/60" />
                                  <span>{p}</span>
                                </li>
                              ))}
                            </ul>
                          </div>

                          {/* Won-deal card */}
                          <div className="rounded-2xl border border-[var(--forest)]/35 bg-[linear-gradient(135deg,rgba(25,70,58,0.18),rgba(20,17,13,0.85))] p-4 shadow-[0_20px_40px_-20px_rgba(0,0,0,0.5)]">
                            <div className="flex items-center justify-between">
                              <p className="text-[9px] font-bold uppercase tracking-[0.25em] text-[var(--forest)]">✓ Aftale lukket</p>
                              <span className="text-[9px] text-[var(--cream)]/55">i dag · 14:32</span>
                            </div>
                            <div className="mt-3 flex items-baseline gap-2">
                              <span className="font-display text-3xl italic leading-none text-[var(--cream)]">32.500</span>
                              <span className="text-[11px] text-[var(--cream)]/55">DKK</span>
                            </div>
                            <p className="mt-2 text-[10px] text-[var(--cream)]/65">
                              Stark Group · sporet til LinkedIn-DM d. 18/3
                            </p>
                            <div className="mt-2.5 flex items-center gap-2 border-t border-[var(--cream)]/8 pt-2 text-[9px] uppercase tracking-wider text-[var(--cream)]/45">
                              <span>Tid fra lead → aftale: 28d</span>
                            </div>
                          </div>
                        </>
                      )}
                    </div>

                    {/* EmberSpark divider — only between stages, not after the
                        last one. Same flame-line + glow pattern DESIGN.md uses
                        at sand/ember section transitions. Marks each machine
                        as its own poster moment instead of three runs on one
                        flat surface. */}
                    {i < journey.length - 1 && (
                      <div
                        aria-hidden
                        className="pointer-events-none relative mt-32 flex items-center justify-center sm:mt-44"
                      >
                        <div className="h-px w-full max-w-[min(680px,70%)] bg-[linear-gradient(90deg,transparent,rgba(255,107,44,0.35)_25%,rgba(255,107,44,0.7)_50%,rgba(255,107,44,0.35)_75%,transparent)]" />
                        <div className="absolute h-[2px] w-[min(180px,18%)] bg-[#ff6b2c] shadow-[0_0_28px_rgba(255,107,44,0.7)]" />
                      </div>
                    )}
                  </article>
                );
              })}
            </div>

          </div>
        </div>
      </section>

      {/* ─────── Section: Connective beat — bespoke, not packaged ───────
          Closes the three-section practice with the white-glove claim:
          each engagement is built to fit, every client takes a different
          subset. Replaces the deleted "Det her er forskellen" before/after
          (which read as a linear funnel that no longer fits). */}
      <section className="relative overflow-hidden bg-[#f6efe4] py-24 text-[#29261f] sm:py-28">
        <div aria-hidden className="paper-grain" />

        <div className="relative z-[1] mx-auto w-full max-w-[1080px] px-8 sm:px-12">
          <div className="mx-auto max-w-[820px] text-center">
            <p className="font-display text-[6vw] leading-[1.05] tracking-tight sm:text-4xl lg:text-[2.75rem]">
              Tre dele. <span className="italic text-[var(--clay)]">Ét billede.</span>
            </p>
            <p className="mx-auto mt-8 max-w-[640px] text-[15px] leading-relaxed text-[#29261f]/72 sm:text-[17px]">
              Sjældent samme vej for to klienter. Engagementet er altid bygget til hvad du faktisk har brug for — den del der mangler, eller hele opbygningen.
            </p>
          </div>

          {/* Three client-paths cards — makes "different vej for each
              client" concrete. Each shows which delivery areas the client
              took. Real client logo replaces the initial-circle when ready. */}
          <div className="mt-14 grid gap-4 sm:mt-16 sm:grid-cols-3 sm:gap-5">
            {[
              {
                client: "Tresyv",
                initials: "TR",
                uses: ["Outbound"],
                note: "Kører den i dag",
              },
              {
                client: "Murph",
                initials: "MU",
                uses: ["Speed-to-lead"],
                note: "87× hurtigere end branchen",
              },
              {
                client: "Burst",
                initials: "BU",
                uses: ["Post-meeting"],
                note: "4× på samme budget",
              },
            ].map((c) => (
              <article
                key={c.client}
                className="relative flex flex-col gap-4 rounded-2xl border border-[#29261f]/15 bg-[#efe6d6]/70 p-5 text-left shadow-[0_20px_50px_-30px_rgba(0,0,0,0.25)]"
              >
                <div className="flex items-center gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-full border border-[var(--clay)]/45 bg-[var(--clay)]/15 text-[11px] font-bold uppercase tracking-wider text-[#29261f]/80">
                    {c.initials}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[12px] font-bold uppercase tracking-[0.2em] text-[#29261f]/85">
                      {c.client}
                    </div>
                    <div className="text-[11px] text-[#29261f]/55">{c.note}</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {c.uses.map((u) => (
                    <span
                      key={u}
                      className="rounded-full border border-[var(--clay)]/40 bg-[var(--clay)]/12 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[var(--clay)]"
                    >
                      {u}
                    </span>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ─────── Section: Testimonials placeholder (dark) ─────── */}
      {/*
        DESIGNED PLACEHOLDER. Real client quotes are intentionally NOT in here yet.
        Replace each card's `placeholder: true` block with a real `quote/name/role/company/result`
        when content is ready. See cases array for analogous structure.
      */}
      {false && (
      <section className="relative overflow-hidden bg-[#0a0907] py-28 sm:py-36">
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          <div className="absolute left-1/2 top-[20%] h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(255,107,44,0.07),transparent_60%)] blur-2xl" />
        </div>

        <div className="mx-auto w-full max-w-[1280px] px-8 sm:px-12">
          <div className="flex items-center gap-3">
            <span aria-hidden className="h-px w-10 bg-[#ff6b2c]" />
            <p className="text-[10px] font-bold uppercase tracking-[0.4em] text-[#ff6b2c]">
              Hvad kunderne siger
            </p>
          </div>
          <h2 className="mt-7 max-w-3xl font-display text-[10vw] leading-[0.92] tracking-[-0.04em] sm:text-6xl lg:text-7xl">
            Folk der har bygget <span className="italic text-[var(--clay)]">maskinen</span> sammen med mig.
          </h2>
          <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-[var(--cream)]/55">
            <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-[#ff6b2c]/80">
              Placeholder ·
            </span>{" "}
            Konkrete kundecitater landes her når de er klar — jeg opfinder ikke proof.
          </p>

          {/* Three vertical-marquee columns — col 1 up, col 2 down, col 3 up.
              Replace each card's bracketed stubs with real content when ready. */}
          <div className="mt-14 grid gap-6 sm:mt-16 sm:grid-cols-3 sm:gap-8">
            {[
              {
                dir: "up",
                cards: [
                  { metric: "[X×]", label: "[resultat-label]", quote: "Her indsættes et konkret kundecitat — én sætning om hvor mærkbart det blev efter systemet kom op at køre.", role: "[Rolle · Firma]" },
                  { metric: "[<5 min]", label: "[tid-label]", quote: "[Kort citat med ét konkret resultat — fx 'vi gik fra X til Y på Z uger'.]", role: "[CEO · Firma]" },
                  { metric: "[+12]", label: "[uge-label]", quote: "[To-sætningers citat — det første om før-tilstanden, det andet om hvad der ændrede sig efter.]", role: "[Stilling · Firma]" },
                ],
              },
              {
                dir: "down",
                cards: [
                  { metric: "[Y×]", label: "[resultat-label]", quote: "[Et citat der nævner et konkret tal og en mærkbar effekt på pipeline eller bookede møder.]", role: "[Founder · Co.]" },
                  { metric: "[40%]", label: "[procent-label]", quote: "Her indsættes et konkret kundecitat — to sætninger om før-tilstanden og hvad der blev anderledes.", role: "[Rolle · Firma]" },
                  { metric: "[<24t]", label: "[tid-label]", quote: "[Kort citat med ét konkret resultat og evt. en gengivelse af forretningseffekten.]", role: "[Direktør · Firma]" },
                ],
              },
              {
                dir: "up",
                cards: [
                  { metric: "[Z×]", label: "[resultat-label]", quote: "[Citat der peger på samarbejdet — fx 'fik adgang til den der bygger', 'ingen mellemled'.]", role: "[CMO · Firma]" },
                  { metric: "[2×]", label: "[multiplier-label]", quote: "[Et citat med før/efter — én sætning om hvad der var, én om hvad der er nu.]", role: "[Salgschef · Firma]" },
                  { metric: "[80%]", label: "[procent-label]", quote: "Her indsættes et konkret kundecitat — én eller to sætninger om hvad der ændrede sig.", role: "[Stilling · Firma]" },
                ],
              },
            ].map((col, ci) => (
              <div
                key={ci}
                className={`relative h-[640px] overflow-hidden ${ci > 0 ? "hidden sm:block" : ""}`}
                style={{
                  maskImage:
                    "linear-gradient(to bottom, transparent 0%, black 8%, black 92%, transparent 100%)",
                  WebkitMaskImage:
                    "linear-gradient(to bottom, transparent 0%, black 8%, black 92%, transparent 100%)",
                }}
              >
                <div
                  className={`flex flex-col gap-6 ${
                    col.dir === "up"
                      ? "testimonial-marquee-up"
                      : "testimonial-marquee-down"
                  }`}
                >
                  {[...col.cards, ...col.cards].map((card, i) => (
                    <article
                      key={i}
                      className="relative flex flex-col gap-5 rounded-2xl border border-dashed border-[var(--cream)]/20 bg-[var(--cream)]/[0.03] p-6 sm:p-7"
                    >
                      <span className="absolute -top-2.5 left-4 inline-flex items-center gap-1.5 rounded-full border border-dashed border-[var(--cream)]/30 bg-[#0a0907] px-2.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.25em] text-[var(--cream)]/55">
                        Placeholder
                      </span>

                      {/* Metric */}
                      <div className="flex items-baseline gap-3">
                        <span className="font-display text-3xl italic leading-none text-[var(--cream)]/25 sm:text-4xl">
                          {card.metric}
                        </span>
                        <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-[var(--cream)]/35">
                          {card.label}
                        </span>
                      </div>

                      {/* Quote */}
                      <blockquote className="text-[14.5px] leading-[1.65] text-[var(--cream)]/55">
                        &ldquo;{card.quote}&rdquo;
                      </blockquote>

                      {/* Attribution */}
                      <div className="mt-auto flex items-center gap-3 border-t border-dashed border-[var(--cream)]/12 pt-4">
                        <span
                          aria-hidden
                          className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-dashed border-[var(--cream)]/25 text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--cream)]/35"
                        >
                          [N]
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-display text-[15px] italic text-[var(--cream)]/70">
                            [Navn Navnesen]
                          </div>
                          <div className="truncate text-[10px] uppercase tracking-[0.2em] text-[var(--cream)]/40">
                            {card.role}
                          </div>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
      )}
      <section className="relative overflow-hidden bg-[#0a0907] py-32 text-[var(--cream)] sm:py-44">
        {/* EmberSpark — top */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-[linear-gradient(180deg,rgba(255,107,44,0.18),transparent)]" />
        <div aria-hidden className="pointer-events-none absolute left-1/2 top-0 h-[2px] w-[min(680px,60%)] -translate-x-1/2 bg-[linear-gradient(90deg,transparent,#ff6b2c_30%,#ff6b2c_70%,transparent)] shadow-[0_0_28px_rgba(255,107,44,0.7)]" />

        {/* EmberSpark — bottom: bridges up to dark founder */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-[linear-gradient(0deg,rgba(255,107,44,0.18),transparent)]" />
        <div aria-hidden className="pointer-events-none absolute bottom-0 left-1/2 h-[2px] w-[min(680px,60%)] -translate-x-1/2 bg-[linear-gradient(90deg,transparent,#ff6b2c_30%,#ff6b2c_70%,transparent)] shadow-[0_0_28px_rgba(255,107,44,0.7)]" />

        <div className="relative z-[1] mx-auto h-[min(820px,90vh)] w-full max-w-[1280px] px-8 sm:px-12">
          {/* Centered headline + CTA — anchors the scatter */}
          <div className="absolute left-1/2 top-1/2 z-[3] w-[calc(100%-4rem)] max-w-[40rem] -translate-x-1/2 -translate-y-1/2 text-center sm:w-[calc(100%-7.5rem)]">
            <h2 className="font-display text-4xl leading-[0.96] tracking-[-0.035em] sm:text-5xl lg:text-[3.75rem]">
              Du beholder alt <span className="italic text-[var(--clay)]">du har.</span>
            </h2>
            <p className="mx-auto mt-6 max-w-[28rem] text-[15px] leading-relaxed text-[var(--cream)]/70">
              Du behøver ikke en ny stack. Annonce → CRM → kalender — jeg kobler det I allerede har, lægger systemet oven på.
            </p>

            {/* CTA stack — forest-green pill (won-color CTA on paper) + email link */}
            <div className="mt-9 flex flex-col items-center gap-4">
              <button
                type="button"
                onClick={() => setQuizOpen(true)}
                className="inline-flex items-center gap-3 rounded-full bg-[var(--forest)] px-8 py-4 text-xs font-bold uppercase tracking-[0.25em] text-[#fff8ea] shadow-[0_18px_50px_-16px_rgba(25,70,58,0.5)] transition hover:-translate-y-0.5 hover:shadow-[0_24px_60px_-16px_rgba(25,70,58,0.6)]"
              >
                Tag lead-quizzen <span aria-hidden>→</span>
              </button>
              <a
                href="mailto:louis@carterco.dk"
                className="text-[10px] font-bold uppercase tracking-[0.25em] text-[var(--cream)]/55 transition hover:text-[var(--cream)]"
              >
                louis@carterco.dk →
              </a>
            </div>

            <p className="mt-8 text-[10px] font-bold uppercase tracking-[0.3em] text-[var(--cream)]/45">
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

      {/* ─────── Section: Founder card — Værksteds-kortet ─────── */}
      <section className="relative overflow-hidden bg-[#f6efe4] py-24 text-[#29261f] sm:py-32 lg:py-40">
        <div aria-hidden className="paper-grain" />

        {/* Atmospheric backdrop — soft warm glow on paper */}
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          <div className="absolute right-[8%] top-[10%] h-[680px] w-[680px] rounded-full bg-[radial-gradient(ellipse_at_center,rgba(255,107,44,0.10),transparent_65%)] blur-2xl" />
          <div className="absolute -left-[8%] bottom-[8%] h-[480px] w-[480px] rounded-full bg-[radial-gradient(ellipse_at_center,rgba(25,70,58,0.08),transparent_65%)] blur-2xl" />
        </div>

        <div className="relative mx-auto w-full max-w-[1080px] px-4 sm:px-8">
          <div className="relative">
            {/* Letter on left, photo on right */}
            <div className="relative z-[1] grid gap-12 p-8 sm:gap-14 sm:p-14 lg:grid-cols-12 lg:gap-20 lg:p-20">

              {/* LEFT — the letter */}
              <div className="lg:col-span-7">

                <h2 className="font-display text-[14vw] leading-[0.92] tracking-[-0.045em] sm:text-[7vw] lg:text-[5.5rem]">
                  Hej.
                  <br />
                  <span className="bg-gradient-to-b from-[#ff8244] via-[#ff6b2c] to-[#c93c0a] bg-clip-text italic text-transparent">
                    Det er mig der bygger.
                  </span>
                </h2>

                {/* Body — positive Hormozy beats: craft, mechanism, commitment, phone */}
                <div className="mt-8 max-w-md space-y-5 text-[15px] leading-[1.7] text-[#29261f]/85 sm:mt-10 sm:text-[16px]">
                  <p>
                    <span className="font-semibold text-[#29261f]">
                      Hvert system bygges hands-on.
                    </span>
                  </p>
                  <p>
                    Fra første dag til den dag den kører selv.
                  </p>
                  <p>
                    Du har mig fra dag ét. Du beholder mig efter overdragelsen.
                  </p>
                  <p>
                    Tag quizzen — oplev flowet fra kundens side, og se hvad dit eget system mangler.
                  </p>
                  <div className="pt-2">
                    <button
                      type="button"
                      onClick={() => setQuizOpen(true)}
                      className="inline-flex items-center gap-3 rounded-full bg-[var(--forest)] px-7 py-3.5 text-xs font-bold uppercase tracking-[0.25em] text-[#fff8ea] shadow-[0_18px_50px_-16px_rgba(25,70,58,0.5)] transition hover:-translate-y-0.5 hover:shadow-[0_24px_60px_-16px_rgba(25,70,58,0.6)]"
                    >
                      Tag lead-quizzen <span aria-hidden>→</span>
                    </button>
                  </div>
                </div>

                {/* Sign-off — email */}
                <div className="mt-10 sm:mt-12">
                  <a
                    href="mailto:louis@carterco.dk"
                    className="group inline-flex items-center gap-2 font-display text-base italic text-[#29261f]/85 transition hover:text-[#c93c0a] sm:text-lg"
                  >
                    louis@carterco.dk
                    <span aria-hidden className="inline-block transition group-hover:translate-x-1">
                      →
                    </span>
                  </a>
                </div>
              </div>

              {/* RIGHT — polaroid */}
              <div className="lg:col-span-5">
                <div className="relative mx-auto w-full max-w-[22rem] lg:ml-auto lg:mr-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/louis.jpeg"
                    alt="Louis Carter"
                    className="aspect-[3/4] w-full rounded-lg object-cover shadow-[0_30px_60px_-25px_rgba(0,0,0,0.35)] ring-1 ring-[#29261f]/10"
                    draggable={false}
                  />

                  {/* Archive caption */}
                  <div className="mt-3 flex items-center gap-2 font-mono text-[9px] font-bold uppercase tracking-[0.3em] text-[#29261f]/55">
                    <span>Louis Carter</span>
                    <span aria-hidden className="h-px flex-1 bg-[#29261f]/20" />
                    <span>København</span>
                  </div>

                  {/* Handwritten arrow + caption — points at photo */}
                  <div
                    className="pointer-events-none absolute right-full top-10 mr-2 hidden items-center gap-1 whitespace-nowrap text-[#29261f] sm:flex"
                    style={{
                      fontFamily: "var(--font-handwritten)",
                      fontSize: "1.1rem",
                      transform: "rotate(-6deg)",
                    }}
                  >
                    <span className="text-right leading-tight">
                      det er mig
                      <br />
                      der svarer
                    </span>
                    <span
                      aria-hidden
                      className="ml-1 inline-block h-[1.4em] w-[1.4em] shrink-0 bg-[#ff6b2c]"
                      style={{
                        maskImage: "url(/annotation-arrow.png)",
                        maskSize: "contain",
                        maskRepeat: "no-repeat",
                        maskPosition: "center",
                        WebkitMaskImage: "url(/annotation-arrow.png)",
                        WebkitMaskSize: "contain",
                        WebkitMaskRepeat: "no-repeat",
                        WebkitMaskPosition: "center",
                        transform: "translate(-40px, 40px) scaleX(-1) rotate(90deg)",
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>

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
          <span className="hidden sm:inline">·</span>
          <a
            href="/privatlivspolitik"
            className="transition hover:text-[var(--cream)]"
          >
            Privatlivspolitik
          </a>
        </div>
      </footer>

      <LeadQuiz
        open={quizOpen}
        onClose={() => setQuizOpen(false)}
        onConvert={resetAndOpen}
      />

      <ExitIntent
        onOpenQuiz={() => setQuizOpen(true)}
        suppressed={quizOpen || open}
      />

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
                {/* Honeypot — bots fill any visible input; humans never see this. */}
                <input
                  type="text"
                  name="website"
                  tabIndex={-1}
                  autoComplete="off"
                  defaultValue=""
                  onChange={(e) => {
                    honeypotRef.current = e.target.value;
                  }}
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    left: "-9999px",
                    width: "1px",
                    height: "1px",
                    opacity: 0,
                    pointerEvents: "none",
                  }}
                />

                <div className="flex flex-col gap-8">
                  <h2 className="font-display text-3xl leading-tight tracking-tight sm:text-4xl">
                    {step.question}
                  </h2>

                  <input
                    autoFocus
                    type={step.type}
                    value={currentValue}
                    onChange={(e) => updateField(step.key, e.target.value)}
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

                  {currentError ? (
                    <p
                      id={`${step.key}-error`}
                      className="-mt-4 text-sm leading-relaxed text-[#ffb86b]"
                    >
                      {currentError}
                    </p>
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
    workspace_id: CARTERCO_WORKSPACE_ID,
    is_draft: true,
    draft_session_id: sessionId,
    draft_updated_at: new Date().toISOString(),
    name: cleaned.name || null,
    company: cleaned.company || null,
    email: cleaned.email || null,
    phone: cleaned.phone || null,
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
  };

  return values[key];
}

function cleanForm(form: FormState): FormState {
  return {
    name: normalizeText(form.name),
    company: normalizeText(form.company),
    email: form.email.trim().toLowerCase(),
    phone: normalizePhone(form.phone),
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
