"use client";

import { useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { PORTAL_CLIENTS } from "@/portal-auth";

export default function PortalLoginPage() {
  const slug = String(useParams().slug ?? "");
  const next = useSearchParams().get("next");
  const displayName = PORTAL_CLIENTS[slug]?.displayName ?? "Din virksomhed";

  const [pw, setPw] = useState("");
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setErr(null);
    const res = await fetch(`/api/portal/${slug}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    if (!res.ok) {
      setPending(false);
      setErr("Forkert adgangskode.");
      return;
    }
    window.location.href = next || `/portal/${slug}`;
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--sand)] px-6">
      <div className="w-full max-w-sm">
        <p className="font-display text-3xl italic text-[var(--ink)]">{displayName}</p>
        <p className="mt-1 text-[13px] text-[var(--ink)]/55">Jeres outreach-overblik fra Carter &amp; Co.</p>
        <form onSubmit={submit} className="mt-6 space-y-3">
          <input
            type="password"
            autoFocus
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder="Adgangskode"
            className="w-full rounded-lg border border-[var(--ink)]/15 bg-[var(--cream)] px-3 py-2.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--ink)]/40"
          />
          <button
            type="submit"
            disabled={pending || !pw}
            className="w-full rounded-lg bg-[var(--ink)] px-3 py-2.5 text-sm font-medium text-[var(--cream)] transition disabled:opacity-50"
          >
            {pending ? "Logger ind…" : "Log ind"}
          </button>
          {err ? <p className="text-[12px] text-[var(--clay)]">{err}</p> : null}
        </form>
      </div>
    </main>
  );
}
