// UI mirror of supabase/functions/_shared/icp.ts. Must stay in sync with
// that file — Louis tells me what to change, I update both and redeploy.
// Used by /outreach's ICP overview tab.
export const ICP = {
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
- AI/automation builders themselves (would compete, not buy)
- Pure consumer B2C (no operational ICP fit)

IMPORTANT: niche-vertical B2B SMBs (e.g. "cybersecurity consultancy",
"BIM/AEC tech vendor", "industrial distributor", "boutique design studio",
"Nordic marketing agency") ARE in-ICP. The company having a specialist
tech focus does NOT make it out-of-ICP unless they explicitly build
AI/automation TOOLING themselves. Default to score 4 for any small DK
B2B unless one of the "Not a fit" reasons clearly applies. Reserve
score 1 for the genuinely-out-of-ICP categories listed above.`,

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
    minCompanyScore: 2,
    minPersonScore: 3,
  },

  lastUpdated: "2026-05-11",
};
