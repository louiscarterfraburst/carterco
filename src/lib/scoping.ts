// Lead Flex scoping shared bits (CEO plan 2026-06-10). Used by the
// quiz-submit route (server) and the scoping modal (client validation).
export const ICP_MIN = 10;
export const ICP_MAX = 240;
export const CUSTOMER_SOURCE_MIN = 10;
export const CUSTOMER_SOURCE_MAX = 400;

export function formatScopingNote(icp: string, customerSource: string): string {
  const lines = [`ICP: ${icp}`];
  if (customerSource) lines.push(`Kunder kommer fra: ${customerSource}`);
  return lines.join("\n");
}
