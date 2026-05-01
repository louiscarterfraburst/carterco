import { createAdminClient } from "@/utils/supabase/admin";
import { markSubmitted, markSkipped, assignResponse } from "./actions";

export const dynamic = "force-dynamic";

type Tab = "worklist" | "submissions" | "unmatched";

type Submission = {
  id: string;
  ref_code: string;
  company: string | null;
  website: string | null;
  domain: string | null;
  industry: string | null;
  city: string | null;
  status: string;
  submitted_at: string | null;
  first_response_at: string | null;
  notes: string | null;
};

type Response = {
  id: string;
  submission_id: string | null;
  channel: string;
  received_at: string;
  from_address: string | null;
  from_domain: string | null;
  subject: string | null;
  body_excerpt: string | null;
};

function warmthBucket(submittedAt: string | null, responseAt: string | null): {
  label: string;
  className: string;
} {
  if (!submittedAt) return { label: "—", className: "text-[var(--cream)]/40" };
  if (!responseAt) {
    const ageMs = Date.now() - new Date(submittedAt).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays > 7) return { label: "no response", className: "text-[var(--cream)]/45" };
    return { label: "waiting", className: "text-[var(--cream)]/55" };
  }
  const dt = (new Date(responseAt).getTime() - new Date(submittedAt).getTime()) / 1000;
  if (dt <= 300) return { label: "warm", className: "text-[#ff6b2c]" };
  if (dt <= 3600) return { label: "lukewarm", className: "text-[#d4a35a]" };
  return { label: "cold", className: "text-[var(--cream)]/55" };
}

function formatDuration(submittedAt: string, responseAt: string): string {
  const sec = (new Date(responseAt).getTime() - new Date(submittedAt).getTime()) / 1000;
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const dt = (Date.now() - new Date(iso).getTime()) / 1000;
  if (dt < 60) return "just now";
  if (dt < 3600) return `${Math.round(dt / 60)}m ago`;
  if (dt < 86400) return `${Math.round(dt / 3600)}h ago`;
  return `${Math.round(dt / 86400)}d ago`;
}

export default async function TestLeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const params = await searchParams;
  const tab: Tab =
    params.tab === "submissions" || params.tab === "unmatched"
      ? params.tab
      : "worklist";

  const sb = createAdminClient();

  // Counts for the tab labels
  const [worklistCount, submittedCount, unmatchedCount] = await Promise.all([
    sb.from("test_submissions").select("id", { count: "exact", head: true }).eq("status", "pending"),
    sb.from("test_submissions").select("id", { count: "exact", head: true }).eq("status", "submitted"),
    sb.from("test_responses").select("id", { count: "exact", head: true }).is("submission_id", null),
  ]);

  return (
    <div className="min-h-screen bg-[#0f0d0a] text-[var(--cream)]">
      <header className="border-b border-[var(--cream)]/10 px-8 py-6">
        <div className="mx-auto max-w-6xl">
          <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-[#ff6b2c]/80">
            Lead-response testing
          </p>
          <h1 className="mt-1 text-2xl font-display">Tag testen.</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--cream)]/65">
            Submit real form leads to companies. Track who responds, how fast, on what channel.
            Use the data as personalized hooks in Sendspark.
          </p>
          <nav className="mt-6 flex gap-2 text-[11px] font-bold uppercase tracking-[0.18em]">
            <TabLink current={tab} target="worklist" label={`Worklist · ${worklistCount.count ?? 0}`} />
            <TabLink current={tab} target="submissions" label={`Submitted · ${submittedCount.count ?? 0}`} />
            <TabLink current={tab} target="unmatched" label={`Unmatched · ${unmatchedCount.count ?? 0}`} />
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-8 py-8">
        {tab === "worklist" && <WorklistTab />}
        {tab === "submissions" && <SubmissionsTab />}
        {tab === "unmatched" && <UnmatchedTab />}
      </main>
    </div>
  );
}

function TabLink({ current, target, label }: { current: Tab; target: Tab; label: string }) {
  const active = current === target;
  return (
    <a
      href={`/test-leads?tab=${target}`}
      className={`rounded-full border px-4 py-2 transition ${
        active
          ? "border-[#ff6b2c] bg-[#ff6b2c]/10 text-[var(--cream)]"
          : "border-[var(--cream)]/15 text-[var(--cream)]/60 hover:border-[var(--cream)]/30 hover:text-[var(--cream)]"
      }`}
    >
      {label}
    </a>
  );
}

async function WorklistTab() {
  const sb = createAdminClient();
  const { data, error } = await sb
    .from("test_submissions")
    .select("id, ref_code, company, website, domain, industry, city, status, submitted_at, first_response_at, notes")
    .eq("status", "pending")
    .order("inserted_at", { ascending: true })
    .limit(50);

  if (error) return <ErrorBox message={error.message} />;
  const subs: Submission[] = data ?? [];
  if (subs.length === 0) return <EmptyBox label="No pending companies in the worklist." />;

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-[var(--cream)]/55">
        Pull a row, paste the <code className="rounded bg-[var(--cream)]/8 px-1">ref_code</code> into
        the company&apos;s contact form message body, click <strong>Submitted</strong>.
      </p>
      <div className="overflow-hidden rounded-2xl border border-[var(--cream)]/10">
        {subs.map((s) => (
          <div
            key={s.id}
            className="flex flex-col gap-3 border-b border-[var(--cream)]/8 p-5 last:border-b-0 sm:flex-row sm:items-center"
          >
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-baseline gap-3">
                <span className="font-display text-lg">{s.company || "—"}</span>
                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#ff6b2c]/80">
                  {s.ref_code}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-[12px] text-[var(--cream)]/55">
                {s.website && (
                  <a
                    href={s.website}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[var(--cream)]/75 underline-offset-2 hover:text-[var(--cream)] hover:underline"
                  >
                    {s.domain ?? s.website}
                  </a>
                )}
                {s.industry && <span>{s.industry}</span>}
                {s.city && <span>{s.city}</span>}
              </div>
            </div>
            <form action={markSubmitted} className="flex shrink-0 items-center gap-2">
              <input type="hidden" name="id" value={s.id} />
              <input
                name="submitted_by"
                placeholder="who?"
                className="w-24 rounded-md border border-[var(--cream)]/15 bg-transparent px-3 py-2 text-[12px] placeholder:text-[var(--cream)]/35 focus:border-[#ff6b2c] focus:outline-none"
              />
              <button
                type="submit"
                className="rounded-full bg-[#ff6b2c] px-5 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[#14110d] hover:bg-[#ff8451]"
              >
                Submitted
              </button>
            </form>
            <form action={markSkipped} className="shrink-0">
              <input type="hidden" name="id" value={s.id} />
              <button
                type="submit"
                className="rounded-full border border-[var(--cream)]/15 px-4 py-2 text-[11px] uppercase tracking-[0.18em] text-[var(--cream)]/55 hover:border-[var(--cream)]/30 hover:text-[var(--cream)]"
              >
                Skip
              </button>
            </form>
          </div>
        ))}
      </div>
      {subs.length === 50 && (
        <p className="text-[11px] text-[var(--cream)]/40">Showing first 50 — work through these and refresh.</p>
      )}
    </div>
  );
}

async function SubmissionsTab() {
  const sb = createAdminClient();
  const { data, error } = await sb
    .from("test_submissions")
    .select("id, ref_code, company, website, domain, industry, city, status, submitted_at, first_response_at, notes")
    .eq("status", "submitted")
    .order("submitted_at", { ascending: false })
    .limit(200);

  if (error) return <ErrorBox message={error.message} />;
  const subs: Submission[] = data ?? [];
  if (subs.length === 0) return <EmptyBox label="No submissions yet — go work through the worklist." />;

  // Warmth distribution
  let warm = 0, lukewarm = 0, cold = 0, waiting = 0, none = 0;
  for (const s of subs) {
    const w = warmthBucket(s.submitted_at, s.first_response_at).label;
    if (w === "warm") warm++;
    else if (w === "lukewarm") lukewarm++;
    else if (w === "cold") cold++;
    else if (w === "waiting") waiting++;
    else if (w === "no response") none++;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Warm ≤5m" value={warm} accent="text-[#ff6b2c]" />
        <Stat label="Lukewarm ≤1h" value={lukewarm} accent="text-[#d4a35a]" />
        <Stat label="Cold >1h" value={cold} accent="text-[var(--cream)]/65" />
        <Stat label="Waiting" value={waiting} accent="text-[var(--cream)]/55" />
        <Stat label="No response" value={none} accent="text-[var(--cream)]/40" />
      </div>

      <div className="overflow-hidden rounded-2xl border border-[var(--cream)]/10">
        <table className="w-full text-[13px]">
          <thead className="bg-[var(--cream)]/[0.03] text-[10px] uppercase tracking-[0.2em] text-[var(--cream)]/55">
            <tr>
              <th className="px-4 py-3 text-left">Company</th>
              <th className="px-4 py-3 text-left">Submitted</th>
              <th className="px-4 py-3 text-left">Time to respond</th>
              <th className="px-4 py-3 text-left">Bucket</th>
            </tr>
          </thead>
          <tbody>
            {subs.map((s) => {
              const w = warmthBucket(s.submitted_at, s.first_response_at);
              return (
                <tr key={s.id} className="border-t border-[var(--cream)]/6">
                  <td className="px-4 py-3">
                    <div className="font-medium">{s.company}</div>
                    <div className="text-[11px] text-[var(--cream)]/45">{s.domain}</div>
                  </td>
                  <td className="px-4 py-3 text-[var(--cream)]/65">
                    {formatRelative(s.submitted_at)}
                  </td>
                  <td className="px-4 py-3">
                    {s.submitted_at && s.first_response_at
                      ? formatDuration(s.submitted_at, s.first_response_at)
                      : "—"}
                  </td>
                  <td className={`px-4 py-3 font-mono text-[11px] uppercase tracking-[0.2em] ${w.className}`}>
                    {w.label}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

async function UnmatchedTab() {
  const sb = createAdminClient();
  const [responses, submitted] = await Promise.all([
    sb
      .from("test_responses")
      .select("id, submission_id, channel, received_at, from_address, from_domain, subject, body_excerpt")
      .is("submission_id", null)
      .order("received_at", { ascending: false })
      .limit(100),
    sb
      .from("test_submissions")
      .select("id, ref_code, company, domain")
      .eq("status", "submitted")
      .order("submitted_at", { ascending: false })
      .limit(500),
  ]);

  if (responses.error) return <ErrorBox message={responses.error.message} />;
  const orphans: Response[] = responses.data ?? [];
  const submittedRows = (submitted.data ?? []) as { id: string; ref_code: string; company: string | null; domain: string | null }[];

  if (orphans.length === 0) return <EmptyBox label="No unmatched replies — all responses attributed." />;

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-[var(--cream)]/55">
        Replies the poller couldn&apos;t attribute. Pick the right submission to assign manually.
      </p>
      {orphans.map((r) => (
        <div
          key={r.id}
          className="rounded-xl border border-[var(--cream)]/10 p-4"
        >
          <div className="flex flex-wrap items-baseline gap-3 text-[13px]">
            <span className="font-medium">{r.from_address}</span>
            <span className="text-[var(--cream)]/45">{formatRelative(r.received_at)}</span>
          </div>
          {r.subject && (
            <div className="mt-1 text-[14px] font-medium">{r.subject}</div>
          )}
          {r.body_excerpt && (
            <div className="mt-2 line-clamp-3 text-[12px] leading-relaxed text-[var(--cream)]/65">
              {r.body_excerpt.slice(0, 400)}
            </div>
          )}
          <form action={assignResponse} className="mt-3 flex flex-wrap items-center gap-2">
            <input type="hidden" name="response_id" value={r.id} />
            <select
              name="submission_id"
              required
              className="flex-1 min-w-0 rounded-md border border-[var(--cream)]/15 bg-[#14110d] px-3 py-2 text-[12px] text-[var(--cream)]"
            >
              <option value="">— assign to submission —</option>
              {submittedRows.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.company || s.domain} · {s.ref_code}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="rounded-full bg-[var(--forest)] px-4 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[#fff8ea] hover:opacity-90"
            >
              Assign
            </button>
          </form>
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="rounded-xl border border-[var(--cream)]/10 px-4 py-3">
      <div className={`font-display text-2xl ${accent}`}>{value}</div>
      <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--cream)]/45">
        {label}
      </div>
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-[13px] text-red-200">
      {message}
    </div>
  );
}

function EmptyBox({ label }: { label: string }) {
  return (
    <div className="rounded-xl border border-dashed border-[var(--cream)]/15 p-8 text-center text-[13px] text-[var(--cream)]/55">
      {label}
    </div>
  );
}
