// Per-workspace SendPilot API key resolution.
//
// The multi-tenant default is ONE SendPilot account (the global
// SENDPILOT_API_KEY), with each workspace's LinkedIn sender distinguished by
// accountId via workspace_senders. Bikenor (PUKY) is the exception: Louis chose
// 2026-06-11 to keep Nikolaj's OWN SendPilot account (its own billing + its own
// connected LinkedIn), so Bikenor sends must use a SEPARATE key.
//
// Safety: if a Bikenor send is attempted but SENDPILOT_API_KEY_BIKENOR is not
// configured, we return "" — NOT the global key. An empty key makes every send
// path fail-safe (the SendPilot client treats a missing key as "cannot verify →
// do not send"). Silently falling back to CarterCo's account would fire
// Nikolaj's outreach from the wrong LinkedIn — the one thing we must never do.
//
// All existing tenants resolve to the global key, byte-for-byte unchanged.

import { BIKENOR_WORKSPACE_ID } from "./workspaces.ts";

type EnvReader = (key: string) => string | undefined;

const denoEnv: EnvReader = (k) => {
  // Read Deno.env without a hard reference to the Deno global, so this module
  // also imports cleanly under vitest (node), where tests pass their own reader.
  // deno-lint-ignore no-explicit-any
  const d = (globalThis as any).Deno;
  return d?.env?.get(k);
};

/**
 * Returns the SendPilot API key to use for a given workspace.
 * - Bikenor → SENDPILOT_API_KEY_BIKENOR (Nikolaj's own account), or "" if unset.
 * - Everything else (incl. null/unknown) → the global SENDPILOT_API_KEY.
 */
export function sendpilotKeyFor(
  workspaceId: string | null | undefined,
  env: EnvReader = denoEnv,
): string {
  if (workspaceId === BIKENOR_WORKSPACE_ID) {
    return env("SENDPILOT_API_KEY_BIKENOR") ?? "";
  }
  return env("SENDPILOT_API_KEY") ?? "";
}
