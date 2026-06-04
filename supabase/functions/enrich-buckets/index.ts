// enrich-buckets — generates the Becc-bucket personalization hook for one
// accepted CarterCo lead and writes it onto the pipeline row. Fired async
// (fire-and-forget) from sendpilot-webhook right after a CarterCo accept lands
// in pending_pre_render, so the hook is ready well before the render completes
// and sendspark-webhook bakes it into rendered_message.
//
// POST { leadId: string }
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";
import { generateBucketHook } from "../_shared/bucket-hook.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method === "GET") return json({ ok: true, name: "enrich-buckets" });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { leadId?: string };
  try { body = await request.json(); }
  catch { return json({ error: "invalid JSON" }, 400); }

  const leadId = String(body.leadId ?? "").trim();
  if (!leadId) return json({ error: "leadId required" }, 400);

  try {
    const result = await generateBucketHook(supabase, leadId);
    return json(result);
  } catch (e) {
    // Non-blocking by design: hook stays null, render falls back to the static
    // Bucket-6 website line. Surface the error for logs but return 200.
    console.error("enrich-buckets error", leadId, e);
    return json({ ok: false, reason: `${(e as Error).message}` });
  }
});
