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
const APIFY_EMAIL_ACTOR = "anchor~linkedin-to-email";

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
  companyName: string | null;       // for CVR lookup (DK leads)
  personName: string | null;        // for proximity matching / log
  firstName: string | null;
  lastName: string | null;
  contactEmail: string | null;
};

type Trace = {
  target: { kind: Kind; id: string; linkedinUrl: string | null; companyDomain: string | null };
  scrape: {
    tried: string[];
    directs: string[]; offices: string[];
    emails_personal: string[];
    emails_generic: string[];
    error?: string;
  };
  cvr?: { tried?: boolean; cvr_number?: string | null; owner_email?: string | null; office_phone?: string | null; error?: string };
  apify: { skipped?: string; error?: string; mobile?: string | null; raw?: unknown };
  apify_email?: { skipped?: string; error?: string; email?: string | null; raw?: unknown };
  decision: {
    phone_direct: string | null; phone_office: string | null; phone_source: string | null;
    email_direct: string | null; email_office: string | null; email_source: string | null;
  };
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

  // ---------- Source 1: website scrape (phone + email) ----------
  const trace: Trace = {
    target: { kind: target.kind, id: target.id, linkedinUrl: target.linkedinUrl, companyDomain: target.companyDomain },
    scrape: { tried: [], directs: [], offices: [], emails_personal: [], emails_generic: [] },
    apify: {},
    decision: {
      phone_direct: null, phone_office: null, phone_source: null,
      email_direct: null, email_office: null, email_source: null,
    },
  };

  if (target.companyDomain) {
    try {
      const r = await scrapeWebsite(target.companyDomain, target.firstName, target.lastName);
      trace.scrape = { ...r };
      if (r.directs.length > 0) {
        trace.decision.phone_direct = r.directs[0];
        trace.decision.phone_source = "scrape";
      }
      if (r.offices.length > 0) {
        trace.decision.phone_office = r.offices[0];
      }
      if (r.emails_personal.length > 0) {
        trace.decision.email_direct = r.emails_personal[0];
        trace.decision.email_source = "scrape";
      }
      if (r.emails_generic.length > 0) {
        trace.decision.email_office = r.emails_generic[0];
      }
    } catch (e) {
      trace.scrape.error = `${(e as Error).message}`;
    }
  } else {
    trace.scrape.error = "no company_domain";
  }

  // ---------- Source 1b: CVR.dk lookup (DK companies only) ----------
  // Returns company-registered phone + email. Often the owner's personal email
  // for sole-trader companies (e.g. mark@futureable.dk, petertrollebonnesen@me.com).
  // Free, no auth required for cvrapi.dk (1000 reqs/day rate limit).
  if (target.companyName && /\.(dk)\/?$/i.test(target.companyDomain ?? "") || (target.companyName && !target.companyDomain)) {
    try {
      const cvr = await cvrLookup(target.companyName);
      trace.cvr = { tried: true, cvr_number: cvr.vat, owner_email: cvr.email, office_phone: cvr.phone };
      if (!trace.decision.email_direct && cvr.email) {
        // CVR-registered email — often direct/personal for small businesses
        const isGeneric = /^(info|kontakt|contact|hello|support|admin)@/i.test(cvr.email);
        if (isGeneric && !trace.decision.email_office) {
          trace.decision.email_office = cvr.email;
        } else if (!isGeneric) {
          trace.decision.email_direct = cvr.email;
          trace.decision.email_source = "cvr";
        }
      }
      if (!trace.decision.phone_direct && cvr.phone) {
        trace.decision.phone_office = trace.decision.phone_office ?? cvr.phone;
      }
    } catch (e) {
      trace.cvr = { tried: true, error: `${(e as Error).message}` };
    }
  } else {
    trace.cvr = { tried: false };
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

  // ---------- Source 3: Apify anchor/linkedin-to-email ----------
  // Fires when we still don't have email_direct after scrape + CVR. Charges
  // ~$0.012 per lookup (success OR miss), so skip when we already have a
  // direct email. Free-tier limit: 1 profile per run, which is fine because
  // scout-phones is invoked per-lead.
  const needEmail = !trace.decision.email_direct;
  if (needEmail && APIFY_API_TOKEN && target.linkedinUrl) {
    try {
      const er = await apifyEmailFinder(target.linkedinUrl);
      trace.apify_email = er;
      if (er.email) {
        trace.decision.email_direct = er.email;
        trace.decision.email_source = "apify_anchor";
      }
    } catch (e) {
      trace.apify_email = { error: `${(e as Error).message}` };
    }
  } else if (!APIFY_API_TOKEN) {
    trace.apify_email = { skipped: "APIFY_API_TOKEN not configured" };
  } else if (!target.linkedinUrl) {
    trace.apify_email = { skipped: "no linkedin_url" };
  } else {
    trace.apify_email = { skipped: "email_direct already found upstream" };
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
      .select("id, person_linkedin_url, person_name, company_domain, company_name, person_email")
      .eq("id", id)
      .single();
    if (!s) return null;
    const [fn, ...rest] = (s.person_name ?? "").split(/\s+/).filter(Boolean);
    return {
      kind, id,
      linkedinUrl: s.person_linkedin_url,
      companyDomain: s.company_domain,
      companyName: s.company_name,
      personName: s.person_name,
      firstName: fn ?? null,
      lastName: rest.length > 0 ? rest.join(" ") : null,
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
    const [fn, ...rest] = (a.name ?? "").split(/\s+/).filter(Boolean);
    return {
      kind, id,
      linkedinUrl: a.linkedin_url,
      companyDomain: null,   // alts don't track website; CVR may still hit by company name
      companyName: a.company,
      personName: a.name,
      firstName: fn ?? null,
      lastName: rest.length > 0 ? rest.join(" ") : null,
      contactEmail: null,
    };
  }

  if (kind === "pipeline") {
    const { data: p } = await supabase
      .from("outreach_pipeline")
      .select("sendpilot_lead_id, linkedin_url, contact_email, workspace_id")
      .eq("sendpilot_lead_id", id)
      .single();
    if (!p) return null;

    let domain: string | null = null;
    let companyName: string | null = null;
    let firstName: string | null = null;
    let lastName: string | null = null;
    if (p.contact_email) {
      const { data: l } = await supabase
        .from("outreach_leads")
        .select("first_name, last_name, website, company")
        .eq("contact_email", p.contact_email)
        .eq("workspace_id", p.workspace_id)
        .maybeSingle();
      if (l) {
        domain = l.website ?? null;
        companyName = l.company ?? null;
        firstName = l.first_name ?? null;
        lastName = l.last_name ?? null;
      }
    }
    const personName = [firstName, lastName].filter(Boolean).join(" ") || null;
    return {
      kind, id,
      linkedinUrl: p.linkedin_url,
      companyDomain: domain,
      companyName,
      personName,
      firstName, lastName,
      contactEmail: p.contact_email,
    };
  }

  return null;
}

async function writeBack(target: Target, trace: Trace): Promise<boolean> {
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    phone_direct: trace.decision.phone_direct,
    phone_office: trace.decision.phone_office,
    phone_source: trace.decision.phone_source,
    phone_scouted_at: now,
    phone_scout_details: trace as unknown as Record<string, unknown>,
    email_direct: trace.decision.email_direct,
    email_office: trace.decision.email_office,
    email_source: trace.decision.email_source,
    email_scouted_at: now,
    email_scout_details: trace as unknown as Record<string, unknown>,
  };

  if (target.kind === "signal") {
    // outreach_signals has phone columns but not email_direct/email_office —
    // person_email is the existing field. Strip email_* keys before writing.
    const signalPatch: Record<string, unknown> = {
      phone_direct: patch.phone_direct,
      phone_office: patch.phone_office,
      phone_source: patch.phone_source,
      phone_scouted_at: patch.phone_scouted_at,
      phone_scout_details: patch.phone_scout_details,
    };
    const { error } = await supabase
      .from("outreach_signals")
      .update(signalPatch)
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
  firstName: string | null,
  lastName: string | null,
): Promise<{
  tried: string[];
  directs: string[]; offices: string[];
  emails_personal: string[]; emails_generic: string[];
}> {
  const clean = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim();
  if (!clean) return { tried: [], directs: [], offices: [], emails_personal: [], emails_generic: [] };

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
  const emailsPersonal = new Set<string>();
  const emailsGeneric = new Set<string>();

  const fnLower = (firstName ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const lnLower = (lastName ?? "").toLowerCase().replace(/[^a-z]/g, "");

  for (const url of candidates) {
    try {
      const html = await fetchHtml(url);
      tried.push(url);
      if (!html) continue;

      // ---- phones ----
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

      const dkMatches = html.match(/\+45[\s.\-]?\d{2}[\s.\-]?\d{2}[\s.\-]?\d{2}[\s.\-]?\d{2}/g) ?? [];
      for (const raw of dkMatches) {
        const phone = normalizePhone(raw);
        if (phone) (url === `https://${clean}/` ? offices : directs).add(phone);
      }
      const intlMatches = html.match(/\+\d{1,3}[\s.\-]?\(?\d{1,4}\)?[\s.\-]?\d{2,4}[\s.\-]?\d{2,4}[\s.\-]?\d{0,4}/g) ?? [];
      for (const raw of intlMatches) {
        const phone = normalizePhone(raw);
        if (phone && phone.length >= 8) {
          (url === `https://${clean}/` ? offices : directs).add(phone);
        }
      }

      // ---- emails ----
      // mailto: links first (most reliable, includes intent)
      const mailtoMatches = html.matchAll(/href=["']mailto:([^"'?]+)/gi);
      for (const m of mailtoMatches) {
        const email = m[1].toLowerCase().trim();
        if (!isValidEmail(email)) continue;
        if (emailLooksPersonal(email, fnLower, lnLower)) emailsPersonal.add(email);
        else emailsGeneric.add(email);
      }

      // Inline email regex (catches text-only emails not wrapped in mailto:)
      const inlineEmails = html.match(/[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [];
      for (const raw of inlineEmails) {
        const email = raw.toLowerCase();
        if (!isValidEmail(email)) continue;
        // Skip emails not on the company's domain (avoid leaking 3rd-party services)
        const emailDomain = email.split("@")[1] ?? "";
        if (!emailDomain.includes(clean.replace(/^www\./, ""))) continue;
        if (emailLooksPersonal(email, fnLower, lnLower)) emailsPersonal.add(email);
        else emailsGeneric.add(email);
      }
    } catch {
      // 404s and timeouts expected — keep iterating
    }
  }

  return {
    tried,
    directs: Array.from(directs), offices: Array.from(offices),
    emails_personal: Array.from(emailsPersonal),
    emails_generic: Array.from(emailsGeneric),
  };
}

function isValidEmail(email: string): boolean {
  if (email.length > 120) return false;
  if (email.endsWith(".png") || email.endsWith(".jpg") || email.endsWith(".gif")) return false;
  if (email.includes("example.") || email.includes("yourdomain")) return false;
  return /^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email);
}

function emailLooksPersonal(email: string, fn: string, ln: string): boolean {
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  if (/^(info|kontakt|contact|hello|hej|support|admin|sales|salg|hr|career|jobs?|noreply|no-reply)@?/.test(email)) {
    return false;
  }
  if (fn && local.includes(fn)) return true;
  if (ln && local.includes(ln)) return true;
  // Pattern like firstname.lastname / firstname_lastname / firstinitial+lastname
  if (/^[a-z]{2,}\.[a-z]{2,}/.test(local)) return true;
  // First name only (no dots) — common for small companies
  if (/^[a-z]{2,12}$/.test(local) && !/(info|sales|admin)/.test(local)) return true;
  return false;
}

// CVR.dk free public API — returns company info incl. directors/owners,
// office phone, and company-registered email (often owner's personal email
// for sole-trader companies). Rate limit: 1000 req/day per IP.
async function cvrLookup(companyName: string): Promise<{
  vat?: string | null; phone?: string | null; email?: string | null;
}> {
  const q = encodeURIComponent(companyName.trim());
  const url = `https://cvrapi.dk/api?country=dk&search=${q}`;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "CarterCo phone-scout/1.0" },
      signal: ctrl.signal,
    });
    if (!res.ok) return {};
    const d = await res.json() as { vat?: string; phone?: string | number; email?: string };
    return {
      vat: d.vat ? String(d.vat) : null,
      phone: d.phone ? `+45${String(d.phone).replace(/\D/g, "")}` : null,
      email: d.email ? d.email.toLowerCase() : null,
    };
  } catch {
    return {};
  } finally {
    clearTimeout(timeout);
  }
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

// anchor/linkedin-to-email — takes LinkedIn URL, returns prospect email if
// the actor's DB has them. Free-tier limit: 1 profile per run, so we always
// call with a single URL. Charges per-lookup whether success or miss, so the
// caller should gate on need (skip when email_direct is already known).
async function apifyEmailFinder(linkedinUrl: string): Promise<{
  email: string | null; raw?: unknown; error?: string;
}> {
  const url = `https://api.apify.com/v2/acts/${APIFY_EMAIL_ACTOR}/run-sync-get-dataset-items?token=${APIFY_API_TOKEN}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startUrls: [{ url: linkedinUrl }] }),
    });
  } catch (e) {
    return { email: null, error: `network: ${(e as Error).message}` };
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return { email: null, error: `apify HTTP ${res.status}: ${txt.slice(0, 200)}` };
  }
  let arr: Array<{ email?: string | null; errorMessage?: string; url?: string }>;
  try { arr = await res.json(); }
  catch { return { email: null, error: "bad json from apify" }; }
  if (!Array.isArray(arr) || arr.length === 0) return { email: null, raw: arr };
  const first = arr[0];
  if (first.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(first.email)) {
    return { email: first.email.toLowerCase(), raw: first };
  }
  return { email: null, raw: first };
}

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
