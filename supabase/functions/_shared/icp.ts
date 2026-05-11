// Single source of truth for CarterCo's ICP definition. Read by:
//   - score-accepted-lead  (Haiku prompt input)
//   - poll-alt-searches    (SendPilot search filters)
//   - /outreach UI ICP tab (read-only overview)
//
// To tune: edit this file, redeploy the two functions, and the UI tab will
// reflect the new values on the next reload. Tell Louis what you changed.

export const ICP = {
  // Free-text fit description fed into Haiku for company scoring.
  companyFit: `Carter & Co builds AI/automation systems for small/medium B2B companies.

A company is a FIT if all three apply:
1. B2B — sells to other businesses, not consumers. Includes any of:
   - Services, agency, consulting (incl. cyber, IT, legal-tech, design,
     marketing, recruitment, finance/accounting)
   - Professional services (specialist consulting in ANY vertical)
   - Light industrial, manufacturing, B2B distribution
   - Vertical SaaS, niche tech tools sold to other businesses
   - Anything else B2B with operational workflows
2. Size 1–100 employees. Sole founders count; freelance partners count.
3. Primarily Denmark; Nordics OK.

NOT a fit (score 1):
- Clearly 200+ employees (out of CarterCo's sweet spot)
- Pure non-profit / community / public sector / educational
- AI/automation TOOLING vendors — companies whose product or primary
  revenue is selling AI/automation tools to others (e.g. AI SaaS,
  RPA platforms, agent frameworks, lead-gen-tool vendors like Apollo).
  This excludes ONLY tool-builders. Consulting firms in cyber, AI, IT,
  legal, or ops who USE automation to enhance their own delivery are
  BUYERS, not competitors — they ARE in-ICP.
- Pure consumer B2C (no operational ICP fit)

IMPORTANT: niche-vertical B2B SMBs (e.g. "cybersecurity consultancy",
"BIM/AEC tech vendor", "industrial distributor", "boutique design studio",
"Nordic marketing agency") ARE in-ICP. The company having a specialist
tech focus does NOT make it out-of-ICP unless they explicitly build
AI/automation TOOLING themselves. Default to score 4 for any small DK
B2B unless one of the "Not a fit" reasons clearly applies. Reserve
score 1 for the genuinely-out-of-ICP categories listed above.`,

  // Free-text buyer-profile fed into Haiku for person scoring.
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

  // Used when SendPilot lead-database is asked for alternates at a company
  // where the originally-accepted person scored too low.
  alternateSearchTitles: [
    "CEO", "Founder", "Co-Founder", "Owner", "Partner",
    "COO", "Chief Operating Officer", "Managing Director",
    "Head of Operations",
    "Head of Marketing", "Head of Growth",
    "Head of Sales", "Sales Director", "Sales Manager", "VP Sales",
  ],

  alternateSearchLocations: ["Denmark"],

  // 1–5 scale. Inclusive at threshold.
  thresholds: {
    minCompanyScore: 2,   // < this → status='rejected_by_icp' (only obvious no-fits)
    minPersonScore: 3,    // < this → trigger SendPilot alternate search
  },

  // Visible in the UI ICP tab so Louis can spot stale config.
  lastUpdated: "2026-05-11",
};

export type IcpScores = {
  companyScore: number;       // 1–5
  personScore: number;        // 1–5
  rationale: string;          // short explanation
};
