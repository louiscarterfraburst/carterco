import { createClient } from "@supabase/supabase-js";

const url = process.env.BIKENOR_SUPABASE_URL;
const serviceKey = process.env.BIKENOR_SUPABASE_SERVICE_KEY;

export function createBikenorAdminClient() {
  if (!url) {
    throw new Error(
      "BIKENOR_SUPABASE_URL is not set — point at Nikolaj's dev branch",
    );
  }
  if (!serviceKey) {
    throw new Error(
      "BIKENOR_SUPABASE_SERVICE_KEY is not set — required for the approval UI to bypass RLS",
    );
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function isBikenorConfigured() {
  return Boolean(url && serviceKey);
}

export const BIKENOR_N8N_BASE_URL =
  process.env.BIKENOR_N8N_BASE_URL ?? "https://bikenor.app.n8n.cloud";
