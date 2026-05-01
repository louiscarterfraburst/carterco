import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
}
if (!serviceKey) {
  throw new Error(
    "SUPABASE_SERVICE_ROLE_KEY is not set — admin pages need it to bypass RLS",
  );
}

// Server-side service-role client. Bypasses RLS — never expose to the browser.
// Used by /test-leads (and any future admin-only views) to read tables that
// have RLS enabled with no public policies.
export function createAdminClient() {
  return createClient(url!, serviceKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
