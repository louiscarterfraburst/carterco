import { describe, expect, it } from "vitest";
import { routeLeadForm } from "./meta-leadgen-routing.ts";

const SOHO_PAGE = "146975948684005";
const SOHO_WS = "ws-soho";
const KLOSTER_WS = "ws-klosterstraede";
const CR_FORM = "111"; // mødelokaler
const OFFICE_FORM = "222"; // kontorer
const K9_FORM = "333"; // Klosterstræde

const allowlist = { [SOHO_PAGE]: [CR_FORM, OFFICE_FORM, K9_FORM] };
const formMap = { [K9_FORM]: KLOSTER_WS };

describe("routeLeadForm", () => {
  it("routes an allowlisted form to the page workspace by default", () => {
    expect(
      routeLeadForm({
        pageId: SOHO_PAGE,
        formId: CR_FORM,
        pageWorkspaceId: SOHO_WS,
        formWorkspaceMap: formMap,
        pageFormAllowlist: allowlist,
      }),
    ).toEqual({ action: "ingest", workspaceId: SOHO_WS });
  });

  it("lets a form-level mapping override the page workspace", () => {
    expect(
      routeLeadForm({
        pageId: SOHO_PAGE,
        formId: K9_FORM,
        pageWorkspaceId: SOHO_WS,
        formWorkspaceMap: formMap,
        pageFormAllowlist: allowlist,
      }),
    ).toEqual({ action: "ingest", workspaceId: KLOSTER_WS });
  });

  it("skips forms outside the page allowlist", () => {
    expect(
      routeLeadForm({
        pageId: SOHO_PAGE,
        formId: "999",
        pageWorkspaceId: SOHO_WS,
        formWorkspaceMap: formMap,
        pageFormAllowlist: allowlist,
      }),
    ).toEqual({ action: "skip", reason: "form_out_of_scope:999" });
  });

  it("blocks a missing form_id when the page has an allowlist (fail closed)", () => {
    expect(
      routeLeadForm({
        pageId: SOHO_PAGE,
        formId: "",
        pageWorkspaceId: SOHO_WS,
        formWorkspaceMap: formMap,
        pageFormAllowlist: allowlist,
      }),
    ).toEqual({ action: "skip", reason: "form_out_of_scope:none" });
  });

  it("blocks everything when the allowlist is an explicitly-empty array", () => {
    expect(
      routeLeadForm({
        pageId: SOHO_PAGE,
        formId: CR_FORM,
        pageWorkspaceId: SOHO_WS,
        formWorkspaceMap: {},
        pageFormAllowlist: { [SOHO_PAGE]: [] },
      }),
    ).toEqual({ action: "skip", reason: `form_out_of_scope:${CR_FORM}` });
  });

  it("applies no form filter to pages without an allowlist entry", () => {
    expect(
      routeLeadForm({
        pageId: "other-page",
        formId: "",
        pageWorkspaceId: "ws-other",
        formWorkspaceMap: formMap,
        pageFormAllowlist: allowlist,
      }),
    ).toEqual({ action: "ingest", workspaceId: "ws-other" });
  });

  it("ingests via the form map even when the page itself is unmapped", () => {
    expect(
      routeLeadForm({
        pageId: SOHO_PAGE,
        formId: K9_FORM,
        pageWorkspaceId: null,
        formWorkspaceMap: formMap,
        pageFormAllowlist: allowlist,
      }),
    ).toEqual({ action: "ingest", workspaceId: KLOSTER_WS });
  });

  it("skips when neither the page nor the form maps to a workspace", () => {
    expect(
      routeLeadForm({
        pageId: SOHO_PAGE,
        formId: CR_FORM,
        pageWorkspaceId: null,
        formWorkspaceMap: formMap,
        pageFormAllowlist: allowlist,
      }),
    ).toEqual({ action: "skip", reason: `unmapped_page:${SOHO_PAGE}` });
  });
});
