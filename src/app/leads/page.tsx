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
import { clampToBusinessHours, wasClamped } from "@/utils/businessHours";

/* ─── types ─────────────────────────────────────────────────────────── */

type CallStatus = "answered" | "no_answer" | null;
type Outcome =
  | "booked"
  | "customer"
  | "interested"
  | "follow_up"
  | "not_interested"
  | "unqualified"
  | "callback"
  | null;

type Lead = {
  id: string;
  created_at: string;
  name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  monthly_leads: string | null;
  response_time: string | null;
  call_status: CallStatus;
  call_status_at: string | null;
  outcome: Outcome;
  outcome_at: string | null;
  notes: string | null;
  is_draft: boolean;
  draft_updated_at: string | null;
  meeting_at: string | null;
  callback_at: string | null;
  next_action_at: string | null;
  next_action_type: "retry" | "callback" | null;
  retry_count: number;
  last_action_fired_at: string | null;
};

type View = "active" | "meetings" | "customers" | "all";

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
  customer: "Kunde",
  interested: "Interesseret",
  follow_up: "Follow up",
  callback: "Ring tilbage",
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
  customer: {
    dot: "bg-[var(--forest)] ring-2 ring-offset-1 ring-[var(--forest)]/30",
    text: "text-[var(--forest)]",
    surface: "bg-[var(--forest)]/[0.16]",
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
  callback: {
    dot: "bg-[var(--clay)] ring-2 ring-offset-1 ring-[var(--clay)]/30",
    text: "text-[var(--clay)]",
    surface: "bg-[var(--clay)]/[0.10]",
    edge: "border-l-[var(--clay)]",
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
  "BFxkts1k-dL9mbX23uPtalmaBnt-bHfXL4Xn7E6xImhFd1XlKR_mFHVXLfELe2PIVoM-c4a3_M9YXIOAlhooFUM";

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
  const [testingNotification, setTestingNotification] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("active");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [hasRungIds, setHasRungIds] = useState<Set<string>>(new Set());
  const [slotsLine, setSlotsLine] = useState<string>("");
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

  const isActiveLead = (l: Lead) =>
    !l.outcome ||
    l.outcome === "callback" ||
    l.outcome === "follow_up" ||
    (l.outcome === "interested" && !!l.next_action_at);

  const visibleLeads = useMemo(() => {
    if (view === "active") return leads.filter(isActiveLead);
    if (view === "customers")
      return leads.filter((l) => l.outcome === "customer");
    if (view === "meetings") {
      const withMeeting = leads.filter((l) => !!l.meeting_at);
      withMeeting.sort((a, b) => {
        const now = Date.now();
        const aT = new Date(a.meeting_at!).getTime();
        const bT = new Date(b.meeting_at!).getTime();
        const aFuture = aT >= now;
        const bFuture = bT >= now;
        if (aFuture && bFuture) return aT - bT;
        if (!aFuture && !bFuture) return bT - aT;
        return aFuture ? -1 : 1;
      });
      return withMeeting;
    }
    return leads;
  }, [leads, view]);

  const pendingOutcomeLeads = useMemo(
    () => leads.filter((l) => l.call_status === "answered" && !l.outcome),
    [leads],
  );

  const stats = useMemo(() => {
    const active = leads.filter(isActiveLead).length;
    const customers = leads.filter((l) => l.outcome === "customer").length;
    const pending = pendingOutcomeLeads.length;
    const total = leads.length;
    const latest = leads[0]?.created_at ?? null;
    return { active, customers, pending, total, latest };
  }, [leads, pendingOutcomeLeads]);

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
    if (!user?.email) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.rpc("suggest_slots", {
        _user_email: user.email,
      });
      if (cancelled || error || !data) return;
      const slotIsoArr = (data as Array<{ slot: string }>).map((r) => r.slot);
      const { data: settings } = await supabase
        .from("user_settings")
        .select("tz")
        .eq("user_email", user.email)
        .maybeSingle();
      setSlotsLine(formatSlotsLine(slotIsoArr, settings?.tz ?? "Europe/Copenhagen"));
    })();
    return () => { cancelled = true; };
  }, [user, supabase]);

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
        "id, created_at, name, company, email, phone, monthly_leads, response_time, call_status, call_status_at, outcome, outcome_at, notes, is_draft, draft_updated_at, meeting_at, callback_at, next_action_at, next_action_type, retry_count, last_action_fired_at",
      )
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      setError(error.message);
      return;
    }

    const sorted = (data ?? []).slice().sort((a, b) => {
      const aAt = a.draft_updated_at ?? a.created_at;
      const bAt = b.draft_updated_at ?? b.created_at;
      return bAt.localeCompare(aAt);
    });
    setLeads(sorted);
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
    const nowIso = new Date().toISOString();
    const nextAt = status ? nowIso : null;
    const current = leads.find((l) => l.id === leadId);
    // "Intet svar" queues the next retry. If the backend has already fired
    // earlier retries, keep the counter advancing through the cadence.
    const scheduleRetry = status === "no_answer";
    const priorCount = current?.retry_count ?? 0;
    const nextRetryCount = scheduleRetry ? priorCount : 0;
    const retryAt = scheduleRetry
      ? clampToBusinessHours(
          new Date(Date.now() + nextDelayForRetryCount(priorCount)).toISOString(),
        )
      : null;

    setLeads((curr) =>
      curr.map((lead) =>
        lead.id === leadId
          ? {
              ...lead,
              call_status: status,
              call_status_at: nextAt,
              next_action_at: scheduleRetry
                ? retryAt
                : status === null
                  ? lead.next_action_at
                  : null,
              next_action_type: scheduleRetry
                ? "retry"
                : status === null
                  ? lead.next_action_type
                  : null,
              retry_count: scheduleRetry
                ? nextRetryCount
                : status === "answered"
                  ? 0
                  : lead.retry_count,
            }
          : lead,
      ),
    );

    const payload: Record<string, unknown> = {
      call_status: status,
      call_status_at: nextAt,
    };
    if (scheduleRetry) {
      payload.next_action_at = retryAt;
      payload.next_action_type = "retry";
      payload.retry_count = nextRetryCount;
    } else if (status === "answered") {
      payload.next_action_at = null;
      payload.next_action_type = null;
      payload.retry_count = 0;
    }

    const { error } = await supabase
      .from("leads")
      .update(payload)
      .eq("id", leadId);

    if (error) {
      setLeads(previous);
      setError(error.message);
    }
  }

  async function setOutcome(
    leadId: string,
    outcome: Outcome,
    callbackAt?: string,
  ) {
    const previous = leads;
    const nowIso = new Date().toISOString();
    const outcomeAt = outcome ? nowIso : null;

    const currentLead = leads.find((l) => l.id === leadId);
    const payload: Record<string, unknown> = {
      outcome,
      outcome_at: outcomeAt,
    };
    let clampedCallback: string | null = null;
    let followUpAt: string | null = null;
    let interestedAt: string | null = null;

    if (outcome === "callback") {
      if (!callbackAt) {
        setError("Vælg et tidspunkt for at ringe tilbage.");
        return;
      }
      clampedCallback = clampToBusinessHours(callbackAt);
      if (wasClamped(callbackAt, clampedCallback)) {
        setMessage("Tidspunkt flyttet til nærmeste arbejdstid (09–17, man–fre).");
      }
      payload.callback_at = clampedCallback;
      payload.next_action_at = clampedCallback;
      payload.next_action_type = "callback";
      payload.retry_count = 0;
      payload.last_action_fired_at = null;
    } else if (outcome === "follow_up") {
      followUpAt = clampToBusinessHours(
        new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      );
      payload.callback_at = null;
      payload.next_action_at = followUpAt;
      payload.next_action_type = "retry";
      payload.retry_count = 0;
      payload.last_action_fired_at = null;
    } else if (outcome === "interested" && !currentLead?.meeting_at) {
      // Said yes but hasn't booked — queue a +2d nudge so they don't rot.
      interestedAt = clampToBusinessHours(
        new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      );
      payload.callback_at = null;
      payload.next_action_at = interestedAt;
      payload.next_action_type = "retry";
      payload.retry_count = 0;
      payload.last_action_fired_at = null;
    } else {
      payload.callback_at = null;
      payload.next_action_at = null;
      payload.next_action_type = null;
    }

    const schedulesAction =
      outcome === "callback" ||
      outcome === "follow_up" ||
      (outcome === "interested" && !!interestedAt);

    setLeads((current) =>
      current.map((lead) =>
        lead.id === leadId
          ? {
              ...lead,
              outcome,
              outcome_at: outcomeAt,
              callback_at: outcome === "callback" ? clampedCallback : null,
              next_action_at:
                outcome === "callback"
                  ? clampedCallback
                  : outcome === "follow_up"
                    ? followUpAt
                    : outcome === "interested"
                      ? interestedAt
                      : null,
              next_action_type:
                outcome === "callback"
                  ? "callback"
                  : outcome === "follow_up" ||
                    (outcome === "interested" && !!interestedAt)
                    ? "retry"
                    : null,
              retry_count: schedulesAction ? 0 : lead.retry_count,
              last_action_fired_at: schedulesAction
                ? null
                : lead.last_action_fired_at,
            }
          : lead,
      ),
    );

    const { error } = await supabase
      .from("leads")
      .update(payload)
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

    if (Notification.permission !== "granted") {
      setNotifications("Ikke aktiv");
      return;
    }

    setNotifications("Gemmer");
    const subscription = await syncPushSubscription();
    setNotifications(subscription ? "Aktiv" : "Ikke aktiv");
  }

  async function syncPushSubscription() {
    const registration = await navigator.serviceWorker.ready;
    let existingSubscription = await registration.pushManager.getSubscription();
    const currentKey = urlBase64ToUint8Array(vapidPublicKey);

    if (
      existingSubscription &&
      !arrayBuffersEqual(
        existingSubscription.options.applicationServerKey,
        currentKey,
      )
    ) {
      await existingSubscription.unsubscribe();
      existingSubscription = null;
    }

    const subscription =
      existingSubscription ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: currentKey,
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
      throw error;
    }

    return subscription;
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
      await syncPushSubscription();
      setNotifications("Aktiv");
      setMessage("Notifikationer er slået til på denne enhed.");
    } catch (err) {
      setNotifications("Ikke aktiv");
      setError(err instanceof Error ? err.message : "Notifikationer fejlede.");
    }
  }

  async function sendTestNotification() {
    setError(null);
    setMessage(null);
    setTestingNotification(true);

    try {
      const { error } = await supabase.functions.invoke("notify-new-lead", {
        body: {
          name: "Test Notifikation",
          company: "CarterCo",
          email: allowedEmail,
          phone: "+4512345678",
          monthly_leads: "50-250",
          response_time: "Under 5 min",
        },
      });

      if (error) {
        setError(error.message);
        return;
      }

      setMessage("Test-notifikation sendt. Tjek om den dukker op på enheden.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Test-notifikation fejlede.");
    } finally {
      setTestingNotification(false);
    }
  }

  function isExpanded(lead: Lead) {
    // Force-open only while the lead still needs an outcome (answered call).
    // After "Intet svar" the retry is queued and the row can collapse.
    if (lead.call_status === "answered" && !lead.outcome) return true;
    if (
      hasRungIds.has(lead.id) &&
      !lead.outcome &&
      lead.call_status !== "no_answer"
    )
      return true;
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
            <Link
              href="/meetings"
              className="focus-cream tabular hidden rounded-sm border border-[var(--ink)]/15 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/65 transition hover:border-[var(--ink)]/35 hover:text-[var(--ink)] sm:inline-flex"
            >
              Møder →
            </Link>
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

      {pendingOutcomeLeads.length > 0 ? (
        <PendingOutcomeBar
          lead={pendingOutcomeLeads[0]}
          remaining={pendingOutcomeLeads.length - 1}
          setOutcome={setOutcome}
        />
      ) : null}

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
            <Stat label="Kunder" value={String(stats.customers)} />
            <Stat label="I alt" value={String(stats.total)} />
            {stats.latest ? (
              <Stat label="Senest" value={formatRelative(stats.latest)} />
            ) : null}
          </dl>
        </div>
      </section>

      {/* Notification status */}
      <section className="mx-auto mb-5 w-full max-w-[1400px] px-4 sm:px-8 lg:px-12">
        <div className="grid gap-3 border border-[var(--ink)]/[0.10] bg-[var(--ink)]/[0.025] p-4 sm:grid-cols-[1fr_auto] sm:items-center">
          <div className="min-w-0">
            <p className="tabular text-[10px] uppercase tracking-[0.26em] text-[var(--ink)]/35">
              Push-notifikationer
            </p>
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
              <span
                className={`h-2.5 w-2.5 rounded-full ${
                  notifications === "Aktiv"
                    ? "bg-[var(--forest)]"
                    : notifications === "Blokeret"
                      ? "bg-[var(--clay)]"
                      : "bg-[var(--ink)]/25"
                }`}
                aria-hidden
              />
              <p className="font-display text-2xl italic leading-none text-[var(--ink)]">
                {notificationTitle(notifications)}
              </p>
            </div>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--ink)]/55">
              {notificationHelp(notifications)}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
            <button
              type="button"
              onClick={() => void enableNotifications()}
              disabled={
                notifications === "Beder om adgang" ||
                notifications === "Gemmer"
              }
              className="focus-cream rounded-sm border border-[var(--ink)]/15 px-4 py-3 text-[10px] uppercase tracking-[0.16em] text-[var(--ink)]/70 transition hover:border-[var(--ink)]/30 hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-45"
            >
              {notifications === "Aktiv" ? "Tjek igen" : "Slå til"}
            </button>
            <button
              type="button"
              onClick={() => void sendTestNotification()}
              disabled={notifications !== "Aktiv" || testingNotification}
              className="focus-cream rounded-sm border border-[var(--ink)]/15 px-4 py-3 text-[10px] uppercase tracking-[0.16em] text-[var(--ink)]/70 transition hover:border-[var(--ink)]/30 hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-35"
            >
              {testingNotification ? "Sender" : "Send test"}
            </button>
          </div>
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
                hasRung={hasRungIds.has(lead.id)}
                onToggle={() => toggleExpanded(lead.id)}
                onRung={() => markRung(lead.id)}
                setCallStatus={setCallStatus}
                setOutcome={setOutcome}
                updateNotes={updateNotes}
                slotsLine={slotsLine}
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
  hasRung,
  onToggle,
  onRung,
  setCallStatus,
  setOutcome,
  updateNotes,
  slotsLine,
}: {
  lead: Lead;
  index: number;
  expanded: boolean;
  hasRung: boolean;
  onToggle: () => void;
  onRung: () => void;
  setCallStatus: (id: string, s: CallStatus) => Promise<void>;
  setOutcome: (
    id: string,
    o: Outcome,
    callbackAt?: string,
  ) => Promise<void>;
  updateNotes: (id: string, v: string) => void;
  slotsLine: string;
}) {
  const urgent =
    !!lead.response_time && URGENCY[lead.response_time] === "urgent";
  const warm =
    !!lead.response_time && URGENCY[lead.response_time] === "warm";
  const rowTimestamp =
    lead.is_draft && lead.draft_updated_at
      ? lead.draft_updated_at
      : lead.created_at;
  const { day, time } = splitLeadTime(rowTimestamp);
  const phoneDigits = lead.phone ? lead.phone.replace(/\D/g, "") : "";
  const canCall = phoneDigits.length >= 8;
  const formattedPhone = lead.phone ? formatPhone(lead.phone) : "—";
  const displayName = lead.name ?? lead.email ?? "Udkast";
  const displayCompany = lead.company;

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
              <h2 className="font-display flex min-w-0 items-baseline gap-2 truncate text-xl leading-tight text-[var(--ink)]">
                <span className="truncate">{displayName}</span>
                {lead.is_draft ? <DraftBadge /> : null}
              </h2>
              <span className="tabular shrink-0 text-[10px] uppercase tracking-[0.18em] text-[var(--ink)]/40">
                {day}
              </span>
            </div>
            <div className="mt-1 flex items-baseline justify-between gap-3">
              <p className="truncate text-sm text-[var(--ink)]/55">
                {displayCompany ?? (
                  <span className="text-[var(--ink)]/30">—</span>
                )}
              </p>
              <span className="tabular shrink-0 text-[11px] text-[var(--ink)]/35">
                {time}
              </span>
            </div>
            {lead.monthly_leads || lead.response_time || lead.next_action_at ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {lead.monthly_leads ? (
                  <MetaTag>{lead.monthly_leads}</MetaTag>
                ) : null}
                {lead.response_time ? (
                  <MetaTag
                    tone={urgent ? "urgent" : warm ? "warm" : "neutral"}
                  >
                    {lead.response_time}
                  </MetaTag>
                ) : null}
                <PendingActionChip lead={lead} />
              </div>
            ) : null}
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
            <h2 className="font-display flex items-baseline gap-2 text-[22px] leading-tight text-[var(--ink)]">
              <span className="truncate">{displayName}</span>
              {lead.is_draft ? <DraftBadge /> : null}
            </h2>
          </div>

          <div className="hidden min-w-0 md:block">
            <p className="truncate text-sm text-[var(--ink)]/55">
              {displayCompany ?? (
                <span className="text-[var(--ink)]/30">—</span>
              )}
            </p>
            {lead.next_action_at || lead.outcome === "callback" ? (
              <div className="mt-1">
                <PendingActionChip lead={lead} />
              </div>
            ) : null}
          </div>

          <div className="hidden md:block">
            {lead.monthly_leads ? (
              <MetaTag>{lead.monthly_leads}</MetaTag>
            ) : (
              <span className="text-[var(--ink)]/25">—</span>
            )}
          </div>

          <div className="hidden md:block">
            {lead.response_time ? (
              <MetaTag tone={urgent ? "urgent" : warm ? "warm" : "neutral"}>
                {lead.response_time}
              </MetaTag>
            ) : (
              <span className="text-[var(--ink)]/25">—</span>
            )}
          </div>

          {/* Expand indicator (desktop only — mobile is whole-row tap) */}
          <div className="hidden md:block">
            <Chevron expanded={expanded} />
          </div>
        </button>

        {/* Tap-to-call action — sibling to the expand button so they can be activated independently */}
        {canCall ? (
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
        ) : (
          <span
            aria-label="Telefon mangler"
            className="flex w-12 shrink-0 items-center justify-center gap-2 self-stretch border-l border-[var(--ink)]/[0.08] text-[var(--ink)]/20 md:w-auto md:gap-3 md:px-5"
            title="Telefonnummer mangler"
          >
            <PhoneIcon />
            <span className="tabular hidden text-[13px] tracking-[0.04em] italic md:inline">
              {lead.phone ?? "—"}
            </span>
          </span>
        )}
      </div>

      {expanded ? (
        <DetailPanel
          lead={lead}
          hasRung={hasRung}
          setCallStatus={setCallStatus}
          setOutcome={setOutcome}
          updateNotes={updateNotes}
          slotsLine={slotsLine}
        />
      ) : null}
    </li>
  );
}

/* ─── detail panel ───────────────────────────────────────────────────── */

function DetailPanel({
  lead,
  hasRung,
  setCallStatus,
  setOutcome,
  updateNotes,
  slotsLine,
}: {
  lead: Lead;
  hasRung: boolean;
  setCallStatus: (id: string, s: CallStatus) => Promise<void>;
  setOutcome: (
    id: string,
    o: Outcome,
    callbackAt?: string,
  ) => Promise<void>;
  updateNotes: (id: string, v: string) => void;
  slotsLine: string;
}) {
  // Resolved — terminal state, shown only in "Vis alle".
  // `callback`, `follow_up`, and `interested`-with-nudge stay editable in Aktive.
  const outcomeIsTerminal =
    lead.outcome !== null &&
    lead.outcome !== undefined &&
    lead.outcome !== "callback" &&
    lead.outcome !== "follow_up" &&
    !(lead.outcome === "interested" && !!lead.next_action_at);
  if (outcomeIsTerminal && lead.outcome) {
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
              {lead.meeting_at ? (
                <p className="tabular mt-2 text-[12px] text-[var(--forest)]">
                  {formatMeetingTime(lead.meeting_at)}
                </p>
              ) : null}
              {lead.outcome_at ? (
                <p className="tabular mt-2 text-[11px] text-[var(--ink)]/40">
                  Lukket {formatLeadTime(lead.outcome_at)}
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
          {lead.outcome === "booked" ? (
            <button
              type="button"
              onClick={() => void setOutcome(lead.id, "customer")}
              className="focus-cream mt-1 flex items-center justify-center gap-2 rounded-sm bg-[var(--forest)] px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--cream)] transition hover:bg-[#2f5e4e] active:bg-[#0e3429]"
            >
              Konverter til kunde →
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const canSms =
    !!lead.phone && lead.phone.replace(/\D/g, "").length >= 8;
  const smsHref = canSms
    ? `sms:${lead.phone}?&body=${encodeURIComponent(buildSmsBody(lead.name, slotsLine))}`
    : "#";
  const hasEmail = !!lead.email && lead.email.includes("@");
  const hasDialled = hasRung || lead.call_status !== null;
  const showOutcomeSection = lead.call_status === "answered";

  return (
    <div className="ledger-detail border-t border-[var(--ink)]/[0.10] bg-[var(--ink)]/[0.03] px-4 py-5 sm:px-6 sm:py-6">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-5">
        {/* Mail (secondary contact action — Ring lives on the row itself) */}
        {hasEmail ? (
          <a
            href={mailtoHref(lead.email, lead.name, slotsLine)}
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
        ) : (
          <div className="flex items-center justify-between gap-4 border-b border-[var(--ink)]/[0.10] pb-3 text-[var(--ink)]/30">
            <span className="flex items-center gap-3 text-[11px] uppercase tracking-[0.18em]">
              <MailIcon />
              Skriv mail
            </span>
            <span className="truncate text-[12px] italic">
              Mail mangler
            </span>
          </div>
        )}

        {/* Step 1 — Svarede / Intet svar. Gated behind having dialled. */}
        <div className="ledger-detail flex flex-col gap-3">
          {!hasDialled ? (
            <div className="flex flex-col items-center gap-2 rounded-sm border border-dashed border-[var(--clay)]/40 bg-[var(--clay)]/[0.05] px-4 py-5 text-center">
              <p className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--clay)]">
                Ring først
              </p>
              <p className="text-[12px] text-[var(--ink)]/55">
                Tryk på telefonikonet for at starte opkaldet — så kan du markere resultatet bagefter.
              </p>
            </div>
          ) : (
            <>
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
                <p className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--clay)]">
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
                {canSms ? (
                  <GhostAnchor
                    href={smsHref}
                    onClick={() => void setCallStatus(lead.id, "no_answer")}
                    active={lead.call_status === "no_answer"}
                  >
                    Intet svar · SMS
                  </GhostAnchor>
                ) : (
                  <GhostButton
                    onClick={() => void setCallStatus(lead.id, "no_answer")}
                    active={lead.call_status === "no_answer"}
                  >
                    Intet svar
                  </GhostButton>
                )}
              </div>
            </>
          )}
        </div>

        {/* Step 2 — outcome + notes (only after Svarede; no_answer just queues retry) */}
        {showOutcomeSection ? (
          <div className="ledger-detail flex flex-col gap-5 border-t border-[var(--ink)]/[0.10] pt-5">
            <div>
              <p className="tabular mb-3 text-[10px] uppercase tracking-[0.28em] text-[var(--ink)]/45">
                Resultat
              </p>
              <div className="grid grid-cols-2 gap-2">
                <OutcomeButton
                  outcome="customer"
                  selected={lead.outcome === "customer"}
                  onClick={() => void setOutcome(lead.id, "customer")}
                  fullWidth
                />
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
                    subtitle={
                      (key === "follow_up" &&
                        lead.outcome === "follow_up" &&
                        lead.next_action_at) ||
                      (key === "interested" &&
                        lead.outcome === "interested" &&
                        lead.next_action_at)
                        ? `Nudge ${formatMeetingTime(lead.next_action_at!)}`
                        : undefined
                    }
                  />
                ))}
                <CallbackOutcomeButton
                  selected={lead.outcome === "callback"}
                  callbackAt={lead.callback_at}
                  onPick={(isoTime) =>
                    void setOutcome(lead.id, "callback", isoTime)
                  }
                  onClear={() => void setOutcome(lead.id, null)}
                />
                <OutcomeButton
                  outcome="unqualified"
                  selected={lead.outcome === "unqualified"}
                  onClick={() => void setOutcome(lead.id, "unqualified")}
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
  if (lead.is_draft) {
    return (
      <span
        aria-hidden
        className="inline-block h-2 w-2 rounded-full bg-transparent ring-[1.5px] ring-inset ring-[var(--ink)]/40"
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

function PendingOutcomeBar({
  lead,
  remaining,
  setOutcome,
}: {
  lead: Lead;
  remaining: number;
  setOutcome: (
    id: string,
    o: Outcome,
    callbackAt?: string,
  ) => Promise<void>;
}) {
  const displayName = lead.name ?? lead.email ?? "Unavngivet";
  return (
    <div className="sticky top-[56px] z-10 border-b border-[var(--clay)]/30 bg-[var(--clay)]/[0.08] backdrop-blur-xl">
      <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-12">
        <div className="min-w-0">
          <p className="tabular text-[10px] uppercase tracking-[0.26em] text-[var(--clay)]">
            Vælg resultat{remaining > 0 ? ` · ${remaining} til` : ""}
          </p>
          <p className="font-display mt-0.5 truncate text-lg italic leading-tight text-[var(--ink)]">
            {displayName}
            {lead.company ? (
              <span className="tabular ml-2 text-xs not-italic text-[var(--ink)]/55">
                {lead.company}
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <PendingQuickButton
            onClick={() => void setOutcome(lead.id, "customer")}
            tone="accent"
          >
            Kunde
          </PendingQuickButton>
          <PendingQuickButton
            onClick={() => void setOutcome(lead.id, "booked")}
          >
            Booket
          </PendingQuickButton>
          <PendingQuickButton
            onClick={() => void setOutcome(lead.id, "interested")}
          >
            Interesseret
          </PendingQuickButton>
          <PendingQuickButton
            onClick={() => void setOutcome(lead.id, "follow_up")}
          >
            Follow up
          </PendingQuickButton>
          <PendingQuickButton
            onClick={() => void setOutcome(lead.id, "not_interested")}
          >
            Ikke int.
          </PendingQuickButton>
          <PendingQuickButton
            onClick={() => void setOutcome(lead.id, "unqualified")}
          >
            Ukval.
          </PendingQuickButton>
        </div>
      </div>
    </div>
  );
}

function PendingQuickButton({
  children,
  onClick,
  tone,
}: {
  children: ReactNode;
  onClick: () => void;
  tone?: "accent";
}) {
  const accent = tone === "accent";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`focus-cream tabular rounded-sm px-2.5 py-1.5 text-[10px] uppercase tracking-[0.16em] transition ${
        accent
          ? "bg-[var(--forest)] text-[var(--cream)] hover:bg-[#2f5e4e]"
          : "border border-[var(--ink)]/15 text-[var(--ink)]/75 hover:border-[var(--ink)]/35 hover:text-[var(--ink)]"
      }`}
    >
      {children}
    </button>
  );
}

function PendingActionChip({ lead }: { lead: Lead }) {
  if (lead.outcome === "callback" && lead.callback_at) {
    return (
      <span className="tabular inline-flex items-center gap-1.5 rounded-full border border-[var(--clay)]/30 bg-[var(--clay)]/[0.08] px-2 py-0.5 text-[10px] text-[var(--clay)]">
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--clay)]"
        />
        Ring tilbage {formatMeetingTime(lead.callback_at)}
      </span>
    );
  }
  if (
    lead.outcome === "follow_up" &&
    lead.next_action_at &&
    lead.next_action_type === "retry"
  ) {
    return (
      <span className="tabular inline-flex items-center gap-1.5 rounded-full border border-[var(--clay)]/30 bg-[var(--clay)]/[0.06] px-2 py-0.5 text-[10px] text-[var(--clay)]">
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 rounded-full bg-transparent ring-[1.5px] ring-inset ring-[var(--clay)]"
        />
        Follow-up {formatRelativeFuture(lead.next_action_at)}
      </span>
    );
  }
  if (
    lead.outcome === "interested" &&
    lead.next_action_at &&
    lead.next_action_type === "retry"
  ) {
    return (
      <span className="tabular inline-flex items-center gap-1.5 rounded-full border border-[var(--clay)]/30 bg-[var(--clay)]/[0.10] px-2 py-0.5 text-[10px] text-[var(--clay)]">
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--clay)]/70"
        />
        Nudge {formatRelativeFuture(lead.next_action_at)}
      </span>
    );
  }
  if (lead.outcome === "unqualified" && lead.retry_count >= 4) {
    return (
      <span className="tabular inline-flex items-center gap-1.5 rounded-full border border-[var(--ink)]/15 bg-[var(--ink)]/[0.04] px-2 py-0.5 text-[10px] text-[var(--ink)]/55">
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--ink)]/40"
        />
        Opgivet — ingen svar
      </span>
    );
  }
  if (
    lead.call_status === "no_answer" &&
    !lead.outcome &&
    lead.next_action_at &&
    lead.next_action_type === "retry"
  ) {
    const attempt = lead.retry_count + 1;
    return (
      <span className="tabular inline-flex items-center gap-1.5 rounded-full border border-[var(--clay)]/30 bg-[var(--clay)]/[0.06] px-2 py-0.5 text-[10px] text-[var(--clay)]">
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 rounded-full bg-transparent ring-[1.5px] ring-inset ring-[var(--clay)]"
        />
        Opfølgning #{attempt} {formatRelativeFuture(lead.next_action_at)}
      </span>
    );
  }
  return null;
}

function DraftBadge() {
  return (
    <span className="tabular inline-flex shrink-0 items-center rounded-full border border-dashed border-[var(--clay)]/60 px-2 py-0.5 text-[9px] uppercase tracking-[0.22em] text-[var(--clay)]">
      Udkast
    </span>
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
  subtitle,
}: {
  outcome: Exclude<Outcome, null>;
  selected: boolean;
  onClick: () => void;
  fullWidth?: boolean;
  subtitle?: string;
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
      <span className="flex flex-col items-start">
        <span>{OUTCOME_LABELS[outcome]}</span>
        {selected && subtitle ? (
          <span className="tabular mt-0.5 text-[9px] text-[var(--ink)]/55 normal-case tracking-normal">
            {subtitle}
          </span>
        ) : null}
      </span>
      <span
        aria-hidden
        className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
          selected ? tone.dot : "bg-[var(--ink)]/15"
        }`}
      />
    </button>
  );
}

function CallbackOutcomeButton({
  selected,
  callbackAt,
  onPick,
  onClear,
}: {
  selected: boolean;
  callbackAt: string | null;
  onPick: (isoTime: string) => void;
  onClear: () => void;
}) {
  const tone = OUTCOME_TONE.callback;
  const [picking, setPicking] = useState(false);
  const [draftValue, setDraftValue] = useState("");

  useEffect(() => {
    if (selected && callbackAt) {
      // Keep the input showing the current scheduled time if edited.
      setDraftValue(toDatetimeLocal(callbackAt));
    }
  }, [selected, callbackAt]);

  if (picking && !selected) {
    return (
      <div className="col-span-2 flex flex-col gap-2 rounded-sm border border-[var(--clay)]/40 bg-[var(--clay)]/[0.06] p-3">
        <label className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--clay)]">
          Ring tilbage — vælg tidspunkt
        </label>
        <div className="flex items-center gap-2">
          <input
            type="datetime-local"
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
            className="focus-cream flex-1 rounded-sm border border-[var(--ink)]/15 bg-transparent px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--clay)]"
          />
          <button
            type="button"
            onClick={() => {
              if (!draftValue) return;
              const iso = new Date(draftValue).toISOString();
              onPick(iso);
              setPicking(false);
            }}
            disabled={!draftValue}
            className="rounded-sm bg-[var(--forest)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--cream)] transition hover:bg-[#2f5e4e] disabled:opacity-40"
          >
            OK
          </button>
          <button
            type="button"
            onClick={() => {
              setPicking(false);
              setDraftValue("");
            }}
            className="rounded-sm border border-[var(--ink)]/15 px-3 py-2 text-[10px] uppercase tracking-[0.2em] text-[var(--ink)]/60 transition hover:text-[var(--ink)]"
          >
            Afbryd
          </button>
        </div>
      </div>
    );
  }

  if (selected) {
    return (
      <button
        type="button"
        onClick={() => {
          setPicking(true);
          setDraftValue(callbackAt ? toDatetimeLocal(callbackAt) : "");
          // Selected → tapping opens re-picker. Clear the outcome so UI shows picker.
          onClear();
        }}
        className={`focus-cream flex items-center justify-between gap-3 rounded-sm border border-transparent ${tone.surface} ${tone.text} px-3 py-3 text-left text-[11px] uppercase tracking-[0.16em] transition`}
      >
        <span className="flex flex-col items-start">
          <span>Ring tilbage</span>
          {callbackAt ? (
            <span className="tabular mt-0.5 text-[9px] text-[var(--ink)]/55 normal-case tracking-normal">
              {formatMeetingTime(callbackAt)}
            </span>
          ) : null}
        </span>
        <span
          aria-hidden
          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`}
        />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setPicking(true)}
      className="focus-cream flex items-center justify-between gap-3 rounded-sm border border-[var(--ink)]/10 px-3 py-3 text-left text-[11px] uppercase tracking-[0.16em] text-[var(--ink)]/65 transition hover:border-[var(--ink)]/30 hover:text-[var(--ink)]"
    >
      <span>Ring tilbage</span>
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ink)]/15"
      />
    </button>
  );
}

function toDatetimeLocal(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
          { key: "meetings", label: "Møder" },
          { key: "customers", label: "Kunder" },
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

function firstName(name: string | null) {
  if (!name) return "der";
  return name.trim().split(/\s+/)[0] ?? name;
}

function buildSmsBody(name: string | null, slotsLine?: string) {
  const slot = slotsLine ? ` Eksempelvis ${slotsLine}.` : "";
  return `Hej ${firstName(name)}, det er Louis fra CarterCo - jeg prøvede lige at ringe.${slot} Skriv når det passer, så finder vi et tidspunkt. /Louis`;
}

const CALENDLY_URL = "https://calendly.com/louis-carter/30min";

function buildEmailDraft(name: string | null, slotsLine?: string) {
  const subject = "Kort follow-up fra CarterCo";
  const slotPara = slotsLine
    ? `Passer en af disse: ${slotsLine}? Eller foreslå selv et tidspunkt.\n\n`
    : "";
  const body = `Hej ${firstName(name)},

Det er Louis fra CarterCo. Jeg prøvede lige at ringe dig efter din henvendelse — har du 20 minutter senere i denne uge til at snakke om, hvordan vi kan gøre dine leads varme hurtigere?

${slotPara}Du kan også booke direkte her: ${CALENDLY_URL}

/Louis`;
  return { subject, body };
}

function mailtoHref(email: string | null | undefined, name: string | null, slotsLine?: string) {
  if (!email) return "#";
  const { subject, body } = buildEmailDraft(name, slotsLine);
  const query = `subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return `mailto:${email}?${query}`;
}

// Format ISO timestamps as Danish prose: "tirsdag 14:00, onsdag 10:00 eller torsdag 13:00"
function formatSlotsLine(slots: string[], tz: string): string {
  if (!slots.length) return "";
  const parts = slots.map((s) => {
    const d = new Date(s);
    const day = d.toLocaleDateString("da-DK", { weekday: "long", timeZone: tz });
    const time = d.toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit", timeZone: tz });
    return `${day} kl. ${time}`;
  });
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} eller ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} eller ${parts[parts.length - 1]}`;
}

function notificationTitle(status: NotificationStatus) {
  switch (status) {
    case "Aktiv":
      return "Aktiv på denne enhed";
    case "Beder om adgang":
      return "Venter på tilladelse";
    case "Gemmer":
      return "Gemmer enheden";
    case "Installer appen":
      return "Åbn som Home Screen app";
    case "Blokeret":
      return "Blokeret i iOS";
    case "Ikke understøttet":
      return "Ikke understøttet";
    default:
      return "Ikke slået til";
  }
}

function notificationHelp(status: NotificationStatus) {
  switch (status) {
    case "Aktiv":
      return "Denne enhed er registreret. Brug Send test for at tjekke om iOS viser push-beskeden.";
    case "Beder om adgang":
      return "Svar på iOS-dialogen. Vælg Tillad, ellers kan appen ikke sende push.";
    case "Gemmer":
      return "Tilladelsen er givet. Appen gemmer nu enheden i Supabase.";
    case "Installer appen":
      return "På iPhone virker push kun når siden er gemt på hjemmeskærmen og åbnet som app.";
    case "Blokeret":
      return "Åbn iOS Indstillinger, find CarterCo/Safari notifikationer, og tillad beskeder igen.";
    case "Ikke understøttet":
      return "Denne browser understøtter ikke web push. Brug Safari på iPhone som Home Screen app.";
    default:
      return "Tryk Slå til på den enhed, hvor du vil modtage nye lead-notifikationer.";
  }
}

function formatMeetingTime(value: string) {
  const d = new Date(value);
  const formatter = new Intl.DateTimeFormat("da-DK", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return formatter.format(d).replace(" kl.", " kl.");
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

const RETRY_LADDER_MS = [
  2 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
  3 * 24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
];

function nextDelayForRetryCount(fired: number): number {
  if (fired < 0) return RETRY_LADDER_MS[0];
  return RETRY_LADDER_MS[Math.min(fired, RETRY_LADDER_MS.length - 1)];
}

function formatRelativeFuture(isoTime: string) {
  const diffMs = new Date(isoTime).getTime() - Date.now();
  if (diffMs <= 0) return "nu";
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `om ${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `om ${hrs} t`;
  const days = Math.round(hrs / 24);
  return `om ${days} d`;
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

function arrayBuffersEqual(
  left: ArrayBuffer | null | undefined,
  right: Uint8Array,
) {
  if (!left || left.byteLength !== right.byteLength) return false;
  const leftBytes = new Uint8Array(left);
  return leftBytes.every((byte, index) => byte === right[index]);
}
