import { NextRequest, NextResponse } from "next/server";
import {
  portalClient,
  portalCookieName,
  portalPasswordEnvVar,
  portalHash,
  PORTAL_COOKIE_MAX_AGE,
} from "@/portal-auth";

// Per-client portal login. Verifies the password in PORTAL_PASSWORD_<SLUG> and
// sets the portal_<slug> cookie. Mirrors the bikenor approval login.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  if (!portalClient(slug)) {
    return NextResponse.json({ error: "unknown_client" }, { status: 404 });
  }
  const expected = process.env[portalPasswordEnvVar(slug)];
  if (!expected) {
    return NextResponse.json({ error: "password_not_configured" }, { status: 503 });
  }
  const { password } = (await req.json().catch(() => ({}))) as { password?: string };
  if (!password || password !== expected) {
    return NextResponse.json({ error: "wrong_password" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(portalCookieName(slug), portalHash(expected), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: PORTAL_COOKIE_MAX_AGE,
  });
  return res;
}
