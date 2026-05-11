"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/client";
import { useWorkspace } from "@/utils/workspace";

type TrackedCompany = {
  id: string;
  workspace_id: string;
  name: string;
  domain: string | null;
  careers_url: string;
  contact_person_name: string | null;
  contact_person_linkedin_url: string | null;
  contact_person_email: string | null;
  added_by: string | null;
  added_at: string;
  last_polled_at: string | null;
  last_poll_status: string | null;
  last_poll_error: string | null;
};

type JobPosting = {
  id: string;
  workspace_id: string;
  tracked_company_id: string;
  title: string;
  snippet: string | null;
  source_url: string | null;
  first_seen_at: string;
  last_seen_at: string;
  closed_at: string | null;
};

type Tab = "postings" | "companies";

export default function HiringPage() {
  const supabase = useMemo(() => createClient(), []);
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const { workspace, workspaces, loading: workspaceLoading } = useWorkspace(supabase, user);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(() =>
    typeof window === "undefined" ? "" : window.localStorage.getItem("hiring_workspace_id") ?? "",
  );
  const [companies, setCompanies] = useState<TrackedCompany[]>([]);
  const [postings, setPostings] = useState<JobPosting[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("postings");

  const activeWorkspace = useMemo(() => {
    if (!workspaces.length) return null;
    return workspaces.find((w) => w.id === selectedWorkspaceId) ?? workspace ?? workspaces[0];
  }, [selectedWorkspaceId, workspace, workspaces]);
  const activeWorkspaceId = activeWorkspace?.id ?? "";

  function chooseWorkspace(id: string) {
    setSelectedWorkspaceId(id);
    if (typeof window !== "undefined") window.localStorage.setItem("hiring_workspace_id", id);
  }

  useEffect(() => {
    let mounted = true;
    supabase.auth.getUser().then(({ data }) => {
      if (!mounted) return;
      setUser(data.user); setLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setUser(s?.user ?? null));
    return () => { mounted = false; subscription.unsubscribe(); };
  }, [supabase]);

  const load = useCallback(async () => {
    setErr(null);
    if (!activeWorkspaceId) return;
    const [{ data: cs, error: cErr }, { data: ps, error: pErr }] = await Promise.all([
      supabase.from("tracked_companies").select("*").eq("workspace_id", activeWorkspaceId).order("name"),
      supabase.from("job_postings").select("*").eq("workspace_id", activeWorkspaceId)
        .is("closed_at", null).order("first_seen_at", { ascending: false }).limit(200),
    ]);
    if (cErr) { setErr(cErr.message); return; }
    if (pErr) { setErr(pErr.message); return; }
    setCompanies((cs ?? []) as TrackedCompany[]);
    setPostings((ps ?? []) as JobPosting[]);
  }, [activeWorkspaceId, supabase]);

  useEffect(() => { if (user && activeWorkspaceId) void load(); }, [user, activeWorkspaceId, load]);

  useEffect(() => {
    if (!user || !activeWorkspaceId) return;
    const filter = `workspace_id=eq.${activeWorkspaceId}`;
    const ch = supabase
      .channel(`hiring-live-${activeWorkspaceId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "job_postings", filter }, () => void load())
      .on("postgres_changes", { event: "*", schema: "public", table: "tracked_companies", filter }, () => void load())
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [user, activeWorkspaceId, supabase, load]);

  async function pollNow() {
    setBusy(true); setErr(null); setInfo(null);
    const { data, error } = await supabase.functions.invoke("track-job-postings", { body: {} });
    setBusy(false);
    if (error) { setErr(error.message ?? String(error)); return; }
    if (data?.error) { setErr(String(data.error)); return; }
    setInfo(`Pollet ${data?.polled ?? 0} virksomheder.`);
    await load();
  }

  async function addCompany(form: NewCompanyForm) {
    setBusy(true); setErr(null); setInfo(null);
    const payload = {
      workspace_id: activeWorkspaceId,
      name: form.name.trim(),
      careers_url: form.careersUrl.trim(),
      domain: form.domain.trim() || null,
      contact_person_name: form.contactName.trim() || null,
      contact_person_linkedin_url: form.contactLinkedinUrl.trim() || null,
      contact_person_email: form.contactEmail.trim() || null,
      added_by: user?.email ?? null,
    };
    const { error } = await supabase.from("tracked_companies").insert(payload);
    setBusy(false);
    if (error) { setErr(error.message); return false; }
    setInfo(`${form.name} tilføjet.`);
    await load();
    return true;
  }

  async function removeCompany(id: string, name: string) {
    if (!confirm(`Fjern ${name} fra trackede virksomheder?`)) return;
    const { error } = await supabase.from("tracked_companies").delete().eq("id", id);
    if (error) setErr(error.message); else { setInfo(`${name} fjernet.`); await load(); }
  }

  async function sendOtp(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setErr(null); setInfo(null);
    const t = email.trim().toLowerCase();
    if (!t) { setErr("Indtast din e-mail."); return; }
    const { error } = await supabase.auth.signInWithOtp({ email: t, options: { shouldCreateUser: true } });
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
    setUser(null); setCompanies([]); setPostings([]);
  }

  const companyById = useMemo(() => new Map(companies.map((c) => [c.id, c])), [companies]);

  if (loading) {
    return (
      <main className="safe-screen flex min-h-screen items-center justify-center bg-[var(--sand)] px-6 text-[var(--ink)]">
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
            CarterCo · Hiring
          </Link>
          <section>
            <p className="tabular text-[10px] uppercase tracking-[0.32em] text-[var(--ink)]/40">Privat arbejdsrum</p>
            <h1 className="font-display mt-4 text-6xl italic leading-[0.9] tracking-[-0.02em] text-[var(--ink)] sm:text-7xl">Hiring</h1>
            <p className="mt-6 max-w-xs text-sm leading-relaxed text-[var(--ink)]/55">
              Notifikation når en sporet virksomhed slår en stilling op.
            </p>
            <form onSubmit={sendOtp} className="mt-10 flex flex-col gap-3">
              <label className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--ink)]/40">E-mail</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email"
                className="focus-orange border-b border-[var(--ink)]/15 bg-transparent py-3 text-base text-[var(--ink)] outline-none transition focus:border-[var(--forest)]" />
              <button type="submit" className="focus-orange mt-4 flex items-center justify-between rounded-sm bg-[var(--forest)] px-5 py-3.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--cream)] transition hover:bg-[#2f5e4e]">
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
          <p className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--ink)]/25">{new Date().getFullYear()} · CarterCo Hiring</p>
        </div>
      </main>
    );
  }

  if (!workspaceLoading && !activeWorkspace) {
    return (
      <main className="safe-screen safe-pad-top safe-pad-bottom safe-px relative min-h-screen overflow-hidden bg-[var(--sand)] text-[var(--ink)]">
        <div className="grain-overlay" />
        <div className="relative mx-auto flex min-h-screen w-full max-w-md flex-col justify-between px-6 py-8 sm:py-10">
          <Link href="/" className="tabular text-[10px] uppercase tracking-[0.35em] text-[var(--ink)]/45">CarterCo · Hiring</Link>
          <section>
            <p className="tabular text-[10px] uppercase tracking-[0.32em] text-[var(--ink)]/40">Ingen workspace</p>
            <h1 className="font-display mt-4 text-5xl italic leading-[0.9] tracking-[-0.02em] text-[var(--ink)]">Adgang afventer</h1>
            <p className="mt-6 max-w-xs text-sm leading-relaxed text-[var(--ink)]/55">
              Din e-mail er ikke tilknyttet noget workspace endnu. Kontakt support, så får du adgang.
            </p>
            <button onClick={() => void signOut()} className="focus-cream mt-8 tabular text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/70 hover:underline">Log ud →</button>
          </section>
          <p className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--ink)]/25">{user.email}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="safe-screen safe-pad-bottom relative min-h-screen overflow-x-hidden bg-[var(--sand)] text-[var(--ink)]">
      <div className="grain-overlay" />

      <div className="safe-pad-top sticky top-0 z-20 border-b border-[var(--ink)]/[0.10] bg-[var(--sand)]/85 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-[1400px] items-center justify-between gap-3 px-4 py-3 sm:gap-4 sm:px-8 lg:px-12">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/" className="tabular truncate text-[10px] uppercase tracking-[0.24em] text-[var(--ink)]/50 hover:text-[var(--ink)]/80 sm:tracking-[0.35em]">
              CarterCo<span className="mx-2 text-[var(--ink)]/25">/</span><span className="text-[var(--ink)]/75">Hiring</span>
            </Link>
            {workspaces.length > 1 ? (
              <select value={activeWorkspace?.id ?? ""} onChange={(e) => chooseWorkspace(e.target.value)}
                className="focus-cream tabular rounded-sm border border-[var(--ink)]/15 bg-transparent px-2 py-1.5 text-[10px] uppercase tracking-[0.18em] text-[var(--ink)]/65 outline-none hover:border-[var(--ink)]/35 focus:border-[var(--ink)]/35">
                {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button onClick={() => void pollNow()} disabled={busy}
              className="focus-cream tabular rounded-sm border border-[var(--ink)]/15 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/65 hover:border-[var(--ink)]/35 hover:text-[var(--ink)] disabled:opacity-50">
              {busy ? "Poller…" : "Poll nu"}
            </button>
            <button onClick={() => void load()}
              className="focus-cream tabular rounded-sm border border-[var(--ink)]/15 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/65 hover:border-[var(--ink)]/35 hover:text-[var(--ink)]">Opdater</button>
            <button onClick={() => void signOut()}
              className="focus-cream tabular rounded-sm border border-[var(--ink)]/15 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/65 hover:border-[var(--ink)]/35 hover:text-[var(--ink)]">Log ud</button>
          </div>
        </div>
      </div>

      <section className="mx-auto w-full max-w-[1400px] px-4 pt-10 pb-6 sm:px-8 sm:pt-14 lg:px-12">
        <p className="tabular text-[10px] uppercase tracking-[0.32em] text-[var(--ink)]/40">Signal</p>
        <h1 className="font-display mt-2 text-[15vw] italic leading-[0.85] tracking-[-0.03em] text-[var(--ink)] sm:text-[88px]">
          Hiring
        </h1>
        <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          <Stat label="Virksomheder" value={companies.length} />
          <Stat label="Åbne stillinger" value={postings.length} />
          <Stat label="Sidste poll" value={lastPolledLabel(companies)} />
          <Stat label="Fejl" value={companies.filter((c) => c.last_poll_status === "error").length} />
        </dl>
      </section>

      {info ? <Banner kind="info">{info}</Banner> : null}
      {err ? <Banner kind="error">{err}</Banner> : null}

      <div className="mx-auto w-full max-w-[1400px] border-b border-[var(--ink)]/[0.10] px-4 sm:px-8 lg:px-12">
        <div className="flex items-center gap-1">
          <TabBtn active={tab === "postings"} onClick={() => setTab("postings")}>Stillinger ({postings.length})</TabBtn>
          <TabBtn active={tab === "companies"} onClick={() => setTab("companies")}>Virksomheder ({companies.length})</TabBtn>
        </div>
      </div>

      <section className="mx-auto w-full max-w-[1400px] px-4 pb-12 pt-6 sm:px-8 lg:px-12">
        {tab === "postings"
          ? <PostingsTab postings={postings} companyById={companyById} />
          : <CompaniesTab companies={companies} postings={postings} onAdd={addCompany} onRemove={removeCompany} busy={busy} />}
      </section>
    </main>
  );
}

// ---------- subcomponents ----------

function PostingsTab({ postings, companyById }: {
  postings: JobPosting[];
  companyById: Map<string, TrackedCompany>;
}) {
  if (postings.length === 0) {
    return <Empty>Ingen åbne stillinger lige nu. Tilføj virksomheder under fanen Virksomheder.</Empty>;
  }
  return (
    <ul className="divide-y divide-[var(--ink)]/[0.08]">
      {postings.map((p) => {
        const c = companyById.get(p.tracked_company_id);
        const company = c?.name ?? "?";
        const contact = c?.contact_person_name;
        const contactLink = c?.contact_person_linkedin_url || (c?.contact_person_email ? `mailto:${c.contact_person_email}` : null);
        return (
          <li key={p.id} className="py-5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="tabular text-[10px] uppercase tracking-[0.2em] text-[var(--ink)]/50">{company}</span>
              <span className="tabular text-[10px] uppercase tracking-[0.18em] text-[var(--ink)]/35">{relativeTime(p.first_seen_at)}</span>
            </div>
            <h3 className="font-display mt-1 text-2xl italic leading-tight tracking-[-0.01em] text-[var(--ink)]">{p.title}</h3>
            {p.snippet ? <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--ink)]/65">{p.snippet}</p> : null}
            <div className="mt-3 flex flex-wrap gap-3">
              {p.source_url ? (
                <a href={p.source_url} target="_blank" rel="noopener noreferrer"
                  className="tabular text-[11px] uppercase tracking-[0.2em] text-[var(--forest)] underline-offset-[6px] hover:underline">
                  Åbn opslag →
                </a>
              ) : null}
              {contact && contactLink ? (
                <a href={contactLink} target={contactLink.startsWith("http") ? "_blank" : undefined}
                  rel="noopener noreferrer"
                  className="tabular text-[11px] uppercase tracking-[0.2em] text-[var(--clay)] underline-offset-[6px] hover:underline">
                  Ping {contact} →
                </a>
              ) : contact ? (
                <span className="tabular text-[11px] uppercase tracking-[0.2em] text-[var(--ink)]/45">Kontakt: {contact}</span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

type NewCompanyForm = {
  name: string; careersUrl: string; domain: string;
  contactName: string; contactLinkedinUrl: string; contactEmail: string;
};

function CompaniesTab({ companies, postings, onAdd, onRemove, busy }: {
  companies: TrackedCompany[];
  postings: JobPosting[];
  onAdd: (f: NewCompanyForm) => Promise<boolean>;
  onRemove: (id: string, name: string) => Promise<void>;
  busy: boolean;
}) {
  const [form, setForm] = useState<NewCompanyForm>({
    name: "", careersUrl: "", domain: "",
    contactName: "", contactLinkedinUrl: "", contactEmail: "",
  });
  const openCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of postings) m.set(p.tracked_company_id, (m.get(p.tracked_company_id) ?? 0) + 1);
    return m;
  }, [postings]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!form.name.trim() || !form.careersUrl.trim()) return;
    const ok = await onAdd(form);
    if (ok) setForm({ name: "", careersUrl: "", domain: "", contactName: "", contactLinkedinUrl: "", contactEmail: "" });
  }

  return (
    <div className="grid grid-cols-1 gap-10 lg:grid-cols-[2fr_1fr]">
      <div>
        {companies.length === 0 ? (
          <Empty>Ingen virksomheder endnu. Tilføj den første i formularen til højre.</Empty>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--ink)]/[0.10] text-left">
                <Th>Virksomhed</Th>
                <Th>Careers URL</Th>
                <Th>Åbne</Th>
                <Th>Sidste poll</Th>
                <Th>Status</Th>
                <Th>Kontakt</Th>
                <Th> </Th>
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.id} className="border-b border-[var(--ink)]/[0.06] align-top">
                  <Td><span className="font-medium text-[var(--ink)]">{c.name}</span></Td>
                  <Td>
                    <a href={c.careers_url} target="_blank" rel="noopener noreferrer"
                      className="text-[var(--forest)] underline underline-offset-[3px] hover:opacity-80">
                      {hostnameOf(c.careers_url)}
                    </a>
                  </Td>
                  <Td>{openCount.get(c.id) ?? 0}</Td>
                  <Td className="tabular text-[11px] text-[var(--ink)]/55">
                    {c.last_polled_at ? relativeTime(c.last_polled_at) : "—"}
                  </Td>
                  <Td>
                    {c.last_poll_status === "error"
                      ? <span title={c.last_poll_error ?? ""} className="tabular text-[11px] text-[var(--clay)]">fejl</span>
                      : c.last_poll_status === "ok"
                        ? <span className="tabular text-[11px] text-[var(--forest)]">ok</span>
                        : <span className="tabular text-[11px] text-[var(--ink)]/40">—</span>}
                  </Td>
                  <Td>{c.contact_person_name ?? <span className="text-[var(--ink)]/35">—</span>}</Td>
                  <Td>
                    <button onClick={() => void onRemove(c.id, c.name)}
                      className="tabular text-[11px] uppercase tracking-[0.18em] text-[var(--ink)]/45 hover:text-[var(--clay)]">
                      Fjern
                    </button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <form onSubmit={submit} className="rounded-sm border border-[var(--ink)]/15 p-5">
        <h3 className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--ink)]/55">Tilføj virksomhed</h3>
        <Field label="Navn" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
        <Field label="Careers URL" value={form.careersUrl} onChange={(v) => setForm({ ...form, careersUrl: v })} required type="url"
          placeholder="https://acme.dk/karriere" />
        <Field label="Domæne (valgfrit)" value={form.domain} onChange={(v) => setForm({ ...form, domain: v })}
          placeholder="acme.dk" />
        <div className="mt-4 border-t border-[var(--ink)]/[0.08] pt-4">
          <p className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/40">Kontakt at pinge</p>
          <Field label="Navn" value={form.contactName} onChange={(v) => setForm({ ...form, contactName: v })} />
          <Field label="LinkedIn" value={form.contactLinkedinUrl} onChange={(v) => setForm({ ...form, contactLinkedinUrl: v })}
            placeholder="https://linkedin.com/in/…" />
          <Field label="E-mail" value={form.contactEmail} onChange={(v) => setForm({ ...form, contactEmail: v })} type="email" />
        </div>
        <button type="submit" disabled={busy || !form.name.trim() || !form.careersUrl.trim()}
          className="focus-orange mt-5 w-full rounded-sm bg-[var(--forest)] px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--cream)] transition hover:bg-[#2f5e4e] disabled:opacity-40">
          Tilføj
        </button>
      </form>
    </div>
  );
}

function Field({ label, value, onChange, required, type = "text", placeholder }: {
  label: string; value: string; onChange: (v: string) => void;
  required?: boolean; type?: string; placeholder?: string;
}) {
  return (
    <label className="mt-3 block">
      <span className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/45">{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} required={required} placeholder={placeholder}
        className="focus-cream mt-1 w-full border-b border-[var(--ink)]/15 bg-transparent py-2 text-sm text-[var(--ink)] outline-none transition focus:border-[var(--ink)]/45 placeholder:text-[var(--ink)]/25" />
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/40">{label}</dt>
      <dd className="font-display text-3xl italic leading-tight tracking-tight text-[var(--ink)]">{value}</dd>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`tabular -mb-px border-b-2 px-3 py-3 text-[11px] uppercase tracking-[0.22em] transition ${
        active
          ? "border-[var(--ink)] text-[var(--ink)]"
          : "border-transparent text-[var(--ink)]/45 hover:text-[var(--ink)]/75"
      }`}>{children}</button>
  );
}

function Banner({ kind, children }: { kind: "info" | "error"; children: React.ReactNode }) {
  const color = kind === "error" ? "var(--clay)" : "var(--forest)";
  return (
    <section className="mx-auto mb-3 w-full max-w-[1400px] px-4 sm:px-8 lg:px-12">
      <p className="border-l pl-3 text-sm" style={{ borderColor: color, color: kind === "error" ? color : "rgb(0 0 0 / 0.7)" }}>{children}</p>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="tabular py-12 text-center text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/35">{children}</p>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="tabular px-3 py-3 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/45">{children}</th>;
}
function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-3 ${className}`}>{children}</td>;
}

// ---------- helpers ----------

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "lige nu";
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} t`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d} d`;
  return new Date(iso).toLocaleDateString("da-DK", { day: "numeric", month: "short" });
}

function lastPolledLabel(companies: TrackedCompany[]): string {
  const stamps = companies.map((c) => c.last_polled_at).filter((s): s is string => !!s);
  if (!stamps.length) return "—";
  const latest = stamps.sort().reverse()[0];
  return relativeTime(latest);
}

function hostnameOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}
