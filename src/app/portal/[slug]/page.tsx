import { notFound } from "next/navigation";
import { createClient } from "@supabase/supabase-js";
import { portalClient } from "@/portal-auth";

// Curated, read-only client overview. Live on each load (no realtime needed).
// The whole point is curation: the client sees the funnel, wins, and active
// conversations — never failures, ICP rejects, scores, or A/B machinery. Those
// stay in the operator cockpit. See docs/client-pipeline-view.md.

export const dynamic = "force-dynamic";

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://znpaevzwlcfuzqxsbyie.supabase.co";
const SUPABASE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  "sb_publishable_rKCrGrKGUr48lEhjqWj3dw_V0kAEKQl";

type Pipe = {
  sendpilot_lead_id: string;
  contact_email: string | null;
  status: string;
  invited_at: string | null;
  sent_at: string | null;
  last_reply_at: string | null;
  last_reply_intent: string | null;
  outcome: string | null;
  updated_at: string | null;
};
type Lead = { contact_email: string; first_name: string | null; last_name: string | null; company: string | null };
type Reply = { sendpilot_lead_id: string; message: string | null; received_at: string | null };

// Buckets the client should never see — pure operator machinery.
const HIDDEN_STATUS = new Set(["failed", "rejected_by_icp"]);
const POSITIVE_INTENT = new Set(["interested", "question", "referral"]);
const CLOSED_OUTCOME = new Set(["not_interested", "wrong_person_confirmed", "ghosted"]);
const MEETING_OUTCOME = new Set(["meeting_booked", "won"]);

const DAY = 24 * 60 * 60 * 1000;

function fullName(l: Lead | undefined): string {
  if (!l) return "";
  return `${l.first_name ?? ""} ${l.last_name ?? ""}`.trim();
}
function daDate(s: string | null): string {
  if (!s) return "";
  try {
    return new Date(s).toLocaleDateString("da-DK", { day: "numeric", month: "short" });
  } catch {
    return "";
  }
}

export default async function PortalPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const client = portalClient(slug);
  if (!client) notFound();
  const ws = client.workspaceId;

  const db = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  const [{ data: pipeData }, { data: leadData }, { data: replyData }] = await Promise.all([
    db
      .from("outreach_pipeline")
      .select(
        "sendpilot_lead_id, contact_email, status, invited_at, sent_at, last_reply_at, last_reply_intent, outcome, updated_at",
      )
      .eq("workspace_id", ws)
      .limit(3000),
    db
      .from("outreach_leads")
      .select("contact_email, first_name, last_name, company")
      .eq("workspace_id", ws),
    db
      .from("outreach_replies")
      .select("sendpilot_lead_id, message, received_at")
      .eq("workspace_id", ws)
      .eq("direction", "inbound")
      .order("received_at", { ascending: false })
      .limit(3000),
  ]);

  const pipe = (pipeData ?? []) as Pipe[];
  const leadByEmail = new Map<string, Lead>();
  for (const l of (leadData ?? []) as Lead[]) leadByEmail.set(l.contact_email, l);
  const latestReplyByLead = new Map<string, Reply>();
  for (const r of (replyData ?? []) as Reply[]) {
    if (!latestReplyByLead.has(r.sendpilot_lead_id)) latestReplyByLead.set(r.sendpilot_lead_id, r);
  }

  // Real, client-visible leads only.
  const real = pipe.filter((r) => !HIDDEN_STATUS.has(r.status));

  const contacted = real.filter((r) => r.invited_at || r.sent_at);
  const replied = real.filter((r) => r.last_reply_at);
  const inConvo = replied.filter(
    (r) =>
      (POSITIVE_INTENT.has(r.last_reply_intent ?? "") || r.outcome === "interested") &&
      !CLOSED_OUTCOME.has(r.outcome ?? "") &&
      !MEETING_OUTCOME.has(r.outcome ?? ""),
  );
  const meetings = real.filter((r) => MEETING_OUTCOME.has(r.outcome ?? ""));

  const now = Date.now();
  const last7 = contacted.filter((r) => {
    const t = r.sent_at ?? r.invited_at;
    return t && now - new Date(t).getTime() < 7 * DAY;
  }).length;

  // Wins: meetings/won first, then fresh interested replies not already a meeting.
  type Win = { kind: string; name: string; company: string; snippet: string; date: string; ts: number };
  const wins: Win[] = [];
  for (const r of meetings) {
    const l = leadByEmail.get(r.contact_email ?? "");
    wins.push({
      kind: r.outcome === "won" ? "Vundet" : "Møde booket",
      name: fullName(l) || "Lead",
      company: l?.company ?? "",
      snippet: latestReplyByLead.get(r.sendpilot_lead_id)?.message?.slice(0, 140) ?? "",
      date: daDate(r.updated_at),
      ts: r.updated_at ? new Date(r.updated_at).getTime() : 0,
    });
  }
  for (const r of real) {
    if (MEETING_OUTCOME.has(r.outcome ?? "")) continue;
    if (r.last_reply_intent !== "interested") continue;
    const l = leadByEmail.get(r.contact_email ?? "");
    wins.push({
      kind: "Positivt svar",
      name: fullName(l) || "Lead",
      company: l?.company ?? "",
      snippet: latestReplyByLead.get(r.sendpilot_lead_id)?.message?.slice(0, 140) ?? "",
      date: daDate(r.last_reply_at),
      ts: r.last_reply_at ? new Date(r.last_reply_at).getTime() : 0,
    });
  }
  wins.sort((a, b) => b.ts - a.ts);
  const topWins = wins.slice(0, 10);

  // Active conversations list.
  const active = [...inConvo]
    .sort((a, b) => (new Date(b.last_reply_at ?? 0).getTime()) - (new Date(a.last_reply_at ?? 0).getTime()))
    .slice(0, 30)
    .map((r) => {
      const l = leadByEmail.get(r.contact_email ?? "");
      return {
        name: fullName(l) || "Lead",
        company: l?.company ?? "",
        snippet: latestReplyByLead.get(r.sendpilot_lead_id)?.message?.slice(0, 180) ?? "",
        date: daDate(r.last_reply_at),
      };
    });

  const funnel = [
    { label: "Kontaktet", value: contacted.length },
    { label: "Svar", value: replied.length },
    { label: "I samtale", value: inConvo.length },
    { label: "Møder", value: meetings.length },
  ];

  return (
    <main className="min-h-screen bg-[var(--sand)] px-6 py-10">
      <div className="mx-auto max-w-3xl">
        {/* header */}
        <header className="flex items-baseline justify-between gap-4">
          <div>
            <h1 className="font-display text-4xl italic text-[var(--ink)]">{client.displayName}</h1>
            <p className="mt-1 text-[13px] text-[var(--ink)]/55">Outreach-overblik · opdateres live</p>
          </div>
          <p className="text-[12px] text-[var(--ink)]/45">Carter &amp; Co.</p>
        </header>

        {/* momentum */}
        <p className="mt-6 text-[15px] text-[var(--ink)]/80">
          <span className="font-display text-2xl italic text-[var(--ink)]">{last7}</span> nye kontakter de seneste 7 dage.
        </p>

        {/* funnel */}
        <section className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {funnel.map((f) => (
            <div key={f.label} className="rounded-xl border border-[var(--ink)]/10 bg-[var(--cream)] p-4">
              <div className="tabular font-display text-3xl text-[var(--ink)]">{f.value}</div>
              <div className="mt-1 text-[12px] text-[var(--ink)]/55">{f.label}</div>
            </div>
          ))}
        </section>

        {/* wins */}
        <section className="mt-9">
          <h2 className="text-[13px] font-medium uppercase tracking-wide text-[var(--ink)]/45">Seneste resultater</h2>
          {topWins.length === 0 ? (
            <p className="mt-3 text-[14px] text-[var(--ink)]/55">Vi er i gang — de første positive svar lander snart.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {topWins.map((w, i) => (
                <li key={i} className="rounded-xl border border-[var(--ink)]/10 bg-[var(--cream)] p-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[14px] font-medium text-[var(--ink)]">
                      {w.name}{w.company ? <span className="text-[var(--ink)]/45"> · {w.company}</span> : null}
                    </span>
                    <span className="shrink-0 rounded-full bg-[var(--forest)]/10 px-2 py-0.5 text-[11px] text-[var(--forest)]">{w.kind}</span>
                  </div>
                  {w.snippet ? <p className="mt-1.5 text-[13px] leading-snug text-[var(--ink)]/70">“{w.snippet}”</p> : null}
                  {w.date ? <p className="mt-1 text-[11px] text-[var(--ink)]/40">{w.date}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* active conversations */}
        <section className="mt-9">
          <h2 className="text-[13px] font-medium uppercase tracking-wide text-[var(--ink)]/45">
            Aktive samtaler ({active.length})
          </h2>
          {active.length === 0 ? (
            <p className="mt-3 text-[14px] text-[var(--ink)]/55">Ingen åbne samtaler lige nu — vi fortsætter med at række ud.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {active.map((c, i) => (
                <li key={i} className="rounded-xl border border-[var(--ink)]/10 bg-[var(--cream)] p-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[14px] font-medium text-[var(--ink)]">
                      {c.name}{c.company ? <span className="text-[var(--ink)]/45"> · {c.company}</span> : null}
                    </span>
                    {c.date ? <span className="shrink-0 text-[11px] text-[var(--ink)]/40">{c.date}</span> : null}
                  </div>
                  {c.snippet ? <p className="mt-1.5 text-[13px] leading-snug text-[var(--ink)]/70">“{c.snippet}”</p> : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <footer className="mt-12 border-t border-[var(--ink)]/10 pt-5 text-[13px] text-[var(--ink)]/55">
          Vi følger op løbende på alle aktive samtaler. Spørgsmål? Skriv til Louis.
        </footer>
      </div>
    </main>
  );
}
