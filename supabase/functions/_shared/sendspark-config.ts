// Per-workspace SendSpark credential lookup. Different SendSpark accounts
// (CarterCo, Tresyv, …) each have their own workspace_id + api_key + secret.
// We key env vars on our internal workspace UUID with hyphens replaced by
// underscores (env var names can't contain hyphens):
//
//   SENDSPARK_WORKSPACE_<uuidWithUnderscores>   — SendSpark workspace ID
//   SENDSPARK_API_KEY_<uuidWithUnderscores>     — SendSpark API key
//   SENDSPARK_API_SECRET_<uuidWithUnderscores>  — SendSpark API secret
//
// Falls back to the legacy global SENDSPARK_WORKSPACE / SENDSPARK_API_KEY /
// SENDSPARK_API_SECRET when no per-workspace override is set — keeps the
// original Tresyv flow working without touching its config.

export type SendsparkCreds = {
  apiKey: string;
  apiSecret: string;
  workspace: string;
  source: "per-workspace" | "global" | "missing";
};

function readPerWorkspace(workspaceId: string, suffix: string): string | null {
  const safe = workspaceId.replaceAll("-", "_");
  return Deno.env.get(`${suffix}_${safe}`) ?? null;
}

export function sendsparkCredsFor(workspaceId: string | null | undefined): SendsparkCreds {
  const id = (workspaceId ?? "").trim();
  if (id) {
    const apiKey = readPerWorkspace(id, "SENDSPARK_API_KEY");
    const apiSecret = readPerWorkspace(id, "SENDSPARK_API_SECRET");
    const workspace = readPerWorkspace(id, "SENDSPARK_WORKSPACE");
    if (apiKey && apiSecret && workspace) {
      return { apiKey, apiSecret, workspace, source: "per-workspace" };
    }
  }
  const apiKey = Deno.env.get("SENDSPARK_API_KEY") ?? "";
  const apiSecret = Deno.env.get("SENDSPARK_API_SECRET") ?? "";
  const workspace = Deno.env.get("SENDSPARK_WORKSPACE") ?? "";
  if (apiKey && apiSecret && workspace) {
    return { apiKey, apiSecret, workspace, source: "global" };
  }
  return { apiKey, apiSecret, workspace, source: "missing" };
}
