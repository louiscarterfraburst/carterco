import {
  createBikenorAdminClient,
  isBikenorConfigured,
} from "@/utils/supabase/bikenor";
import { DraftActions } from "./draft-actions";

export const dynamic = "force-dynamic";

type DraftRow = {
  id: string;
  pipeline_id: string;
  brand: string;
  channel: string;
  body: string;
  subject: string | null;
  strategy: string | null;
  language: string;
  rationale: string | null;
  status: string;
  created_at: string;
};

export default async function BikenorApprovalPage() {
  if (!isBikenorConfigured()) {
    return (
      <main className="mx-auto max-w-3xl p-8 font-mono text-sm">
        <h1 className="mb-2 text-xl font-bold">Bikenor approval — not configured</h1>
        <p className="text-gray-600">
          Set <code>BIKENOR_SUPABASE_URL</code> and
          <code> BIKENOR_SUPABASE_SERVICE_KEY</code> in your env, then reload.
          Point them at the dev branch on project ref{" "}
          <code>sukelzkzdxghbzhbxprh</code>.
        </p>
      </main>
    );
  }

  const supa = createBikenorAdminClient();
  const { data, error } = await supa
    .from("outreach_drafts")
    .select(
      "id,pipeline_id,brand,channel,body,subject,strategy,language,rationale,status,created_at",
    )
    .eq("status", "pending_approval")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    return (
      <main className="mx-auto max-w-3xl p-8 font-mono text-sm">
        <h1 className="mb-2 text-xl font-bold text-red-700">Query failed</h1>
        <pre className="overflow-auto rounded bg-red-50 p-3 text-xs">
          {JSON.stringify(error, null, 2)}
        </pre>
      </main>
    );
  }

  const drafts = (data ?? []) as DraftRow[];

  return (
    <main className="mx-auto max-w-4xl p-6 font-mono text-sm">
      <header className="mb-6 flex items-baseline justify-between">
        <h1 className="text-xl font-bold">Bikenor — pending drafts</h1>
        <span className="text-xs text-gray-500">{drafts.length} pending</span>
      </header>

      {drafts.length === 0 && (
        <p className="rounded border border-dashed border-gray-300 p-6 text-center text-gray-500">
          No drafts pending approval.
        </p>
      )}

      <ul className="space-y-4">
        {drafts.map((d) => (
          <li key={d.id} className="rounded border border-gray-200 p-4">
            <div className="mb-2 flex flex-wrap items-baseline gap-3 text-xs text-gray-500">
              <span className="rounded bg-gray-100 px-2 py-0.5 font-semibold uppercase">
                {d.brand}
              </span>
              <span>{d.channel}</span>
              <span>{d.language}</span>
              {d.strategy && <span className="italic">{d.strategy}</span>}
              <span className="ml-auto">
                {new Date(d.created_at).toLocaleString("da-DK")}
              </span>
            </div>
            {d.subject && (
              <div className="mb-1 font-semibold">Subject: {d.subject}</div>
            )}
            <DraftActions draft={d} />
            {d.rationale && (
              <p className="mt-2 text-xs text-gray-500">
                rationale: {d.rationale}
              </p>
            )}
          </li>
        ))}
      </ul>

      <footer className="mt-8 text-xs text-gray-500">
        Pointed at <code>{process.env.BIKENOR_SUPABASE_URL}</code> · approvals
        fire <code>OUT.9 — Send Approved Draft</code>.
      </footer>
    </main>
  );
}
