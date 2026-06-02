// Resolves the active ICP for a workspace from the icp_versions table.
// Falls back to the hardcoded factory defaults in _shared/icp.ts when the
// DB has no active row (early bootstrap / safety net).
//
// score-accepted-lead and any other function that needs the live ICP should
// call loadActiveIcp(workspaceId) once at the start of a run and pass the
// result down. Each call is one DB roundtrip — don't call per-lead.

import { ICP as FALLBACK } from "./icp.ts";
import { CARTERCO_WORKSPACE_ID } from "./workspaces.ts";

export type ResolvedIcp = {
  versionId: string | null;     // null when falling back to file constants
  version: number;
  companyFit: string;
  personFit: string;
  alternateSearchTitles: string[];
  alternateSearchLocations: string[];
  minCompanyScore: number;
  minPersonScore: number;
  source: "db" | "fallback";
};

type SbClient = {
  from: (t: string) => {
    select: (cols: string) => {
      eq: (col: string, val: unknown) => {
        eq: (col: string, val: unknown) => {
          maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
        };
      };
    };
  };
};

export async function loadActiveIcp(
  supabase: SbClient,
  workspaceId: string,
): Promise<ResolvedIcp> {
  const { data } = await supabase
    .from("icp_versions")
    .select("id, version, company_fit, person_fit, alternate_search_titles, alternate_search_locations, min_company_score, min_person_score")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true)
    .maybeSingle();

  if (data) {
    const row = data as {
      id: string;
      version: number;
      company_fit: string;
      person_fit: string;
      alternate_search_titles: string[];
      alternate_search_locations: string[];
      min_company_score: number;
      min_person_score: number;
    };
    return {
      versionId: row.id,
      version: row.version,
      companyFit: row.company_fit,
      personFit: row.person_fit,
      alternateSearchTitles: row.alternate_search_titles,
      alternateSearchLocations: row.alternate_search_locations,
      minCompanyScore: row.min_company_score,
      minPersonScore: row.min_person_score,
      source: "db",
    };
  }

  // Fallback to factory defaults. The file constants in icp.ts are CarterCo's
  // ICP, so the fallback is ONLY valid for the CarterCo workspace. Any other
  // workspace without an active icp_versions row must NOT be silently scored
  // against CarterCo's ICP — fail loud so the missing seed is fixed.
  if (workspaceId !== CARTERCO_WORKSPACE_ID) {
    throw new Error(
      `loadActiveIcp: no active icp_versions row for workspace ${workspaceId} and no per-workspace fallback (icp.ts defaults are CarterCo-only)`,
    );
  }
  return {
    versionId: null,
    version: 0,
    companyFit: FALLBACK.companyFit,
    personFit: FALLBACK.personFit,
    alternateSearchTitles: FALLBACK.alternateSearchTitles,
    alternateSearchLocations: FALLBACK.alternateSearchLocations,
    minCompanyScore: FALLBACK.thresholds.minCompanyScore,
    minPersonScore: FALLBACK.thresholds.minPersonScore,
    source: "fallback",
  };
}
