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

  // Skip Slack housekeeping + RB2B onboarding noise before doing any DB work
  if (!isVisitorSignal(body)) {
    return json({ ok: true, skipped: "non-visitor noise" });
  }

  const extracted = parseRb2bBody(body);

  const { data: ws } = await supabase.rpc("carterco_workspace_id");
  const workspaceId = ws as string | null;
  if (!workspaceId) return json({ error: "workspace not resolvable" }, 500);

  const row = {
    workspace_id: workspaceId,
    source: "rb2b_via_slack_email",
    external_id: messageId,
    signal_type: extracted.isRepeat ? "visitor.repeat" : "visitor.identified",
    identified_at: new Date().toISOString(),
    person_name: extracted.personName,
    person_title: extracted.personTitle,
    person_linkedin_url: extracted.personLinkedinUrl,
    person_email: extracted.personEmail,
    company_name: extracted.companyName,
    company_domain: extracted.companyDomain,
    company_linkedin_url: extracted.companyLinkedinUrl,
    company_industry: extracted.companyIndustry,
    company_size: extracted.companySize,
    geo: extracted.geo,
    page_views: extracted.pageViews,
    payload: {
      cloudmailin: payload,
      raw_body: body,
      from: envelope.from ?? headers.from ?? null,
      to: envelope.to ?? headers.to ?? null,
      company_revenue: extracted.companyRevenue,
      is_repeat: extracted.isRepeat,
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
// Filters out RB2B / Slack noise: channel joins, integration adds, RB2B's onboarding
// "Adam from RB2B" test message. Returns true if this body is a real visitor signal.
function isVisitorSignal(text: string): boolean {
  if (/has joined the channel/i.test(text)) return false;
  if (/added an integration to this channel/i.test(text)) return false;
  if (/Hey there.*it'?s Adam from RB2B/i.test(text)) return false;
  // Real signals always have these markers
  return /\*Company\*:|REPEAT VISITOR SIGNAL/i.test(text);
}

// RB2B's Slack message format (free tier, company-level identification):
//
//   Vela Wood *Company*: Vela Wood
//   *LinkedIn*: https://www.linkedin.com/company/vela-wood
//   *Location*: Copenhagen, 84 Vela Wood First identified visiting *<https://carterco.dk/outreach>*
//   on *May 13, 2026 at 05:42AM EDT* Connect on LinkedIn  :linkedin: button More Details...
//   *About <https://velawood.com |Vela Wood>* *Website:* <https://velawood.com >
//   *Est. Employees:* 51-200 *Industry:* Professional And Business Services *Est. Revenue:* $5M - $10M
//
// Repeat visit format prepends ":repeat: REPEAT VISITOR SIGNAL" and includes a page count.
// Note: free tier returns /company/ LinkedIn URLs (company-level). Person-level returns
// /in/ URLs — parser handles both.
function parseRb2bBody(text: string) {
  const isRepeat = /REPEAT VISITOR SIGNAL/i.test(text);

  // *Company*: <Name>
  const cn = text.match(/\*Company\*:\s*([^\n*]+?)(?=\n|\s*\*)/);
  const companyName = cn ? cn[1].trim() : null;

  // *LinkedIn*: <url> — /company/ slug for company-level, /in/ slug for person-level
  const li = text.match(/\*LinkedIn\*:\s*(https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[^\s*<>|]+)/i);
  const liUrl = li ? li[1] : null;
  const isPersonLevel = liUrl ? /\/in\//.test(liUrl) : false;

  // *Location*: City, Region — followed by junk (the company name repeats, then "First
  // identified visiting" or "has visited"). Strip the trailing junk by stopping at those.
  const loc = text.match(/\*Location\*:\s*([^\n*]+?)(?=\s+\S+\s+(?:First identified|has visited)|\s+\*[A-Z]|\n|$)/i);
  const locationRaw = loc ? loc[1].trim() : null;
  // Strip the company name when it appears at the end of the location string
  let location = locationRaw;
  if (location && companyName && location.toLowerCase().endsWith(companyName.toLowerCase())) {
    location = location.slice(0, location.length - companyName.length).trim().replace(/[,\s]+$/, "");
  }

  // Website from *About <URL|Name>* or *Website:* <URL>
  const aboutUrl = text.match(/\*About\s*<\s*(https?:\/\/[^\s|>]+)/i)?.[1]
    ?? text.match(/\*Website:?\*?\s*<\s*(https?:\/\/[^\s|>]+)/i)?.[1]
    ?? null;
  let companyDomain: string | null = null;
  if (aboutUrl) {
    try {
      companyDomain = new URL(aboutUrl.trim()).hostname.replace(/^www\./, "");
    } catch { /* ignore */ }
  }

  // Firmographics — bolded labels followed by free text, terminated by the next bold label
  const industryMatch = text.match(/\*Industry:?\*\s*([^\n*]+?)(?=\s*\*[A-Z]|\n|$)/);
  const employeesMatch = text.match(/\*Est\.\s*Employees:?\*\s*([^\n*]+?)(?=\s*\*[A-Z]|\n|$)/);
  const revenueMatch = text.match(/\*Est\.\s*Revenue:?\*\s*([^\n*]+?)(?=\s*\*[A-Z]|\n|$)/);

  // Visited URL (first-time visit) or implicit URL (repeat visit just says "has visited X pages")
  const visitedUrl = text.match(/First identified visiting\s*\*?\s*<?(https?:\/\/[^\s|>*]+)/i)?.[1] ?? null;
  const pageCount = text.match(/has visited\s*\*?(\d+)\*?\s*pages/i)?.[1] ?? null;

  return {
    // When LinkedIn is /in/ the displayed name IS the person; when /company/ it's company-level only
    personName: isPersonLevel ? companyName : null,
    personTitle: null,
    personLinkedinUrl: isPersonLevel ? liUrl : null,
    personEmail: null,
    companyName,
    companyDomain,
    companyLinkedinUrl: isPersonLevel ? null : liUrl,
    companyIndustry: industryMatch ? industryMatch[1].trim() : null,
    companySize: employeesMatch ? employeesMatch[1].trim() : null,
    companyRevenue: revenueMatch ? revenueMatch[1].trim() : null,
    geo: location ? { raw: location } : null,
    pageViews: visitedUrl ? [{ url: visitedUrl, count: pageCount ? Number(pageCount) : 1 }] : null,
    isRepeat,
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
