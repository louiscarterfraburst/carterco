"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type DraftRow = {
  id: string;
  pipeline_id: string;
  brand: string;
  channel: string;
  body: string;
  subject: string | null;
  language: string;
};

export function DraftActions({ draft }: { draft: DraftRow }) {
  const router = useRouter();
  const [body, setBody] = useState(draft.body);
  const [subject, setSubject] = useState(draft.subject ?? "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const dirty = body !== draft.body || subject !== (draft.subject ?? "");

  async function call(action: "approve" | "save" | "discard") {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/outreach-bikenor/${draft.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, body, subject: subject || null }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({ error: "unknown" }));
        setError(j.error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div>
      {draft.channel === "email" && (
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="(no subject)"
          className="mb-2 w-full rounded border border-gray-300 px-2 py-1 text-sm"
        />
      )}
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={Math.max(4, Math.min(14, body.split("\n").length + 1))}
        className="w-full rounded border border-gray-300 p-2 font-mono text-sm leading-relaxed"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          onClick={() => call("approve")}
          disabled={pending}
          className="rounded bg-black px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
        >
          Approve &amp; send
        </button>
        <button
          onClick={() => call("save")}
          disabled={pending || !dirty}
          className="rounded border border-gray-300 px-3 py-1 text-xs disabled:opacity-40"
        >
          Save edits
        </button>
        <button
          onClick={() => call("discard")}
          disabled={pending}
          className="rounded border border-red-300 px-3 py-1 text-xs text-red-700 disabled:opacity-40"
        >
          Discard
        </button>
        {pending && <span className="text-xs text-gray-500">working…</span>}
        {error && <span className="text-xs text-red-700">{error}</span>}
      </div>
    </div>
  );
}
