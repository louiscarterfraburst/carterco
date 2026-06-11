// Lead Flex scoping shared bits (CEO plan 2026-06-10). Used by the
// quiz-submit route (server) and the scoping modal (client validation).
export const ICP_MIN = 10;
export const ICP_MAX = 240;

export function formatScopingNote(icp: string, tried: string[]): string {
  const lines = [`ICP: ${icp}`];
  if (tried.length) lines.push(`Har prøvet: ${tried.join(", ")}`);
  return lines.join("\n");
}
