"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/client";

const ALLOWED_EMAILS = ["louis@carterco.dk", "rm@tresyv.dk", "haugefrom@haugefrom.com"];

type PipelineRow = {
  sendpilot_lead_id: string;
  linkedin_url: string;
  contact_email: string;
  is_cold: boolean | null;
  status:
    | "invited"
    | "accepted"
    | "rendering"
    | "rendered"
    | "pending_approval"
    | "sent"
    | "rejected"
    | "failed";
  video_link: string | null;
  embed_link: string | null;
  thumbnail_url: string | null;
  rendered_message: string | null;
  invited_at: string | null;
  accepted_at: string | null;
  rendered_at: string | null;
  sent_at: string | null;
  queued_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  error: string | null;
  updated_at: string;
  lead?: { first_name: string | null; last_name: string | null; company: string | null; title: string | null; website: string | null };
};

export default function OutreachPage() {
  const supabase = useMemo(() => createClient(), []);
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState(ALLOWED_EMAILS[0]);
  const [token, setToken] = useState("");
  const [rows, setRows] = useState<PipelineRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyLead, setBusyLead] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ leadId: string; message: string } | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    supabase.auth.getUser().then(({ data }) => {
      if (!mounted) return;
      setUser(data.user);
      setLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => {
      setUser(s?.user ?? null);
    });
    return () => { mounted = false; subscription.unsubscribe(); };
  }, [supabase]);

  useEffect(() => { if (user) void load(); }, [user]); // eslint-disable-line

  async function load() {
    setErr(null);
    const { data, error } = await supabase
      .from("outreach_pipeline")
      .select("*, lead:outreach_leads!inner(first_name,last_name,company,title,website)")
      .order("updated_at", { ascending: false })
      .limit(500);
    if (error) {
      // The join via foreign key may not exist (we only have linkedin_url FK implicit).
      // Fall back: fetch pipeline + leads separately and merge.
      const { data: pipe, error: pipeErr } = await supabase
        .from("outreach_pipeline")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(500);
      if (pipeErr) { setErr(pipeErr.message); return; }
      const ids = (pipe ?? []).map((r) => r.contact_email).filter(Boolean);
      const { data: leads } = await supabase
        .from("outreach_leads")
        .select("contact_email, first_name, last_name, company, title, website")
        .in("contact_email", ids);
      const leadMap = new Map((leads ?? []).map((l) => [l.contact_email, l]));
      setRows(((pipe ?? []) as PipelineRow[]).map((r) => ({
        ...r, lead: leadMap.get(r.contact_email) as PipelineRow["lead"] ?? undefined,
      })));
      return;
    }
    setRows((data ?? []) as PipelineRow[]);
  }

  async function decide(leadId: string, decision: "approve" | "reject", messageOverride?: string) {
    setBusyLead(leadId); setErr(null); setInfo(null);
    const { data, error } = await supabase.functions.invoke("outreach-approve", {
      body: { leadId, decision, ...(messageOverride ? { messageOverride } : {}) },
    });
    setBusyLead(null);
    if (error) { setErr(error.message ?? String(error)); return; }
    if (data?.error) { setErr(`${data.error}${data.details ? `: ${data.details}` : ""}`); return; }
    setInfo(decision === "approve"
      ? data?.ok ? `Sendt (HTTP ${data.status}).` : `Send fejlede (HTTP ${data?.status}).`
      : "Afvist.");
    setEditing(null);
    await load();
  }

  async function sendOtp(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setErr(null); setInfo(null);
    const t = email.trim().toLowerCase();
    if (!ALLOWED_EMAILS.includes(t)) { setErr("Adgangskontrol: ukendt e-mail."); return; }
    const { error } = await supabase.auth.signInWithOtp({ email: t, options: { shouldCreateUser: false } });
    if (error) setErr(error.message); else setInfo("Tjek din mail for kode.");
  }

  async function verifyOtp(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setErr(null);
    const { error } = await supabase.auth.verifyOtp({
      email: email.trim().toLowerCase(), token: token.trim(), type: "email",
    });
    if (error) setErr(error.message); else { setToken(""); setInfo(null); }
  }

  async function signOut() {
    await supabase.auth.signOut();
    setUser(null); setRows([]);
  }

  const stats = useMemo(() => {
    const c = { total: rows.length, invited: 0, accepted: 0, rendering: 0, pending: 0, sent: 0, rejected: 0, failed: 0 };
    for (const r of rows) {
      if (r.status === "invited") c.invited++;
      else if (r.status === "accepted") c.accepted++;
      else if (r.status === "rendering" || r.status === "rendered") c.rendering++;
      else if (r.status === "pending_approval") c.pending++;
      else if (r.status === "sent") c.sent++;
      else if (r.status === "rejected") c.rejected++;
      else if (r.status === "failed") c.failed++;
    }
    return c;
  }, [rows]);

  const pending = rows.filter((r) => r.status === "pending_approval");
  const recent = rows.filter((r) => r.status === "sent" || r.status === "failed" || r.status === "rejected").slice(0, 30);

  if (loading) {
    return (
      <main className="safe-screen safe-pad-top safe-pad-bottom flex min-h-screen items-center justify-center bg-[var(--sand)] px-6 text-[var(--ink)]">
        <p className="tabular text-[11px] uppercase tracking-[0.4em] text-[var(--ink)]/40">Indlæser</p>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="safe-screen safe-pad-top safe-pad-bottom safe-px relative min-h-screen overflow-hidden bg-[var(--sand)] text-[var(--ink)]">
        <div className="grain-overlay" />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[60vh] bg-[radial-gradient(ellipse_at_top,rgba(185,112,65,0.14),transparent_60%)]" />
        <div className="safe-screen relative mx-auto flex min-h-screen w-full max-w-md min-w-0 flex-col justify-between px-6 py-8 sm:py-10">
          <Link href="/" className="tabular text-[10px] uppercase tracking-[0.35em] text-[var(--ink)]/45 hover:text-[var(--ink)]/70">
            CarterCo · Outreach
          </Link>
          <section>
            <p className="tabular text-[10px] uppercase tracking-[0.32em] text-[var(--ink)]/40">Privat arbejdsrum</p>
            <h1 className="font-display mt-4 text-6xl italic leading-[0.9] tracking-[-0.02em] text-[var(--ink)] sm:text-7xl">Outreach</h1>
            <p className="mt-6 max-w-xs text-sm leading-relaxed text-[var(--ink)]/55">Godkend eller afvis personaliserede beskeder før de sendes.</p>
            <form onSubmit={sendOtp} className="mt-10 flex flex-col gap-3">
              <label className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--ink)]/40">E-mail</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email"
                className="focus-orange border-b border-[var(--ink)]/15 bg-transparent py-3 text-base text-[var(--ink)] outline-none transition focus:border-[var(--forest)]" />
              <button type="submit"
                className="focus-orange mt-4 flex items-center justify-between rounded-sm bg-[var(--forest)] px-5 py-3.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--cream)] transition hover:bg-[#2f5e4e]">
                <span>Send login-link</span><span aria-hidden>→</span>
              </button>
            </form>
            <form onSubmit={verifyOtp} className="mt-8 flex flex-col gap-3">
              <label className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--ink)]/40">Eller indtast kode</label>
              <input type="text" value={token} onChange={(e) => setToken(e.target.value)} inputMode="numeric"
                autoComplete="one-time-code" placeholder="6-cifret"
                className="focus-cream tabular border-b border-[var(--ink)]/15 bg-transparent py-3 text-base text-[var(--ink)] outline-none transition placeholder:text-[var(--ink)]/25 focus:border-[var(--ink)]/45" />
              <button type="submit" className="focus-cream mt-2 self-start text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/70 underline-offset-[6px] hover:text-[var(--ink)] hover:underline">Verificer →</button>
            </form>
            {info ? <p className="mt-8 border-l border-[var(--forest)]/50 pl-3 text-sm text-[var(--ink)]/70">{info}</p> : null}
            {err ? <p className="mt-8 border-l border-[var(--clay)]/50 pl-3 text-sm text-[var(--clay)]">{err}</p> : null}
          </section>
          <p className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--ink)]/25">{new Date().getFullYear()} · CarterCo Outreach</p>
        </div>
      </main>
    );
  }

  return (
    <main className="safe-screen safe-pad-bottom relative min-h-screen overflow-x-hidden bg-[var(--sand)] text-[var(--ink)]">
      <div className="grain-overlay" />

      <div className="safe-pad-top sticky top-0 z-20 border-b border-[var(--ink)]/[0.10] bg-[var(--sand)]/85 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-[1400px] items-center justify-between gap-3 px-4 py-3 sm:gap-4 sm:px-8 lg:px-12">
          <Link href="/" className="tabular truncate text-[10px] uppercase tracking-[0.24em] text-[var(--ink)]/50 hover:text-[var(--ink)]/80 sm:tracking-[0.35em]">
            CarterCo<span className="mx-2 text-[var(--ink)]/25">/</span><span className="text-[var(--ink)]/75">Outreach</span>
          </Link>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" onClick={() => void load()}
              className="focus-cream tabular rounded-sm border border-[var(--ink)]/15 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/65 hover:border-[var(--ink)]/35 hover:text-[var(--ink)]">
              Opdater
            </button>
            <button type="button" onClick={() => void signOut()}
              className="focus-cream tabular rounded-sm border border-[var(--ink)]/15 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/65 hover:border-[var(--ink)]/35 hover:text-[var(--ink)]">
              Log ud
            </button>
          </div>
        </div>
      </div>

      <section className="mx-auto w-full max-w-[1400px] px-4 pt-10 pb-8 sm:px-8 sm:pt-16 lg:px-12">
        <p className="tabular text-[10px] uppercase tracking-[0.32em] text-[var(--ink)]/40">Status</p>
        <h1 className="font-display mt-2 text-[15vw] italic leading-[0.85] tracking-[-0.03em] text-[var(--ink)] sm:text-[96px]">Outreach</h1>

        <dl className="mt-8 grid grid-cols-3 gap-4 text-sm sm:grid-cols-7 sm:gap-8">
          <Stat label="Inviteret" value={stats.invited} />
          <Stat label="Accept" value={stats.accepted} />
          <Stat label="Render" value={stats.rendering} />
          <Stat label="Afventer" value={stats.pending} accent />
          <Stat label="Sendt" value={stats.sent} />
          <Stat label="Afvist" value={stats.rejected} />
          <Stat label="Fejl" value={stats.failed} />
        </dl>
      </section>

      {info ? <Banner kind="info">{info}</Banner> : null}
      {err ? <Banner kind="error">{err}</Banner> : null}

      <section className="mx-auto w-full max-w-[1400px] px-4 pb-12 sm:px-8 lg:px-12">
        <h2 className="tabular text-[11px] uppercase tracking-[0.28em] text-[var(--ink)]/55">Afventer godkendelse <span className="text-[var(--ink)]/35">({pending.length})</span></h2>
        {pending.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--ink)]/45">Ingen ventende beskeder.</p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {pending.map((r) => {
              const isEditing = editing?.leadId === r.sendpilot_lead_id;
              const message = isEditing ? editing.message : r.rendered_message ?? "";
              return (
                <li key={r.sendpilot_lead_id}
                    className="rounded-sm border border-[var(--ink)]/12 bg-[var(--cream)]/40 p-4 sm:p-6">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="font-display text-2xl italic leading-tight tracking-tight text-[var(--ink)]">
                        {r.lead?.first_name} {r.lead?.last_name}
                      </div>
                      <div className="tabular mt-1 text-[12px] text-[var(--ink)]/60">
                        {r.lead?.company} · <a href={r.linkedin_url} target="_blank" rel="noreferrer"
                          className="underline underline-offset-2 hover:text-[var(--ink)]">LinkedIn ↗</a>
                      </div>
                      <div className="tabular mt-0.5 text-[11px] text-[var(--ink)]/40">
                        Køet {fmt(r.queued_at ?? r.rendered_at)} · {r.lead?.title?.slice(0, 80)}
                      </div>
                    </div>
                    {r.video_link ? (
                      <a href={r.video_link} target="_blank" rel="noreferrer"
                         className="focus-orange tabular rounded-sm border border-[var(--ink)]/15 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/65 hover:border-[var(--ink)]/35 hover:text-[var(--ink)]">
                        Se video ↗
                      </a>
                    ) : null}
                  </div>

                  <textarea
                    value={message}
                    onChange={(e) => setEditing({ leadId: r.sendpilot_lead_id, message: e.target.value })}
                    rows={Math.max(6, message.split("\n").length + 1)}
                    className="focus-cream mt-4 w-full resize-y rounded-sm border border-[var(--ink)]/12 bg-[var(--sand)] p-3 text-sm leading-relaxed text-[var(--ink)] outline-none focus:border-[var(--ink)]/35"
                  />

                  <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                    <button type="button" disabled={busyLead === r.sendpilot_lead_id}
                      onClick={() => void decide(r.sendpilot_lead_id, "reject")}
                      className="focus-cream tabular rounded-sm border border-[var(--clay)]/40 px-4 py-2 text-[11px] uppercase tracking-[0.22em] text-[var(--clay)] hover:bg-[var(--clay)]/5 disabled:opacity-40">
                      Afvis
                    </button>
                    <button type="button" disabled={busyLead === r.sendpilot_lead_id}
                      onClick={() => void decide(r.sendpilot_lead_id, "approve", isEditing ? editing.message : undefined)}
                      className="focus-orange tabular rounded-sm bg-[var(--forest)] px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--cream)] hover:bg-[#2f5e4e] disabled:opacity-50">
                      {busyLead === r.sendpilot_lead_id ? "Sender…" : "Godkend & send"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <h2 className="tabular mt-12 text-[11px] uppercase tracking-[0.28em] text-[var(--ink)]/55">Senest behandlet <span className="text-[var(--ink)]/35">({recent.length})</span></h2>
        {recent.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--ink)]/45">Endnu intet sendt.</p>
        ) : (
          <ul className="mt-4 flex flex-col divide-y divide-[var(--ink)]/8 border-y border-[var(--ink)]/8">
            {recent.map((r) => (
              <li key={r.sendpilot_lead_id} className="grid grid-cols-12 gap-3 py-3 text-sm">
                <span className="col-span-3 sm:col-span-2 tabular text-[12px] text-[var(--ink)]/55">{fmt(r.sent_at ?? r.decided_at ?? r.updated_at)}</span>
                <span className="col-span-3 sm:col-span-2 truncate"><StatusPill status={r.status} /></span>
                <span className="col-span-6 sm:col-span-3 truncate text-[var(--ink)]/80">{r.lead?.first_name} {r.lead?.last_name}</span>
                <span className="hidden sm:block sm:col-span-3 truncate text-[var(--ink)]/60">{r.lead?.company}</span>
                <span className="col-span-12 sm:col-span-2 truncate text-[12px] text-[var(--ink)]/45">{r.error ?? r.decided_by ?? ""}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function Stat({ label, value, accent = false }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div>
      <dd className={`font-display text-3xl italic leading-tight tracking-tight ${accent ? "text-[var(--clay)]" : "text-[var(--ink)]"}`}>{value}</dd>
      <dt className="tabular mt-1 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/45">{label}</dt>
    </div>
  );
}

function Banner({ kind, children }: { kind: "info" | "error"; children: React.ReactNode }) {
  const color = kind === "error" ? "var(--clay)" : "var(--forest)";
  return (
    <section className="mx-auto mb-5 w-full max-w-[1400px] px-4 sm:px-8 lg:px-12">
      <p className="border-l pl-3 text-sm" style={{ borderColor: `${color}` , color: kind === "error" ? color : "rgb(0 0 0 / 0.7)" }}>{children}</p>
    </section>
  );
}

function StatusPill({ status }: { status: PipelineRow["status"] }) {
  const map: Record<PipelineRow["status"], { label: string; bg: string; fg: string }> = {
    invited: { label: "Inviteret", bg: "rgb(0 0 0 / .06)", fg: "rgb(0 0 0 / .55)" },
    accepted: { label: "Accept", bg: "rgb(0 0 0 / .06)", fg: "rgb(0 0 0 / .55)" },
    rendering: { label: "Render", bg: "rgb(0 0 0 / .06)", fg: "rgb(0 0 0 / .55)" },
    rendered: { label: "Klar", bg: "rgb(0 0 0 / .06)", fg: "rgb(0 0 0 / .55)" },
    pending_approval: { label: "Afventer", bg: "rgba(185,112,65,0.14)", fg: "var(--clay)" },
    sent: { label: "Sendt", bg: "rgba(35,90,67,0.14)", fg: "var(--forest)" },
    rejected: { label: "Afvist", bg: "rgb(0 0 0 / .06)", fg: "rgb(0 0 0 / .45)" },
    failed: { label: "Fejl", bg: "rgba(185,112,65,0.14)", fg: "var(--clay)" },
  };
  const s = map[status];
  return (
    <span className="tabular inline-block rounded-sm px-2 py-0.5 text-[10px] uppercase tracking-[0.18em]"
          style={{ background: s.bg, color: s.fg }}>{s.label}</span>
  );
}

function fmt(ts: string | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString("da-DK", { dateStyle: "short", timeStyle: "short" });
}
