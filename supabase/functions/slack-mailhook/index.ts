// slack-mailhook
//
// CloudMailin → here. The flow is:
//   RB2B → Slack #rb2b-leads → Slack Workflow ("Send an email") →
//     CloudMailin inbound → POST JSON Normalized → here.
//
// Auth: shared token in ?token=... query string. Set SLACK_MAILHOOK_TOKEN.
// CloudMailin JSON Normalized payload shape (relevant fields):
//   { envelope: { from, to, helo_domain, remote_ip },
//     headers:  { subject, from, to, date, ... },
//     plain:    "...plain text body...",
//     html:     "...html body...",
//     attachments: [...] }
//
// We extract visitor signals from the plain-text email body using
// permissive regex — RB2B's Slack message format varies (and they
// occasionally change wording) so we collect what we can and stash the
// full body in payload.raw_body for forensics.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SLACK_MAILHOOK_TOKEN = Deno.env.get("SLACK_MAILHOOK_TOKEN") ?? "";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method === "GET") return json({ ok: true, name: "slack-mailhook" });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (SLACK_MAILHOOK_TOKEN) {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") ?? "";
    if (token !== SLACK_MAILHOOK_TOKEN) return json({ error: "Invalid token" }, 401);
  }

  // CloudMailin posts application/json with JSON Normalized; defensively
  // accept either JSON or form-encoded multipart (in case the dropdown was
  // left on Multipart-Normalized).
  let payload: Record<string, unknown> = {};
  const ct = request.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    try { payload = await request.json(); }
    catch { return json({ error: "Invalid JSON" }, 400); }
  } else {
    const form = await request.formData();
    for (const [k, v] of form.entries()) payload[k] = typeof v === "string" ? v : "";
  }

  const body = pickString(payload, "plain", "text", "body")
    ?? stripHtml(pickString(payload, "html") ?? "")
    ?? "";
  const headers = (payload.headers ?? {}) as Record<string, string>;
  const envelope = (payload.envelope ?? {}) as Record<string, string>;
  const subject = pickString(payload, "subject") ?? headers.subject ?? "";
  const messageId =
    pickString(payload, "message_id", "message-id") ??
    headers["message-id"] ?? headers["Message-Id"] ?? null;

  const extracted = parseRb2bBody(body);

  const { data: ws } = await supabase.rpc("carterco_workspace_id");
  const workspaceId = ws as string | null;
  if (!workspaceId) return json({ error: "workspace not resolvable" }, 500);

  const row = {
    workspace_id: workspaceId,
    source: "rb2b_via_slack_email",
    external_id: messageId,
    signal_type: subject || "visitor.identified",
    identified_at: new Date().toISOString(),
    person_name: extracted.personName,
    person_title: extracted.personTitle,
    person_linkedin_url: extracted.personLinkedinUrl,
    person_email: extracted.personEmail,
    company_name: extracted.companyName,
    company_domain: extracted.companyDomain,
    company_linkedin_url: null,
    company_industry: null,
    company_size: null,
    geo: extracted.geo,
    page_views: extracted.pageViews,
    payload: {
      cloudmailin: payload,
      raw_body: body,
      from: envelope.from ?? headers.from ?? null,
      to: envelope.to ?? headers.to ?? null,
    },
  };

  const { data, error } = await supabase
    .from("outreach_signals")
    .insert(row)
    .select("id")
    .single();

  if (error) {
    if (`${error.message}`.includes("duplicate key")) {
      return json({ ok: true, duplicate: true });
    }
    console.error("signal insert error", error);
    return json({ error: "DB error", details: error.message }, 500);
  }
  return json({ ok: true, id: data.id, extracted });
});

// RB2B's Slack message format varies — common shapes:
//   "🎯 New visitor: John Doe (VP Marketing at Acme Corp)
//    https://linkedin.com/in/johndoe — example.com"
// We pull whatever we can find and leave the rest in raw_body.
function parseRb2bBody(text: string) {
  const linkedinMatch = text.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]+/i);
  const personLinkedinUrl = linkedinMatch ? linkedinMatch[0] : null;

  const emailMatch = text.match(/[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/);
  const personEmail = emailMatch && !emailMatch[0].includes("cloudmailin") && !emailMatch[0].includes("slack") ? emailMatch[0] : null;

  const titleAtMatch = text.match(/([A-Z][\w.&,'\- ]{1,80}?)\s+(?:at|@|hos|i)\s+([\w.&,'\- ]{2,80})/i);
  const personTitle = titleAtMatch ? titleAtMatch[1].trim() : null;
  const companyName = titleAtMatch ? titleAtMatch[2].trim() : null;

  const domainMatch = text.match(/\b(?!linkedin\.com)([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/i);
  const companyDomain = domainMatch ? domainMatch[1] : null;

  const nameMatch = text.match(/(?:visitor|lead|new)[^\n:]*?[:—–-]?\s*([A-ZÆØÅ][\w'’\-]+(?:\s+[A-ZÆØÅ][\w'’\-]+){1,3})/);
  const personName = nameMatch ? nameMatch[1].trim() : null;

  return {
    personName,
    personTitle,
    personLinkedinUrl,
    personEmail,
    companyName,
    companyDomain,
    geo: null,
    pageViews: null,
  };
}

function stripHtml(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function pickString(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
