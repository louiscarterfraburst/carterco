"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/client";

const ALLOWED_EMAILS = ["louis@carterco.dk", "rm@tresyv.dk", "haugefrom@haugefrom.com"];

type Settings = {
  user_email: string;
  ical_url: string | null;
  business_hours_start: string;
  business_hours_end: string;
  business_days: number[];
  tz: string;
  slot_duration_minutes: number;
  suggest_count: number;
  suggest_lookahead_days: number;
  suggest_min_lead_hours: number;
  display_name: string | null;
  company_name: string | null;
  calendly_url: string | null;
  signoff: string | null;
  last_synced_at: string | null;
  last_sync_error: string | null;
};

const DAY_LABELS = ["Man", "Tir", "Ons", "Tor", "Fre", "Lør", "Søn"];

export default function SettingsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState(ALLOWED_EMAILS[0]);
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [s, setS] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    supabase.auth.getUser().then(({ data }) => {
      if (!mounted) return;
      setUser(data.user); setLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, ses) => {
      setUser(ses?.user ?? null);
    });
    return () => { mounted = false; subscription.unsubscribe(); };
  }, [supabase]);

  useEffect(() => { if (user) void load(); }, [user]); // eslint-disable-line

  async function load() {
    if (!user?.email) return;
    const { data, error } = await supabase.from("user_settings").select("*").eq("user_email", user.email).maybeSingle();
    if (error) { setErr(error.message); return; }
    setS(data ?? defaultSettings(user.email));
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!s) return;
    setBusy(true); setErr(null); setInfo(null);
    const { error } = await supabase.from("user_settings").upsert(s, { onConflict: "user_email" });
    setBusy(false);
    if (error) setErr(error.message);
    else { setInfo("Gemt."); await load(); }
  }

  async function syncNow() {
    if (!s) return;
    setBusy(true); setErr(null); setInfo(null);
    // Save first so cal-poll has the URL to fetch.
    const { error: saveErr } = await supabase.from("user_settings").upsert(s, { onConflict: "user_email" });
    if (saveErr) { setBusy(false); setErr(saveErr.message); return; }

    const { data, error } = await supabase.functions.invoke("cal-poll", { body: {} });
    setBusy(false);
    if (error) setErr(error.message ?? String(error));
    else {
      const mine = (data?.polled ?? []).find((p: { user: string }) => p.user === user?.email);
      if (mine?.error) setErr(`Sync fejlede: ${mine.error}`);
      else setInfo(`Hentet ${mine?.events ?? 0} events.`);
      await load();
    }
  }

  async function sendOtp(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setErr(null); setInfo(null);
    const t = email.trim().toLowerCase();
    if (!ALLOWED_EMAILS.includes(t)) { setErr("Ukendt e-mail."); return; }
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

  async function signOut() { await supabase.auth.signOut(); setUser(null); setS(null); }

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
        <div className="safe-screen relative mx-auto flex min-h-screen w-full max-w-md flex-col justify-between px-6 py-8 sm:py-10">
          <Link href="/" className="tabular text-[10px] uppercase tracking-[0.35em] text-[var(--ink)]/45 hover:text-[var(--ink)]/70">
            CarterCo · Settings
          </Link>
          <section>
            <h1 className="font-display mt-4 text-6xl italic leading-[0.9] tracking-[-0.02em] text-[var(--ink)] sm:text-7xl">Settings</h1>
            <form onSubmit={sendOtp} className="mt-10 flex flex-col gap-3">
              <label className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--ink)]/40">E-mail</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email"
                className="focus-orange border-b border-[var(--ink)]/15 bg-transparent py-3 text-base text-[var(--ink)] outline-none focus:border-[var(--forest)]" />
              <button type="submit" className="focus-orange mt-4 flex items-center justify-between rounded-sm bg-[var(--forest)] px-5 py-3.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--cream)] hover:bg-[#2f5e4e]">
                <span>Send login-link</span><span aria-hidden>→</span>
              </button>
            </form>
            <form onSubmit={verifyOtp} className="mt-8 flex flex-col gap-3">
              <label className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--ink)]/40">Eller indtast kode</label>
              <input type="text" value={token} onChange={(e) => setToken(e.target.value)} inputMode="numeric"
                autoComplete="one-time-code" placeholder="6-cifret"
                className="focus-cream tabular border-b border-[var(--ink)]/15 bg-transparent py-3 text-base text-[var(--ink)] outline-none placeholder:text-[var(--ink)]/25 focus:border-[var(--ink)]/45" />
              <button type="submit" className="focus-cream mt-2 self-start text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/70 hover:underline">Verificer →</button>
            </form>
            {info ? <p className="mt-8 border-l border-[var(--forest)]/50 pl-3 text-sm text-[var(--ink)]/70">{info}</p> : null}
            {err ? <p className="mt-8 border-l border-[var(--clay)]/50 pl-3 text-sm text-[var(--clay)]">{err}</p> : null}
          </section>
          <p className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--ink)]/25">{new Date().getFullYear()} · CarterCo</p>
        </div>
      </main>
    );
  }

  return (
    <main className="safe-screen safe-pad-bottom relative min-h-screen overflow-x-hidden bg-[var(--sand)] text-[var(--ink)]">
      <div className="grain-overlay" />

      <div className="safe-pad-top sticky top-0 z-20 border-b border-[var(--ink)]/[0.10] bg-[var(--sand)]/85 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-[800px] items-center justify-between gap-3 px-4 py-3 sm:px-8">
          <Link href="/" className="tabular truncate text-[10px] uppercase tracking-[0.24em] text-[var(--ink)]/50 hover:text-[var(--ink)]/80 sm:tracking-[0.35em]">
            CarterCo<span className="mx-2 text-[var(--ink)]/25">/</span><span className="text-[var(--ink)]/75">Settings</span>
          </Link>
          <button type="button" onClick={() => void signOut()}
            className="focus-cream tabular rounded-sm border border-[var(--ink)]/15 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/65 hover:border-[var(--ink)]/35 hover:text-[var(--ink)]">Log ud</button>
        </div>
      </div>

      <section className="mx-auto w-full max-w-[800px] px-4 pt-10 pb-6 sm:px-8 sm:pt-14">
        <p className="tabular text-[10px] uppercase tracking-[0.32em] text-[var(--ink)]/40">Indstillinger</p>
        <h1 className="font-display mt-2 text-[15vw] italic leading-[0.85] tracking-[-0.03em] text-[var(--ink)] sm:text-[88px]">Settings</h1>
      </section>

      {info ? <Banner kind="info">{info}</Banner> : null}
      {err ? <Banner kind="error">{err}</Banner> : null}

      <section className="mx-auto w-full max-w-[800px] px-4 pb-12 sm:px-8">
        {!s ? <p className="text-sm text-[var(--ink)]/45">Indlæser indstillinger…</p> : (
          <form onSubmit={save} className="flex flex-col gap-8">
            <div>
              <h2 className="tabular text-[11px] uppercase tracking-[0.28em] text-[var(--ink)]/55">Identitet</h2>
              <p className="mt-1 text-sm text-[var(--ink)]/55">
                Bruges i email- og SMS-skabeloner i /leads. F.eks. &ldquo;Hej {"{firstName}"}, det er {"{display_name}"} fra {"{company_name}"}…&rdquo; med {"/{signoff}"} til sidst.
              </p>
              <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Fornavn">
                  <input type="text" value={s.display_name ?? ""} onChange={(e) => setS({ ...s, display_name: e.target.value })}
                    placeholder="Louis"
                    className="focus-cream tabular w-full rounded-sm border border-[var(--ink)]/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--ink)]/35" />
                </Field>
                <Field label="Firma">
                  <input type="text" value={s.company_name ?? ""} onChange={(e) => setS({ ...s, company_name: e.target.value })}
                    placeholder="CarterCo"
                    className="focus-cream tabular w-full rounded-sm border border-[var(--ink)]/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--ink)]/35" />
                </Field>
                <Field label="Calendly-link">
                  <input type="url" value={s.calendly_url ?? ""} onChange={(e) => setS({ ...s, calendly_url: e.target.value })}
                    placeholder="https://calendly.com/dit-navn/30min"
                    className="focus-cream tabular w-full rounded-sm border border-[var(--ink)]/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--ink)]/35" />
                </Field>
                <Field label="Signatur (vises som /Navn)">
                  <input type="text" value={s.signoff ?? ""} onChange={(e) => setS({ ...s, signoff: e.target.value })}
                    placeholder="Louis"
                    className="focus-cream tabular w-full rounded-sm border border-[var(--ink)]/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--ink)]/35" />
                </Field>
              </div>
            </div>

            <div>
              <h2 className="tabular text-[11px] uppercase tracking-[0.28em] text-[var(--ink)]/55">Kalender (Google iCal)</h2>
              <p className="mt-1 text-sm text-[var(--ink)]/55">
                Hent din private iCal-URL i Google Calendar → Indstillinger → din kalender → <em>Hemmelig adresse i iCal-format</em>.
                Brug formatet <code>https://calendar.google.com/.../basic.ics</code>.
              </p>
              <input type="url" value={s.ical_url ?? ""} onChange={(e) => setS({ ...s, ical_url: e.target.value })}
                placeholder="https://calendar.google.com/calendar/ical/.../private-…/basic.ics"
                className="focus-cream tabular mt-3 w-full rounded-sm border border-[var(--ink)]/15 bg-transparent px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--ink)]/35" />
              <div className="mt-2 flex flex-wrap items-center gap-3 text-[12px] text-[var(--ink)]/55">
                <button type="button" disabled={busy || !s.ical_url} onClick={() => void syncNow()}
                  className="focus-cream tabular rounded-sm border border-[var(--ink)]/15 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/65 hover:border-[var(--ink)]/35 hover:text-[var(--ink)] disabled:opacity-40">
                  {busy ? "Synkroniserer…" : "Synkronisér nu"}
                </button>
                {s.last_synced_at ? <span>Senest: {new Date(s.last_synced_at).toLocaleString("da-DK")}</span> : null}
                {s.last_sync_error ? <span className="text-[var(--clay)]">Fejl: {s.last_sync_error}</span> : null}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Arbejdstid start">
                <input type="time" value={s.business_hours_start.slice(0,5)} onChange={(e) => setS({ ...s, business_hours_start: e.target.value + ":00" })}
                  className="focus-cream tabular w-full rounded-sm border border-[var(--ink)]/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--ink)]/35" />
              </Field>
              <Field label="Arbejdstid slut">
                <input type="time" value={s.business_hours_end.slice(0,5)} onChange={(e) => setS({ ...s, business_hours_end: e.target.value + ":00" })}
                  className="focus-cream tabular w-full rounded-sm border border-[var(--ink)]/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--ink)]/35" />
              </Field>
              <Field label="Mødelængde (min)">
                <input type="number" min={15} max={240} step={15} value={s.slot_duration_minutes} onChange={(e) => setS({ ...s, slot_duration_minutes: Number(e.target.value) })}
                  className="focus-cream tabular w-full rounded-sm border border-[var(--ink)]/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--ink)]/35" />
              </Field>
              <Field label="Antal forslag">
                <input type="number" min={1} max={5} value={s.suggest_count} onChange={(e) => setS({ ...s, suggest_count: Number(e.target.value) })}
                  className="focus-cream tabular w-full rounded-sm border border-[var(--ink)]/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--ink)]/35" />
              </Field>
              <Field label="Look-ahead (dage)">
                <input type="number" min={1} max={30} value={s.suggest_lookahead_days} onChange={(e) => setS({ ...s, suggest_lookahead_days: Number(e.target.value) })}
                  className="focus-cream tabular w-full rounded-sm border border-[var(--ink)]/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--ink)]/35" />
              </Field>
              <Field label="Min. forberedelse (timer)">
                <input type="number" min={0} max={48} value={s.suggest_min_lead_hours} onChange={(e) => setS({ ...s, suggest_min_lead_hours: Number(e.target.value) })}
                  className="focus-cream tabular w-full rounded-sm border border-[var(--ink)]/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--ink)]/35" />
              </Field>
            </div>

            <Field label="Arbejdsdage">
              <div className="flex flex-wrap gap-1.5">
                {DAY_LABELS.map((d, i) => {
                  const dayNum = i + 1;
                  const active = s.business_days.includes(dayNum);
                  return (
                    <button key={d} type="button"
                      onClick={() => {
                        const next = active ? s.business_days.filter((x) => x !== dayNum) : [...s.business_days, dayNum].sort();
                        setS({ ...s, business_days: next });
                      }}
                      className={`tabular rounded-sm border px-3 py-1.5 text-[11px] uppercase tracking-[0.22em] transition ${
                        active ? "border-[var(--forest)]/60 bg-[var(--forest)]/10 text-[var(--forest)]"
                               : "border-[var(--ink)]/15 text-[var(--ink)]/55 hover:border-[var(--ink)]/35"
                      }`}>{d}</button>
                  );
                })}
              </div>
            </Field>

            <div className="flex justify-end pt-2">
              <button type="submit" disabled={busy}
                className="focus-orange tabular rounded-sm bg-[var(--forest)] px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--cream)] hover:bg-[#2f5e4e] disabled:opacity-50">
                {busy ? "Gemmer…" : "Gem"}
              </button>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/45">{label}</label>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function Banner({ kind, children }: { kind: "info" | "error"; children: React.ReactNode }) {
  const color = kind === "error" ? "var(--clay)" : "var(--forest)";
  return (
    <section className="mx-auto mb-4 w-full max-w-[800px] px-4 sm:px-8">
      <p className="border-l pl-3 text-sm" style={{ borderColor: color, color: kind === "error" ? color : "rgb(0 0 0 / 0.7)" }}>{children}</p>
    </section>
  );
}

function defaultSettings(email: string): Settings {
  return {
    user_email: email,
    ical_url: null,
    business_hours_start: "09:00:00",
    business_hours_end: "17:00:00",
    business_days: [1, 2, 3, 4, 5],
    tz: "Europe/Copenhagen",
    slot_duration_minutes: 30,
    suggest_count: 3,
    suggest_lookahead_days: 7,
    suggest_min_lead_hours: 2,
    display_name: null,
    company_name: null,
    calendly_url: null,
    signoff: null,
    last_synced_at: null,
    last_sync_error: null,
  };
}
