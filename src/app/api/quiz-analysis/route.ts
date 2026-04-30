import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ─── In-memory caches (process-local; fine for single-instance Vercel/Next dev) ───
type CacheEntry = { data: AnalysisResponse; expiresAt: number };
const analysisCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

type RateBucket = { count: number; windowStart: number };
const rateBuckets = new Map<string, RateBucket>();
const RATE_LIMIT = 5; // per IP per hour
const RATE_WINDOW_MS = 60 * 60 * 1000;

type AnalysisResponse = {
  icp: string;
  currentChannels: string[];
  missingChannels: string[];
  notes: string;
};

const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_CHARS = 8000;

function hashUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function getClientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp;
  return "unknown";
}

function checkRateLimit(ip: string): { ok: true } | { ok: false; resetIn: number } {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > RATE_WINDOW_MS) {
    rateBuckets.set(ip, { count: 1, windowStart: now });
    return { ok: true };
  }
  if (bucket.count >= RATE_LIMIT) {
    return { ok: false, resetIn: RATE_WINDOW_MS - (now - bucket.windowStart) };
  }
  bucket.count += 1;
  return { ok: true };
}

function isValidPublicUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    // Reject internal/private hostnames (basic SSRF guard)
    const host = u.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host.startsWith("169.254.") || // link-local
      host.endsWith(".local") ||
      host.endsWith(".internal")
    ) {
      return null;
    }
    return u;
  } catch {
    return null;
  }
}

async function fetchAndStrip(url: URL): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        // Polite user-agent so admins know who's hitting them
        "User-Agent": "CarterCo-LeadQuiz/1.0 (+https://carterco.dk)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      throw new Error(`Fetch failed: ${res.status}`);
    }
    const html = await res.text();
    // Strip script/style first to avoid leaking JS into prompt
    const cleaned = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
      .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return cleaned.slice(0, MAX_BODY_CHARS);
  } finally {
    clearTimeout(timer);
  }
}

async function analyzeWithClaude(
  url: string,
  bodyText: string,
): Promise<AnalysisResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }
  const client = new Anthropic({ apiKey });

  const systemPrompt = `Du er en B2B-marketing analytiker. Du får tekstindholdet fra en virksomheds hjemmeside og skal udlede:

- icp: 1-2 sætninger om hvem virksomheden sælger til (rolle/branche/størrelse)
- currentChannels: hvilke akkvisitionskanaler de tydeligvis bruger (vælg fra: LinkedIn, Cold email, Meta-annoncer, Google Ads, Referencer, SEO, Indholdsmarkedsføring, Webinarer, Direct mail, Andet)
- missingChannels: hvilke kanaler de bør overveje (samme liste, undgå overlap med currentChannels)
- notes: 1-2 sætninger der opsummerer deres positionering og tone

Returner KUN gyldig JSON (ingen markdown-fences, ingen forklaring). Form:
{"icp":"...","currentChannels":[],"missingChannels":[],"notes":"..."}`;

  const userPrompt = `URL: ${url}

Indhold (forkortet):
${bodyText}`;

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 600,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  // Extract text from first content block
  const block = message.content[0];
  if (!block || block.type !== "text") {
    throw new Error("Claude returned no text");
  }
  const raw = block.text.trim();
  // Strip code fences if Claude added them despite instruction
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("Claude returned non-JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Claude returned non-object");
  }
  const p = parsed as Partial<AnalysisResponse>;
  return {
    icp: typeof p.icp === "string" ? p.icp : "",
    currentChannels: Array.isArray(p.currentChannels)
      ? p.currentChannels.filter((x): x is string => typeof x === "string")
      : [],
    missingChannels: Array.isArray(p.missingChannels)
      ? p.missingChannels.filter((x): x is string => typeof x === "string")
      : [],
    notes: typeof p.notes === "string" ? p.notes : "",
  };
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const url = (body as { url?: unknown })?.url;
  if (typeof url !== "string") {
    return NextResponse.json({ error: "url required" }, { status: 400 });
  }

  const parsedUrl = isValidPublicUrl(url);
  if (!parsedUrl) {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  // Rate limit per IP
  const ip = getClientIp(req);
  const rl = checkRateLimit(ip);
  if (!rl.ok) {
    return NextResponse.json(
      {
        error: "Rate limit exceeded",
        retryInSeconds: Math.ceil(rl.resetIn / 1000),
      },
      { status: 429 },
    );
  }

  const cacheKey = hashUrl(parsedUrl.toString());
  const now = Date.now();
  const cached = analysisCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return NextResponse.json(cached.data);
  }

  try {
    const text = await fetchAndStrip(parsedUrl);
    if (text.length < 50) {
      return NextResponse.json(
        { error: "Site indhold er for kort til analyse" },
        { status: 422 },
      );
    }
    const data = await analyzeWithClaude(parsedUrl.toString(), text);
    analysisCache.set(cacheKey, { data, expiresAt: now + CACHE_TTL_MS });
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Analyse fejlede", detail: message },
      { status: 502 },
    );
  }
}
