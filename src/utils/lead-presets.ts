// Per-lead outcome preset.
//
// Outcome buttons were per-workspace (workspaces.outcome_preset), but Soho's
// workspace receives two kinds of leads from the same Meta page — meeting-room
// enquiries (CR New-copy form) and office enquiries (Office-carter form) — and
// they close differently: a meeting room is self-serve booked via link, an
// office goes viewing → rented. The lead's meta_form_id picks the preset;
// leads without a mapped form fall back to the workspace default.

export const FORM_PRESET_OVERRIDES: Record<string, string> = {
  "1539910014404003": "meeting_room", // Soho · MJ | Leads | CR New-copy (mødelokaler)
  "997952706463015": "office", // Soho · MJ | Leads | Office-carter (kontorer)
};

export function leadOutcomePreset(
  workspacePreset: string,
  metaFormId?: string | null,
): string {
  return (metaFormId && FORM_PRESET_OVERRIDES[metaFormId]) || workspacePreset;
}
