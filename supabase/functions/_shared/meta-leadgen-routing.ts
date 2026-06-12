// Form-level lead routing for Meta lead ads.
//
// A page maps to a default workspace (META_PAGE_WORKSPACE_MAP), but individual
// forms on that page can override the destination (META_FORM_WORKSPACE_MAP) —
// Soho's page hosts forms for two locations: CR New-copy/Office-carter land in
// the Soho workspace while K9 lands in Klosterstræde.
//
// The per-page allowlist keeps its fail-closed semantics: when a page has an
// allowlist entry, a missing form_id or a form outside the list BLOCKS, and an
// explicitly-empty array means "allow nothing". Pages without an entry have no
// form filter.

export type FormRoute =
  | { action: "skip"; reason: string }
  | { action: "ingest"; workspaceId: string };

export function routeLeadForm(opts: {
  pageId: string;
  formId: string;
  pageWorkspaceId: string | null;
  formWorkspaceMap: Record<string, string>;
  pageFormAllowlist: Record<string, string[]>;
}): FormRoute {
  const { pageId, formId, pageWorkspaceId, formWorkspaceMap, pageFormAllowlist } = opts;

  const allow = pageFormAllowlist[pageId];
  if (allow && (!formId || !allow.includes(formId))) {
    return { action: "skip", reason: `form_out_of_scope:${formId || "none"}` };
  }

  const workspaceId = (formId && formWorkspaceMap[formId]) || pageWorkspaceId;
  if (!workspaceId) {
    return { action: "skip", reason: `unmapped_page:${pageId}` };
  }
  return { action: "ingest", workspaceId };
}
