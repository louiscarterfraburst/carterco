// When a prospect replies "wrong person, talk to our COO/marketingschef" with
// a title but no name, fire a SendPilot lead-database search filtered by that
// title at the same company. Results land via the existing poll-alt-searches
// cron and surface in vw_action_queue as referral / invite_pending rows.
//
// Reuses outreach_pipeline.alt_search_id / alt_search_status (same slot used
// by score-accepted-lead). Safe because by the time a referral reply arrives
// (hours/days post-acceptance), any score-accepted-lead search has long since
// finished. We refuse to overwrite a still-pending search to avoid orphaning
// it.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.103.3";
import { fireSendpilotLeadSearch } from "./sendpilot-client.ts";

const SP_API_KEY = Deno.env.get("SENDPILOT_API_KEY") ?? "";

// Generic referential phrases the classifier sometimes hallucinates as a
// "title" when the prospect just said "the right person" / "den rette
// person" without naming a role. SendPilot can't search those.
const TITLE_BLOCKLIST = new Set([
  "right person", "rette person", "rigtige person", "den rette",
  "someone", "anyone", "person", "the right person",
]);

// Prospects often name multiple titles in one breath: "kontakt vores COO
// eller marketingschef", "talk to the CMO or marketing manager", "the CEO,
// CTO or head of product". Split on common separators and pass each as a
// distinct jobTitles[] filter — SendPilot ORs them inside the same search.
function splitTitles(raw: string): string[] {
  return raw
    .split(/\s*(?:,|\/|\bor\b|\beller\b|\bog\b|\band\b|&)\s*/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !TITLE_BLOCKLIST.has(t.toLowerCase()));
}

export async function fireReferralTitleSearch(
  supabase: SupabaseClient,
  leadId: string,
  title: string,
): Promise<{ fired: boolean; reason?: string; searchId?: string }> {
  const cleanTitle = title.trim();
  if (!cleanTitle) return { fired: false, reason: "empty_title" };
  if (TITLE_BLOCKLIST.has(cleanTitle.toLowerCase())) {
    return { fired: false, reason: "title_too_generic" };
  }
  const titles = splitTitles(cleanTitle);
  if (titles.length === 0) return { fired: false, reason: "title_too_generic" };

  const { data: pipe } = await supabase
    .from("outreach_pipeline")
    .select("contact_email, alt_search_status")
    .eq("sendpilot_lead_id", leadId)
    .maybeSingle();
  if (!pipe?.contact_email) return { fired: false, reason: "no_pipeline" };
  if (pipe.alt_search_status === "pending") {
    return { fired: false, reason: "search_already_pending" };
  }

  const { data: orig } = await supabase
    .from("outreach_leads")
    .select("company")
    .eq("contact_email", pipe.contact_email)
    .maybeSingle();
  const company = ((orig?.company as string | undefined) ?? "").trim();
  if (!company) return { fired: false, reason: "no_company" };

  const { id, error } = await fireSendpilotLeadSearch({
    apiKey: SP_API_KEY,
    companyName: company,
    titles,
    locations: [],
    limit: 5,
  });
  if (!id) {
    console.error("referral-title search failed", error);
    return { fired: false, reason: error ?? "sendpilot_failed" };
  }

  await supabase.from("outreach_pipeline").update({
    alt_search_id: id,
    alt_search_status: "pending",
    alt_search_kind: "referral_title",
  }).eq("sendpilot_lead_id", leadId);

  return { fired: true, searchId: id };
}
