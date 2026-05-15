import { NextRequest, NextResponse } from "next/server";

// Protect /test-leads with HTTP Basic Auth.
// Set ADMIN_BASIC_AUTH=user:password in env (Vercel + .env.local).
//
// We only gate /test-leads here. Twilio webhooks at /api/twilio/* must stay
// open (Twilio signs the requests; verifyTwilioSignature handles auth there).

export const config = {
  matcher: ["/test-leads/:path*"],
};

export function proxy(req: NextRequest) {
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
