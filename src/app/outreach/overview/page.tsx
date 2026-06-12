"use client";

// Cross-client triage overview — for Louis, not clients. Answers "what needs my
// attention across every client, right now" so nothing gets mishandled or
// forgotten. Unlike /portal/<slug> (client-facing, curated to hide problems),
// this LEADS with problems. See docs/client-pipeline-view.md.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/client";

// Workspaces are loaded from the workspaces table (RLS scopes to membership)
// so a newly provisioned client appears here without a code change.
type Workspace = { id: string; name: string };

const WARM_INTENT = new Set(["interested", "question", "referral"]);
const PENDING_STATUS = new Set(["pending_approval", "pending_alt_review"]);
const DAY = 24 * 60 * 60 * 1000;

type Pipe = {
  sendpilot_lead_id: string;
  contact_email: string | null;
  workspace_id: string;
  status: string;
  last_reply_at: string | null;
  last_reply_intent: string | null;
  outcome: string | null;
  thread_out_of_sync: boolean | null;
};
type ReplyRow = { sendpilot_lead_id: string; workspace_id: string; intent: string | null; handled: boolean | null };
type Lead = { contact_email: string; first_name: string | null; last_name: string | null };

type Bucket = { key: string; label: string; tone: "alarm" | "warn" | "info"; names: string[] };
type ClientAttention = { id: string; name: string; total: number; buckets: Bucket[] };

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-[var(--sand)] px-6 py-10">
      <div className="mx-auto max-w-4xl">
        <header className="mb-6 flex items-baseline justify-between gap-4">
          <div>
            <h1 className="font-display text-4xl italic text-[var(--ink)]">Skal ses på</h1>
            <p className="mt-1 text-[13px] text-[var(--ink)]/55">På tværs af alle klienter · opdateres live</p>
          </div>
          <Link href="/outreach" className="text-[12px] text-[var(--ink)]/45 underline">/outreach</Link>
        </header>
        {children}
      </div>
    </main>
  );
}

export default function OverviewPage() {
  const supabase = useMemo(() => createClient(), []);
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [clients, setClients] = useState<ClientAttention[]>([]);

  useEffect(() => {
    void supabase.auth.getUser().then(({ data }) => {
      setUser(data.user ?? null);
      setAuthReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setUser(session?.user ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, [supabase]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const { data: wsData } = await supabase
        .from("workspaces")
        .select("id, name")
        .order("name", { ascending: true });
      if (cancelled) return;
      const workspaces = (wsData ?? []) as Workspace[];
      const wsIds = workspaces.map((w) => w.id);

      const [{ data: pipeData }, { data: replyData }, { data: leadData }] = await Promise.all([
        supabase
          .from("outreach_pipeline")
          .select("sendpilot_lead_id, contact_email, workspace_id, status, last_reply_at, last_reply_intent, outcome, thread_out_of_sync")
          .in("workspace_id", wsIds)
          .limit(8000),
        supabase
          .from("outreach_replies")
          .select("sendpilot_lead_id, workspace_id, intent, handled")
          .in("workspace_id", wsIds)
          .eq("direction", "inbound")
          .eq("handled", false)
          .limit(4000),
        supabase
          .from("outreach_leads")
          .select("contact_email, first_name, last_name")
          .in("workspace_id", wsIds)
          .limit(20000),
      ]);
      if (cancelled) return;

      const pipe = (pipeData ?? []) as Pipe[];
      const replies = (replyData ?? []) as ReplyRow[];
      const nameByEmail = new Map<string, string>();
      for (const l of (leadData ?? []) as Lead[]) {
        const n = `${l.first_name ?? ""} ${l.last_name ?? ""}`.trim();
        if (n) nameByEmail.set(l.contact_email, n);
      }
      const nameByLead = new Map<string, string>();
      const wsByLead = new Map<string, string>();
      for (const p of pipe) {
        wsByLead.set(p.sendpilot_lead_id, p.workspace_id);
        const n = p.contact_email ? nameByEmail.get(p.contact_email) : undefined;
        if (n) nameByLead.set(p.sendpilot_lead_id, n);
      }
      const now = Date.now();

      const result: ClientAttention[] = workspaces.map((w) => {
        const rows = pipe.filter((p) => p.workspace_id === w.id);
        const nameOf = (leadId: string) => nameByLead.get(leadId) ?? "Lead";

        const failed = rows.filter((p) => p.status === "failed");
        const outOfSync = rows.filter((p) => p.thread_out_of_sync === true);
        const pending = rows.filter((p) => PENDING_STATUS.has(p.status));
        const stalled = rows.filter(
          (p) =>
            p.last_reply_at &&
            !p.outcome &&
            WARM_INTENT.has(p.last_reply_intent ?? "") &&
            now - new Date(p.last_reply_at).getTime() > 7 * DAY,
        );
        const unanswered = replies.filter(
          (r) => r.workspace_id === w.id && WARM_INTENT.has(r.intent ?? ""),
        );

        const buckets: Bucket[] = [];
        const push = (key: string, label: string, tone: Bucket["tone"], ids: string[]) => {
          if (ids.length) buckets.push({ key, label: `${ids.length} ${label}`, tone, names: ids.map(nameOf) });
        };
        push("unanswered", "ubesvarede varme svar", "alarm", unanswered.map((r) => r.sendpilot_lead_id));
        push("failed", "fejlede afsendelser", "alarm", failed.map((p) => p.sendpilot_lead_id));
        push("stalled", "samtaler ved at gå kolde", "warn", stalled.map((p) => p.sendpilot_lead_id));
        push("pending", "afventer din godkendelse", "warn", pending.map((p) => p.sendpilot_lead_id));
        push("outofsync", "tråde ude af sync", "info", outOfSync.map((p) => p.sendpilot_lead_id));

        return { id: w.id, name: w.name, total: buckets.reduce((s, b) => s + b.names.length, 0), buckets };
      });

      result.sort((a, b) => b.total - a.total);
      setClients(result);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, supabase]);

  if (!authReady) {
    return <Shell><p className="tabular text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/45">Indlæser…</p></Shell>;
  }
  if (!user) {
    return (
      <Shell>
        <p className="text-[14px] text-[var(--ink)]/70">
          Du skal være logget ind. <Link href="/outreach" className="underline">Log ind på /outreach</Link>, så vender vi tilbage hertil.
        </p>
      </Shell>
    );
  }
  if (loading) {
    return <Shell><p className="tabular text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/45">Henter…</p></Shell>;
  }

  const grandTotal = clients.reduce((s, c) => s + c.total, 0);
  const toneClass: Record<Bucket["tone"], string> = {
    alarm: "border-[var(--clay)]/40 bg-[var(--clay)]/10 text-[var(--clay)]",
    warn: "border-amber-500/40 bg-amber-500/10 text-amber-700",
    info: "border-[var(--ink)]/20 bg-[var(--ink)]/5 text-[var(--ink)]/60",
  };

  return (
    <Shell>
      <p className="mb-5 text-[15px] text-[var(--ink)]/80">
        {grandTotal === 0
          ? "Intet kræver handling lige nu. Alt kører."
          : <><span className="font-display text-2xl italic text-[var(--ink)]">{grandTotal}</span> ting kræver din opmærksomhed.</>}
      </p>
      <div className="space-y-3">
        {clients.map((c) => (
          <div key={c.id} className="rounded-xl border border-[var(--ink)]/10 bg-[var(--cream)] p-4">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-display text-xl italic text-[var(--ink)]">{c.name}</span>
              <span className="tabular text-[12px] text-[var(--ink)]/45">{c.total === 0 ? "alt ser fint ud" : `${c.total} ting`}</span>
            </div>
            {c.buckets.length > 0 ? (
              <div className="mt-3 space-y-2">
                {c.buckets.map((b) => (
                  <div key={b.key} className="flex flex-wrap items-center gap-2">
                    <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[12px] ${toneClass[b.tone]}`}>{b.label}</span>
                    <span className="text-[12px] text-[var(--ink)]/55">
                      {b.names.slice(0, 4).join(", ")}{b.names.length > 4 ? ` +${b.names.length - 4} flere` : ""}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </Shell>
  );
}
