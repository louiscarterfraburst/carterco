import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "https://znpaevzwlcfuzqxsbyie.supabase.co";
const supabaseKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  "sb_publishable_rKCrGrKGUr48lEhjqWj3dw_V0kAEKQl";

export async function createClient() {
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing Supabase server environment variables");
  }

  const cookieStore = await cookies();

  return createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Server Components cannot set cookies directly. Add middleware when
          // deploying to a server runtime such as Vercel.
        }
      },
    },
  });
}
