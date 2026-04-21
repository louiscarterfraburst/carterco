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
  | "follow_up"
  | "not_interested"
  | "unqualified"
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
  follow_up: "Follow up",
  not_interested: "Ikke interesseret",
  unqualified: "Ikke kvalificeret",
};

const OUTCOME_TONE: Record<
  Exclude<Outcome, null>,
  { dot: string; text: string; surface: string; edge: string }
> = {
  booked: {
    dot: "bg-[var(--forest)]",
    text: "text-[var(--forest)]",
    surface: "bg-[var(--forest)]/20",
    edge: "border-l-[var(--forest)]",
  },
  interested: {
    dot: "bg-[var(--clay)]",
    text: "text-[var(--clay)]",
    surface: "bg-[var(--clay)]/15",
    edge: "border-l-[var(--clay)]",
  },
  follow_up: {
    dot: "bg-transparent ring-1 ring-inset ring-[var(--ink)]/60",
    text: "text-[var(--ink)]/80",
    surface: "bg-[var(--ink)]/[0.05]",
    edge: "border-l-[var(--ink)]/40",
  },
  not_interested: {
    dot: "bg-[var(--ink)]/30",
    text: "text-[var(--ink)]/55",
    surface: "bg-[var(--ink)]/[0.04]",
    edge: "border-l-[var(--ink)]/25",
  },
  unqualified: {
    dot: "bg-transparent ring-1 ring-inset ring-[var(--ink)]/30",
    text: "text-[var(--ink)]/45",
    surface: "bg-[var(--ink)]/[0.025]",
    edge: "border-l-[var(--ink)]/15",
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
  const [hasRungIds, setHasRungIds] = useState<Set<string>>(new Set());
  const notesTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  function markRung(leadId: string) {
    setHasRungIds((curr) => {
      const next = new Set(curr);
      next.add(leadId);
      return next;
    });
  }

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
    if (hasRungIds.has(lead.id) && !lead.outcome) return true;
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
      <main className="safe-screen safe-pad-top safe-pad-bottom relative flex min-h-screen max-w-full items-center justify-center overflow-x-hidden bg-[var(--sand)] px-6 text-[var(--ink)]">
        <div className="grain-overlay" />
        <p className="tabular text-[11px] uppercase tracking-[0.4em] text-[var(--ink)]/40">
          Indlæser
        </p>
      </main>
    );
  }

  /* ─── login screen ─── */
  if (!user) {
    return (
      <main className="safe-screen safe-pad-top safe-pad-bottom safe-px relative min-h-screen max-w-full overflow-hidden bg-[var(--sand)] text-[var(--ink)]">
        <div className="grain-overlay" />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[60vh] bg-[radial-gradient(ellipse_at_top,rgba(185,112,65,0.14),transparent_60%)]" />

        <div className="safe-screen relative mx-auto flex min-h-screen w-full max-w-md min-w-0 flex-col justify-between px-6 py-8 sm:py-10">
          <Link
            href="/"
            className="tabular text-[10px] uppercase tracking-[0.35em] text-[var(--ink)]/45 hover:text-[var(--ink)]/70"
          >
            CarterCo · Leads
          </Link>

          <section>
            <p className="tabular text-[10px] uppercase tracking-[0.32em] text-[var(--ink)]/40">
              Privat arbejdsrum
            </p>
            <h1 className="font-display mt-4 text-6xl italic leading-[0.9] tracking-[-0.02em] text-[var(--ink)] sm:text-7xl">
              Leads
            </h1>
            <p className="mt-6 max-w-xs text-sm leading-relaxed text-[var(--ink)]/55">
              Se nye henvendelser, ring direkte og hold styr på din pipeline
              uden støj.
            </p>

            <form onSubmit={sendLink} className="mt-10 flex flex-col gap-3">
              <label className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--ink)]/40">
                E-mail
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                className="focus-orange border-b border-[var(--ink)]/15 bg-transparent py-3 text-base text-[var(--ink)] outline-none transition focus:border-[var(--forest)]"
              />
              <button
                type="submit"
                className="focus-orange mt-4 flex items-center justify-between rounded-sm bg-[var(--forest)] px-5 py-3.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--cream)] transition hover:bg-[#2f5e4e] active:bg-[#0e3429]"
              >
                <span>Send login-link</span>
                <span aria-hidden>→</span>
              </button>
            </form>

            <form onSubmit={verifyCode} className="mt-8 flex flex-col gap-3">
              <label className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--ink)]/40">
                Eller indtast kode
              </label>
              <input
                type="text"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-cifret"
                className="focus-cream tabular border-b border-[var(--ink)]/15 bg-transparent py-3 text-base text-[var(--ink)] outline-none transition placeholder:text-[var(--ink)]/25 focus:border-[var(--ink)]/45"
              />
              <button
                type="submit"
                className="focus-cream mt-2 self-start text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/70 underline-offset-[6px] transition hover:text-[var(--ink)] hover:underline"
              >
                Verificer →
              </button>
            </form>

            {message ? (
              <p className="mt-8 border-l border-[var(--forest)]/50 pl-3 text-sm text-[var(--ink)]/70">
                {message}
              </p>
            ) : null}
            {error ? (
              <p className="mt-8 border-l border-[var(--clay)]/50 pl-3 text-sm text-[var(--clay)]">
                {error}
              </p>
            ) : null}
          </section>

          <p className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--ink)]/25">
            {new Date().getFullYear()} · Kun for {allowedEmail}
          </p>
        </div>
      </main>
    );
  }

  /* ─── main dashboard ─── */
  return (
    <main className="safe-screen safe-pad-bottom relative min-h-screen max-w-full overflow-x-hidden bg-[var(--sand)] text-[var(--ink)]">
      <div className="grain-overlay" />

      {/* Sticky top bar */}
      <div className="safe-pad-top sticky top-0 z-20 border-b border-[var(--ink)]/[0.10] bg-[var(--sand)]/85 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-[1400px] min-w-0 items-center justify-between gap-3 px-4 py-3 sm:gap-4 sm:px-8 lg:px-12">
          <Link
            href="/"
            className="tabular min-w-0 truncate text-[10px] uppercase tracking-[0.24em] text-[var(--ink)]/50 transition hover:text-[var(--ink)]/80 sm:tracking-[0.35em]"
          >
            CarterCo
            <span className="mx-2 text-[var(--ink)]/25">/</span>
            <span className="text-[var(--ink)]/75">Leads</span>
          </Link>

          <div className="flex min-w-0 shrink-0 items-center gap-1 sm:gap-2">
            <SegmentedToggle value={view} onChange={setView} />
            <div className="mx-1 hidden h-4 w-px bg-[var(--ink)]/10 sm:block" />
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
      <section className="relative mx-auto w-full max-w-[1400px] min-w-0 px-4 pt-10 pb-8 sm:px-8 sm:pt-16 sm:pb-10 lg:px-12">
        <div className="pointer-events-none absolute inset-x-4 top-6 -z-10 h-[40vh] bg-[radial-gradient(ellipse_at_top_left,rgba(185,112,65,0.08),transparent_60%)] sm:inset-x-8 lg:inset-x-12" />

        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="tabular text-[10px] uppercase tracking-[0.32em] text-[var(--ink)]/40">
              Indbakke
            </p>
            <h1 className="font-display mt-2 text-[15vw] italic leading-[0.85] tracking-[-0.03em] text-[var(--ink)] sm:text-[96px]">
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
            <p className="border-l-2 border-[var(--forest)]/60 bg-[var(--forest)]/[0.04] py-2 pl-4 pr-4 text-sm text-[var(--ink)]/75">
              {message}
            </p>
          ) : null}
          {error ? (
            <p className="mt-2 border-l-2 border-[var(--clay)]/70 bg-[var(--clay)]/[0.04] py-2 pl-4 pr-4 text-sm text-[var(--clay)]">
              {error}
            </p>
          ) : null}
        </div>
      )}

      {/* Ledger */}
      <section className="mx-auto w-full max-w-[1400px] min-w-0 px-4 pb-24 sm:px-8 lg:px-12">
        {/* Column headers — desktop only */}
        <div className="hidden border-b border-[var(--ink)]/[0.10] px-2 pb-3 md:grid md:grid-cols-[16px_80px_1.2fr_1fr_90px_120px_20px_1px_180px] md:gap-4 md:items-end">
          <span />
          <ColHeader>Modtaget</ColHeader>
          <ColHeader>Navn</ColHeader>
          <ColHeader>Virksomhed</ColHeader>
          <ColHeader>Volumen</ColHeader>
          <ColHeader>Respons</ColHeader>
          <span />
          <span />
          <ColHeader className="px-5 text-center">Ring</ColHeader>
        </div>

        {visibleLeads.length === 0 ? (
          <div className="border-b border-[var(--ink)]/[0.08] py-16 text-center">
            <p className="font-display text-2xl italic text-[var(--ink)]/40">
              {view === "active"
                ? "Ingen aktive leads."
                : "Ingen leads endnu."}
            </p>
            <p className="mt-3 tabular text-[10px] uppercase tracking-[0.3em] text-[var(--ink)]/30">
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
                onRung={() => markRung(lead.id)}
                setCallStatus={setCallStatus}
                setOutcome={setOutcome}
                updateNotes={updateNotes}
              />
            ))}
          </ol>
        )}
      </section>

      <footer className="mx-auto w-full max-w-[1400px] px-4 pb-10 sm:px-8 lg:px-12">
        <p className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--ink)]/25">
          Push: {notifications}
          <span className="mx-3 text-[var(--ink)]/15">·</span>
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
  onRung,
  setCallStatus,
  setOutcome,
  updateNotes,
}: {
  lead: Lead;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  onRung: () => void;
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
      className="ledger-row relative border-b border-[var(--ink)]/[0.10]"
      style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
    >
      {/* Urgency stripe */}
      {urgent && !lead.outcome ? (
        <span
          aria-hidden
          className="absolute left-0 top-0 bottom-0 w-[2px] bg-[var(--clay)]"
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

      <div className="flex min-w-0 items-stretch overflow-hidden">
        <button
          type="button"
          onClick={onToggle}
          className="focus-cream grid min-w-0 flex-1 grid-cols-[16px_1fr] items-center gap-3 px-3 py-4 text-left transition hover:bg-[var(--ink)]/[0.04] sm:px-4 md:grid-cols-[16px_80px_1.2fr_1fr_90px_120px_20px] md:gap-4 md:py-5"
        >
          {/* Status dot */}
          <StatusDot lead={lead} />

          {/* Mobile: stacked content */}
          <div className="min-w-0 md:hidden">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="font-display truncate text-xl leading-tight text-[var(--ink)]">
                {lead.name}
              </h2>
              <span className="tabular shrink-0 text-[10px] uppercase tracking-[0.18em] text-[var(--ink)]/40">
                {day}
              </span>
            </div>
            <div className="mt-1 flex items-baseline justify-between gap-3">
              <p className="truncate text-sm text-[var(--ink)]/55">
                {lead.company}
              </p>
              <span className="tabular shrink-0 text-[11px] text-[var(--ink)]/35">
                {time}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <MetaTag>{lead.monthly_leads}</MetaTag>
              <MetaTag tone={urgent ? "urgent" : warm ? "warm" : "neutral"}>
                {lead.response_time}
              </MetaTag>
            </div>
          </div>

          {/* Desktop columns */}
          <div className="hidden flex-col gap-0.5 md:flex">
            <span className="tabular text-[11px] uppercase tracking-[0.16em] text-[var(--ink)]/55">
              {day}
            </span>
            <span className="tabular text-[11px] text-[var(--ink)]/30">
              {time}
            </span>
          </div>

          <div className="hidden min-w-0 md:block">
            <h2 className="font-display truncate text-[22px] leading-tight text-[var(--ink)]">
              {lead.name}
            </h2>
          </div>

          <div className="hidden min-w-0 md:block">
            <p className="truncate text-sm text-[var(--ink)]/55">
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

          {/* Expand indicator (desktop only — mobile is whole-row tap) */}
          <div className="hidden md:block">
            <Chevron expanded={expanded} />
          </div>
        </button>

        {/* Tap-to-call action — sibling to the expand button so they can be activated independently */}
        <a
          href={`tel:${lead.phone}`}
          onClick={onRung}
          aria-label={`Ring ${formattedPhone}`}
          className="focus-orange group flex w-12 shrink-0 items-center justify-center gap-2 self-stretch border-l border-[var(--ink)]/[0.08] text-[var(--forest)] transition hover:bg-[var(--forest)] hover:text-[var(--cream)] active:bg-[#0e3429] md:w-auto md:gap-3 md:px-5"
        >
          <PhoneIcon />
          <span className="tabular hidden text-[13px] tracking-[0.04em] md:inline">
            {formattedPhone}
          </span>
        </a>
      </div>

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
  // Resolved — terminal state, shown only in "Vis alle"
  if (lead.outcome) {
    return (
      <div className="ledger-detail border-t border-[var(--ink)]/[0.10] bg-[var(--ink)]/[0.03] px-4 py-5 sm:px-6 sm:py-6">
        <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="tabular text-[10px] uppercase tracking-[0.26em] text-[var(--ink)]/35">
                Lukket
              </p>
              <p className="font-display mt-1.5 text-2xl italic leading-tight text-[var(--ink)]">
                {OUTCOME_LABELS[lead.outcome]}
              </p>
              {lead.outcome_at ? (
                <p className="tabular mt-2 text-[11px] text-[var(--ink)]/40">
                  {formatLeadTime(lead.outcome_at)}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => void setOutcome(lead.id, null)}
              className="text-[11px] uppercase tracking-[0.18em] text-[var(--ink)]/50 underline-offset-4 transition hover:text-[var(--ink)] hover:underline"
            >
              Genåbn
            </button>
          </div>
          {lead.notes ? (
            <p className="whitespace-pre-wrap border-l-2 border-[var(--ink)]/10 pl-4 text-sm leading-relaxed text-[var(--ink)]/70">
              {lead.notes}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  const smsHref = `sms:${lead.phone}?&body=${encodeURIComponent(
    buildSmsBody(lead.name),
  )}`;
  const showOutcomeSection = !!lead.call_status;

  return (
    <div className="ledger-detail border-t border-[var(--ink)]/[0.10] bg-[var(--ink)]/[0.03] px-4 py-5 sm:px-6 sm:py-6">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-5">
        {/* Mail (secondary contact action — Ring lives on the row itself) */}
        <a
          href={`mailto:${lead.email}`}
          className="focus-cream flex items-center justify-between gap-4 border-b border-[var(--ink)]/[0.10] pb-3 text-[var(--ink)]/55 transition hover:text-[var(--ink)]"
        >
          <span className="flex items-center gap-3 text-[11px] uppercase tracking-[0.18em]">
            <MailIcon />
            Skriv mail
          </span>
          <span className="truncate text-[12px] text-[var(--ink)]/35">
            {lead.email}
          </span>
        </a>

        {/* Step 1 — Svarede / Intet svar (always visible when expanded) */}
        <div className="ledger-detail flex flex-col gap-3">
          {lead.call_status ? (
            <div className="flex items-center justify-between gap-3">
              <p className="flex items-center gap-2.5 text-[12px] text-[var(--ink)]/70">
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    lead.call_status === "answered"
                      ? "bg-[var(--clay)]"
                      : "bg-transparent ring-[1.5px] ring-inset ring-[var(--clay)]"
                  }`}
                  aria-hidden
                />
                {lead.call_status === "answered"
                  ? "Svarede på opkaldet"
                  : "Intet svar · SMS afsendt"}
              </p>
              <button
                type="button"
                onClick={() => void setCallStatus(lead.id, null)}
                className="text-[10px] uppercase tracking-[0.2em] text-[var(--ink)]/40 underline-offset-4 transition hover:text-[var(--ink)]/75 hover:underline"
              >
                Fortryd
              </button>
            </div>
          ) : (
            <p className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--ink)]/45">
              Hvad skete der?
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
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
        </div>

        {/* Step 2 — outcome + notes (only after Svarede/Intet svar) */}
        {showOutcomeSection ? (
          <div className="ledger-detail flex flex-col gap-5 border-t border-[var(--ink)]/[0.10] pt-5">
            <div>
              <p className="tabular mb-3 text-[10px] uppercase tracking-[0.28em] text-[var(--ink)]/45">
                Resultat
              </p>
              <div className="grid grid-cols-2 gap-2">
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
                <OutcomeButton
                  outcome="unqualified"
                  selected={lead.outcome === "unqualified"}
                  onClick={() => void setOutcome(lead.id, "unqualified")}
                  fullWidth
                />
              </div>
            </div>
            <textarea
              value={lead.notes ?? ""}
              onChange={(e) => updateNotes(lead.id, e.target.value)}
              placeholder="Noter — valgfrit"
              rows={3}
              className="focus-cream w-full resize-y border border-[var(--ink)]/10 bg-transparent px-3 py-3 text-sm leading-relaxed text-[var(--ink)] outline-none transition placeholder:italic placeholder:text-[var(--ink)]/25 focus:border-[var(--ink)]/40"
            />
          </div>
        ) : null}
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
        className="inline-block h-2 w-2 rounded-full bg-[var(--clay)]"
      />
    );
  }
  if (lead.call_status === "no_answer") {
    return (
      <span
        aria-hidden
        className="inline-block h-2 w-2 rounded-full bg-transparent ring-[1.5px] ring-inset ring-[var(--clay)]"
      />
    );
  }
  return (
    <span
      aria-hidden
      className="dot-pulse inline-block h-2 w-2 rounded-full bg-[var(--forest)]"
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
      ? "text-[var(--clay)] ring-[var(--clay)]/40 bg-[var(--clay)]/[0.08]"
      : tone === "warm"
        ? "text-[var(--clay)] ring-[var(--clay)]/30 bg-[var(--clay)]/[0.06]"
        : "text-[var(--ink)]/55 ring-[var(--ink)]/10 bg-transparent";
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
          ? "border-[var(--clay)]/60 bg-[var(--clay)]/[0.08] text-[var(--ink)]"
          : "border-[var(--ink)]/12 text-[var(--ink)]/70 hover:border-[var(--ink)]/30 hover:text-[var(--ink)]"
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
          ? "border-[var(--clay)]/60 bg-[var(--clay)]/[0.08] text-[var(--ink)]"
          : "border-[var(--ink)]/12 text-[var(--ink)]/70 hover:border-[var(--ink)]/30 hover:text-[var(--ink)]"
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
  fullWidth,
}: {
  outcome: Exclude<Outcome, null>;
  selected: boolean;
  onClick: () => void;
  fullWidth?: boolean;
}) {
  const tone = OUTCOME_TONE[outcome];
  return (
    <button
      type="button"
      onClick={onClick}
      className={`focus-cream flex items-center justify-between gap-3 rounded-sm border px-3 py-3 text-left text-[11px] uppercase tracking-[0.16em] transition ${
        fullWidth ? "col-span-2" : ""
      } ${
        selected
          ? `border-transparent ${tone.surface} ${tone.text}`
          : "border-[var(--ink)]/10 text-[var(--ink)]/65 hover:border-[var(--ink)]/30 hover:text-[var(--ink)]"
      }`}
    >
      <span>{OUTCOME_LABELS[outcome]}</span>
      <span
        aria-hidden
        className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
          selected ? tone.dot : "bg-[var(--ink)]/15"
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
      className="relative flex items-center gap-0 rounded-sm border border-[var(--ink)]/10 bg-[var(--ink)]/[0.04] p-0.5"
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
                ? "bg-[var(--ink)] text-[var(--sand)]"
                : "text-[var(--ink)]/55 hover:text-[var(--ink)]"
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
          ? "border-[var(--forest)]/50 text-[var(--forest)]"
          : "border-[var(--ink)]/10 text-[var(--ink)]/60 hover:border-[var(--ink)]/30 hover:text-[var(--ink)]"
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
      <dt className="tabular text-[10px] uppercase tracking-[0.26em] text-[var(--ink)]/35">
        {label}
      </dt>
      <dd
        className={`font-display mt-1 text-3xl leading-none tabular sm:text-4xl ${
          accent ? "text-[var(--forest)]" : "text-[var(--ink)]"
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
      className={`tabular text-[10px] uppercase tracking-[0.26em] text-[var(--ink)]/30 ${className ?? ""}`}
    >
      {children}
    </span>
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-flex h-5 w-5 items-center justify-center text-[var(--ink)]/30 transition-transform duration-300 ${
        expanded ? "rotate-90 text-[var(--ink)]/60" : ""
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
