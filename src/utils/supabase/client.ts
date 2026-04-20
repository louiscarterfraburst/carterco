import { createBrowserClient } from "@supabase/ssr";

const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "https://znpaevzwlcfuzqxsbyie.supabase.co";
const supabaseKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  "sb_publishable_rKCrGrKGUr48lEhjqWj3dw_V0kAEKQl";

export function createClient() {
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing Supabase browser environment variables");
  }

  return createBrowserClient(supabaseUrl, supabaseKey);
}
