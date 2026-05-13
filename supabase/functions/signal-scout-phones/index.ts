// signal-scout-phones
//
// Phone discovery waterfall for an outreach_signals row:
//   1. Website scrape — fetch homepage + /kontakt + /contact + /team + /about,
//      pull tel: links and Danish/international phone patterns. Free, fast, only
//      finds publicly listed numbers.
//   2. Prospeo — query Mobile Finder with linkedinUrl or email; returns mobile
//      (direct dial). Free 75 credits/mo on signup (~7 phones), then $39/mo
//      Starter for 100 phones. Skipped if we already have phone_direct from scrape.
//   3. Office fallback — if no direct found, use the best office number we saw
//      (scrape footer is the only source — Prospeo doesn't return office numbers).
//
// Writes results back to outreach_signals: phone_direct, phone_office,
// phone_source ('scrape' | 'prospeo'), phone_scout_details (full trace).
//
// Auth: requires SUPABASE_SERVICE_ROLE_KEY (server-side). UI invokes via
// supabase.functions.invoke which forwards the user's session JWT — function
// uses service role internally to bypass RLS for the update.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PROSPEO_API_KEY = Deno.env.get("PROSPEO_API_KEY") ?? "";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

type Trace = {
  scrape: { tried: string[]; directs: string[]; offices: string[]; error?: string };
  prospeo: { skipped?: boolean; error?: string; person_phone?: string | null; raw?: unknown };
  decision: { phone_direct: string | null; phone_office: string | null; phone_source: string | null; office_source: string | null };
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method === "GET") return json({ ok: true, name: "signal-scout-phones" });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { signalId?: string };
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const signalId = body.signalId;
  if (!signalId) return json({ error: "signalId required" }, 400);

  const { data: signal, error: sigErr } = await supabase
    .from("outreach_signals")
    .select("*")
    .eq("id", signalId)
    .single();
  if (sigErr || !signal) return json({ error: "signal not found", details: sigErr?.message }, 404);

  const trace: Trace = {
    scrape: { tried: [], directs: [], offices: [] },
    prospeo: {},
    decision: { phone_direct: null, phone_office: null, phone_source: null, office_source: null },
  };

  // Layer 1: scrape
  if (signal.company_domain) {
    try {
      const scrapeResult = await scrapeWebsite(signal.company_domain);
      trace.scrape = { ...trace.scrape, ...scrapeResult };
    } catch (e) {
      trace.scrape.error = String(e);
    }
  }

  // Pick the most likely direct from scrape: if we have person name, prefer
  // numbers found near their name in the HTML. For v1 we just take the first
  // direct-looking number that isn't the office.
  if (trace.scrape.directs.length > 0) {
    trace.decision.phone_direct = trace.scrape.directs[0];
    trace.decision.phone_source = "scrape";
  }
  if (trace.scrape.offices.length > 0) {
    trace.decision.phone_office = trace.scrape.offices[0];
    trace.decision.office_source = "scrape";
  }

  // Layer 2: Prospeo — only if scrape didn't find a direct (saves credits).
  // Always-call mode could be added later if hit rate is poor.
  const needDirect = !trace.decision.phone_direct;
  if (needDirect && PROSPEO_API_KEY && (signal.person_linkedin_url || signal.person_email)) {
    try {
      const ps = await callProspeo({
        linkedinUrl: signal.person_linkedin_url,
        email: signal.person_email,
      });
      trace.prospeo = ps;
      if (ps.person_phone) {
        trace.decision.phone_direct = ps.person_phone;
        trace.decision.phone_source = "prospeo";
      }
    } catch (e) {
      trace.prospeo.error = String(e);
    }
  } else if (!PROSPEO_API_KEY) {
    trace.prospeo.skipped = true;
    trace.prospeo.error = "PROSPEO_API_KEY not configured";
  } else if (!needDirect) {
    trace.prospeo.skipped = true;
  }

  // Persist
  const { error: updErr } = await supabase
    .from("outreach_signals")
    .update({
      phone_direct: trace.decision.phone_direct,
      phone_office: trace.decision.phone_office,
      phone_source: trace.decision.phone_source,
      phone_scouted_at: new Date().toISOString(),
      phone_scout_details: trace,
    })
    .eq("id", signalId);
  if (updErr) return json({ error: "DB update failed", details: updErr.message }, 500);

  return json({
    ok: true,
    phone_direct: trace.decision.phone_direct,
    phone_office: trace.decision.phone_office,
    phone_source: trace.decision.phone_source,
    trace,
  });
});

// ---------- Scrape -------------------------------------------------------

async function scrapeWebsite(domain: string): Promise<{ tried: string[]; directs: string[]; offices: string[] }> {
  const clean = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim();
  if (!clean) return { tried: [], directs: [], offices: [] };

  const candidates = [
    `https://${clean}/`,
    `https://${clean}/kontakt`,
    `https://${clean}/contact`,
    `https://${clean}/team`,
    `https://${clean}/about`,
    `https://${clean}/om-os`,
  ];

  const tried: string[] = [];
  const directs = new Set<string>();
  const offices = new Set<string>();

  for (const url of candidates) {
    try {
      const html = await fetchHtml(url);
      tried.push(url);
      if (!html) continue;

      // tel: links — these are the most reliable signal of a callable number
      const telMatches = html.matchAll(/href=["']tel:([+\d\s().\-]+)["']/gi);
      for (const m of telMatches) {
        const phone = normalizePhone(m[1]);
        if (!phone) continue;
        // Heuristic: numbers on /team or /contact near a person name are
        // directs; numbers on / footer are office. Without DOM context just
        // bucket by URL path.
        if (url.includes("/team") || url.includes("/kontakt") || url.includes("/contact")) {
          directs.add(phone);
        } else {
          offices.add(phone);
        }
      }

      // Inline phone patterns — Danish +45 + 8 digits, generic international
      const dkMatches = html.match(/\+45[\s.\-]?\d{2}[\s.\-]?\d{2}[\s.\-]?\d{2}[\s.\-]?\d{2}/g) ?? [];
      for (const raw of dkMatches) {
        const phone = normalizePhone(raw);
        if (phone) (url === `https://${clean}/` ? offices : directs).add(phone);
      }
      // Generic international (+CC ...)
      const intlMatches = html.match(/\+\d{1,3}[\s.\-]?\(?\d{1,4}\)?[\s.\-]?\d{2,4}[\s.\-]?\d{2,4}[\s.\-]?\d{0,4}/g) ?? [];
      for (const raw of intlMatches) {
        const phone = normalizePhone(raw);
        if (phone && phone.length >= 8) {
          (url === `https://${clean}/` ? offices : directs).add(phone);
        }
      }
    } catch {
      // 404s and timeouts are expected — keep iterating
    }
  }

  return { tried, directs: Array.from(directs), offices: Array.from(offices) };
}

async function fetchHtml(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("text/html") && !ct.includes("text/plain")) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizePhone(raw: string): string | null {
  const cleaned = raw.replace(/[^\d+]/g, "");
  if (cleaned.length < 7) return null;
  return cleaned;
}

// ---------- Prospeo ------------------------------------------------------
//
// Prospeo's Mobile Finder endpoint takes a LinkedIn profile URL or email and
// returns a mobile direct dial when one is verified. 10 credits per valid hit,
// 0 on miss. Free tier: 75 credits/mo. API key passed via X-KEY header.
//
// Endpoint: POST https://api.prospeo.io/mobile-finder
// Body:     { "url": "<linkedin profile url>" }  (or { "email": "..." })
// Response: { "email_status": "...", "response": { "mobile": "+...", ... } }
async function callProspeo(opts: {
  linkedinUrl?: string | null;
  email?: string | null;
}): Promise<{ person_phone: string | null; raw: unknown; error?: string }> {
  const body: Record<string, string> = {};
  if (opts.linkedinUrl) body.url = opts.linkedinUrl;
  else if (opts.email) body.email = opts.email;
  else return { person_phone: null, raw: null, error: "no_input" };

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch("https://api.prospeo.io/mobile-finder", {
      method: "POST",
      headers: {
        "X-KEY": PROSPEO_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data: unknown = null;
    try { data = JSON.parse(text); } catch { /* keep raw text */ }
    if (!res.ok) {
      return {
        person_phone: null,
        raw: data ?? text,
        error: `prospeo http ${res.status}`,
      };
    }
    const obj = data as Record<string, unknown> | null;
    const response = obj?.response as Record<string, unknown> | undefined;
    const personPhone =
      pickPhone(response?.mobile) ??
      pickPhone(response?.phone) ??
      pickPhone(obj?.mobile) ??
      pickPhone(obj?.phone);
    return { person_phone: personPhone, raw: data ?? text };
  } catch (e) {
    return { person_phone: null, raw: null, error: String(e) };
  } finally {
    clearTimeout(timeout);
  }
}

function pickPhone(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return normalizePhone(v);
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const candidate = (obj.number ?? obj.phone ?? obj.value) as unknown;
    if (typeof candidate === "string" && candidate.trim()) return normalizePhone(candidate);
  }
  return null;
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
