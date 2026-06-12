"use client";

// Per-workspace flow view for /leads: renders the machine a lead runs through
// in the ACTIVE workspace — intake, call-first, retry, email template, outcome
// ladder — derived live from the workspace's configuration (see
// src/utils/leads-flow.ts), so Soho, Klosterstræde and CarterCo each see their
// own wiring rather than a generic diagram.

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/client";
import { useWorkspace } from "@/utils/workspace";
import { buildLeadsFlow } from "@/utils/leads-flow";

export default function LeadsFlowPage() {
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
  function chooseWorkspace(id: string) {
    setSelectedWorkspaceId(id);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("leads_workspace_id", id);
    }
  }

  const steps = useMemo(
    () => (activeWorkspace ? buildLeadsFlow(activeWorkspace) : []),
    [activeWorkspace],
  );

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
        <div className="safe-screen relative mx-auto flex min-h-screen w-full max-w-md min-w-0 flex-col justify-between px-6 py-8 sm:py-10">
          <Link
            href="/leads"
            className="tabular text-[10px] uppercase tracking-[0.35em] text-[var(--ink)]/45 hover:text-[var(--ink)]/70"
          >
            CarterCo · Flow
          </Link>
          <section>
            <p className="tabular text-[10px] uppercase tracking-[0.32em] text-[var(--ink)]/40">
              Privat arbejdsrum
            </p>
            <h1 className="font-display mt-4 text-6xl italic leading-[0.9] tracking-[-0.02em] text-[var(--ink)] sm:text-7xl">
              Flow
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
        <div className="relative mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6">
          <p className="tabular text-[10px] uppercase tracking-[0.32em] text-[var(--ink)]/40">
            Ingen workspace
          </p>
          <p className="mt-4 text-sm text-[var(--ink)]/65">
            Din e-mail er ikke tilknyttet noget workspace endnu. Kontakt support, så får du adgang.
          </p>
        </div>
      </main>
    );
  }

  /* ─── flow ─── */
  return (
    <main className="safe-screen safe-pad-bottom relative min-h-screen max-w-full overflow-x-hidden bg-[var(--sand)] text-[var(--ink)]">
      <div className="grain-overlay" />

      <div className="safe-pad-top sticky top-0 z-20 border-b border-[var(--ink)]/[0.10] bg-[var(--sand)]/85 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-[860px] min-w-0 items-center justify-between gap-3 px-4 py-3 sm:px-8">
          <Link
            href="/leads"
            className="tabular min-w-0 truncate text-[10px] uppercase tracking-[0.24em] text-[var(--ink)]/50 transition hover:text-[var(--ink)]/80 sm:tracking-[0.35em]"
          >
            ← Leads
            <span className="mx-2 text-[var(--ink)]/25">/</span>
            <span className="text-[var(--ink)]/75">Flow</span>
          </Link>
          {workspaces.length > 1 ? (
            <select
              value={activeWorkspace?.id ?? ""}
              onChange={(e) => chooseWorkspace(e.target.value)}
              className="focus-cream tabular shrink-0 rounded-sm border border-[var(--ink)]/15 bg-transparent px-2 py-1.5 text-[10px] uppercase tracking-[0.18em] text-[var(--ink)]/65 outline-none hover:border-[var(--ink)]/35 focus:border-[var(--ink)]/35"
              title="Workspace"
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          ) : null}
        </div>
      </div>

      <div className="mx-auto w-full max-w-[860px] px-4 py-10 sm:px-8">
        <p className="tabular text-[10px] uppercase tracking-[0.32em] text-[var(--ink)]/40">
          Sådan løber et lead igennem
        </p>
        <h1 className="font-display mt-3 text-5xl italic leading-[0.95] tracking-[-0.02em] sm:text-6xl">
          {activeWorkspace?.name}
        </h1>

        <ol className="mt-12 border-l border-[var(--ink)]/15">
          {steps.map((step, i) => (
            <li key={step.key} className="relative pb-12 pl-8 last:pb-0">
              <span className="tabular absolute -left-[13px] top-0 flex h-[26px] w-[26px] items-center justify-center rounded-full border border-[var(--ink)]/20 bg-[var(--sand)] text-[10px] text-[var(--ink)]/60">
                {i + 1}
              </span>
              <div className="flex flex-wrap items-baseline gap-3">
                <h2 className="text-lg font-semibold tracking-[-0.01em]">{step.title}</h2>
                <span
                  className={`tabular rounded-sm border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.18em] ${
                    step.actor === "auto"
                      ? "border-[var(--forest)]/30 text-[var(--forest)]"
                      : "border-[var(--ink)]/20 text-[var(--ink)]/50"
                  }`}
                >
                  {step.actor === "auto" ? "Automatisk" : "Operatør"}
                </span>
              </div>
              <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-[var(--ink)]/70">
                {step.detail}
              </p>
              {step.branches ? (
                <ul className="mt-4 flex flex-col gap-3">
                  {step.branches.map((b) => (
                    <li
                      key={b.label}
                      className={`rounded-sm border px-4 py-3 ${
                        b.closes
                          ? "border-[var(--clay)]/30 bg-[var(--clay)]/[0.04]"
                          : "border-[var(--ink)]/10 bg-[var(--ink)]/[0.025]"
                      }`}
                    >
                      <p className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/60">
                        {b.label}
                        {b.closes ? <span className="ml-2 text-[var(--clay)]">· lukker</span> : null}
                      </p>
                      <p className="mt-1.5 max-w-[58ch] text-sm leading-relaxed text-[var(--ink)]/70">
                        {b.detail}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </main>
  );
}
