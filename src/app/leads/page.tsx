"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/client";

type Lead = {
  id: string;
  created_at: string;
  name: string;
  company: string;
  email: string;
  phone: string;
  monthly_leads: string;
  response_time: string;
};

type NotificationStatus =
  | "Ikke aktiv"
  | "Installer appen"
  | "Ikke understøttet"
  | "Blokeret"
  | "Beder om adgang"
  | "Gemmer"
  | "Aktiv";

const allowedEmail = "louis@carterco.dk";
const vapidPublicKey =
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ??
  "BHu6uhde8dpGML_i2Q0iQ_mU1heEp9FCxoB-wG9bAuUcu8PruD78-eBLoZhWvgy46xSXW7KSHXOlwg67ekFXADU";

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
        "id, created_at, name, company, email, phone, monthly_leads, response_time",
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
      options: {
        shouldCreateUser: false,
      },
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

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#0f0d0a] px-6 text-[var(--cream)]">
        <p className="text-xs font-bold uppercase tracking-[0.3em] text-[var(--cream)]/50">
          Indlæser
        </p>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="min-h-screen bg-[#0f0d0a] px-6 py-8 text-[var(--cream)]">
        <section className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-sm flex-col justify-center">
          <Link
            href="/"
            className="mb-10 text-xs font-bold uppercase tracking-[0.25em] text-[var(--cream)]/45"
          >
            CarterCo
          </Link>
          <h1 className="font-display text-5xl leading-none tracking-tight">
            Leads
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-[var(--cream)]/60">
            Log ind for at se nye leads og ringe direkte fra mobilen.
          </p>

          <form onSubmit={sendLink} className="mt-10 flex flex-col gap-4">
            <label className="text-xs font-bold uppercase tracking-[0.25em] text-[var(--cream)]/45">
              E-mail
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              className="rounded-xl border border-[var(--cream)]/15 bg-black/25 px-4 py-4 text-base text-[var(--cream)] outline-none transition focus:border-[#ff6b2c]"
            />
            <button
              type="submit"
              className="rounded-full bg-[#ff6b2c] px-6 py-4 text-xs font-bold uppercase tracking-[0.25em] text-[#0f0d0a]"
            >
              Send login
            </button>
          </form>

          <form onSubmit={verifyCode} className="mt-8 flex flex-col gap-4">
            <label className="text-xs font-bold uppercase tracking-[0.25em] text-[var(--cream)]/45">
              Kode
            </label>
            <input
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="6-cifret kode"
              className="rounded-xl border border-[var(--cream)]/15 bg-black/25 px-4 py-4 text-base text-[var(--cream)] outline-none transition placeholder:text-[var(--cream)]/25 focus:border-[#ff6b2c]"
            />
            <button
              type="submit"
              className="rounded-full border border-[var(--cream)]/15 px-6 py-4 text-xs font-bold uppercase tracking-[0.25em] text-[var(--cream)]/80"
            >
              Brug kode
            </button>
          </form>

          {message ? (
            <p className="mt-6 rounded-xl border border-[#ff6b2c]/30 bg-[#ff6b2c]/10 p-4 text-sm text-[var(--cream)]/75">
              {message}
            </p>
          ) : null}
          {error ? (
            <p className="mt-6 rounded-xl border border-[#ff6b2c]/40 bg-[#ff6b2c]/10 p-4 text-sm text-[#ffb86b]">
              {error}
            </p>
          ) : null}
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#0f0d0a] px-4 py-5 text-[var(--cream)] sm:px-8">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4">
        <div>
          <Link
            href="/"
            className="text-[10px] font-bold uppercase tracking-[0.3em] text-[var(--cream)]/35"
          >
            CarterCo
          </Link>
          <h1 className="mt-3 font-display text-4xl leading-none tracking-tight">
            Leads
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void enableNotifications()}
            disabled={notifications === "Beder om adgang" || notifications === "Gemmer"}
            className="rounded-full border border-[var(--cream)]/15 px-4 py-3 text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--cream)]/70 disabled:cursor-wait disabled:opacity-50"
          >
            Notifikationer
          </button>
          <button
            type="button"
            onClick={() => void loadLeads()}
            className="rounded-full border border-[var(--cream)]/15 px-4 py-3 text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--cream)]/70"
          >
            Opdater
          </button>
          <button
            type="button"
            onClick={() => void signOut()}
            className="rounded-full border border-[var(--cream)]/15 px-4 py-3 text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--cream)]/45"
          >
            Ud
          </button>
        </div>
      </header>

      <section className="mx-auto mt-6 flex w-full max-w-3xl flex-col gap-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[var(--cream)]/35">
          Push: {notifications}
        </p>

        {message ? (
          <p className="rounded-xl border border-[#ff6b2c]/30 bg-[#ff6b2c]/10 p-4 text-sm text-[var(--cream)]/75">
            {message}
          </p>
        ) : null}

        {error ? (
          <p className="rounded-xl border border-[#ff6b2c]/40 bg-[#ff6b2c]/10 p-4 text-sm text-[#ffb86b]">
            {error}
          </p>
        ) : null}

        {leads.length === 0 ? (
          <p className="rounded-xl border border-[var(--cream)]/10 bg-black/20 p-5 text-sm text-[var(--cream)]/55">
            Ingen leads endnu.
          </p>
        ) : null}

        {leads.map((lead) => (
          <article
            key={lead.id}
            className="rounded-xl border border-[var(--cream)]/10 bg-black/25 p-5"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold leading-tight">
                  {lead.name}
                </h2>
                <p className="mt-1 text-sm text-[var(--cream)]/55">
                  {lead.company}
                </p>
              </div>
              <time className="shrink-0 text-right text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--cream)]/35">
                {formatLeadTime(lead.created_at)}
              </time>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-2 text-xs text-[var(--cream)]/60">
              <span className="rounded-lg bg-white/5 px-3 py-2">
                {lead.monthly_leads}
              </span>
              <span className="rounded-lg bg-white/5 px-3 py-2">
                {lead.response_time}
              </span>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <a
                href={`tel:${lead.phone}`}
                className="rounded-full bg-[#ff6b2c] px-5 py-4 text-center text-xs font-bold uppercase tracking-[0.25em] text-[#0f0d0a]"
              >
                Ring {lead.phone}
              </a>
              <a
                href={`mailto:${lead.email}`}
                className="rounded-full border border-[var(--cream)]/15 px-5 py-4 text-center text-xs font-bold uppercase tracking-[0.25em] text-[var(--cream)]/75"
              >
                Mail
              </a>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}

function formatLeadTime(value: string) {
  return new Intl.DateTimeFormat("da-DK", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
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
