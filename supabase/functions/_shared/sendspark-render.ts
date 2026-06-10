// Single home for kicking a SendSpark personalized render. Extracted from
// outreach-approve so the manual `render` decision and the play-level
// auto-render-on-accept path (sendpilot-webhook / sendpilot-poll) share one
// code path. The render result lands via sendspark-webhook, which builds the
// DM and moves the pipeline row to pending_approval.
import { firstNameForGreeting, normalizeCompanyName, urlOrigin } from "./text.ts";
import { sendsparkCredsFor } from "./sendspark-config.ts";

// Per-campaign SendSpark dynamic override. Mirrors sendpilot-webhook and
// sendpilot-poll so every render path uses the correct dynamic.
export function pickDynamic(campaignId: string): string {
  const id = (campaignId ?? "").trim();
  if (id) {
    const perCampaign = Deno.env.get(`SS_DYNAMIC_${id}`);
    if (perCampaign) return perCampaign;
  }
  return Deno.env.get("SENDSPARK_DYNAMIC") ?? "";
}

export async function sendsparkRender(
  lead: Record<string, unknown>,
  campaignId = "",
  workspaceId: string | null = null,
): Promise<{ ok: boolean; status: number; errorBody: string }> {
  const creds = sendsparkCredsFor(workspaceId);
  if (creds.source === "missing") {
    return { ok: false, status: 0, errorBody: `no SendSpark creds for workspace ${workspaceId ?? "(null)"}` };
  }
  const payload = {
    processAndAuthorizeCharge: true,
    prospect: {
      contactName: firstNameForGreeting(lead.first_name as string) || "there",
      contactEmail: lead.contact_email as string,
      company: normalizeCompanyName(lead.company as string).slice(0, 80),
      jobTitle: ((lead.title as string) ?? "").slice(0, 100),
      backgroundUrl: urlOrigin(lead.website as string),
    },
  };
  const dynamicId = pickDynamic(campaignId);
  const url =
    `https://api-gw.sendspark.com/v1/workspaces/${creds.workspace}/dynamics/${dynamicId}/prospect`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": creds.apiKey,
      "x-api-secret": creds.apiSecret,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (res.ok) return { ok: true, status: res.status, errorBody: "" };
  const errorBody = await res.text().catch(() => "");
  return { ok: false, status: res.status, errorBody: errorBody.slice(0, 400) };
}
