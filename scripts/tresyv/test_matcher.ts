// Dry-run the Tresyv client-reference matcher against sample prospects.
// Run: deno run --env-file=.env.local --allow-env --allow-net scripts/tresyv/test_matcher.ts

import { pickClientReference } from "../../supabase/functions/_shared/pick-client-reference.ts";

const SAMPLES: Array<{ company: string; website: string; industry: string }> = [
    {
        company: "Hjulster",
        website: "hjulster.dk",
        industry: "Bike retailer + B2B fleet — webshop and physical stores",
    },
    {
        company: "Eldorado A/S",
        website: "eldorado.dk",
        industry: "Danish food/grocery wholesale, distribution to retail",
    },
    {
        company: "Sostrene Grene",
        website: "sostrenegrene.com",
        industry: "Retail chain — Danish home/lifestyle, omnichannel webshop + 250+ stores",
    },
    {
        company: "Onomondo",
        website: "onomondo.com",
        industry: "B2B IoT connectivity SaaS, global telco-replacement platform",
    },
    {
        company: "GBIF",
        website: "gbif.org",
        industry: "International biodiversity data infrastructure (UN-adjacent, non-profit)",
    },
    {
        company: "Cleanstep",
        website: "cleanstep.dk",
        industry: "DK cleaning-supply wholesaler — DanDomain webshop, B2B engros",
    },
    {
        company: "Karaoke King ApS",
        website: "karaokeking.dk",
        industry: "Karaoke equipment retailer for events",
    },
    {
        company: "Tivoli",
        website: "tivoli.dk",
        industry: "Iconic Copenhagen amusement park, omnichannel ticketing + retail",
    },
];

async function main() {
    for (const p of SAMPLES) {
        console.log(`\n=== ${p.company} (${p.industry})`);
        const r = await pickClientReference(p);
        if (r.matches) {
            console.log(`  Lane A — confidence ${r.confidence.toFixed(2)}`);
            console.log(`  rationale: ${r.rationale}`);
            for (const m of r.matches) {
                console.log(`    • ${m.name}: ${m.reason}`);
            }
        } else {
            console.log(`  Lane B (no ref) — confidence ${r.confidence.toFixed(2)}`);
            console.log(`  why: ${r.rationale}`);
        }
    }
}

main().catch((e) => {
    console.error(e);
    Deno.exit(1);
});
