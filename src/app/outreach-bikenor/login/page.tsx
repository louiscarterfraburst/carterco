"use client";

import { useState } from "react";

export default function BikenorLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const [pw, setPw] = useState("");
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setErr(null);
    const { next } = await searchParams;
    const res = await fetch("/api/outreach-bikenor/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    if (!res.ok) {
      setPending(false);
      setErr("wrong password");
      return;
    }
    window.location.href = next || "/outreach-bikenor";
  }

  return (
    <main className="mx-auto max-w-sm p-8 font-mono text-sm">
      <h1 className="mb-4 text-xl font-bold">Bikenor approval — sign in</h1>
      <form onSubmit={submit} className="space-y-2">
        <input
          type="password"
          autoFocus
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          placeholder="password"
          className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={pending || !pw}
          className="w-full rounded bg-black px-3 py-1 text-sm font-semibold text-white disabled:opacity-50"
        >
          {pending ? "checking…" : "sign in"}
        </button>
        {err && <p className="text-xs text-red-700">{err}</p>}
      </form>
    </main>
  );
}
