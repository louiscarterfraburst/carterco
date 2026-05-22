// Tresyv client reference library — used by pick-client-reference.ts to
// select 1-3 most-impressive prior clients to mention in a prospect's
// outbound message. Pulled from tresyv.com/cases (2026-05-20) plus
// "Læger uden Grænser" which Rasmus named in his draft but doesn't appear
// on the public cases page.
//
// When this list goes stale, re-fetch /cases via WebFetch and rebuild.
//
// `impressiveness` is a hand-tuned 1-5 score for how much social-proof
// weight the client carries (5 = household name / award winner, 1 = niche
// or generic). Used by the matcher as a tiebreaker.

export type TresyvClient = {
    name: string;
    sectors: string[];          // industries the prospect might recognize
    project_type: string[];     // what we built — e-com, app, B2B platform, etc.
    summary: string;            // one-line description
    metrics: string[];          // concrete numbers (users, products, stores, etc.)
    awards: string[];           // recognitions
    impressiveness: 1 | 2 | 3 | 4 | 5;
    notes?: string;
};

export const TRESYV_CLIENTS: TresyvClient[] = [
    {
        name: "Dansk Blindesamfund",
        sectors: ["non-profit", "accessibility", "membership-org", "public-sector-adjacent"],
        project_type: ["website", "accessibility-platform"],
        summary: "Moderniseret platform skræddersyet til 32.000 blinde og svagsynede brugere",
        metrics: ["32.000 brugere"],
        awards: ["Guld — Best in UX Design, Danish Digital Awards"],
        impressiveness: 5,
        notes: "Strongest social proof — award winner. Always lead with this for any accessibility, non-profit, UX-quality, or member-organization angle.",
    },
    {
        name: "EET Group",
        sectors: ["b2b", "distribution", "it-hardware", "wholesale", "logistics", "european"],
        project_type: ["b2b-webshop", "multi-market-platform"],
        summary: "B2B webshop med 1,8 mio. produkter, 1.100+ brands, samme-dags forsendelse på tværs af 24 europæiske markeder",
        metrics: ["1.8M produkter", "1.100+ brands", "24 europæiske markeder", "30.000+ kunder/år"],
        awards: [],
        impressiveness: 5,
        notes: "Best heavy-B2B reference. Pull when prospect is wholesale, distribution, multi-country, or large product catalog.",
    },
    {
        name: "Maersk Container Industry",
        sectors: ["b2b", "manufacturing", "shipping", "logistics", "industrial"],
        project_type: ["b2b-website", "manufacturer-platform"],
        summary: "Webpræsens for Maersks producent af køle-containere til intermodal-industrien",
        metrics: [],
        awards: [],
        impressiveness: 4,
        notes: "Maersk-brand recognition does heavy lifting even without metrics. Pull for industrial, manufacturing, shipping, or B2B trade prospects.",
    },
    {
        name: "Mercedes-Benz CPH",
        sectors: ["automotive", "retail", "dealership", "premium-brand"],
        project_type: ["e-commerce", "integrated-platform"],
        summary: "Samlet digital løsning til salg, værksted, booking, webshop og kundeservice",
        metrics: [],
        awards: [],
        impressiveness: 4,
        notes: "Premium-brand reference. Pull for automotive, dealership, or any prospect unifying sales + service.",
    },
    {
        name: "Greenmind",
        sectors: ["retail", "e-commerce", "sustainability", "circular-economy", "consumer-electronics"],
        project_type: ["webshop", "omnichannel"],
        summary: "Danmarks største refurbished-elektronik forhandler — webshop integreret med 16 fysiske butikker",
        metrics: ["16 fysiske butikker", "3 års garanti"],
        awards: [],
        impressiveness: 4,
        notes: "Strong for retailers running both physical + online. Sustainability angle is a bonus.",
    },
    {
        name: "Andersen & Martini",
        sectors: ["automotive", "dealership", "retail"],
        project_type: ["e-commerce", "service-booking"],
        summary: "E-commerce platform der samler bilsalg, værkstedsbooking og tilbehør ét sted",
        metrics: [],
        awards: [],
        impressiveness: 3,
        notes: "Use for auto dealers, esp. if Mercedes-Benz CPH is too premium-coded.",
    },
    {
        name: "Biltorvet",
        sectors: ["automotive", "marketplace", "consumer"],
        project_type: ["mobile-app", "marketplace"],
        summary: "App med notifikationer, søgning og agenter til bilannoncer",
        metrics: [],
        awards: [],
        impressiveness: 3,
    },
    {
        name: "Billund Lufthavn",
        sectors: ["travel", "transport", "public-infrastructure", "consumer"],
        project_type: ["website", "platform-framework"],
        summary: "Ny digital ramme der balancerer forretning og brugerbehov for lufthavnens services",
        metrics: [],
        awards: [],
        impressiveness: 4,
        notes: "Recognizable Danish institution. Good for transport, hospitality, or any consumer-facing public service.",
    },
    {
        name: "Billund Lufthavn Tax Free Shop",
        sectors: ["retail", "e-commerce", "travel", "click-and-collect"],
        project_type: ["e-commerce", "shop-and-collect"],
        summary: "Shop & collect-service hvor rejsende bestiller toldfri varer online til afhentning i lufthavnen",
        metrics: [],
        awards: [],
        impressiveness: 3,
    },
    {
        name: "Ønskeskyen",
        sectors: ["consumer", "social", "mobile-first", "gifting"],
        project_type: ["mobile-app", "consumer-platform"],
        summary: "Ønskeliste-app og web — oprettelse, deling og personaliserede anbefalinger på tværs af lejligheder",
        metrics: [],
        awards: [],
        impressiveness: 4,
        notes: "Recognizable consumer brand in DK. Good for B2C apps, social/community products, or anyone selling on emotional/relationship value.",
    },
    {
        name: "Plan Børnefonden",
        sectors: ["non-profit", "fundraising", "donor-management"],
        project_type: ["donor-platform", "website"],
        summary: "Sponsorat-platformen 'MitPlan' der forbinder donorer med fadderbørn og udviklingsprojekter",
        metrics: [],
        awards: [],
        impressiveness: 4,
        notes: "Strong non-profit reference. Pair with Dansk Blindesamfund for org/fundraising prospects.",
    },
    {
        name: "Læger uden Grænser",
        sectors: ["non-profit", "international", "humanitarian", "donor-management"],
        project_type: ["website", "donor-platform"],
        summary: "Digital løsning til Læger uden Grænser (Médecins Sans Frontières)",
        metrics: [],
        awards: [],
        impressiveness: 5,
        notes: "Mentioned by Rasmus directly — not on public /cases page. Strongest non-profit name. Pull for any humanitarian / NGO / mission-driven prospect.",
    },
    {
        name: "AOF",
        sectors: ["education", "non-profit", "membership-org", "events"],
        project_type: ["website", "distributed-platform"],
        summary: "Moderniseret digital platform for national uddannelsesorganisation med kurser og kulturelle events",
        metrics: [],
        awards: [],
        impressiveness: 3,
    },
    {
        name: "2021.AI",
        sectors: ["enterprise-software", "ai", "saas", "b2b"],
        project_type: ["enterprise-platform", "saas"],
        summary: "GRACE AI Platform — enterprise-application der samler udvikling, drift og governance af AI",
        metrics: [],
        awards: [],
        impressiveness: 4,
        notes: "Use for enterprise SaaS, AI/data, or governance-heavy B2B prospects.",
    },
    {
        name: "Enity",
        sectors: ["energy", "sustainability", "saas", "analytics", "b2b"],
        project_type: ["data-platform", "saas"],
        summary: "Energi-platform der omsætter forbrugsdata til indsigt i kWh, CO₂ og kroner",
        metrics: [],
        awards: [],
        impressiveness: 3,
    },
    {
        name: "PC Schematic",
        sectors: ["engineering-software", "industrial", "b2b", "cad"],
        project_type: ["software-product", "professional-tool"],
        summary: "Optimeret software til elektrisk og automations-design med komponentportal og auto-dokumentation",
        metrics: ["tusindvis af brugere"],
        awards: [],
        impressiveness: 3,
    },
    {
        name: "CarbonCuts",
        sectors: ["climate-tech", "industrial", "startup", "sustainability"],
        project_type: ["website", "brand-launch"],
        summary: "Digital tilstedeværelse for CO₂-lagrings-virksomhed",
        metrics: ["1,5 mio. tons CO₂/år kapacitet i 2030"],
        awards: [],
        impressiveness: 3,
    },
    {
        name: "TenFifty",
        sectors: ["fintech", "investment", "wealth-management", "b2b2c"],
        project_type: ["website", "investment-platform"],
        summary: "Investerings-platform med distinkt akvarel-æstetik og diversificerede aktivklasser",
        metrics: [],
        awards: [],
        impressiveness: 3,
    },
    {
        name: "Stine A",
        sectors: ["fashion", "retail", "e-commerce", "brand"],
        project_type: ["webshop", "brand-experience"],
        summary: "Elegant fashion-webshop med klar kategorisering og mix-and-match-styling",
        metrics: [],
        awards: [],
        impressiveness: 3,
    },
    {
        name: "N'AGE",
        sectors: ["beauty", "skincare", "luxury", "e-commerce"],
        project_type: ["webshop", "brand"],
        summary: "Brugervenlig webshop for klinisk hudpleje med større brands og behandlinger",
        metrics: [],
        awards: [],
        impressiveness: 2,
    },
    {
        name: "Soundtracktor",
        sectors: ["music", "marketplace", "creator-economy", "licensing"],
        project_type: ["marketplace", "community-platform"],
        summary: "Global musik-community og webshops der forbinder komponister og brands",
        metrics: [],
        awards: [],
        impressiveness: 3,
    },
    {
        name: "Able",
        sectors: ["food-tech", "b2b", "consumer-app", "mobile-first"],
        project_type: ["mobile-app", "ordering-platform"],
        summary: "Frokost-bestillingsapp med tracking, belønninger, ratings og abonnementer",
        metrics: [],
        awards: [],
        impressiveness: 2,
    },
    {
        name: "FollowBet",
        sectors: ["gaming", "betting", "community", "consumer"],
        project_type: ["platform", "community"],
        summary: "Betting-platform der kombinerer wagering, fællesskab og passion for spillet",
        metrics: [],
        awards: [],
        impressiveness: 2,
    },
    {
        name: "Broløkke",
        sectors: ["hospitality", "tourism", "heritage", "events"],
        project_type: ["website", "brand-identity"],
        summary: "Ny identitet og digital platform for historisk herregård på Langeland",
        metrics: [],
        awards: [],
        impressiveness: 2,
    },
];

// Blocklist helper: returns the matched Tresyv client name if the prospect's
// company is already a Tresyv customer, else null. Word-boundary match so
// "FutureAble" doesn't match the client "Able". Case-insensitive.
//
// Callers (sendpilot-webhook + sendpilot-poll on connection.accepted)
// auto-reject the lead with status='rejected' and an audit reason. Pitching
// an existing customer is exactly the kind of trust-break we built the
// workspace separation system to prevent — same rule, different axis.
export function matchTresyvClient(company: string | null | undefined): string | null {
  const c = (company ?? "").trim();
  if (!c) return null;
  const cLower = c.toLowerCase();
  for (const client of TRESYV_CLIENTS) {
    const nameLower = client.name.toLowerCase();
    // \b doesn't work for non-ASCII letters in JS regex; use a manual
    // word-boundary check: nameLower appears in cLower bordered by non-letter
    // (or start/end).
    const idx = cLower.indexOf(nameLower);
    if (idx === -1) continue;
    const before = idx === 0 ? "" : cLower[idx - 1];
    const after = idx + nameLower.length >= cLower.length ? "" : cLower[idx + nameLower.length];
    const isLetterOrDigit = (ch: string) => /[\p{L}\p{N}]/u.test(ch);
    if (!isLetterOrDigit(before) && !isLetterOrDigit(after)) {
      return client.name;
    }
  }
  return null;
}
