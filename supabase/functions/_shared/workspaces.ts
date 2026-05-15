// Stable, human-readable labels for workspace IDs. Used to prefix push
// notification titles so the recipient can tell at a glance which client /
// workspace fired the alert.

export const ODAGROUP_WORKSPACE_ID = "cdfd80d8-33bb-4b64-b778-0a2c5ab78cc6";

const WORKSPACE_LABELS: Record<string, string> = {
  "1e067f9a-d453-41a7-8bc4-9fdb5644a5fa": "CarterCo",
  "2740ba1f-d5d5-4008-bf43-b45367c73134": "Tresyv",
  "f4777612-4615-4734-94de-4745eade3318": "Haugefrom",
  "cdfd80d8-33bb-4b64-b778-0a2c5ab78cc6": "OdaGroup",
};

export function workspaceLabel(id: string | null | undefined): string {
  if (!id) return "?";
  return WORKSPACE_LABELS[id] ?? id.slice(0, 8);
}
