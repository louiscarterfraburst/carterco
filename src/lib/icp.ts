// UI mirror of supabase/functions/_shared/icp.ts. Must stay in sync with
// that file — Louis tells me what to change, I update both and redeploy.
// Used by /outreach's ICP overview tab.

// ICP is CarterCo-only for now. Tresyv runs a separate outreach for a
// different company. The /outreach UI hides ICP tabs/scores when the
// active workspace isn't CarterCo.
export const CARTERCO_WORKSPACE_ID = "1e067f9a-d453-41a7-8bc4-9fdb5644a5fa";

export const ICP = {
  // POSTURE: very permissive. Repeated misfires from the model
  // over-rejecting on company-name vibes. Score-1 is now reserved
  // for blatantly obvious non-fits only. When uncertain, score 4.
  companyFit: `Carter & Co builds AI/automation systems for small/medium B2B companies.

Default to score 4 for any company unless one of the very narrow
"obvious no" reasons below clearly applies. When in doubt, score 4.

A company is OBVIOUSLY NOT a fit (score 1) ONLY if:
- It is unambiguously a huge corporation (500+ employees worldwide;
  "Maersk", "WPP", "Microsoft" tier), AND nothing in the lead's
  data suggests they're targeting a small DK subsidiary
- It is unambiguously a non-profit / charity / community / school /
  public-sector body, AND not a for-profit affiliated venture
- It is unambiguously a pure consumer-only B2C brand with no B2B side

Everything else is score 3–5:
- 5: clearly a small DK B2B fit — services, agency, industrial, vertical SaaS, SMB
- 4: probably a fit, some uncertainty
- 3: data is ambiguous, but plausibly a fit — be generous

DO NOT auto-classify a company as an "AI/automation tooling vendor"
based on the name alone, or based on tech-sounding industry tags.
Many small DK firms have technical names but are buyers, not
competitors. Only treat them as competitors if their description
EXPLICITLY says they sell AI/automation/RPA platforms as their core
product, AND you have evidence beyond the name.

Do not penalize for having technical-sounding names, niche vertical
focus, or buzzwords in the bio.`,

  personFit: `The right person at the company has budget OR direct influence over
operational/AI/marketing/sales tooling decisions.

For SMALL companies (1–30 employees) the bar is lower: functional heads,
partners, and managers with the relevant domain in their title can champion
or buy these tools directly.

Top fit (5):    Founder, CEO, Co-Founder, Owner, Partner (at any size)
Strong (4):     COO, Managing Director, Head of Operations
Strong (4):     Head of Marketing, Head of Growth
Strong (4):     Head of Sales, Sales Director, Sales Manager, VP Sales
Strong (4):     At small companies (1–30 employees): Information Manager,
                IT Manager, Operations Manager, Digital Manager — they can
                buy tools when their domain matches the offering
Mixed (3):      Director-level at mid-size (30–100); Specialists at small
                companies in adjacent domains
Wrong (1–2):    ICs, junior managers, BDRs, account managers at any size;
                HR / Finance / Legal at SMBs (unless that's the function
                being sold into); employees at huge corps (200+) regardless
                of title`,

  alternateSearchTitles: [
    "CEO", "Founder", "Co-Founder", "Owner", "Partner",
    "COO", "Chief Operating Officer", "Managing Director",
    "Head of Operations",
    "Head of Marketing", "Head of Growth",
    "Head of Sales", "Sales Director", "Sales Manager", "VP Sales",
  ],

  alternateSearchLocations: ["Denmark"],

  thresholds: {
    minCompanyScore: 1,   // effectively no auto-rejection on company alone
    minPersonScore: 3,
  },

  lastUpdated: "2026-05-11 (loosened — no auto-reject on company)",
};
