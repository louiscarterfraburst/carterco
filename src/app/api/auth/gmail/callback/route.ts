// /api/auth/gmail/callback
//
// Google's OAuth redirect lands here with ?code=... We exchange the code
// for refresh_token + access_token, store them under the signed-in user's
// email, and redirect back to /outreach with a success param.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/utils/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state") ?? "/outreach";
  const error = req.nextUrl.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(`${req.nextUrl.origin}${state}?gmail_error=${encodeURIComponent(error)}`);
  }
  if (!code) {
    return new NextResponse("missing code", { status: 400 });
  }
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return new NextResponse("OAuth not configured on server", { status: 500 });
  }

  const redirectUri = `${req.nextUrl.origin}/api/auth/gmail/callback`;

  // Exchange code → tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    const txt = await tokenRes.text();
    console.error("token exchange failed", tokenRes.status, txt);
    return new NextResponse(`token exchange failed: ${tokenRes.status}`, { status: 500 });
  }
  const tokens = await tokenRes.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
  };
  if (!tokens.refresh_token) {
    // Happens if user previously granted consent — they don't get a fresh
    // refresh token. Tell them to revoke at myaccount.google.com/permissions
    // and try again.
    return new NextResponse(
      "No refresh_token returned. Revoke at https://myaccount.google.com/permissions and reconnect.",
      { status: 400 },
    );
  }

  // Resolve user from session
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) {
    return new NextResponse("Not signed in", { status: 401 });
  }

  // Upsert token row keyed by user_email (RLS enforces user can only write own row)
  const { error: upsertErr } = await supabase
    .from("gmail_tokens")
    .upsert({
      user_email: user.email,
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
      expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      granted_scopes: tokens.scope,
      updated_at: new Date().toISOString(),
    });
  if (upsertErr) {
    console.error("gmail_tokens upsert", upsertErr);
    return new NextResponse(`token storage failed: ${upsertErr.message}`, { status: 500 });
  }

  return NextResponse.redirect(`${req.nextUrl.origin}${state}?gmail_connected=1`);
}
