// Shared text-normalisation helpers for outreach copy.
//
// `normalizeCompanyName` strips legal suffixes (A/S, ApS, IVS, Inc, GmbH, etc.)
// from a raw company name so it reads as the BRAND in marketing copy and
// SendSpark video personalisation — not the boilerplate registered name.
// Idempotent.
//
// Examples:
//   "Aller Leisure A/S"        → "Aller Leisure"
//   "Tagteam ApS"              → "Tagteam"
//   "Story House Egmont A/S"   → "Story House Egmont"
//   "Hornsyld Købmandsgaard A/S" → "Hornsyld Købmandsgaard"
//   "Acme Holding ApS"         → "Acme Holding"
//   "Lars Larsen Group"        → "Lars Larsen Group"   (Group kept — brand)
//   "Mouseflow"                → "Mouseflow"
//   "  Foo, Inc.  "            → "Foo"

const LEGAL_SUFFIX_RE =
  /[\s,.]+(?:a\s*\/?\s*s|aps|ivs|i\s*\/\s*s|k\s*\/\s*s|p\s*\/\s*s|amba|fmba|inc|llc|ltd|gmbh|ag|s\.?a|s\.?l|ab|oy|bv|nv|pty\s+ltd|pte\s+ltd|pvt\s+ltd|sp\.?\s*z\s*o\.?\s*o\.?)\.?\s*$/i;

export function normalizeCompanyName(input: string | null | undefined): string {
  if (!input) return "";
  let s = String(input).replace(/[®™©]/g, "").trim();
  s = s.replace(/\s+/g, " ");
  // Loop a couple of times to catch nested suffixes (rare: "Foo Holding ApS"
  // already strips to "Foo Holding" in one pass since "Holding" is brand,
  // but "Foo ApS Holding ApS" or "Foo Inc, Ltd" need a second pass).
  for (let i = 0; i < 3; i++) {
    const next = s.replace(LEGAL_SUFFIX_RE, "").trim();
    if (next === s) break;
    s = next;
  }
  return s.replace(/[\s,.;:]+$/g, "").trim();
}

// `normalizeWebsiteUrl` reduces a raw website to its bare domain — the form
// you'd say out loud. Strips protocol, www., everything after the first /,
// ?, or # (paths, query strings, fragments), and lowercases the result.
// Use for COPY (LinkedIn message body, voice-overs). For the URL pushed to
// SendSpark's `backgroundUrl`, use `urlOrigin` instead — SendSpark needs a
// real URL but ideally the bare origin so its own scrape decides the locale
// (avoids locked-in /en redirects from upstream scraping).
//
// Examples:
//   "https://www.allerleisure.com/about"  → "allerleisure.com"
//   "https://saasiest.com/?utm_source=li" → "saasiest.com"
//   "www.bygma-vest.dk/"                  → "bygma-vest.dk"
//   "EXAMPLE.COM"                         → "example.com"
//   "blog.example.com/post-1"             → "blog.example.com"
export function normalizeWebsiteUrl(input: string | null | undefined): string {
  if (!input) return "";
  let s = String(input).trim();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");      // strip protocol
  s = s.split(/[/?#]/)[0] ?? "";                      // drop path/query/hash
  s = s.replace(/^www\./i, "");                       // drop www.
  return s.toLowerCase().trim();
}

// `urlOrigin` returns just the protocol+host of a URL — no path, no query,
// no hash. Use for the URL pushed to scrapers/screenshot services (e.g.
// SendSpark `backgroundUrl`) so the upstream scraper hits the bare home
// page and the *site's* geo-detection runs against the scraper's IP,
// instead of pinning whatever locale path SendPilot landed on.
//
// Examples:
//   "https://example.com/en/about?utm=foo"   → "https://example.com/"
//   "https://www.allerleisure.com/en"        → "https://www.allerleisure.com/"
//   "allerleisure.com/da-DK"                 → "https://allerleisure.com/"
//   ""                                       → ""
export function urlOrigin(input: string | null | undefined): string {
  if (!input) return "";
  let s = String(input).trim();
  if (!s) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}/`;
  } catch {
    return "";
  }
}
