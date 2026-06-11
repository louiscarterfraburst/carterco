// Lead Flex scoping join helpers (CEO plan 2026-06-10-leadflex-website-cta).
// Pure functions so vitest can cover both branches without Deno APIs.
//
// The website's scoping modal persists the visitor's answers BEFORE the
// cal.com redirect and puts only a `scoping:<uuid>` token in the booking
// notes. cal-webhook looks for that token in the raw webhook body (covers
// additionalNotes/responses regardless of where cal.com surfaces the field)
// and joins the persisted row onto the lead.

const SCOPING_TOKEN_RE =
  /scoping:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export function extractScopingId(raw: string): string | null {
  const m = raw.match(SCOPING_TOKEN_RE);
  return m ? m[1].toLowerCase() : null;
}

export function formatFlexNote(icp: string, tried: string[]): string {
  const lines = ["Flex-møde booket via carterco.dk", `ICP: ${icp}`];
  if (tried.length) lines.push(`Har prøvet: ${tried.join(", ")}`);
  return lines.join("\n");
}
