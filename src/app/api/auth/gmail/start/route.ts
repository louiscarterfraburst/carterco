// /api/auth/gmail/start
//
// Kicks off Google OAuth for Gmail read access. User clicks "Forbind Gmail"
// in /outreach → lands here → we redirect to Google's consent screen with
// the right scopes. After consent, Google calls back to /api/auth/gmail/callback.

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";

export async function GET(req: NextRequest) {
  if (!GOOGLE_CLIENT_ID) {
    return new NextResponse("GOOGLE_CLIENT_ID not configured on server", { status: 500 });
  }

  const origin = req.nextUrl.origin;
  const redirectUri = `${origin}/api/auth/gmail/callback`;

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    // gmail.readonly is the minimum scope to list + read messages
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    access_type: "offline",
    prompt: "consent",
    // pass the post-auth destination so the callback knows where to send us
    state: req.nextUrl.searchParams.get("return") ?? "/outreach",
  });

  return NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}
