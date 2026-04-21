"use client";

import {
  FormEvent,
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/client";

/* ─── types ─────────────────────────────────────────────────────────── */

type CallStatus = "answered" | "no_answer" | null;
type Outcome =
  | "booked"
  | "interested"
  | "not_interested"
  | "follow_up"
  | null;

type Lead = {
  id: string;
  created_at: string;
  name: string;
  company: string;
  email: string;
  phone: string;
  monthly_leads: string;
  response_time: string;
  call_status: CallStatus;
  call_status_at: string | null;
  outcome: Outcome;
  outcome_at: string | null;
  notes: string | null;
};

type View = "active" | "all";

type NotificationStatus =
  | "Ikke aktiv"
  | "Installer appen"
  | "Ikke understøttet"
  | "Blokeret"
  | "Beder om adgang"
  | "Gemmer"
  | "Aktiv";

const OUTCOME_LABELS: Record<Exclude<Outcome, null>, string> = {
  booked: "Booket møde",
  interested: "Interesseret",
  not_interested: "Ikke interesseret",
  follow_up: "Follow up",
};

const OUTCOME_TONE: Record<
  Exclude<Outcome, null>,
  { dot: string; text: string; surface: string; edge: string }
> = {
  booked: {
    dot: "bg-[#7fb89b] shadow-[0_0_12px_rgba(127,184,155,0.4)]",
    text: "text-[#9fc9b2]",
    surface: "bg-[#19463a]/20",
    edge: "border-l-[#7fb89b]",
  },
  interested: {
    dot: "bg-[#d98a54] shadow-[0_0_12px_rgba(217,138,84,0.35)]",
    text: "text-[#e2a37b]",
    surface: "bg-[#b97041]/15",
    edge: "border-l-[#d98a54]",
  },
  not_interested: {
    dot: "bg-[var(--cream)]/25",
    text: "text-[var(--cream)]/50",
    surface: "bg-white/[0.02]",
    edge: "border-l-[var(--cream)]/20",
  },
  follow_up: {
    dot: "bg-transparent ring-1 ring-inset ring-[var(--cream)]/60",
    text: "text-[var(--cream)]/80",
    surface: "bg-white/[0.03]",
    edge: "border-l-[var(--cream)]/40",
  },
};

const URGENCY: Record<string, "urgent" | "warm" | "cool" | "muted"> = {
  "Under 5 min": "urgent",
  "5–30 min": "warm",
  "30 min – 2 timer": "cool",
  "Mere end 2 timer": "muted",
  "Ved ikke": "muted",
};

const allowedEmail = "louis@carterco.dk";
const vapidPublicKey =
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ??
  "BHu6uhde8dpGML_i2Q0iQ_mU1heEp9FCxoB-wG9bAuUcu8PruD78-eBLoZhWvgy46xSXW7KSHXOlwg67ekFXADU";

/* ─── component ─────────────────────────────────────────────────────── */

export default function LeadsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState(allowedEmail);
  const [token, setToken] = useState("");
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [notifications, setNotifications] =
    useState<NotificationStatus>("Ikke aktiv");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("active");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const notesTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  const visibleLeads = useMemo(
    () => (view === "active" ? leads.filter((l) => !l.outcome) : leads),
    [leads, view],
  );

  const stats = useMemo(() => {
    const active = leads.filter((l) => !l.outcome).length;
    const total = leads.length;
    const latest = leads[0]?.created_at ?? null;
    return { active, total, latest };
  }, [leads]);

  useEffect(() => {
    let mounted = true;
    supabase.auth.getUser().then(({ data }) => {
      if (!mounted) return;
      setUser(data.user);
      setLoading(false);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [supabase]);

  useEffect(() => {
    if (!user) return;
    void loadLeads();
    void refreshNotificationStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function loadLeads() {
    setError(null);
    const { data, error } = await supabase
      .from("leads")
      .select(
        "id, created_at, name, company, email, phone, monthly_leads, response_time, call_status, call_status_at, outcome, outcome_at, notes",
      )
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      setError(error.message);
      return;
    }

    setLeads(data ?? []);
  }

  async function sendLink(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setMessage(null);

    if (email.trim().toLowerCase() !== allowedEmail) {
      setError("Denne side er kun for CarterCo.");
      return;
    }

    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { shouldCreateUser: false },
    });

    if (error) {
      setError(error.message);
      return;
    }

    setMessage("Tjek din mail for login-link eller kode.");
  }

  async function verifyCode(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const { error } = await supabase.auth.verifyOtp({
      email: email.trim().toLowerCase(),
      token: token.trim(),
      type: "email",
    });

    if (error) {
      setError(error.message);
      return;
    }

    setToken("");
    setMessage(null);
  }

  async function signOut() {
    await supabase.auth.signOut();
    setUser(null);
    setLeads([]);
  }

  async function setCallStatus(leadId: string, status: CallStatus) {
    const previous = leads;
    const nextAt = status ? new Date().toISOString() : null;
    setLeads((current) =>
      current.map((lead) =>
        lead.id === leadId
          ? { ...lead, call_status: status, call_status_at: nextAt }
          : lead,
      ),
    );

    const { error } = await supabase
      .from("leads")
      .update({ call_status: status, call_status_at: nextAt })
      .eq("id", leadId);

    if (error) {
      setLeads(previous);
      setError(error.message);
    }
  }

  async function setOutcome(leadId: string, outcome: Outcome) {
    const previous = leads;
    const nextAt = outcome ? new Date().toISOString() : null;
    setLeads((current) =>
      current.map((lead) =>
        lead.id === leadId ? { ...lead, outcome, outcome_at: nextAt } : lead,
      ),
    );

    const { error } = await supabase
      .from("leads")
      .update({ outcome, outcome_at: nextAt })
      .eq("id", leadId);

    if (error) {
      setLeads(previous);
      setError(error.message);
    }
  }

  function updateNotes(leadId: string, value: string) {
    setLeads((current) =>
      current.map((lead) =>
        lead.id === leadId ? { ...lead, notes: value } : lead,
      ),
    );

    const timers = notesTimers.current;
    const existing = timers.get(leadId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      timers.delete(leadId);
      const { error } = await supabase
        .from("leads")
        .update({ notes: value.length > 0 ? value : null })
        .eq("id", leadId);
      if (error) setError(error.message);
    }, 400);

    timers.set(leadId, timer);
  }

  async function refreshNotificationStatus() {
    if (!("Notification" in window) || !("serviceWorker" in navigator)) {
      setNotifications("Ikke understøttet");
      return;
    }
    if (!("PushManager" in window)) {
      setNotifications("Installer appen");
      return;
    }
    if (Notification.permission === "denied") {
      setNotifications("Blokeret");
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    setNotifications(subscription ? "Aktiv" : "Ikke aktiv");
  }

  async function enableNotifications() {
    setError(null);
    setMessage(null);

    if (!("Notification" in window) || !("serviceWorker" in navigator)) {
      setError("Denne browser understøtter ikke push-notifikationer.");
      return;
    }
    if (!("PushManager" in window)) {
      setNotifications("Installer appen");
      setError(
        "Push virker på iPhone, når siden er gemt på hjemmeskærmen og åbnet som app.",
      );
      return;
    }

    setNotifications("Beder om adgang");
    const permission = await Notification.requestPermission();

    if (permission !== "granted") {
      setNotifications("Ikke aktiv");
      setError("Notifikationer blev ikke slået til.");
      return;
    }

    try {
      setNotifications("Gemmer");
      const registration = await navigator.serviceWorker.ready;
      const existingSubscription =
        await registration.pushManager.getSubscription();
      const subscription =
        existingSubscription ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
        }));
      const subscriptionJson = subscription.toJSON();

      const { error } = await supabase.from("push_subscriptions").upsert(
        {
          endpoint: subscription.endpoint,
          p256dh: subscriptionJson.keys?.p256dh,
          auth: subscriptionJson.keys?.auth,
          user_agent: navigator.userAgent,
        },
        { onConflict: "endpoint" },
      );

      if (error) {
        setNotifications("Ikke aktiv");
        setError(error.message);
        return;
      }

      setNotifications("Aktiv");
      setMessage("Notifikationer er slået til på denne enhed.");
    } catch (err) {
      setNotifications("Ikke aktiv");
      setError(err instanceof Error ? err.message : "Notifikationer fejlede.");
    }
  }

  function isExpanded(lead: Lead) {
    if (lead.call_status && !lead.outcome) return true;
    return expandedIds.has(lead.id);
  }

  function toggleExpanded(id: string) {
    setExpandedIds((curr) => {
      const next = new Set(curr);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /* ─── loading screen ─── */
  if (loading) {
    return (
      <main className="relative flex min-h-screen items-center justify-center bg-[#0a0907] px-6 text-[var(--cream)]">
        <div className="grain-overlay" />
        <p className="tabular text-[11px] uppercase tracking-[0.4em] text-[var(--cream)]/40">
          Indlæser
        </p>
      </main>
    );
  }

  /* ─── login screen ─── */
  if (!user) {
    return (
      <main className="relative min-h-screen overflow-hidden bg-[#0a0907] text-[var(--cream)]">
        <div className="grain-overlay" />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[60vh] bg-[radial-gradient(ellipse_at_top,rgba(185,112,65,0.18),transparent_60%)]" />

        <div className="relative mx-auto flex min-h-screen w-full max-w-md flex-col justify-between px-6 py-10">
          <Link
            href="/"
            className="tabular text-[10px] uppercase tracking-[0.35em] text-[var(--cream)]/45 hover:text-[var(--cream)]/70"
          >
            CarterCo · Leads
          </Link>

          <section>
            <p className="tabular text-[10px] uppercase tracking-[0.32em] text-[var(--cream)]/40">
              Privat arbejdsrum
            </p>
            <h1 className="font-display mt-4 text-6xl italic leading-[0.9] tracking-[-0.02em] text-[var(--cream)] sm:text-7xl">
              Leads
            </h1>
            <p className="mt-6 max-w-xs text-sm leading-relaxed text-[var(--cream)]/55">
              Se nye henvendelser, ring direkte og hold styr på din pipeline
              uden støj.
            </p>

            <form onSubmit={sendLink} className="mt-10 flex flex-col gap-3">
              <label className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--cream)]/40">
                E-mail
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                className="focus-orange border-b border-[var(--cream)]/15 bg-transparent py-3 text-base text-[var(--cream)] outline-none transition focus:border-[#ff6b2c]"
              />
              <button
                type="submit"
                className="focus-orange mt-4 flex items-center justify-between rounded-sm bg-[#ff6b2c] px-5 py-3.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#0a0907] transition hover:bg-[#ff7f47]"
              >
                <span>Send login-link</span>
                <span aria-hidden>→</span>
              </button>
            </form>

            <form onSubmit={verifyCode} className="mt-8 flex flex-col gap-3">
              <label className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--cream)]/40">
                Eller indtast kode
              </label>
              <input
                type="text"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-cifret"
                className="focus-cream tabular border-b border-[var(--cream)]/15 bg-transparent py-3 text-base text-[var(--cream)] outline-none transition placeholder:text-[var(--cream)]/25 focus:border-[var(--cream)]/45"
              />
              <button
                type="submit"
                className="focus-cream mt-2 self-start text-[11px] uppercase tracking-[0.22em] text-[var(--cream)]/70 underline-offset-[6px] transition hover:text-[var(--cream)] hover:underline"
              >
                Verificer →
              </button>
            </form>

            {message ? (
              <p className="mt-8 border-l border-[#ff6b2c]/50 pl-3 text-sm text-[var(--cream)]/70">
                {message}
              </p>
            ) : null}
            {error ? (
              <p className="mt-8 border-l border-[#ffb86b]/50 pl-3 text-sm text-[#ffb86b]">
                {error}
              </p>
            ) : null}
          </section>

          <p className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--cream)]/25">
            {new Date().getFullYear()} · Kun for {allowedEmail}
          </p>
        </div>
      </main>
    );
  }

  /* ─── main dashboard ─── */
  return (
    <main className="relative min-h-screen bg-[#0a0907] text-[var(--cream)]">
      <div className="grain-overlay" />

      {/* Sticky top bar */}
      <div className="sticky top-0 z-20 border-b border-[var(--cream)]/[0.06] bg-[#0a0907]/85 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-[1400px] items-center justify-between gap-4 px-4 py-3 sm:px-8 lg:px-12">
          <Link
            href="/"
            className="tabular text-[10px] uppercase tracking-[0.35em] text-[var(--cream)]/50 transition hover:text-[var(--cream)]/80"
          >
            CarterCo
            <span className="mx-2 text-[var(--cream)]/25">/</span>
            <span className="text-[var(--cream)]/75">Leads</span>
          </Link>

          <div className="flex items-center gap-1 sm:gap-2">
            <SegmentedToggle value={view} onChange={setView} />
            <div className="mx-1 hidden h-4 w-px bg-[var(--cream)]/10 sm:block" />
            <IconButton
              title={`Push: ${notifications}`}
              onClick={() => void enableNotifications()}
              disabled={
                notifications === "Beder om adgang" ||
                notifications === "Gemmer"
              }
              active={notifications === "Aktiv"}
            >
              <BellIcon />
              <span className="sr-only">Notifikationer</span>
            </IconButton>
            <IconButton
              title="Opdater"
              onClick={() => void loadLeads()}
            >
              <RefreshIcon />
              <span className="sr-only">Opdater</span>
            </IconButton>
            <IconButton title="Log ud" onClick={() => void signOut()}>
              <ExitIcon />
              <span className="sr-only">Ud</span>
            </IconButton>
          </div>
        </div>
      </div>

      {/* Masthead */}
      <section className="relative mx-auto w-full max-w-[1400px] px-4 pt-10 pb-8 sm:px-8 sm:pt-16 sm:pb-10 lg:px-12">
        <div className="pointer-events-none absolute inset-x-4 top-6 -z-10 h-[40vh] bg-[radial-gradient(ellipse_at_top_left,rgba(185,112,65,0.08),transparent_60%)] sm:inset-x-8 lg:inset-x-12" />

        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="tabular text-[10px] uppercase tracking-[0.32em] text-[var(--cream)]/40">
              Indbakke
            </p>
            <h1 className="font-display mt-2 text-[15vw] italic leading-[0.85] tracking-[-0.03em] text-[var(--cream)] sm:text-[96px]">
              Leads
            </h1>
          </div>

          <dl className="flex items-end gap-6 sm:gap-10">
            <Stat label="Aktive" value={String(stats.active)} accent />
            <Stat label="I alt" value={String(stats.total)} />
            {stats.latest ? (
              <Stat label="Senest" value={formatRelative(stats.latest)} />
            ) : null}
          </dl>
        </div>
      </section>

      {/* Messages */}
      {(message || error) && (
        <div className="mx-auto mb-4 w-full max-w-[1400px] px-4 sm:px-8 lg:px-12">
          {message ? (
            <p className="border-l-2 border-[#ff6b2c]/60 bg-[#ff6b2c]/[0.04] py-2 pl-4 pr-4 text-sm text-[var(--cream)]/75">
              {message}
            </p>
          ) : null}
          {error ? (
            <p className="mt-2 border-l-2 border-[#ffb86b]/70 bg-[#ffb86b]/[0.04] py-2 pl-4 pr-4 text-sm text-[#ffb86b]">
              {error}
            </p>
          ) : null}
        </div>
      )}

      {/* Ledger */}
      <section className="mx-auto w-full max-w-[1400px] px-4 pb-24 sm:px-8 lg:px-12">
        {/* Column headers — desktop only */}
        <div className="hidden border-b border-[var(--cream)]/[0.08] px-2 pb-3 md:grid md:grid-cols-[16px_80px_1.2fr_1fr_90px_120px_160px_20px] md:gap-4 md:items-end">
          <span />
          <ColHeader>Modtaget</ColHeader>
          <ColHeader>Navn</ColHeader>
          <ColHeader>Virksomhed</ColHeader>
          <ColHeader>Volumen</ColHeader>
          <ColHeader>Respons</ColHeader>
          <ColHeader className="text-right">Telefon</ColHeader>
          <span />
        </div>

        {visibleLeads.length === 0 ? (
          <div className="border-b border-[var(--cream)]/[0.08] py-16 text-center">
            <p className="font-display text-2xl italic text-[var(--cream)]/40">
              {view === "active"
                ? "Ingen aktive leads."
                : "Ingen leads endnu."}
            </p>
            <p className="mt-3 tabular text-[10px] uppercase tracking-[0.3em] text-[var(--cream)]/30">
              Indbakken er ren.
            </p>
          </div>
        ) : (
          <ol className="relative">
            {visibleLeads.map((lead, index) => (
              <LeadRow
                key={lead.id}
                lead={lead}
                index={index}
                expanded={isExpanded(lead)}
                onToggle={() => toggleExpanded(lead.id)}
                setCallStatus={setCallStatus}
                setOutcome={setOutcome}
                updateNotes={updateNotes}
              />
            ))}
          </ol>
        )}
      </section>

      <footer className="mx-auto w-full max-w-[1400px] px-4 pb-10 sm:px-8 lg:px-12">
        <p className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--cream)]/25">
          Push: {notifications}
          <span className="mx-3 text-[var(--cream)]/15">·</span>
          {stats.total} i arkivet
        </p>
      </footer>
    </main>
  );
}

/* ─── row ────────────────────────────────────────────────────────────── */

function LeadRow({
  lead,
  index,
  expanded,
  onToggle,
  setCallStatus,
  setOutcome,
  updateNotes,
}: {
  lead: Lead;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  setCallStatus: (id: string, s: CallStatus) => Promise<void>;
  setOutcome: (id: string, o: Outcome) => Promise<void>;
  updateNotes: (id: string, v: string) => void;
}) {
  const urgent = URGENCY[lead.response_time] === "urgent";
  const warm = URGENCY[lead.response_time] === "warm";
  const { day, time } = splitLeadTime(lead.created_at);
  const formattedPhone = formatPhone(lead.phone);

  return (
    <li
      className="ledger-row relative border-b border-[var(--cream)]/[0.06]"
      style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
    >
      {/* Urgency stripe */}
      {urgent && !lead.outcome ? (
        <span
          aria-hidden
          className="absolute left-0 top-0 bottom-0 w-[2px] bg-[#ff6b2c]"
        />
      ) : null}
      {lead.outcome ? (
        <span
          aria-hidden
          className={`absolute left-0 top-0 bottom-0 w-[2px] ${outcomeStripe(
            lead.outcome,
          )}`}
        />
      ) : null}

      <button
        type="button"
        onClick={onToggle}
        className="focus-cream grid w-full grid-cols-[16px_1fr_24px] items-center gap-4 px-2 py-4 text-left transition hover:bg-[var(--cream)]/[0.02] md:grid-cols-[16px_80px_1.2fr_1fr_90px_120px_160px_20px] md:items-center md:gap-4 md:py-5"
      >
        {/* Status dot */}
        <StatusDot lead={lead} />

        {/* Mobile: stacked content */}
        <div className="min-w-0 md:hidden">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-display truncate text-xl leading-tight text-[var(--cream)]">
              {lead.name}
            </h2>
            <span className="tabular shrink-0 text-[10px] uppercase tracking-[0.18em] text-[var(--cream)]/40">
              {day}
            </span>
          </div>
          <div className="mt-1 flex items-baseline justify-between gap-3">
            <p className="truncate text-sm text-[var(--cream)]/55">
              {lead.company}
            </p>
            <span className="tabular shrink-0 text-[11px] text-[var(--cream)]/35">
              {time}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <MetaTag>{lead.monthly_leads}</MetaTag>
            <MetaTag tone={urgent ? "urgent" : warm ? "warm" : "neutral"}>
              {lead.response_time}
            </MetaTag>
            <span className="tabular ml-auto text-[11px] text-[var(--cream)]/50">
              {formattedPhone}
            </span>
          </div>
        </div>

        {/* Desktop columns */}
        <div className="hidden flex-col gap-0.5 md:flex">
          <span className="tabular text-[11px] uppercase tracking-[0.16em] text-[var(--cream)]/55">
            {day}
          </span>
          <span className="tabular text-[11px] text-[var(--cream)]/30">
            {time}
          </span>
        </div>

        <div className="hidden min-w-0 md:block">
          <h2 className="font-display truncate text-[22px] leading-tight text-[var(--cream)]">
            {lead.name}
          </h2>
        </div>

        <div className="hidden min-w-0 md:block">
          <p className="truncate text-sm text-[var(--cream)]/55">
            {lead.company}
          </p>
        </div>

        <div className="hidden md:block">
          <MetaTag>{lead.monthly_leads}</MetaTag>
        </div>

        <div className="hidden md:block">
          <MetaTag tone={urgent ? "urgent" : warm ? "warm" : "neutral"}>
            {lead.response_time}
          </MetaTag>
        </div>

        <div className="hidden justify-self-end tabular text-sm text-[var(--cream)]/75 md:block">
          {formattedPhone}
        </div>

        {/* Expand indicator */}
        <Chevron expanded={expanded} />
      </button>

      {expanded ? (
        <DetailPanel
          lead={lead}
          setCallStatus={setCallStatus}
          setOutcome={setOutcome}
          updateNotes={updateNotes}
        />
      ) : null}
    </li>
  );
}

/* ─── detail panel ───────────────────────────────────────────────────── */

function DetailPanel({
  lead,
  setCallStatus,
  setOutcome,
  updateNotes,
}: {
  lead: Lead;
  setCallStatus: (id: string, s: CallStatus) => Promise<void>;
  setOutcome: (id: string, o: Outcome) => Promise<void>;
  updateNotes: (id: string, v: string) => void;
}) {
  const smsHref = `sms:${lead.phone}?&body=${encodeURIComponent(
    buildSmsBody(lead.name),
  )}`;

  return (
    <div className="ledger-detail relative grid gap-8 border-t border-[var(--cream)]/[0.05] bg-[var(--cream)]/[0.015] px-4 py-6 md:grid-cols-[1fr_380px] md:px-8 md:py-8">
      {/* Left: contact column */}
      <div className="flex flex-col gap-6">
        <div>
          <p className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--cream)]/35">
            Kontakt
          </p>
          <div className="mt-3 flex flex-col gap-2">
            <a
              href={`tel:${lead.phone}`}
              className="focus-orange group inline-flex items-center justify-between gap-4 rounded-sm bg-[#ff6b2c] px-5 py-4 text-[12px] font-semibold uppercase tracking-[0.2em] text-[#0a0907] transition hover:bg-[#ff7f47]"
            >
              <span className="flex items-center gap-3">
                <PhoneIcon />
                Ring
              </span>
              <span className="tabular text-[13px] tracking-[0.1em]">
                {formatPhone(lead.phone)}
              </span>
            </a>
            <a
              href={`mailto:${lead.email}`}
              className="focus-cream group inline-flex items-center justify-between gap-4 border-b border-[var(--cream)]/10 px-1 py-3 text-sm text-[var(--cream)]/70 transition hover:text-[var(--cream)]"
            >
              <span className="flex items-center gap-3">
                <MailIcon />
                Skriv mail
              </span>
              <span className="truncate text-[13px] text-[var(--cream)]/45 group-hover:text-[var(--cream)]/70">
                {lead.email}
              </span>
            </a>
          </div>
        </div>

        <div>
          <p className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--cream)]/35">
            Besked til lead
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <GhostButton
              onClick={() => void setCallStatus(lead.id, "answered")}
              active={lead.call_status === "answered"}
            >
              Svarede
            </GhostButton>
            <GhostAnchor
              href={smsHref}
              onClick={() => void setCallStatus(lead.id, "no_answer")}
              active={lead.call_status === "no_answer"}
            >
              Intet svar · SMS
            </GhostAnchor>
          </div>
          {lead.call_status ? (
            <div className="mt-3 flex items-center justify-between">
              <p className="flex items-center gap-2 text-[12px] text-[var(--cream)]/60">
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    lead.call_status === "answered"
                      ? "bg-[#b97041]"
                      : "bg-[#b97041] ring-1 ring-inset ring-[#b97041]"
                  }`}
                />
                {lead.call_status === "answered"
                  ? "Svarede på opkaldet"
                  : "Intet svar · SMS afsendt fra din telefon"}
              </p>
              <button
                type="button"
                onClick={() => void setCallStatus(lead.id, null)}
                className="text-[10px] uppercase tracking-[0.2em] text-[var(--cream)]/40 underline-offset-4 hover:text-[var(--cream)]/75 hover:underline"
              >
                Fortryd
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {/* Right: pipeline column */}
      <div className="flex flex-col gap-6">
        <div>
          <div className="flex items-center justify-between">
            <p className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--cream)]/35">
              Resultat
            </p>
            {lead.outcome ? (
              <button
                type="button"
                onClick={() => void setOutcome(lead.id, null)}
                className="text-[10px] uppercase tracking-[0.2em] text-[var(--cream)]/40 underline-offset-4 hover:text-[var(--cream)]/75 hover:underline"
              >
                Genåbn
              </button>
            ) : null}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            {(
              [
                "booked",
                "interested",
                "follow_up",
                "not_interested",
              ] as const
            ).map((key) => (
              <OutcomeButton
                key={key}
                outcome={key}
                selected={lead.outcome === key}
                onClick={() => void setOutcome(lead.id, key)}
              />
            ))}
          </div>

          {lead.outcome_at ? (
            <p className="tabular mt-3 text-[10px] uppercase tracking-[0.22em] text-[var(--cream)]/35">
              Lukket {formatLeadTime(lead.outcome_at)}
            </p>
          ) : null}
        </div>

        <div>
          <p className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--cream)]/35">
            Noter
          </p>
          <textarea
            value={lead.notes ?? ""}
            onChange={(e) => updateNotes(lead.id, e.target.value)}
            placeholder="Skriv hvad I talte om, næste skridt, dato for opkald …"
            rows={4}
            className="focus-cream mt-3 w-full resize-y border border-[var(--cream)]/10 bg-transparent px-3 py-3 text-sm leading-relaxed text-[var(--cream)] outline-none transition placeholder:italic placeholder:text-[var(--cream)]/25 focus:border-[var(--cream)]/40"
          />
        </div>
      </div>
    </div>
  );
}

/* ─── primitives ─────────────────────────────────────────────────────── */

function StatusDot({ lead }: { lead: Lead }) {
  if (lead.outcome) {
    const tone = OUTCOME_TONE[lead.outcome];
    return (
      <span
        aria-hidden
        className={`inline-block h-2 w-2 rounded-full ${tone.dot}`}
      />
    );
  }
  if (lead.call_status === "answered") {
    return (
      <span
        aria-hidden
        className="inline-block h-2 w-2 rounded-full bg-[#b97041] shadow-[0_0_10px_rgba(185,112,65,0.45)]"
      />
    );
  }
  if (lead.call_status === "no_answer") {
    return (
      <span
        aria-hidden
        className="inline-block h-2 w-2 rounded-full bg-transparent ring-[1.5px] ring-inset ring-[#b97041]"
      />
    );
  }
  return (
    <span
      aria-hidden
      className="dot-pulse inline-block h-2 w-2 rounded-full bg-[var(--cream)]"
    />
  );
}

function MetaTag({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "urgent" | "warm" | "neutral";
}) {
  const toneCls =
    tone === "urgent"
      ? "text-[#ffb68a] ring-[#ff6b2c]/40 bg-[#ff6b2c]/[0.08]"
      : tone === "warm"
        ? "text-[#e2a37b] ring-[#b97041]/30 bg-[#b97041]/[0.06]"
        : "text-[var(--cream)]/55 ring-[var(--cream)]/10 bg-transparent";
  return (
    <span
      className={`tabular inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] uppercase tracking-[0.12em] ring-1 ring-inset ${toneCls}`}
    >
      {children}
    </span>
  );
}

function GhostButton({
  children,
  onClick,
  active,
}: {
  children: ReactNode;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`focus-cream group relative overflow-hidden rounded-sm border px-4 py-3 text-[11px] uppercase tracking-[0.18em] transition ${
        active
          ? "border-[#b97041]/60 bg-[#b97041]/[0.08] text-[var(--cream)]"
          : "border-[var(--cream)]/12 text-[var(--cream)]/70 hover:border-[var(--cream)]/30 hover:text-[var(--cream)]"
      }`}
    >
      {children}
    </button>
  );
}

function GhostAnchor({
  children,
  href,
  onClick,
  active,
}: {
  children: ReactNode;
  href: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <a
      href={href}
      onClick={onClick}
      className={`focus-cream group relative overflow-hidden rounded-sm border px-4 py-3 text-center text-[11px] uppercase tracking-[0.18em] transition ${
        active
          ? "border-[#b97041]/60 bg-[#b97041]/[0.08] text-[var(--cream)]"
          : "border-[var(--cream)]/12 text-[var(--cream)]/70 hover:border-[var(--cream)]/30 hover:text-[var(--cream)]"
      }`}
    >
      {children}
    </a>
  );
}

function OutcomeButton({
  outcome,
  selected,
  onClick,
}: {
  outcome: Exclude<Outcome, null>;
  selected: boolean;
  onClick: () => void;
}) {
  const tone = OUTCOME_TONE[outcome];
  return (
    <button
      type="button"
      onClick={onClick}
      className={`focus-cream flex items-center justify-between gap-3 rounded-sm border px-3 py-3 text-left text-[11px] uppercase tracking-[0.16em] transition ${
        selected
          ? `border-transparent ${tone.surface} ${tone.text}`
          : "border-[var(--cream)]/10 text-[var(--cream)]/65 hover:border-[var(--cream)]/30 hover:text-[var(--cream)]"
      }`}
    >
      <span>{OUTCOME_LABELS[outcome]}</span>
      <span
        aria-hidden
        className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
          selected ? tone.dot : "bg-[var(--cream)]/15"
        }`}
      />
    </button>
  );
}

function SegmentedToggle({
  value,
  onChange,
}: {
  value: View;
  onChange: (v: View) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Vis"
      className="relative flex items-center gap-0 rounded-sm border border-[var(--cream)]/10 bg-white/[0.02] p-0.5"
    >
      {(
        [
          { key: "active", label: "Aktive" },
          { key: "all", label: "Alle" },
        ] as const
      ).map(({ key, label }) => {
        const selected = value === key;
        return (
          <button
            key={key}
            role="tab"
            aria-selected={selected}
            type="button"
            onClick={() => onChange(key)}
            className={`focus-cream relative rounded-[2px] px-3 py-1.5 text-[10px] uppercase tracking-[0.18em] transition ${
              selected
                ? "bg-[var(--cream)] text-[#0a0907]"
                : "text-[var(--cream)]/55 hover:text-[var(--cream)]"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function IconButton({
  children,
  onClick,
  title,
  disabled,
  active,
}: {
  children: ReactNode;
  onClick: () => void;
  title: string;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`focus-cream relative flex h-9 w-9 items-center justify-center rounded-sm border transition ${
        active
          ? "border-[#ff6b2c]/40 text-[#ff6b2c]"
          : "border-[var(--cream)]/10 text-[var(--cream)]/60 hover:border-[var(--cream)]/30 hover:text-[var(--cream)]"
      } disabled:cursor-wait disabled:opacity-40`}
    >
      {children}
    </button>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col items-start">
      <dt className="tabular text-[10px] uppercase tracking-[0.26em] text-[var(--cream)]/35">
        {label}
      </dt>
      <dd
        className={`font-display mt-1 text-3xl leading-none tabular sm:text-4xl ${
          accent ? "text-[#ff6b2c]" : "text-[var(--cream)]"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function ColHeader({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`tabular text-[10px] uppercase tracking-[0.26em] text-[var(--cream)]/30 ${className ?? ""}`}
    >
      {children}
    </span>
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-flex h-5 w-5 items-center justify-center text-[var(--cream)]/30 transition-transform duration-300 ${
        expanded ? "rotate-90 text-[var(--cream)]/60" : ""
      }`}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path
          d="M4 2.5L8 6L4 9.5"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function BellIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path
        d="M3 10.5h8M4.5 10.5V6.75a2.5 2.5 0 015 0v3.75M7 12.5a1 1 0 001-1h-2a1 1 0 001 1zM7 3v.5"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path
        d="M11.5 7a4.5 4.5 0 11-1.318-3.182L11.5 5M11.5 5V2M11.5 5H8.5"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ExitIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path
        d="M5.5 3H3.5a1 1 0 00-1 1v6a1 1 0 001 1h2M8.5 9.5L11 7M11 7L8.5 4.5M11 7H5.5"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path
        d="M4 2.5l.75 2-1 1.25a7 7 0 003.5 3.5l1.25-1 2 .75.5 2.5A1 1 0 0110 12.5 9 9 0 011.5 4a1 1 0 011-1L4 2.5z"
        stroke="currentColor"
        strokeWidth="1.15"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path
        d="M2 4h10v6H2V4zM2 4l5 3.5L12 4"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ─── helpers ────────────────────────────────────────────────────────── */

function outcomeStripe(outcome: Exclude<Outcome, null>) {
  return OUTCOME_TONE[outcome].edge;
}

function buildSmsBody(name: string) {
  const firstName = name.trim().split(/\s+/)[0] ?? name;
  return `Hej ${firstName}, det er Louis fra CarterCo - jeg prøvede lige at ringe. Skriv når det passer, så finder vi et tidspunkt. /Louis`;
}

function formatLeadTime(value: string) {
  return new Intl.DateTimeFormat("da-DK", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function splitLeadTime(value: string) {
  const d = new Date(value);
  const month = d
    .toLocaleDateString("da-DK", { month: "short" })
    .replace(".", "")
    .toUpperCase();
  const day = `${d.getDate()} ${month}`;
  const time = d.toLocaleTimeString("da-DK", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return { day, time };
}

function formatRelative(value: string) {
  const then = new Date(value).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "nu";
  if (mins < 60) return `${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} t`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days} d`;
  return new Intl.DateTimeFormat("da-DK", {
    day: "2-digit",
    month: "short",
  }).format(new Date(value));
}

function formatPhone(raw: string) {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10 && digits.startsWith("45")) {
    const groups = digits.slice(2).match(/.{1,2}/g);
    if (groups) return `+45 ${groups.join(" ")}`;
  }
  if (digits.length === 8) {
    const groups = digits.match(/.{1,2}/g);
    if (groups) return `+45 ${groups.join(" ")}`;
  }
  return raw;
}

function urlBase64ToUint8Array(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputArray;
}
