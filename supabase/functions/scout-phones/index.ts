// scout-phones
//
// Unified phone-discovery function. Replaces signal-scout-phones (which is
// kept around for backward compat with the Signaler UI). Accepts a target
// from any of three sources and runs the same waterfall:
//
//   1. Website scrape — homepage + /kontakt + /contact + /team + /about +
//      /om-os. Catches office numbers and occasional direct phones on team
//      pages. Free, fast, ~50% hit rate on DK SMBs.
//   2. Apify parvenu/mobile-phone-enrichment — takes a LinkedIn URL, returns
//      a verified mobile direct dial. $0.20/hit, only charges on success.
//      Database aggregates LinkedIn-derived phones; ~25% hit rate on DK SMB.
//   3. (TODO) LinkedIn cookie-based scraper — for connected leads where #2
//      misses but the prospect has phone on their LinkedIn Contact Info tab.
//      Requires li_at cookie maintenance — deferred until pain demands it.
//
// Inputs (POST body): { kind: 'pipeline' | 'alt' | 'signal', id: string }
//
// Writes phone_direct/phone_office/phone_source/phone_scouted_at/
// phone_scout_details back to the correct table for the kind.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const APIFY_API_TOKEN = Deno.env.get("APIFY_API_TOKEN") ?? "";
const APIFY_PHONE_ACTOR = "parvenu~mobile-phone-enrichment";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

type Kind = "pipeline" | "alt" | "signal";

type Target = {
  kind: Kind;
  id: string;                       // sendpilot_lead_id (pipeline) | alt_contact uuid | signal uuid
  linkedinUrl: string | null;
  companyDomain: string | null;     // for scrape
  personName: string | null;        // for log / future LinkedIn step
  contactEmail: string | null;
};

type Trace = {
  target: { kind: Kind; id: string; linkedinUrl: string | null; companyDomain: string | null };
  scrape: { tried: string[]; directs: string[]; offices: string[]; error?: string };
  apify: { skipped?: string; error?: string; mobile?: string | null; raw?: unknown };
  decision: { phone_direct: string | null; phone_office: string | null; phone_source: string | null };
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method === "GET") return json({ ok: true, name: "scout-phones" });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { kind?: Kind; id?: string };
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }
  if (!body.kind || !body.id) return json({ error: "kind+id required" }, 400);

  const target = await resolveTarget(body.kind, body.id);
  if (!target) return json({ error: "target not found" }, 404);

  // ---------- Source 1: website scrape ----------
  const trace: Trace = {
    target: { kind: target.kind, id: target.id, linkedinUrl: target.linkedinUrl, companyDomain: target.companyDomain },
    scrape: { tried: [], directs: [], offices: [] },
    apify: {},
    decision: { phone_direct: null, phone_office: null, phone_source: null },
  };

  if (target.companyDomain) {
    try {
      const r = await scrapeWebsite(target.companyDomain, target.personName);
      trace.scrape = { ...r };
      if (r.directs.length > 0) {
        trace.decision.phone_direct = r.directs[0];
        trace.decision.phone_source = "scrape";
      }
      if (r.offices.length > 0) {
        trace.decision.phone_office = r.offices[0];
      }
    } catch (e) {
      trace.scrape.error = `${(e as Error).message}`;
    }
  } else {
    trace.scrape.error = "no company_domain";
  }

  // ---------- Source 2: Apify parvenu mobile-phone-enrichment ----------
  // Fire only if scrape didn't already produce a direct phone. Mobile from
  // Apify is higher signal than scraped office, so it can overwrite phone_office
  // → phone_direct slot if we land one.
  const needDirect = !trace.decision.phone_direct;
  if (needDirect && APIFY_API_TOKEN && target.linkedinUrl) {
    try {
      const apifyResult = await apifyMobileFinder(target.linkedinUrl);
      trace.apify = apifyResult;
      if (apifyResult.mobile) {
        trace.decision.phone_direct = apifyResult.mobile;
        trace.decision.phone_source = "apify_parvenu";
      }
    } catch (e) {
      trace.apify.error = `${(e as Error).message}`;
    }
  } else if (!APIFY_API_TOKEN) {
    trace.apify.skipped = "APIFY_API_TOKEN not configured";
  } else if (!target.linkedinUrl) {
    trace.apify.skipped = "no linkedin_url";
  } else {
    trace.apify.skipped = "scrape already found direct";
  }

  // Office fallback: if no direct found but scrape gave us an office, keep it.
  // phone_source reflects whichever source produced phone_direct, OR "scrape"
  // if only an office number was found.
  if (!trace.decision.phone_direct && trace.decision.phone_office) {
    trace.decision.phone_source = "scrape";
  }

  // ---------- Write back ----------
  const writeOk = await writeBack(target, trace);
  if (!writeOk) {
    console.error("scout-phones write failed", target);
    return json({ ok: false, error: "write failed", trace }, 500);
  }

  return json({ ok: true, trace });
});

// ---------- target resolution ----------------------------------------------

async function resolveTarget(kind: Kind, id: string): Promise<Target | null> {
  if (kind === "signal") {
    const { data: s } = await supabase
      .from("outreach_signals")
      .select("id, person_linkedin_url, person_name, company_domain, person_email")
      .eq("id", id)
      .single();
    if (!s) return null;
    return {
      kind, id,
      linkedinUrl: s.person_linkedin_url,
      companyDomain: s.company_domain,
      personName: s.person_name,
      contactEmail: s.person_email,
    };
  }

  if (kind === "alt") {
    const { data: a } = await supabase
      .from("outreach_alt_contacts")
      .select("id, linkedin_url, name, company")
      .eq("id", id)
      .single();
    if (!a) return null;
    // alt_contacts don't track a website. Best-effort: derive domain from the
    // company name later if needed. For now scrape may be skipped for alts.
    return {
      kind, id,
      linkedinUrl: a.linkedin_url,
      companyDomain: null,   // future: resolve via Apollo or manual lookup
      personName: a.name,
      contactEmail: null,
    };
  }

  if (kind === "pipeline") {
    // For pipeline rows the id is sendpilot_lead_id. Resolve LinkedIn URL
    // from pipeline itself; resolve company_domain via outreach_leads.website.
    const { data: p } = await supabase
      .from("outreach_pipeline")
      .select("sendpilot_lead_id, linkedin_url, contact_email, workspace_id")
      .eq("sendpilot_lead_id", id)
      .single();
    if (!p) return null;

    let domain: string | null = null;
    let name: string | null = null;
    if (p.contact_email) {
      const { data: l } = await supabase
        .from("outreach_leads")
        .select("first_name, last_name, website")
        .eq("contact_email", p.contact_email)
        .eq("workspace_id", p.workspace_id)
        .maybeSingle();
      if (l) {
        domain = l.website ?? null;
        name = [l.first_name, l.last_name].filter(Boolean).join(" ") || null;
      }
    }
    return {
      kind, id,
      linkedinUrl: p.linkedin_url,
      companyDomain: domain,
      personName: name,
      contactEmail: p.contact_email,
    };
  }

  return null;
}

async function writeBack(target: Target, trace: Trace): Promise<boolean> {
  const patch = {
    phone_direct: trace.decision.phone_direct,
    phone_office: trace.decision.phone_office,
    phone_source: trace.decision.phone_source,
    phone_scouted_at: new Date().toISOString(),
    phone_scout_details: trace as unknown as Record<string, unknown>,
  };

  if (target.kind === "signal") {
    const { error } = await supabase
      .from("outreach_signals")
      .update(patch)
      .eq("id", target.id);
    if (error) { console.error("signal update", error); return false; }
    return true;
  }
  if (target.kind === "alt") {
    const { error } = await supabase
      .from("outreach_alt_contacts")
      .update(patch)
      .eq("id", target.id);
    if (error) { console.error("alt update", error); return false; }
    return true;
  }
  if (target.kind === "pipeline") {
    const { error } = await supabase
      .from("outreach_pipeline")
      .update(patch)
      .eq("sendpilot_lead_id", target.id);
    if (error) { console.error("pipeline update", error); return false; }
    return true;
  }
  return false;
}

// ---------- Source 1: scrape -----------------------------------------------

async function scrapeWebsite(
  domain: string,
  _personName: string | null,
): Promise<{ tried: string[]; directs: string[]; offices: string[] }> {
  const clean = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim();
  if (!clean) return { tried: [], directs: [], offices: [] };

  const candidates = [
    `https://${clean}/`,
    `https://${clean}/kontakt`,
    `https://${clean}/contact`,
    `https://${clean}/team`,
    `https://${clean}/about`,
    `https://${clean}/om-os`,
    `https://${clean}/medarbejdere`,
    `https://${clean}/ansatte`,
    `https://${clean}/salg`,
    `https://${clean}/sales`,
  ];

  const tried: string[] = [];
  const directs = new Set<string>();
  const offices = new Set<string>();

  for (const url of candidates) {
    try {
      const html = await fetchHtml(url);
      tried.push(url);
      if (!html) continue;

      // tel: links — most reliable signal of a callable number
      const telMatches = html.matchAll(/href=["']tel:([+\d\s().\-]+)["']/gi);
      for (const m of telMatches) {
        const phone = normalizePhone(m[1]);
        if (!phone) continue;
        if (url.includes("/team") || url.includes("/kontakt") || url.includes("/contact") ||
            url.includes("/medarbejdere") || url.includes("/ansatte") ||
            url.includes("/salg") || url.includes("/sales")) {
          directs.add(phone);
        } else {
          offices.add(phone);
        }
      }

      // Inline DK phones (+45 + 8 digits)
      const dkMatches = html.match(/\+45[\s.\-]?\d{2}[\s.\-]?\d{2}[\s.\-]?\d{2}[\s.\-]?\d{2}/g) ?? [];
      for (const raw of dkMatches) {
        const phone = normalizePhone(raw);
        if (phone) (url === `https://${clean}/` ? offices : directs).add(phone);
      }
      // Generic international
      const intlMatches = html.match(/\+\d{1,3}[\s.\-]?\(?\d{1,4}\)?[\s.\-]?\d{2,4}[\s.\-]?\d{2,4}[\s.\-]?\d{0,4}/g) ?? [];
      for (const raw of intlMatches) {
        const phone = normalizePhone(raw);
        if (phone && phone.length >= 8) {
          (url === `https://${clean}/` ? offices : directs).add(phone);
        }
      }
    } catch {
      // 404s and timeouts expected — keep iterating
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

// ---------- Source 2: Apify parvenu mobile-phone-enrichment ----------------

async function apifyMobileFinder(linkedinUrl: string): Promise<{
  mobile: string | null; raw?: unknown; error?: string;
}> {
  const url = `https://api.apify.com/v2/acts/${APIFY_PHONE_ACTOR}/run-sync-get-dataset-items?token=${APIFY_API_TOKEN}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ linkedinUrl }),
    });
  } catch (e) {
    return { mobile: null, error: `network: ${(e as Error).message}` };
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return { mobile: null, error: `apify HTTP ${res.status}: ${txt.slice(0, 200)}` };
  }
  let arr: Array<{ mobile_number?: string | null; success?: boolean }>;
  try {
    arr = await res.json();
  } catch {
    return { mobile: null, error: "bad json from apify" };
  }
  if (!Array.isArray(arr) || arr.length === 0) {
    return { mobile: null, raw: arr };
  }
  const first = arr[0];
  if (!first.success || !first.mobile_number) {
    return { mobile: null, raw: first };
  }
  return { mobile: first.mobile_number, raw: first };
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
