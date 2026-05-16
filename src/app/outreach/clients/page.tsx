"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/client";

// Read-only overview of every client workspace the signed-in user can see.
// Goal: when you have N clients running, you can answer "what flow is this
// client on, where does each piece of config live, and what's currently
// happening in their pipeline" without grepping the codebase. Editing happens
// in the source files / DB rows we link to — this page never mutates.

type VoicePlaybook = {
  owner_first_name: string | null;
  value_prop: string | null;
  guidelines: string | null;
  cta_preference: string | null;
  booking_link: string | null;
  updated_at: string | null;
};

type IcpVersion = {
  version: number;
  company_fit: string | null;
  person_fit: string | null;
  alternate_search_titles: string[] | null;
  alternate_search_locations: string[] | null;
  min_company_score: number | null;
  min_person_score: number | null;
  created_at: string | null;
};

type AgentBrief = {
  slug: string;
  path: string;
  content: string;
  strategies: string[];
};

type FirstMessageFlow = {
  kind: "video_render" | "ai_drafted_dm";
  trigger: string;
  summary: string;
  steps: { label: string; detail: string; ref: string }[];
};

type SharedSequence = {
  id: string;
  description: string;
  trigger: string;
  excludes_global: string[];
  steps: {
    id: string;
    wait_hours: number;
    template: string;
    fires_7d: { ok: number; fail: number };
  }[];
  source: "global" | "workspace";
};

type ClientConfig = {
  workspace: { id: string; name: string; owner_email: string | null };
  outreach_style: "video_render" | "ai_drafted_dm";
  voice_playbook: VoicePlaybook | null;
  active_icp: IcpVersion | null;
  agent_brief: AgentBrief | null;
  first_message_flow: FirstMessageFlow;
  sequences: SharedSequence[];
  pipeline_counts: Record<string, number>;
  pipeline_total_30d: number;
  sent_30d: number;
  replied_30d: number;
};

const STYLE_LABELS: Record<ClientConfig["outreach_style"], string> = {
  video_render: "Video render (SendSpark)",
  ai_drafted_dm: "AI-drafted DM (Claude)",
};

const CTA_LABELS: Record<string, string> = {
  soft_discovery: "Soft discovery (no link)",
  no_cta: "No CTA",
  booking_link: "Booking link",
};

export default function ClientsOverviewPage() {
  const supabase = useMemo(() => createClient(), []);
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [configs, setConfigs] = useState<ClientConfig[] | null>(null);
  const [sequencesError, setSequencesError] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void supabase.auth.getUser().then(({ data }) => {
      setUser(data.user ?? null);
      setAuthLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, [supabase]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        if (!cancelled) setErr("Mistede session. Genindlæs.");
        return;
      }
      try {
        const res = await fetch("/api/outreach/client-config", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          if (!cancelled) setErr(body.error ?? `HTTP ${res.status}`);
          return;
        }
        const body = (await res.json()) as {
          configs: ClientConfig[];
          sequences_error: string | null;
        };
        if (!cancelled) {
          setConfigs(body.configs);
          setSequencesError(body.sequences_error ?? null);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [user, supabase]);

  if (authLoading) {
    return <Shell><p className="tabular text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/45">Indlæser…</p></Shell>;
  }

  if (!user) {
    return (
      <Shell>
        <p className="text-[var(--ink)]/70">
          Du skal være logget ind. <Link href="/outreach" className="underline">Log ind på /outreach</Link>, så vender vi tilbage hertil.
        </p>
      </Shell>
    );
  }

  if (err) {
    return (
      <Shell>
        <p className="tabular text-[11px] uppercase tracking-[0.22em] text-[var(--clay)]">Fejl: {err}</p>
      </Shell>
    );
  }

  if (!configs) {
    return <Shell><p className="tabular text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/45">Henter klient-konfig…</p></Shell>;
  }

  if (!configs.length) {
    return (
      <Shell>
        <p className="text-[var(--ink)]/70">Ingen workspaces. Kontakt support.</p>
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="mb-8">
        <h1 className="font-display text-3xl italic leading-tight tracking-tight text-[var(--ink)] sm:text-4xl">
          Klient-oversigt
        </h1>
        <p className="mt-2 max-w-2xl text-[14px] text-[var(--ink)]/70">
          Read-only. Hver klient har sit eget workspace, voice playbook, ICP og
          (for AI-drafted) sit eget agent-brief. Brug det her som tjek-side før
          du redigerer — fil-stier og DB-tabeller står på hvert kort, så du
          rammer det rigtige flow første gang.
        </p>
      </header>

      {sequencesError ? (
        <div
          className="mb-6 flex items-start gap-3 rounded-md border p-4"
          style={{
            background: "color-mix(in oklab, var(--clay) 6%, transparent)",
            borderColor: "color-mix(in oklab, var(--clay) 50%, transparent)",
          }}
          role="alert"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--cream)]" style={{ background: "var(--clay)" }} aria-hidden>!</span>
          <div className="min-w-0 flex-1">
            <div className="tabular text-[10px] uppercase tracking-[0.22em]" style={{ color: "var(--clay)" }}>
              Engine-fejl
            </div>
            <p className="mt-0.5 text-[13.5px] text-[var(--ink)]/85">{sequencesError}</p>
            <p className="mt-1 text-[12px] text-[var(--ink)]/60">
              Outbound-flow kortene nedenfor viser muligvis tom data. Tjek <code className="tabular text-[11.5px]">outreach_sequences</code>-tabellen og engine-logs.
            </p>
          </div>
        </div>
      ) : null}

      <div className="space-y-6">
        {configs.map((c) => <ClientCard key={c.workspace.id} config={c} />)}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-[var(--sand)] text-[var(--ink)]">
      <SubHeader />
      <div className="mx-auto w-full max-w-[1100px] px-4 py-8 sm:px-8 lg:px-12">
        {children}
      </div>
    </main>
  );
}

function SubHeader() {
  return (
    <div className="safe-pad-top sticky top-0 z-20 border-b border-[var(--ink)]/[0.10] bg-[var(--sand)]/85 backdrop-blur-xl">
      <div className="mx-auto flex w-full max-w-[1400px] items-center justify-between gap-3 px-4 py-3 sm:gap-4 sm:px-8 lg:px-12">
        <Link href="/" className="tabular truncate text-[10px] uppercase tracking-[0.24em] text-[var(--ink)]/50 hover:text-[var(--ink)]/80 sm:tracking-[0.35em]">
          CarterCo<span className="mx-2 text-[var(--ink)]/25">/</span>
          <Link href="/outreach" className="text-[var(--ink)]/55 hover:text-[var(--ink)]/80">Outreach</Link>
          <span className="mx-2 text-[var(--ink)]/25">/</span>
          <span className="text-[var(--ink)]/75">Clients</span>
        </Link>
        <Link href="/outreach" className="focus-cream tabular rounded-sm border border-[var(--ink)]/15 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/65 hover:border-[var(--ink)]/35 hover:text-[var(--ink)]">
          ← Til inbox
        </Link>
      </div>
    </div>
  );
}

function ClientCard({ config }: { config: ClientConfig }) {
  const styleTone = config.outreach_style === "ai_drafted_dm" ? "var(--forest)" : "var(--clay)";
  const lastUpdated = config.voice_playbook?.updated_at;

  return (
    <section className="rounded-md border border-[var(--ink)]/12 bg-[var(--cream)]/80 p-6 shadow-[0_1px_0_rgba(0,0,0,0.02)]">
      {/* Header */}
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-[var(--ink)]/10 pb-4">
        <div className="min-w-0">
          <h2 className="font-display text-2xl italic leading-tight tracking-tight text-[var(--ink)]">
            {config.workspace.name}
          </h2>
          <p className="tabular mt-1 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/45">
            {config.workspace.owner_email ?? "—"} · {config.workspace.id.slice(0, 8)}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <span
            className="tabular inline-block rounded-sm border px-2 py-1 text-[10px] uppercase tracking-[0.22em]"
            style={{ color: styleTone, borderColor: styleTone, opacity: 0.85 }}
          >
            {STYLE_LABELS[config.outreach_style]}
          </span>
        </div>
      </div>

      {/* Activity strip */}
      <dl className="mt-4 grid grid-cols-3 gap-x-4 gap-y-2 border-b border-[var(--ink)]/10 pb-4">
        <Stat label="Sendt 30 d" value={config.sent_30d} />
        <Stat label="Svar 30 d" value={config.replied_30d} tint="var(--forest)" />
        <Stat label="I pipeline 30 d" value={config.pipeline_total_30d} />
      </dl>

      {/* Outbound flow — laid out like an automation canvas */}
      <Block title="Outbound flow" source={`Trigger: ${config.first_message_flow.trigger}`}>
        <FlowCanvas
          style={config.outreach_style}
          firstMessage={config.first_message_flow}
          sequences={config.sequences}
        />
      </Block>

      {/* Voice playbook */}
      <Block title="Voice playbook" source="Supabase · outreach_voice_playbooks" updatedAt={lastUpdated}>
        {config.voice_playbook ? (
          <dl className="space-y-3 text-[14px]">
            <Field label="Owner first name" value={config.voice_playbook.owner_first_name} />
            <Field label="Value prop" value={config.voice_playbook.value_prop} multiline />
            <Field label="Guidelines" value={config.voice_playbook.guidelines} multiline />
            <Field
              label="CTA"
              value={
                config.voice_playbook.cta_preference
                  ? CTA_LABELS[config.voice_playbook.cta_preference] ?? config.voice_playbook.cta_preference
                  : null
              }
            />
            <Field label="Booking link" value={config.voice_playbook.booking_link} mono />
          </dl>
        ) : (
          <p className="tabular text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/45">
            Intet voice playbook for dette workspace.
          </p>
        )}
      </Block>

      {/* Active ICP */}
      <Block
        title={`Aktiv ICP${config.active_icp ? ` · v${config.active_icp.version}` : ""}`}
        source="Supabase · icp_versions (is_active=true)"
        updatedAt={config.active_icp?.created_at ?? null}
      >
        {config.active_icp ? (
          <dl className="space-y-3 text-[14px]">
            <Field label="Company fit" value={config.active_icp.company_fit} multiline />
            <Field label="Person fit" value={config.active_icp.person_fit} multiline />
            <Field
              label="Min scores"
              value={
                `Company ≥ ${config.active_icp.min_company_score ?? "—"} · Person ≥ ${config.active_icp.min_person_score ?? "—"}`
              }
            />
            <Field
              label="Alt. titles"
              value={(config.active_icp.alternate_search_titles ?? []).join(", ") || null}
            />
            <Field
              label="Alt. locations"
              value={(config.active_icp.alternate_search_locations ?? []).join(", ") || null}
            />
          </dl>
        ) : (
          <p className="tabular text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/45">
            Ingen aktiv ICP-version.
          </p>
        )}
      </Block>

      {/* Agent brief — only for AI-drafted clients */}
      {config.outreach_style === "ai_drafted_dm" ? (
        <Block
          title={`Agent brief${config.agent_brief ? ` · ${config.agent_brief.strategies.length} strategier` : ""}`}
          source={config.agent_brief ? config.agent_brief.path : "—"}
        >
          {config.agent_brief ? (
            <>
              {config.agent_brief.strategies.length ? (
                <ul className="mb-4 grid grid-cols-1 gap-1 text-[13px] sm:grid-cols-2">
                  {config.agent_brief.strategies.map((s) => (
                    <li key={s} className="flex items-baseline gap-2">
                      <span className="text-[var(--clay)]">›</span>
                      <span className="text-[var(--ink)]/80">{s}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <details className="group">
                <summary className="tabular cursor-pointer text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/50 hover:text-[var(--ink)]/80">
                  Vis fuld brief ({config.agent_brief.content.length.toLocaleString()} tegn)
                </summary>
                <pre className="mt-3 max-h-[480px] overflow-auto whitespace-pre-wrap rounded-sm border border-[var(--ink)]/10 bg-[var(--sand)]/60 p-4 text-[12.5px] leading-relaxed text-[var(--ink)]/85">
                  {config.agent_brief.content}
                </pre>
              </details>
            </>
          ) : (
            <p className="tabular text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/45">
              Ingen brief-fil fundet. Tilføj <code>clients/&lt;slug&gt;/agent-brief.md</code> og kortlæg den i <code>WORKSPACE_BRIEF_SLUG</code>.
            </p>
          )}
        </Block>
      ) : null}

      {/* Pipeline status counts */}
      <Block title="Pipeline status (30 d)" source="Supabase · outreach_pipeline">
        {Object.keys(config.pipeline_counts).length ? (
          <ul className="grid grid-cols-2 gap-x-6 gap-y-1 text-[13px] sm:grid-cols-3">
            {Object.entries(config.pipeline_counts)
              .sort(([, a], [, b]) => b - a)
              .map(([status, n]) => (
                <li key={status} className="flex justify-between gap-3 border-b border-dashed border-[var(--ink)]/10 py-1">
                  <span className="tabular text-[10px] uppercase tracking-[0.18em] text-[var(--ink)]/55">{status}</span>
                  <span className="tabular text-[var(--ink)]/85">{n}</span>
                </li>
              ))}
          </ul>
        ) : (
          <p className="tabular text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/45">
            Ingen pipeline-aktivitet seneste 30 dage.
          </p>
        )}
      </Block>

      {/* Files & flows — where to edit each thing */}
      <Block title="Filer & flows" source="Hvor du redigerer">
        <ul className="space-y-1 text-[13px]">
          <FileRow label="Voice playbook" path="DB · outreach_voice_playbooks (1 row pr. workspace)" />
          <FileRow label="ICP" path="DB · icp_versions (nyt is_active=true row = ny version)" />
          {config.outreach_style === "ai_drafted_dm" ? (
            <>
              <FileRow
                label="Agent brief (kilde)"
                path={config.agent_brief?.path ?? "clients/<slug>/agent-brief.md"}
              />
              <FileRow
                label="Agent brief (mirror)"
                path="supabase/functions/_shared/draft-first-message.ts"
              />
              <FileRow
                label="Sync brief → mirror"
                path={`python3 scripts/sync_${config.agent_brief?.slug ?? "<slug>"}_brief.py`}
                mono
              />
              <FileRow
                label="connection.accepted routing"
                path="supabase/functions/sendpilot-webhook/index.ts"
              />
              <FileRow
                label="Reply drafter (allowed users)"
                path="supabase/functions/outreach-ai/index.ts"
              />
            </>
          ) : (
            <>
              <FileRow
                label="Video render flow"
                path="supabase/functions/sendpilot-webhook/index.ts (pending_pre_render → rendered)"
              />
              <FileRow
                label="Reply drafter (allowed users)"
                path="supabase/functions/outreach-ai/index.ts"
              />
            </>
          )}
          <FileRow label="Follow-up sequences" path="DB · outreach_sequences (workspace_id = null → global; = this ws → override)" />
          <FileRow label="Sequence loader" path="supabase/functions/_shared/sequences.ts" />
          <FileRow label="Sequence engine" path="supabase/functions/outreach-engagement-tick/index.ts" />
          <FileRow label="Push label" path="supabase/functions/_shared/workspaces.ts" />
        </ul>
      </Block>
    </section>
  );
}

// ── Flow canvas (ActiveCampaign-ish) ─────────────────────────────────────────
// Vertical layout of node cards connected by labeled pipes. Read-only — the
// canvas mirrors what's actually wired, it doesn't edit anything. Branches use
// a two-column grid; the inactive side is dimmed for clients that can't reach
// it (e.g. AI-drafted-DM clients never receive the `played` signal because
// there's no video).

type FlowTone = "trigger" | "draft" | "approve" | "send" | "wait" | "end" | "branch";

const TONE_STYLES: Record<FlowTone, { fg: string; ring: string; bg: string }> = {
  trigger: { fg: "var(--clay)", ring: "var(--clay)/45", bg: "var(--clay)/8" },
  draft:   { fg: "var(--forest)", ring: "var(--forest)/40", bg: "var(--forest)/8" },
  approve: { fg: "var(--ink)/70", ring: "var(--ink)/25", bg: "var(--cream)" },
  send:    { fg: "var(--ink)", ring: "var(--ink)/22", bg: "var(--sand)/60" },
  wait:    { fg: "var(--ink)/55", ring: "var(--ink)/15", bg: "transparent" },
  end:     { fg: "var(--ink)/40", ring: "var(--ink)/15", bg: "var(--ink)/3" },
  branch:  { fg: "var(--clay)", ring: "var(--clay)/45", bg: "var(--clay)/6" },
};

function FlowNode({
  tone,
  icon,
  type,
  title,
  subtitle,
  body,
  ref,
}: {
  tone: FlowTone;
  icon: string;
  type: string;
  title: string;
  subtitle?: string;
  body?: React.ReactNode;
  ref?: string;
}) {
  const t = TONE_STYLES[tone];
  return (
    <div
      className="flex gap-3 rounded-md border p-3"
      style={{
        borderColor: `color-mix(in oklab, ${t.ring.split("/")[0]} ${t.ring.split("/")[1] ?? "100"}%, transparent)`,
        background: t.bg === "transparent"
          ? "transparent"
          : `color-mix(in oklab, ${t.bg.split("/")[0]} ${t.bg.split("/")[1] ?? "100"}%, transparent)`,
      }}
    >
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[14px] leading-none"
        style={{ background: t.fg, color: "var(--cream)" }}
        aria-hidden
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span
            className="tabular text-[9px] uppercase tracking-[0.22em]"
            style={{ color: t.fg }}
          >
            {type}
          </span>
          <span className="text-[13.5px] font-medium text-[var(--ink)]">{title}</span>
        </div>
        {subtitle ? (
          <div className="mt-0.5 text-[12.5px] text-[var(--ink)]/70">{subtitle}</div>
        ) : null}
        {body ? <div className="mt-2">{body}</div> : null}
        {ref ? (
          <code className="tabular mt-1.5 block text-[10.5px] text-[var(--ink)]/40">{ref}</code>
        ) : null}
      </div>
    </div>
  );
}

function FlowPipe({ label, tone = "default" }: { label?: string; tone?: "default" | "branch" }) {
  const lineColor = tone === "branch" ? "var(--clay)/40" : "var(--ink)/20";
  return (
    <div className="flex flex-col items-center">
      <div
        className="h-3 w-px"
        style={{ background: `color-mix(in oklab, ${lineColor.split("/")[0]} ${lineColor.split("/")[1]}%, transparent)` }}
      />
      {label ? (
        <span
          className="tabular my-0.5 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.18em]"
          style={{
            borderColor: `color-mix(in oklab, ${lineColor.split("/")[0]} ${lineColor.split("/")[1]}%, transparent)`,
            background: "var(--cream)",
            color: "var(--ink)",
          }}
        >
          {label}
        </span>
      ) : null}
      <div
        className="h-3 w-px"
        style={{ background: `color-mix(in oklab, ${lineColor.split("/")[0]} ${lineColor.split("/")[1]}%, transparent)` }}
      />
    </div>
  );
}

function FlowBranch({
  label,
  warning,
  children,
}: {
  label: string;
  warning?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-center">
        <span className="tabular inline-block rounded-full border border-[var(--clay)]/45 bg-[var(--clay)]/[0.08] px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-[var(--clay)]">
          ◇ {label}
        </span>
        {warning ? (
          <p className="mt-1.5 text-[11.5px] text-[var(--clay)]/85">{warning}</p>
        ) : null}
      </div>
      <div className="mt-3 grid grid-cols-1 gap-5 md:grid-cols-2">{children}</div>
    </div>
  );
}

function FlowColumn({
  label,
  dimmed,
  dimmedReason,
  children,
}: {
  label: string;
  dimmed?: boolean;
  dimmedReason?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={dimmed ? "opacity-40" : ""}>
      <div className="mb-2 text-center">
        <span className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/60">
          ↓ {label}
        </span>
        {dimmed && dimmedReason ? (
          <div className="tabular mt-0.5 text-[9.5px] uppercase tracking-[0.18em] text-[var(--ink)]/40">
            {dimmedReason}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function SequenceSourceBadge({ source }: { source: "global" | "workspace" }) {
  if (source === "workspace") {
    return (
      <span className="tabular inline-flex items-center gap-1 rounded-full border border-[var(--forest)]/40 bg-[var(--forest)]/[0.08] px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-[var(--forest)]">
        ◉ Workspace override
      </span>
    );
  }
  return (
    <span className="tabular inline-flex items-center gap-1 rounded-full border border-[var(--ink)]/20 bg-[var(--ink)]/[0.05] px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-[var(--ink)]/55">
      ◯ Global default
    </span>
  );
}

function SequenceSteps({ sequence }: { sequence: SharedSequence | undefined }) {
  if (!sequence) {
    return (
      <p className="tabular text-center text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/40">
        Ingen sequence
      </p>
    );
  }
  return (
    <>
      <div className="mb-2 flex justify-center">
        <SequenceSourceBadge source={sequence.source} />
      </div>
      {sequence.steps.map((step) => (
        <Fragment key={step.id}>
          <FlowPipe label={`⏱ +${formatWait(step.wait_hours)}`} />
          <FlowNode
            tone="send"
            icon="↗"
            type="Auto-send"
            title={step.id}
            body={
              <>
                <pre className="whitespace-pre-wrap rounded-sm border border-[var(--ink)]/10 bg-[var(--cream)] p-2 text-[12px] leading-snug text-[var(--ink)]/85">
                  {step.template}
                </pre>
                <FiresBadge fires={step.fires_7d} />
              </>
            }
            ref={
              sequence.source === "global"
                ? `DB · outreach_sequences (global) → ${sequence.id}.${step.id}`
                : `DB · outreach_sequences (this workspace) → ${sequence.id}.${step.id}`
            }
          />
        </Fragment>
      ))}
      <FlowPipe />
      <FlowNode tone="end" icon="■" type="End" title="Sequence afsluttet" />
    </>
  );
}

function FlowCanvas({
  style,
  firstMessage,
  sequences,
}: {
  style: ClientConfig["outreach_style"];
  firstMessage: FirstMessageFlow;
  sequences: SharedSequence[];
}) {
  const watched = sequences.find((s) => s.id === "watched_followup_v1");
  const unwatched = sequences.find((s) => s.id === "unwatched_followup_v1");
  const isAi = style === "ai_drafted_dm";

  return (
    <div>
      <FlowNode
        tone="trigger"
        icon="⚡"
        type="Trigger"
        title="connection.accepted"
        subtitle="SendPilot webhook fyrer når prospect accepterer connection request"
        ref="supabase/functions/sendpilot-webhook/index.ts"
      />
      <FlowPipe />

      {isAi ? (
        <>
          <FlowNode
            tone="draft"
            icon="✎"
            type="AI draft"
            title="Claude skriver første DM"
            subtitle="Læser agent-brief, vælger strategi ud fra titel, skriver besked"
            ref="supabase/functions/_shared/draft-first-message.ts"
          />
          <FlowPipe />
        </>
      ) : (
        <>
          <FlowNode
            tone="draft"
            icon="▶"
            type="Render"
            title="SendSpark renderer personlig video"
            subtitle="Per-workspace SendSpark-credentials via SENDSPARK_*_<workspace>"
            ref="supabase/functions/_shared/sendspark-config.ts + sendspark-webhook/index.ts"
          />
          <FlowPipe />
        </>
      )}

      <FlowNode
        tone="approve"
        icon="✓"
        type="Manual"
        title={isAi ? "Du godkender draft" : "Du previewer videoen og godkender"}
        subtitle="Lander i /outreach som pending_approval"
        ref="/outreach"
      />
      <FlowPipe label="→ accept" />
      <FlowNode
        tone="send"
        icon="↗"
        type="Send"
        title="DM sendt via SendPilot"
        subtitle="Signal sat: sent"
      />

      <div className="mt-4">
        <FlowPipe label="hvad så?" tone="branch" />
        <FlowBranch
          label="Follow-up sequences"
          warning={
            allWorkspaceSequencesAreGlobal(sequences)
              ? "Begge sekvenser er globale defaults — ændringer rammer alle workspaces. Insert en workspace_id-row i outreach_sequences for at overstyre for denne klient."
              : "Mindst én sekvens er en workspace-override — kun denne klient bruger den."
          }
        >
          <FlowColumn
            label="Hvis prospect afspiller videoen"
            dimmed={isAi}
            dimmedReason={isAi ? "Ikke aktiveret — ingen video i AI-drafted flow" : undefined}
          >
            <SequenceSteps sequence={watched} />
          </FlowColumn>
          <FlowColumn label="Hvis ingen afspilning / engagement">
            <SequenceSteps sequence={unwatched} />
          </FlowColumn>
        </FlowBranch>
      </div>
    </div>
  );
}

function allWorkspaceSequencesAreGlobal(sequences: SharedSequence[]): boolean {
  return sequences.length > 0 && sequences.every((s) => s.source === "global");
}

function FiresBadge({ fires }: { fires: { ok: number; fail: number } }) {
  const total = fires.ok + fires.fail;
  if (total === 0) {
    return (
      <div className="tabular mt-2 text-[10px] uppercase tracking-[0.18em] text-[var(--ink)]/35">
        Fyrede ikke i seneste 7 d
      </div>
    );
  }
  return (
    <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="tabular text-[10px] uppercase tracking-[0.18em] text-[var(--ink)]/55">
        Seneste 7 d:
      </span>
      <span className="tabular text-[11.5px]" style={{ color: "var(--forest)" }}>
        ✓ {fires.ok} sendt
      </span>
      {fires.fail > 0 ? (
        <span className="tabular text-[11.5px]" style={{ color: "var(--clay)" }}>
          ✗ {fires.fail} fejl / afbrudt
        </span>
      ) : null}
    </div>
  );
}

function formatWait(hours: number): string {
  if (hours < 1) {
    const mins = Math.round(hours * 60);
    return `${mins} min`;
  }
  if (hours < 24) return `${hours} t`;
  const days = hours / 24;
  return Number.isInteger(days) ? `${days} d` : `${days.toFixed(1)} d`;
}

function Stat({ label, value, tint }: { label: string; value: number; tint?: string }) {
  return (
    <div>
      <dd
        className="font-display text-2xl italic leading-tight tracking-tight"
        style={{ color: tint ?? "var(--ink)" }}
      >
        {value}
      </dd>
      <dt className="tabular mt-1 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/45">{label}</dt>
    </div>
  );
}

function Block({
  title,
  source,
  updatedAt,
  children,
}: {
  title: string;
  source: string;
  updatedAt?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="tabular text-[10px] uppercase tracking-[0.24em] text-[var(--ink)]/55">{title}</h3>
        <p className="tabular text-[10px] uppercase tracking-[0.18em] text-[var(--ink)]/35">
          {source}
          {updatedAt ? ` · opd. ${formatDate(updatedAt)}` : ""}
        </p>
      </div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function Field({
  label,
  value,
  multiline = false,
  mono = false,
}: {
  label: string;
  value: string | null | undefined;
  multiline?: boolean;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="tabular text-[10px] uppercase tracking-[0.18em] text-[var(--ink)]/45">{label}</dt>
      <dd
        className={[
          "mt-0.5 text-[var(--ink)]/85",
          multiline ? "whitespace-pre-wrap" : "",
          mono ? "tabular text-[12.5px] break-all" : "",
        ].join(" ").trim()}
      >
        {value ?? <span className="text-[var(--ink)]/35">—</span>}
      </dd>
    </div>
  );
}

function FileRow({ label, path, mono = false }: { label: string; path: string; mono?: boolean }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-3 border-b border-dashed border-[var(--ink)]/10 py-1">
      <span className="tabular text-[10px] uppercase tracking-[0.18em] text-[var(--ink)]/55">{label}</span>
      <code className={`text-right ${mono ? "tabular" : ""} text-[12px] text-[var(--ink)]/75`}>{path}</code>
    </li>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("da-DK", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}
