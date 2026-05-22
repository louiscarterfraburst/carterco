// One-shot: walk inbound replies with intent in (question, interested) and
// no suggested_reply, then ask outreach-ai/draft_reply to generate the draft.
// Reads its own service role key from the platform env, so auth lines up with
// what outreach-ai expects (no local-vs-deployed key mismatch).
//
// Safe to re-run — idempotent on rows that now have a draft.
// Delete this function after the backlog is cleared.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";

const SUPA_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

Deno.serve(async () => {
  const supabase = createClient(SUPA_URL, SERVICE_ROLE);

  const { data: rows, error } = await supabase
    .from("outreach_replies")
    .select("id, sendpilot_lead_id, intent, received_at")
    .eq("direction", "inbound")
    .in("intent", ["question", "interested"])
    .is("suggested_reply", null)
    .order("received_at", { ascending: false });
  if (error) return json({ ok: false, error: error.message }, 500);

  const results: Array<Record<string, unknown>> = [];
  for (const r of rows ?? []) {
    const res = await fetch(`${SUPA_URL}/functions/v1/outreach-ai?op=draft_reply`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SERVICE_ROLE}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ replyId: r.id }),
    });
    if (!res.ok) {
      results.push({ replyId: r.id, status: res.status, error: (await res.text()).slice(0, 200) });
      continue;
    }
    const j = await res.json();
    if (!j.draft) {
      results.push({ replyId: r.id, error: "no draft returned" });
      continue;
    }
    const { error: upErr } = await supabase
      .from("outreach_replies")
      .update({
        suggested_reply: j.draft,
        suggested_reply_generated_at: new Date().toISOString(),
      })
      .eq("id", r.id);
    if (upErr) {
      results.push({ replyId: r.id, error: `update: ${upErr.message}` });
      continue;
    }
    results.push({ replyId: r.id, ok: true, len: j.draft.length });
  }

  return json({ ok: true, processed: results.length, results });
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
