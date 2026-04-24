"use client";

import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/client";

type Meeting = {
  id: string;
  name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  meeting_at: string;
  source: string | null;
  outcome: string | null;
  calendly_event_uri: string | null;
  created_at: string;
};

const allowedEmail = "louis@carterco.dk";

export default function MeetingsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState(allowedEmail);
  const [token, setToken] = useState("");
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    void loadMeetings();
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadMeetings() {
    setError(null);
    const { data, error } = await supabase
      .from("leads")
      .select(
        "id, name, company, email, phone, meeting_at, source, outcome, calendly_event_uri, created_at",
      )
      .not("meeting_at", "is", null)
      .order("meeting_at", { ascending: true });

    if (error) {
      setError(error.message);
      return;
    }
    setMeetings((data ?? []) as Meeting[]);
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
    setMeetings([]);
  }

  const { upcoming, past } = useMemo(() => {
    const now = Date.now();
    const up: Meeting[] = [];
    const back: Meeting[] = [];
    for (const m of meetings) {
      const when = new Date(m.meeting_at).getTime();
      if (when >= now) up.push(m);
      else back.push(m);
    }
    up.sort(
      (a, b) =>
        new Date(a.meeting_at).getTime() - new Date(b.meeting_at).getTime(),
    );
    back.sort(
      (a, b) =>
        new Date(b.meeting_at).getTime() - new Date(a.meeting_at).getTime(),
    );
    return { upcoming: up, past: back };
  }, [meetings]);

  const nextMeetingAt = upcoming[0]?.meeting_at ?? null;

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
            CarterCo · Møder
          </Link>

          <section>
            <p className="tabular text-[10px] uppercase tracking-[0.32em] text-[var(--ink)]/40">
              Privat arbejdsrum
            </p>
            <h1 className="font-display mt-4 text-6xl italic leading-[0.9] tracking-[-0.02em] text-[var(--ink)] sm:text-7xl">
              Møder
            </h1>
            <p className="mt-6 max-w-xs text-sm leading-relaxed text-[var(--ink)]/55">
              Kommende og tidligere bookede samtaler fra Calendly.
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

  return (
    <main className="safe-screen safe-pad-bottom relative min-h-screen max-w-full overflow-x-hidden bg-[var(--sand)] text-[var(--ink)]">
      <div className="grain-overlay" />

      <div className="safe-pad-top sticky top-0 z-20 border-b border-[var(--ink)]/[0.10] bg-[var(--sand)]/85 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-[1400px] min-w-0 items-center justify-between gap-3 px-4 py-3 sm:gap-4 sm:px-8 lg:px-12">
          <Link
            href="/"
            className="tabular min-w-0 truncate text-[10px] uppercase tracking-[0.24em] text-[var(--ink)]/50 transition hover:text-[var(--ink)]/80 sm:tracking-[0.35em]"
          >
            CarterCo
            <span className="mx-2 text-[var(--ink)]/25">/</span>
            <span className="text-[var(--ink)]/75">Møder</span>
          </Link>

          <div className="flex min-w-0 shrink-0 items-center gap-2">
            <Link
              href="/leads"
              className="focus-cream tabular rounded-sm border border-[var(--ink)]/15 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/65 transition hover:border-[var(--ink)]/35 hover:text-[var(--ink)]"
            >
              Leads →
            </Link>
            <button
              type="button"
              onClick={() => void loadMeetings()}
              className="focus-cream rounded-sm border border-[var(--ink)]/15 p-1.5 text-[var(--ink)]/65 transition hover:border-[var(--ink)]/35 hover:text-[var(--ink)]"
              title="Opdater"
            >
              <RefreshIcon />
              <span className="sr-only">Opdater</span>
            </button>
            <button
              type="button"
              onClick={() => void signOut()}
              className="focus-cream rounded-sm border border-[var(--ink)]/15 p-1.5 text-[var(--ink)]/65 transition hover:border-[var(--ink)]/35 hover:text-[var(--ink)]"
              title="Log ud"
            >
              <ExitIcon />
              <span className="sr-only">Ud</span>
            </button>
          </div>
        </div>
      </div>

      <section className="relative mx-auto w-full max-w-[1400px] min-w-0 px-4 pt-10 pb-8 sm:px-8 sm:pt-16 sm:pb-10 lg:px-12">
        <div className="pointer-events-none absolute inset-x-4 top-6 -z-10 h-[40vh] bg-[radial-gradient(ellipse_at_top_left,rgba(185,112,65,0.08),transparent_60%)] sm:inset-x-8 lg:inset-x-12" />

        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="tabular text-[10px] uppercase tracking-[0.32em] text-[var(--ink)]/40">
              Kalender
            </p>
            <h1 className="font-display mt-2 text-[15vw] italic leading-[0.85] tracking-[-0.03em] text-[var(--ink)] sm:text-[96px]">
              Møder
            </h1>
          </div>

          <dl className="flex items-end gap-6 sm:gap-10">
            <Stat label="Kommende" value={String(upcoming.length)} accent />
            <Stat label="Tidligere" value={String(past.length)} />
            {nextMeetingAt ? (
              <Stat label="Næste" value={formatRelativeFuture(nextMeetingAt)} />
            ) : null}
          </dl>
        </div>
      </section>

      {error ? (
        <section className="mx-auto mb-5 w-full max-w-[1400px] px-4 sm:px-8 lg:px-12">
          <p className="border-l border-[var(--clay)]/50 pl-3 text-sm text-[var(--clay)]">
            {error}
          </p>
        </section>
      ) : null}

      <section className="mx-auto w-full max-w-[1400px] px-4 pb-12 sm:px-8 lg:px-12">
        <Section title="Kommende" count={upcoming.length}>
          {upcoming.length === 0 ? (
            <EmptyRow message="Ingen bookede møder lige nu." />
          ) : (
            <ul className="flex flex-col">
              {upcoming.map((m) => (
                <MeetingRow key={m.id} meeting={m} tense="upcoming" />
              ))}
            </ul>
          )}
        </Section>

        <Section title="Tidligere" count={past.length}>
          {past.length === 0 ? (
            <EmptyRow message="Ingen tidligere møder endnu." />
          ) : (
            <ul className="flex flex-col">
              {past.map((m) => (
                <MeetingRow key={m.id} meeting={m} tense="past" />
              ))}
            </ul>
          )}
        </Section>
      </section>
    </main>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <div className="mt-10 first:mt-0">
      <div className="mb-3 flex items-baseline justify-between border-b border-[var(--ink)]/[0.10] pb-2">
        <h2 className="tabular text-[10px] uppercase tracking-[0.3em] text-[var(--ink)]/50">
          {title}
        </h2>
        <span className="tabular text-[10px] text-[var(--ink)]/35">
          {count}
        </span>
      </div>
      {children}
    </div>
  );
}

function MeetingRow({
  meeting,
  tense,
}: {
  meeting: Meeting;
  tense: "upcoming" | "past";
}) {
  const when = new Date(meeting.meeting_at);
  const displayName = meeting.name ?? meeting.email ?? "Unavngivet";
  const cancelled = meeting.outcome === null;
  return (
    <li className="border-b border-[var(--ink)]/[0.08] last:border-b-0">
      <div className="grid gap-3 py-4 sm:grid-cols-[1fr_auto_auto] sm:items-center sm:gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={`inline-block h-2 w-2 rounded-full ${
                tense === "upcoming"
                  ? "bg-[var(--forest)]"
                  : cancelled
                    ? "bg-[var(--clay)]/40"
                    : "bg-[var(--ink)]/25"
              }`}
            />
            <p className="font-display truncate text-xl italic leading-tight text-[var(--ink)]">
              {displayName}
            </p>
            {cancelled ? (
              <span className="tabular rounded-full border border-[var(--clay)]/40 px-2 py-0.5 text-[9px] uppercase tracking-[0.22em] text-[var(--clay)]">
                Aflyst
              </span>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--ink)]/55">
            {meeting.company ? <span>{meeting.company}</span> : null}
            {meeting.email ? (
              <a
                href={`mailto:${meeting.email}`}
                className="hover:text-[var(--ink)]"
              >
                {meeting.email}
              </a>
            ) : null}
            {meeting.phone ? (
              <a
                href={`tel:${meeting.phone}`}
                className="hover:text-[var(--ink)]"
              >
                {meeting.phone}
              </a>
            ) : null}
          </div>
        </div>

        <div className="tabular text-right text-[12px] leading-tight text-[var(--ink)]">
          <p>{formatMeetingDay(when)}</p>
          <p className="text-[var(--ink)]/50">{formatMeetingHM(when)}</p>
        </div>

        <div className="flex items-center justify-end gap-2">
          <span className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/40">
            {tense === "upcoming"
              ? formatRelativeFuture(meeting.meeting_at)
              : formatRelativePast(meeting.meeting_at)}
          </span>
          <Link
            href="/leads"
            className="focus-cream tabular rounded-sm border border-[var(--ink)]/15 px-2.5 py-1 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/55 transition hover:border-[var(--ink)]/35 hover:text-[var(--ink)]"
          >
            Lead →
          </Link>
        </div>
      </div>
    </li>
  );
}

function EmptyRow({ message }: { message: string }) {
  return (
    <p className="tabular border-b border-[var(--ink)]/[0.08] py-6 text-center text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/35">
      {message}
    </p>
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
    <div>
      <dt className="tabular text-[10px] uppercase tracking-[0.26em] text-[var(--ink)]/40">
        {label}
      </dt>
      <dd
        className={`font-display mt-1 text-3xl italic leading-none sm:text-4xl ${
          accent ? "text-[var(--clay)]" : "text-[var(--ink)]"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function formatMeetingDay(d: Date) {
  return new Intl.DateTimeFormat("da-DK", {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(d);
}

function formatMeetingHM(d: Date) {
  return new Intl.DateTimeFormat("da-DK", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

function formatRelativeFuture(iso: string) {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "nu";
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `om ${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `om ${hrs} t`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `om ${days} d`;
  const weeks = Math.round(days / 7);
  return `om ${weeks} u`;
}

function formatRelativePast(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff <= 0) return "nu";
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `${mins} min siden`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} t siden`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days} d siden`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks} u siden`;
  return new Intl.DateTimeFormat("da-DK", {
    day: "2-digit",
    month: "short",
  }).format(new Date(iso));
}

function RefreshIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 8a5.5 5.5 0 0 1 9.4-3.9" />
      <path d="M12.5 2v3h-3" />
      <path d="M13.5 8a5.5 5.5 0 0 1-9.4 3.9" />
      <path d="M3.5 14v-3h3" />
    </svg>
  );
}

function ExitIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 3h3v10h-3" />
      <path d="M7 5l-3 3 3 3" />
      <path d="M4 8h6" />
    </svg>
  );
}
