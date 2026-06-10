// Deno edge functions import npm packages via `npm:` specifiers, which tsc
// can't resolve. The only such module that crosses into the vitest/tsc world
// (via type-only imports from supabase/functions/_shared/*) is supabase-js —
// map it onto the locally installed package so the types line up.
declare module "npm:@supabase/supabase-js@2.103.3" {
  export type { SupabaseClient } from "@supabase/supabase-js";
}
