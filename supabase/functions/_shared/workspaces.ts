// Stable, human-readable labels for workspace IDs. Used to prefix push
// notification titles so the recipient can tell at a glance which client /
// workspace fired the alert.
const WORKSPACE_LABELS: Record<string, string> = {
  "1e067f9a-d453-41a7-8bc4-9fdb5644a5fa": "CarterCo",
  "2740ba1f-d5d5-4008-bf43-b45367c73134": "Tresyv",
};

export function workspaceLabel(id: string | null | undefined): string {
  if (!id) return "?";
  return WORKSPACE_LABELS[id] ?? id.slice(0, 8);
}
