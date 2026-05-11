// Live-dump a specific SendPilot conversation thread (all messages).
// Usage: GET ?conv=<conversationId>
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SP_API_KEY = Deno.env.get("SENDPILOT_API_KEY") ?? "";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const conv = url.searchParams.get("conv") ?? "";
  if (!conv) return json({ error: "conv param required" }, 400);

  const account = url.searchParams.get("account") ?? "";
  const qs = new URLSearchParams({ limit: "50" });
  if (account) qs.set("accountId", account);
  const res = await fetch(
    `https://api.sendpilot.ai/v1/inbox/conversations/${conv}/messages?${qs}`,
    { headers: { "X-API-Key": SP_API_KEY } },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return json({ error: `sendpilot ${res.status}`, body: body.slice(0, 400) }, 502);
  }
  const body = await res.json().catch(() => null);
  return json({ ok: true, raw: body });
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
