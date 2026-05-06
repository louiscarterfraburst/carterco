// Per-prospect timeline. One submission (test_submissions row keyed by ref_code)
// expanded into a chronological feed of every contact point we have on that
// prospect: form submit + responses (email/phone/sms) + LinkedIn pipeline events.
//
// LinkedIn data is joined in via `leads_to_enrich.website` (which the
// enrichment script populated alongside `linkedin_url`). A single domain may
// map to multiple linkedin_urls (multiple people at the same company), so the
// LinkedIn section can show several people.

import { createAdminClient } from "@/utils/supabase/admin";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

type Channel = "form" | "email" | "phone" | "sms" | "linkedin";

type TimelineEvent = {
  ts: string;                 // ISO
  channel: Channel;
  title: string;
  detail?: string;
  meta?: string;              // small text on the right (e.g. "from acme.dk")
};

const CHANNEL_BADGE: Record<Channel, { icon: string; label: string; color: string }> = {
  form:     { icon: "📝", label: "form",     color: "text-[#ff6b2c]" },
  email:    { icon: "✉️", label: "email",    color: "text-[#d4a35a]" },
  phone:    { icon: "📞", label: "phone",    color: "text-[#9bbf7e]" },
  sms:      { icon: "💬", label: "sms",      color: "text-[#9bbf7e]" },
  linkedin: { icon: "🔗", label: "linkedin", color: "text-[#7ea3bf]" },
};

function fmtAbs(iso: string): string {
  const d = new Date(iso);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
}

function fmtRel(iso: string): string {
  const dt = (Date.now() - new Date(iso).getTime()) / 1000;
  if (dt < 60) return "just now";
  if (dt < 3600) return `${Math.round(dt / 60)}m ago`;
  if (dt < 86400) return `${Math.round(dt / 3600)}h ago`;
  return `${Math.round(dt / 86400)}d ago`;
}

export default async function ProspectTimelinePage({
  params,
}: {
  params: Promise<{ refcode: string }>;
}) {
  const { refcode } = await params;
  const sb = createAdminClient();

  // 1. Submission (the prospect anchor)
  const { data: sub } = await sb
    .from("test_submissions")
    .select("id, ref_code, company, website, domain, industry, city, status, submitted_at, contact_url, notes, phone")
    .eq("ref_code", refcode)
    .maybeSingle();
  if (!sub) notFound();

  // 2. All responses tied to this submission (email/phone/sms)
  const { data: responsesData } = await sb
    .from("test_responses")
    .select("id, channel, received_at, from_address, from_domain, subject, body_excerpt")
    .eq("submission_id", sub.id)
    .order("received_at", { ascending: false })
    .limit(500);
  const responses = responsesData ?? [];

  // 3. LinkedIn join: leads_to_enrich rows that share this domain → their
  //    linkedin_url → outreach_pipeline rows. Join is best-effort.
  let linkedinPeople: Array<{
    full_name: string | null;
    linkedin_url: string;
    pipeline: Record<string, string | null> | null;
  }> = [];

  if (sub.domain || sub.website) {
    // Match enriched leads by either exact website or by domain substring
    const { data: enrichedRows } = await sb
      .from("leads_to_enrich")
      .select("full_name, linkedin_url, website")
      .or(`website.eq.${sub.website ?? "_none_"},website.ilike.%${sub.domain ?? "_none_"}%`)
      .limit(20);

    const enriched = (enrichedRows ?? []).filter((r) => r.linkedin_url);
    const liUrls = enriched.map((r) => r.linkedin_url as string);

    let pipelineByUrl: Record<string, Record<string, string | null>> = {};
    if (liUrls.length > 0) {
      const { data: pipelineRows } = await sb
        .from("outreach_pipeline")
        .select("linkedin_url, status, invited_at, accepted_at, rendered_at, sent_at, viewed_at, played_at, last_reply_at, last_reply_intent, cta_clicked_at")
        .in("linkedin_url", liUrls);
      for (const p of pipelineRows ?? []) {
        if (p.linkedin_url) pipelineByUrl[p.linkedin_url as string] = p as unknown as Record<string, string | null>;
      }
    }

    linkedinPeople = enriched.map((e) => ({
      full_name: (e.full_name as string) ?? null,
      linkedin_url: e.linkedin_url as string,
      pipeline: pipelineByUrl[e.linkedin_url as string] ?? null,
    }));
  }

  // ── Build the chronological timeline ──
  const events: TimelineEvent[] = [];

  // Form submit event
  if (sub.submitted_at) {
    events.push({
      ts: sub.submitted_at,
      channel: "form",
      title: "Contact form submitted",
      detail: sub.contact_url ? `via ${sub.contact_url}` : (sub.notes ?? undefined),
    });
  }

  // Responses
  for (const r of responses) {
    const ch: Channel = r.channel === "phone" ? "phone" : r.channel === "sms" ? "sms" : "email";
    events.push({
      ts: r.received_at,
      channel: ch,
      title: r.subject || (ch === "phone" ? "Inbound call" : ch === "sms" ? "Inbound SMS" : "Email reply"),
      detail: r.body_excerpt?.slice(0, 280) ?? undefined,
      meta: r.from_address ?? undefined,
    });
  }

  // LinkedIn pipeline events — flatten the named timestamp columns into events
  for (const p of linkedinPeople) {
    const pipe = p.pipeline;
    if (!pipe) continue;
    const personSuffix = p.full_name ? ` · ${p.full_name}` : "";
    const liEvents: Array<[string, string]> = [
      ["invited_at", "LinkedIn connection request sent"],
      ["accepted_at", "Connection accepted"],
      ["rendered_at", "Personalized video rendered"],
      ["sent_at", "Video DM sent"],
      ["viewed_at", "Video viewed"],
      ["played_at", "Video played"],
      ["cta_clicked_at", "CTA clicked"],
      ["last_reply_at", "LinkedIn reply received"],
    ];
    for (const [col, label] of liEvents) {
      const ts = pipe[col];
      if (!ts) continue;
      events.push({
        ts,
        channel: "linkedin",
        title: label + personSuffix,
        detail: col === "last_reply_at" && pipe.last_reply_intent
          ? `Intent: ${pipe.last_reply_intent}`
          : undefined,
        meta: p.linkedin_url.replace(/^https?:\/\//, "").replace(/^www\./, ""),
      });
    }
  }

  // Sort newest first
  events.sort((a, b) => b.ts.localeCompare(a.ts));

  // Counts per channel for the header pills
  const channelCounts: Record<Channel, number> = { form: 0, email: 0, phone: 0, sms: 0, linkedin: 0 };
  for (const e of events) channelCounts[e.channel]++;

  return (
    <div className="min-h-screen bg-[#0f0d0a] text-[var(--cream)]">
      <header className="border-b border-[var(--cream)]/10 px-8 py-6">
        <div className="mx-auto max-w-4xl">
          <a
            href="/test-leads"
            className="text-[10px] font-bold uppercase tracking-[0.3em] text-[#ff6b2c]/80 hover:text-[#ff6b2c]"
          >
            ← back to test-leads
          </a>
          <div className="mt-3 flex flex-wrap items-baseline gap-3">
            <h1 className="font-display text-2xl">{sub.company || sub.domain || "—"}</h1>
            <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#ff6b2c]/80">
              {sub.ref_code}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-[12px] text-[var(--cream)]/55">
            {sub.website && (
              <a
                href={sub.website}
                target="_blank"
                rel="noreferrer"
                className="text-[var(--cream)]/75 underline-offset-2 hover:text-[var(--cream)] hover:underline"
              >
                {sub.domain ?? sub.website}
              </a>
            )}
            {sub.industry && <span>{sub.industry}</span>}
            {sub.city && <span>{sub.city}</span>}
            {sub.phone && <span>{sub.phone}</span>}
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--cream)]/45">
              {sub.status}
            </span>
          </div>
          {/* Channel pills */}
          <div className="mt-5 flex flex-wrap gap-2 text-[11px]">
            {(Object.keys(CHANNEL_BADGE) as Channel[]).map((c) => {
              const n = channelCounts[c];
              if (n === 0) return null;
              const b = CHANNEL_BADGE[c];
              return (
                <span
                  key={c}
                  className={`rounded-full border border-[var(--cream)]/15 bg-[var(--cream)]/[0.03] px-3 py-1 ${b.color}`}
                >
                  {b.icon} {n} {b.label}
                </span>
              );
            })}
            {events.length === 0 && (
              <span className="text-[var(--cream)]/45">No activity yet.</span>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-8 py-8">
        {events.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--cream)]/15 p-8 text-center text-[13px] text-[var(--cream)]/55">
            No activity recorded yet. The submission has{" "}
            {sub.submitted_at ? "been submitted" : "not been submitted"}, and no responses
            have been received.
          </div>
        ) : (
          <ol className="space-y-3">
            {events.map((e, i) => {
              const b = CHANNEL_BADGE[e.channel];
              return (
                <li
                  key={i}
                  className="rounded-xl border border-[var(--cream)]/10 bg-[var(--cream)]/[0.02] p-4"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <div className="flex items-baseline gap-3">
                      <span className={`font-mono text-[10px] uppercase tracking-[0.2em] ${b.color}`}>
                        {b.icon} {b.label}
                      </span>
                      <span className="font-medium text-[14px]">{e.title}</span>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] text-[var(--cream)]/45">
                      <span>{fmtRel(e.ts)}</span>
                      <span className="font-mono">{fmtAbs(e.ts)}</span>
                    </div>
                  </div>
                  {e.meta && (
                    <div className="mt-1 text-[11px] text-[var(--cream)]/55">{e.meta}</div>
                  )}
                  {e.detail && (
                    <div className="mt-2 line-clamp-4 whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--cream)]/70">
                      {e.detail}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {/* LinkedIn people section — even those with no pipeline activity */}
        {linkedinPeople.length > 0 && (
          <section className="mt-10">
            <h2 className="mb-3 text-[10px] font-bold uppercase tracking-[0.3em] text-[var(--cream)]/55">
              LinkedIn contacts at this company
            </h2>
            <ul className="space-y-2">
              {linkedinPeople.map((p) => (
                <li
                  key={p.linkedin_url}
                  className="flex flex-wrap items-baseline justify-between gap-3 rounded-xl border border-[var(--cream)]/10 px-4 py-3 text-[13px]"
                >
                  <div>
                    <span className="font-medium">{p.full_name || "—"}</span>
                    {p.pipeline?.status && (
                      <span className="ml-3 font-mono text-[10px] uppercase tracking-[0.2em] text-[#7ea3bf]">
                        {p.pipeline.status}
                      </span>
                    )}
                  </div>
                  <a
                    href={p.linkedin_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[12px] text-[var(--cream)]/55 underline-offset-2 hover:text-[var(--cream)] hover:underline"
                  >
                    {p.linkedin_url.replace(/^https?:\/\//, "").replace(/^www\./, "")}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}
