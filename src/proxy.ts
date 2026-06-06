import { NextRequest, NextResponse } from "next/server";
import {
  portalClient,
  portalCookieName,
  portalPasswordEnvVar,
  portalHash,
  portalSafeEqual,
} from "./portal-auth";

// Combined proxy for four unrelated jobs:
//
// 1. Basic-auth gate on /test-leads (admin-only debug page)
// 2. Locale auto-routing on / and /en
// 3. Password gate on /outreach-bikenor (admin approve page for the bikenor pilot)
// 4. Per-client password gate on /portal/<slug> (curated client overview)
//
// The matcher covers all path patterns; the function dispatches.

export const config = {
  matcher: [
    "/",
    "/en",
    "/test-leads/:path*",
    "/outreach-bikenor/:path*",
    "/api/outreach-bikenor/:path*",
    "/portal/:path*",
    "/api/portal/:path*",
  ],
};

const LOCALE_COOKIE = "locale";
const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

const BIKENOR_COOKIE = "bk_approval";

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (
    pathname.startsWith("/outreach-bikenor") ||
    pathname.startsWith("/api/outreach-bikenor")
  ) {
    return bikenorGate(req);
  }

  if (
    pathname.startsWith("/portal") ||
    pathname.startsWith("/api/portal")
  ) {
    return portalGate(req);
  }

  if (pathname.startsWith("/test-leads")) {
    return basicAuthGate(req);
  }

  if (pathname === "/" || pathname === "/en") {
    return localeRoute(req, pathname);
  }

  return NextResponse.next();
}

// ─── /test-leads basic auth ────────────────────────────────────────
//
// Twilio webhooks at /api/twilio/* must stay open (Twilio signs the
// requests; verifyTwilioSignature handles auth there). Set
// ADMIN_BASIC_AUTH=user:password in env (Vercel + .env.local).

function basicAuthGate(req: NextRequest) {
  const expected = process.env.ADMIN_BASIC_AUTH;
  if (!expected) {
    // Fail-closed: if not configured, deny rather than expose.
    return new NextResponse("ADMIN_BASIC_AUTH not configured", { status: 503 });
  }

  const header = req.headers.get("authorization") || "";
  if (!header.startsWith("Basic ")) {
    return challenge();
  }
  const decoded = atob(header.slice("Basic ".length).trim());
  if (decoded !== expected) {
    return challenge();
  }
  return NextResponse.next();
}

function challenge() {
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="carterco-admin"' },
  });
}

// ─── Locale auto-routing ───────────────────────────────────────────
//
// First-time non-DK visitors land on /en. First-time DK visitors land on /.
// Every visit to / or /en sets a "locale" cookie matching the path — so once
// the visitor makes an explicit choice (by clicking the DA · EN switcher),
// that choice sticks and won't get auto-redirected away.
//
// Geo signal: Vercel edge x-vercel-ip-country header (~95% country accuracy;
// VPNs/proxies are the noise). Visible switcher in the nav covers the tail.

function localeRoute(req: NextRequest, pathname: string) {
  const cookie = req.cookies.get(LOCALE_COOKIE)?.value;

  if (pathname === "/en") {
    return withLocaleCookie(NextResponse.next(), "en");
  }

  // pathname === "/"
  // Returning DA visitor — stay, refresh cookie
  if (cookie === "da") {
    return withLocaleCookie(NextResponse.next(), "da");
  }
  // Just clicked DA from /en — they're explicitly here, honor it
  if (cookie === "en") {
    return withLocaleCookie(NextResponse.next(), "da");
  }
  // First-time visitor — geo decides
  const country = req.headers.get("x-vercel-ip-country");
  if (country && country !== "DK") {
    return NextResponse.redirect(new URL("/en", req.url));
  }
  // DK or unknown country (local dev, bots) — stay on DA
  return withLocaleCookie(NextResponse.next(), "da");
}

function withLocaleCookie(res: NextResponse, locale: "da" | "en"): NextResponse {
  res.cookies.set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: LOCALE_COOKIE_MAX_AGE,
    sameSite: "lax",
  });
  return res;
}

// ─── /outreach-bikenor password gate ───────────────────────────────
//
// Admin-only approve page for the bikenor pilot. Set BIKENOR_APPROVAL_PASSWORD
// in env. If unset: prod blocks (503), dev passes through.

function bikenorGate(req: NextRequest) {
  const expected = process.env.BIKENOR_APPROVAL_PASSWORD;
  const url = req.nextUrl;

  if (!expected) {
    if (process.env.NODE_ENV === "production") {
      return new NextResponse(
        "BIKENOR_APPROVAL_PASSWORD not set in this environment",
        { status: 503 },
      );
    }
    return NextResponse.next();
  }

  if (url.pathname === "/outreach-bikenor/login" && req.method === "POST") {
    return NextResponse.next();
  }

  const cookie = req.cookies.get(BIKENOR_COOKIE)?.value;
  if (cookie && safeEqual(cookie, bikenorHash(expected))) {
    return NextResponse.next();
  }

  if (url.pathname === "/outreach-bikenor/login") {
    return NextResponse.next();
  }

  const loginUrl = url.clone();
  loginUrl.pathname = "/outreach-bikenor/login";
  loginUrl.searchParams.set("next", url.pathname + url.search);
  return NextResponse.redirect(loginUrl);
}

// ─── /portal/<slug> per-client password gate ───────────────────────
//
// Curated read-only client overview. Each client has its own password in env
// (PORTAL_PASSWORD_<SLUG>) and its own cookie (portal_<slug>), so one client's
// link never opens another's. If a client's password is unset: prod blocks
// (503), dev passes through. See docs/client-pipeline-view.md.

function portalGate(req: NextRequest) {
  const url = req.nextUrl;
  const parts = url.pathname.split("/").filter(Boolean); // ["portal", slug, ...] or ["api","portal",slug,...]
  const slug = parts[0] === "api" ? parts[2] : parts[1];

  // No slug (bare /portal) or unknown client → let the route 404, nothing to gate.
  if (!slug || !portalClient(slug)) return NextResponse.next();

  const expected = process.env[portalPasswordEnvVar(slug)];
  if (!expected) {
    if (process.env.NODE_ENV === "production") {
      return new NextResponse(
        `${portalPasswordEnvVar(slug)} not set in this environment`,
        { status: 503 },
      );
    }
    return NextResponse.next();
  }

  const loginPath = `/portal/${slug}/login`;

  // Let the login POST (and the login page itself) through unauthenticated.
  if (url.pathname === loginPath) return NextResponse.next();
  if (url.pathname === `/api/portal/${slug}/login` && req.method === "POST") {
    return NextResponse.next();
  }

  const cookie = req.cookies.get(portalCookieName(slug))?.value;
  if (cookie && portalSafeEqual(cookie, portalHash(expected))) {
    return NextResponse.next();
  }

  const loginUrl = url.clone();
  loginUrl.pathname = loginPath;
  loginUrl.searchParams.set("next", url.pathname + url.search);
  return NextResponse.redirect(loginUrl);
}

// Cheap derived value (not cryptographic) — keeps the raw password out of
// cookies in plaintext. Fine for an admin-only page Louis controls.
function bikenorHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return `v1.${Math.abs(h).toString(36)}.${s.length}`;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export {
  bikenorHash,
  BIKENOR_COOKIE,
};
export const BIKENOR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
