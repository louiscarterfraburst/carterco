import { NextRequest, NextResponse } from "next/server";
import {
  bikenorHash,
  BIKENOR_COOKIE,
  BIKENOR_COOKIE_MAX_AGE,
} from "@/proxy";

export async function POST(req: NextRequest) {
  const expected = process.env.BIKENOR_APPROVAL_PASSWORD;
  if (!expected) {
    return NextResponse.json(
      { error: "password_not_configured" },
      { status: 503 },
    );
  }
  const { password } = (await req.json()) as { password?: string };
  if (!password || password !== expected) {
    return NextResponse.json({ error: "wrong_password" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(BIKENOR_COOKIE, bikenorHash(expected), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: BIKENOR_COOKIE_MAX_AGE,
  });
  return res;
}
