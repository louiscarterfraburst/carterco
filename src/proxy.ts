import { NextRequest, NextResponse } from "next/server";

// Combined proxy for two unrelated jobs:
//
// 1. Basic-auth gate on /test-leads (admin-only debug page)
// 2. Locale auto-routing on / and /en
//
// The matcher covers all three path patterns; the function dispatches.

export const config = {
  matcher: ["/", "/en", "/test-leads/:path*"],
};

const LOCALE_COOKIE = "locale";
const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

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
