"use client";

// Agent overview (soho-leadflow.md §6). Per-receptionist dashboard scoped to the
// active workspace: calls made, viewings booked, rooms rented, and
// speed-to-first-call. Attribution comes entirely from `sender` on
// lead_conversation_events (the actor's email stamped at insert time) — no
// performed_by column. Answer rate is intentionally omitted: it needs Telavox
// call records, which are blocked on a calling-seat token (§4).

import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/client";
import { useWorkspace } from "@/utils/workspace";

type Range = "today" | "7d" | "30d";

type AgentRow = {
  email: string;
  calls: number;
  booked: number;
  rented: number;
  avg_speed_seconds: number | null;
};

type Summary = {
  total_calls: number;
  total_booked: number;
  total_rented: number;
  unattributed_booked: number;
  unattributed_rented: number;
  avg_speed_seconds: number | null;
};

type Overview = { agents: AgentRow[] } & Summary;

const RANGE_LABEL: Record<Range, string> = {
  today: "I dag",
  "7d": "7 dage",
  "30d": "30 dage",
};

// Average first-call latency (seconds) → short DK duration. "—" when none.
function formatSpeed(seconds: number | null): string {
  if (seconds == null) return "—";
  const min = Math.round(seconds / 60);
  if (min < 1) return "<1 min";
  if (min < 60) return `${min} min`;
  const hours = seconds / 3600;
  if (hours < 24) return `${hours.toFixed(1).replace(".", ",")} t`;
  return `${(seconds / 86400).toFixed(1).replace(".", ",")} d`;
}

export default function AgentOverviewPage() {
  const supabase = useMemo(() => createClient(), []);
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const { workspace, workspaces, loading: workspaceLoading } = useWorkspace(
    supabase,
    user,
  );
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(() =>
    typeof window === "undefined"
      ? ""
      : window.localStorage.getItem("leads_workspace_id") ?? "",
  );
  const activeWorkspace = useMemo(() => {
    if (!workspaces.length) return null;
    return (
      workspaces.find((w) => w.id === selectedWorkspaceId) ??
      workspace ??
      workspaces[0]
    );
  }, [selectedWorkspaceId, workspace, workspaces]);
  const activeWorkspaceId = activeWorkspace?.id ?? "";
  function chooseWorkspace(id: string) {
    setSelectedWorkspaceId(id);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("leads_workspace_id", id);
    }
  }

  const [range, setRange] = useState<Range>("today");
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<AgentRow[]>([]);
  const [summary, setSummary] = useState<Summary>({
    total_calls: 0,
    total_booked: 0,
    total_rented: 0,
    unattributed_booked: 0,
    unattributed_rented: 0,
    avg_speed_seconds: null,
  });
  const [dataLoading, setDataLoading] = useState(false);

  // ── auth ──
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

  // ── workspace roster (email → first name) ──
  useEffect(() => {
    if (!user || !activeWorkspaceId) return;
    let cancelled = false;
    void supabase
      .from("workspace_members")
      .select("user_email, display_name")
      .eq("workspace_id", activeWorkspaceId)
      .then(({ data }) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const m of data ?? []) {
          if (m.user_email && m.display_name) map[m.user_email] = m.display_name;
        }
        setMemberNames(map);
      });
    return () => {
      cancelled = true;
    };
  }, [user, activeWorkspaceId, supabase]);

  // ── aggregate ──
  // Server-side RPC: exact counts (no client row-limit truncation), one round
  // trip, "today" resolved in Europe/Copenhagen, and the booked/rented
  // attribution computed in one place (the last person to log phone/note
  // contact on the lead at or before the outcome was set).
  useEffect(() => {
    if (!user || !activeWorkspaceId) return;
    let cancelled = false;

    async function load() {
      setDataLoading(true);
      setError(null);
      const { data, error } = await supabase.rpc("agent_overview", {
        p_workspace_id: activeWorkspaceId,
        p_range: range,
      });
      if (cancelled) return;
      if (error) {
        setError(error.message);
        setRows([]);
        setDataLoading(false);
        return;
      }
      const o = (data ?? {}) as Partial<Overview>;
      setRows((o.agents ?? []) as AgentRow[]);
      setSummary({
        total_calls: o.total_calls ?? 0,
        total_booked: o.total_booked ?? 0,
        total_rented: o.total_rented ?? 0,
        unattributed_booked: o.unattributed_booked ?? 0,
        unattributed_rented: o.unattributed_rented ?? 0,
        avg_speed_seconds: o.avg_speed_seconds ?? null,
      });
      setDataLoading(false);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [user, activeWorkspaceId, range, supabase]);

  async function sendLink(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) {
      setError("Indtast din e-mail.");
      return;
    }
    const { error } = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: { shouldCreateUser: true },
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
  }

  const totals = {
    calls: summary.total_calls,
    booked: summary.total_booked,
    rented: summary.total_rented,
    speed: formatSpeed(summary.avg_speed_seconds),
  };

  /* ─── loading ─── */
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

  /* ─── login ─── */
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
            CarterCo · Oversigt
          </Link>
          <section>
            <p className="tabular text-[10px] uppercase tracking-[0.32em] text-[var(--ink)]/40">
              Privat arbejdsrum
            </p>
            <h1 className="font-display mt-4 text-6xl italic leading-[0.9] tracking-[-0.02em] text-[var(--ink)] sm:text-7xl">
              Oversigt
            </h1>
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
            {new Date().getFullYear()} · CarterCo
          </p>
        </div>
      </main>
    );
  }

  /* ─── no workspace ─── */
  if (!workspaceLoading && !activeWorkspace) {
    return (
      <main className="safe-screen safe-pad-top safe-pad-bottom safe-px relative min-h-screen overflow-hidden bg-[var(--sand)] text-[var(--ink)]">
        <div className="grain-overlay" />
        <div className="relative mx-auto flex min-h-screen w-full max-w-md flex-col justify-between px-6 py-8 sm:py-10">
          <Link
            href="/leads"
            className="tabular text-[10px] uppercase tracking-[0.35em] text-[var(--ink)]/45"
          >
            ← Leads
          </Link>
          <section>
            <p className="tabular text-[10px] uppercase tracking-[0.32em] text-[var(--ink)]/40">
              Ingen workspace
            </p>
            <h1 className="font-display mt-4 text-5xl italic leading-[0.9] tracking-[-0.02em] text-[var(--ink)] sm:text-6xl">
              Adgang afventer
            </h1>
            <button
              onClick={() => void signOut()}
              className="focus-cream mt-8 tabular text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/70 hover:underline"
            >
              Log ud →
            </button>
          </section>
          <p className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--ink)]/25">
            {user.email}
          </p>
        </div>
      </main>
    );
  }

  /* ─── dashboard ─── */
  const hasAttribution = rows.some((r) => r.booked > 0 || r.rented > 0);
  return (
    <main className="safe-screen safe-pad-bottom relative min-h-screen max-w-full overflow-x-hidden bg-[var(--sand)] text-[var(--ink)]">
      <div className="grain-overlay" />

      {/* Sticky top bar */}
      <div className="safe-pad-top sticky top-0 z-20 border-b border-[var(--ink)]/[0.10] bg-[var(--sand)]/85 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-[1400px] min-w-0 items-center justify-between gap-3 px-4 py-3 sm:gap-4 sm:px-8 lg:px-12">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              href="/leads"
              className="tabular min-w-0 truncate text-[10px] uppercase tracking-[0.24em] text-[var(--ink)]/50 transition hover:text-[var(--ink)]/80 sm:tracking-[0.35em]"
            >
              ← Leads
              <span className="mx-2 text-[var(--ink)]/25">/</span>
              <span className="text-[var(--ink)]/75">Oversigt</span>
            </Link>
            {workspaces.length > 1 ? (
              <select
                value={activeWorkspace?.id ?? ""}
                onChange={(e) => chooseWorkspace(e.target.value)}
                className="focus-cream tabular shrink-0 rounded-sm border border-[var(--ink)]/15 bg-transparent px-2 py-1.5 text-[10px] uppercase tracking-[0.18em] text-[var(--ink)]/65 outline-none hover:border-[var(--ink)]/35 focus:border-[var(--ink)]/35"
                title="Workspace"
              >
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {(["today", "7d", "30d"] as Range[]).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`focus-cream tabular rounded-sm px-2.5 py-1.5 text-[10px] uppercase tracking-[0.18em] transition ${
                  range === r
                    ? "bg-[var(--ink)]/[0.07] text-[var(--ink)]"
                    : "text-[var(--ink)]/45 hover:text-[var(--ink)]/75"
                }`}
              >
                {RANGE_LABEL[r]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Masthead + totals */}
      <section className="relative mx-auto w-full max-w-[1400px] min-w-0 px-4 pt-10 pb-8 sm:px-8 sm:pt-16 sm:pb-10 lg:px-12">
        <div className="pointer-events-none absolute inset-x-4 top-6 -z-10 h-[40vh] bg-[radial-gradient(ellipse_at_top_left,rgba(185,112,65,0.08),transparent_60%)] sm:inset-x-8 lg:inset-x-12" />
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="tabular text-[10px] uppercase tracking-[0.32em] text-[var(--ink)]/40">
              {activeWorkspace?.name ?? "Workspace"} · {RANGE_LABEL[range]}
            </p>
            <h1 className="font-display mt-2 text-[14vw] italic leading-[0.85] tracking-[-0.03em] text-[var(--ink)] sm:text-[88px]">
              Oversigt
            </h1>
          </div>
          <dl className="flex flex-wrap items-end gap-6 sm:gap-10">
            <Stat label="Opkald" value={String(totals.calls)} accent />
            <Stat label="Booket" value={String(totals.booked)} />
            <Stat label="Udlejet" value={String(totals.rented)} />
            <Stat label="Ø. svartid" value={totals.speed} />
          </dl>
        </div>
      </section>

      {/* Per-agent table */}
      <section className="mx-auto w-full max-w-[1400px] px-4 pb-16 sm:px-8 lg:px-12">
        <div className="grid grid-cols-[1.4fr_repeat(4,minmax(0,1fr))] items-center gap-3 border-b border-[var(--ink)]/[0.12] pb-2.5">
          <ColHeader>Agent</ColHeader>
          <ColHeader className="text-right">Opkald</ColHeader>
          <ColHeader className="text-right">Booket</ColHeader>
          <ColHeader className="text-right">Udlejet</ColHeader>
          <ColHeader className="text-right">Svartid</ColHeader>
        </div>

        {dataLoading && rows.length === 0 ? (
          <p className="tabular py-10 text-center text-[11px] uppercase tracking-[0.3em] text-[var(--ink)]/30">
            Indlæser
          </p>
        ) : rows.length === 0 ? (
          <p className="tabular py-10 text-center text-[11px] uppercase tracking-[0.3em] text-[var(--ink)]/30">
            Ingen aktivitet i perioden
          </p>
        ) : (
          <ul>
            {rows.map((r) => (
              <li
                key={r.email}
                className="grid grid-cols-[1.4fr_repeat(4,minmax(0,1fr))] items-center gap-3 border-b border-[var(--ink)]/[0.08] py-4"
              >
                <span className="font-display truncate text-xl leading-tight text-[var(--ink)]">
                  {memberNames[r.email] ?? r.email.split("@")[0]}
                </span>
                <span className="tabular text-right text-lg text-[var(--ink)]/80">
                  {r.calls || <span className="text-[var(--ink)]/20">—</span>}
                </span>
                <span className="tabular text-right text-lg text-[var(--ink)]/80">
                  {r.booked || <span className="text-[var(--ink)]/20">—</span>}
                </span>
                <span className="tabular text-right text-lg text-[var(--forest)]">
                  {r.rented || <span className="text-[var(--ink)]/20">—</span>}
                </span>
                <span className="tabular text-right text-sm text-[var(--ink)]/55">
                  {formatSpeed(r.avg_speed_seconds)}
                </span>
              </li>
            ))}
          </ul>
        )}

        {summary.unattributed_booked + summary.unattributed_rented > 0 ? (
          <p className="tabular mt-4 text-[10px] uppercase tracking-[0.2em] text-[var(--ink)]/35">
            +{" "}
            {summary.unattributed_booked + summary.unattributed_rented} uden
            agent-tilskrivning (ingen logget kontakt før resultatet)
          </p>
        ) : null}

        <p className="mt-8 max-w-2xl text-[12px] leading-relaxed text-[var(--ink)]/40">
          Booket/udlejet tilskrives den der sidst loggede kontakt (opkald eller
          note) på leadet før resultatet blev sat. Svartid = tid fra leadet kom
          ind til første opkald, for leads oprettet i perioden.
          {hasAttribution ? "" : " Svarprocent kommer når Telavox-opkaldsdata er koblet på."}
        </p>
      </section>
    </main>
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
