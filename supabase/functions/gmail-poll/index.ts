// gmail-poll
//
// Polls the user's Gmail inbox for replies to emails we sent via /outreach,
// writes them to outreach_replies (so they appear in the Svar tab and AI
// classify_reply fires on them just like LinkedIn replies do).
//
// Matching strategy: for each outreach_emails row with sent_at set and
// reply_received_at null, query Gmail for messages from the prospect's
// email address sent after sent_at. If a hit is found, treat the first
// matching message as the reply.
//
// Auth: requires a refresh_token stored in public.gmail_tokens. Bootstrap
// via Google OAuth Playground or the /api/auth/gmail/start route (Next.js
// side). Refresh tokens are long-lived; access tokens are minted per run.
//
// Schedule: invoked by pg_cron every 5 minutes via net.http_post.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
};

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method === "GET") return json({ ok: true, name: "gmail-poll" });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return json({ error: "GOOGLE_CLIENT_ID/SECRET not configured" }, 500);
  }

  // Load all stored gmail tokens (multi-user ready; today's row count is 1)
  const { data: tokenRows, error: tokenErr } = await supabase
    .from("gmail_tokens")
    .select("user_email, refresh_token, access_token, expires_at");
  if (tokenErr) return json({ error: `gmail_tokens read: ${tokenErr.message}` }, 500);
  if (!tokenRows || tokenRows.length === 0) {
    return json({ ok: true, message: "no gmail tokens configured — bootstrap one first", checked: 0 });
  }

  let totalReplies = 0;
  let totalChecked = 0;
  const perUser: Array<{ user: string; checked: number; matched: number; errors: string[] }> = [];

  for (const t of tokenRows) {
    const userEmail = t.user_email as string;
    const errors: string[] = [];
    const result = { user: userEmail, checked: 0, matched: 0, errors };

    // Mint a fresh access_token using the refresh token.
    const accessToken = await refreshAccessToken(t.refresh_token as string);
    if (!accessToken) {
      result.errors.push("token refresh failed");
      perUser.push(result);
      continue;
    }

    // Load outreach_emails awaiting a reply, sent in the last 30 days.
    const { data: pending, error: pendErr } = await supabase
      .from("outreach_emails")
      .select("id, workspace_id, pipeline_lead_id, to_email, sent_at")
      .not("sent_at", "is", null)
      .is("reply_received_at", null)
      .gte("sent_at", new Date(Date.now() - 30 * 24 * 3600_000).toISOString())
      .order("sent_at", { ascending: false });
    if (pendErr) { result.errors.push(`pending read: ${pendErr.message}`); perUser.push(result); continue; }

    for (const row of pending ?? []) {
      totalChecked++;
      result.checked++;
      const sentEpoch = Math.floor(new Date(row.sent_at as string).getTime() / 1000);
      const q = `from:${row.to_email} after:${sentEpoch}`;
      try {
        const messages = await listMessages(accessToken, q);
        if (messages.length === 0) continue;
        // Take the first (most recent) match
        const messageId = messages[0].id;
        const detail = await getMessage(accessToken, messageId);
        if (!detail) { result.errors.push(`fetch detail failed for ${messageId}`); continue; }

        // Insert as inbound reply. workspace_id + sendpilot_lead_id mirror
        // outreach_emails so the Svar tab + classify_reply pick it up.
        const replyBody = detail.body || detail.snippet || "(no body)";
        const { data: insertedReply, error: insErr } = await supabase
          .from("outreach_replies")
          .insert({
            sendpilot_lead_id: row.pipeline_lead_id,
            workspace_id: row.workspace_id,
            linkedin_url: null,
            direction: "inbound",
            message: replyBody,
            external_id: `gmail:${messageId}`,
          })
          .select("id")
          .single();
        if (insErr) {
          // duplicate external_id means we already imported this — skip silently
          if (!`${insErr.message}`.includes("duplicate")) {
            result.errors.push(`insert reply: ${insErr.message}`);
          }
          continue;
        }

        // Update outreach_emails so the queue stops asking us to send again
        await supabase.from("outreach_emails")
          .update({
            reply_received_at: new Date().toISOString(),
            reply_message_id: messageId,
            gmail_thread_id: detail.threadId ?? null,
            reply_snippet: (detail.snippet ?? "").slice(0, 240),
          })
          .eq("id", row.id);

        // Also stamp the pipeline so the I dag queue updates immediately
        await supabase.from("outreach_pipeline")
          .update({ last_reply_at: new Date().toISOString() })
          .eq("sendpilot_lead_id", row.pipeline_lead_id);

        // Fire classify_reply best-effort (mirror sendpilot-webhook pattern)
        // deno-lint-ignore no-explicit-any
        const er: any = (globalThis as any).EdgeRuntime;
        const task = classifyReply(insertedReply.id, replyBody, row.pipeline_lead_id);
        if (er && typeof er.waitUntil === "function") er.waitUntil(task);

        result.matched++;
        totalReplies++;
      } catch (e) {
        result.errors.push(`gmail query: ${(e as Error).message}`);
      }
    }

    perUser.push(result);
  }

  return json({ ok: true, totalChecked, totalReplies, perUser });
});

// ---------- Gmail API helpers ---------------------------------------------

async function refreshAccessToken(refreshToken: string): Promise<string | null> {
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) {
      console.error("token refresh", res.status, await res.text());
      return null;
    }
    const data = await res.json() as { access_token?: string };
    return data.access_token ?? null;
  } catch (e) {
    console.error("refreshAccessToken error", e);
    return null;
  }
}

async function listMessages(accessToken: string, query: string): Promise<Array<{ id: string }>> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=3`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`list HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json() as { messages?: Array<{ id: string }> };
  return data.messages ?? [];
}

async function getMessage(
  accessToken: string,
  id: string,
): Promise<{ threadId?: string; snippet?: string; body?: string } | null> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return null;
  const data = await res.json();
  const body = extractPlainBody(data.payload);
  return {
    threadId: data.threadId,
    snippet: data.snippet,
    body,
  };
}

// Walk MIME parts looking for text/plain; fall back to text/html stripped.
function extractPlainBody(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  // deno-lint-ignore no-explicit-any
  const p = payload as any;
  if (p.body?.data && p.mimeType === "text/plain") {
    return decodeBase64Url(p.body.data);
  }
  if (Array.isArray(p.parts)) {
    for (const part of p.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    // No plain part — try HTML stripped
    for (const part of p.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        const html = decodeBase64Url(part.body.data);
        return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      }
    }
    // Multipart — recurse into first part
    for (const part of p.parts) {
      const inner = extractPlainBody(part);
      if (inner) return inner;
    }
  }
  if (p.body?.data) return decodeBase64Url(p.body.data);
  return "";
}

function decodeBase64Url(b64: string): string {
  const std = b64.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(std), (c) => c.charCodeAt(0)));
  } catch {
    return "";
  }
}

async function classifyReply(replyId: string, text: string, leadId: string): Promise<void> {
  try {
    const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/outreach-ai?op=classify_reply`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return;
    const j = await res.json() as { intent?: string; confidence?: number; reasoning?: string };
    await supabase.from("outreach_replies").update({
      intent: j.intent,
      confidence: j.confidence,
      reasoning: j.reasoning,
      classified_at: new Date().toISOString(),
    }).eq("id", replyId);
    if (j.intent) {
      await supabase.from("outreach_pipeline")
        .update({ last_reply_intent: j.intent })
        .eq("sendpilot_lead_id", leadId);
    }
  } catch (e) {
    console.error("classifyReply error", e);
  }
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
