import type { Metadata } from "next";

export const metadata: Metadata = {
    title: "Tresyv outreach — flow oversigt",
    description:
        "Hvordan beskeden bygges per modtager — tre tekstlinjer, to kanaler, ét fælles opfølgningsflow.",
};

const LANES = [
    {
        code: "A1",
        title: "Lang — med kunde-reference",
        when: "Når Haiku matcher en eller flere Tresyv-kunder, prospekten vil genkende og finde relevant",
        channel: "Tekst-kun (eller video uden video-spørgsmål)",
        body: `Hej [fornavn]

Tak for forbindelsen.

Jeg har kigget kort på [hjemmeside], og jeg tror, der er nogle ret oplagte muligheder for at gøre brugerrejsen tydeligere og få mere ud af de besøgende, I allerede har.

Min kollega Tue og jeg har arbejdet med UX, design og brugerpsykologi i mange år og hjælper virksomheder med websites, der er lettere at forstå, lettere at bruge og bedre til at konvertere.

Vi har bl.a. hjulpet [HAIKU-PICKS — fx Greenmind, EET Group og Dansk Blindesamfund — vælges ud fra prospektens branche].

Hvis det er relevant, giver vi gerne en kort og uforpligtende gennemgang af jeres website. Bagefter får I 5-10 konkrete forbedringspunkter, som I kan bruge med det samme.

Kunne det være relevant for jer?

De venligste hilsner
Rasmus`,
    },
    {
        code: "A2",
        title: "Lang — uden reference",
        when: "Når Haiku ikke finder et stærkt match (B2B SaaS, niche, ukendt segment osv.) — bedre med ingen reference end en svag",
        channel: "Tekst-kun",
        body: `Hej [fornavn]

Tak for forbindelsen.

Jeg har kigget kort på [hjemmeside], og jeg tror, der er nogle ret oplagte muligheder for at gøre brugerrejsen tydeligere og få mere ud af de besøgende, I allerede har.

Min kollega Tue og jeg har arbejdet med UX, design og brugerpsykologi i over 25 år og hjælper dagligt stærke brands med websites, der er lettere at forstå, lettere at bruge og bedre til at konvertere.

Hvis det er relevant, giver vi gerne en kort og uforpligtende gennemgang af jeres website. Bagefter får I 5-10 konkrete forbedringspunkter, som I kan bruge med det samme.

Kunne det være relevant for jer?

De venligste hilsner
Rasmus`,
    },
    {
        code: "B",
        title: "Kort — bait under video",
        when: "Når SendSpark renderer en personaliseret video til prospekten — videoen bærer personificeringen, teksten bliver kort",
        channel: "Video + kort tekst",
        body: `Hej [fornavn]

Tak for forbindelsen.

Jeg har kigget kort på [hjemmeside], og jeg tror, der er et par ret oplagte greb, som kan gøre websitet skarpere og få flere besøgende til at tage næste skridt.

Skal jeg sende dig 2-3 konkrete ting, jeg især ville få kigget på?

De venligste hilsner
Rasmus

▶ [video.tresyv.dk/share/{render-id}]`,
    },
] as const;

const FOLLOWUPS = [
    {
        signal: "Video set til ende eller CTA klikket",
        angle: "Pull-the-meeting",
        copy: "Hej [fornavn] — så du fik kigget videoen 🙂 Skal vi tage en kort snak om de 5-10 punkter? Du kan booke direkte her: [calendly] — eller bare svar med et tidspunkt der passer.",
    },
    {
        signal: "Video set, men ikke til ende",
        angle: "Soft nudge",
        copy: "Hej [fornavn] — bare et hurtigt nudge. Min note ville nemt drukne i indbakken. Hvis det er på et forkert tidspunkt, så ingen ærgrelse — bare lad mig vide.",
    },
    {
        signal: "Ingen aktivitet på videoen",
        angle: "Anderledes vinkel",
        copy: "Hej [fornavn] — jeg har lige skimmet [hjemmeside] igen og noterede [konkret observation]. Det kunne være værd at vende. Kunne du tænke dig at høre mere?",
    },
    {
        signal: "Tekst-kun-flow (ingen video sendt)",
        angle: "Tekst-nudge — uden video-spørgsmål",
        copy: "Hej [fornavn] — bare et hurtigt nudge på den her. Hvis det ikke er relevant lige nu er det helt fint, så lader jeg dig være.",
    },
];

const BREAKUP = `Hej [fornavn]

Sidste hilsen fra min side. Hvis tidspunktet ikke er det rette, er der ikke noget ærgerligt i det. Du er velkommen til at række ud, hvis det skifter senere.

De venligste hilsner
Rasmus`;

export default function TresyvFlowPage() {
    return (
        <main className="min-h-screen bg-[var(--cream)] text-[var(--ink)]">
            <div className="mx-auto max-w-5xl px-5 py-16 sm:px-8 sm:py-20">
                <Header />
                <Section title="Beslutningstræ">
                    <DecisionTree />
                </Section>

                <Section title="Tre tekstlinjer">
                    <div className="grid gap-6 sm:grid-cols-3">
                        {LANES.map((lane) => (
                            <LaneCard key={lane.code} lane={lane} />
                        ))}
                    </div>
                </Section>

                <Section title="Opfølgning — drevet af engagement-signaler">
                    <FollowupTable />
                </Section>

                <Section title="Breakup — fælles sidste hilsen">
                    <pre className="whitespace-pre-wrap rounded-md border border-[var(--ink)]/12 bg-white/40 p-5 font-sans text-[14px] leading-relaxed text-[var(--ink)]/85">
                        {BREAKUP}
                    </pre>
                </Section>

                <Section title="Skabeloner i alt">
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Tally count={3} label="Første-besked tekster (A1, A2, B)" />
                        <Tally count={4} label="Opfølgnings-variant (engagement-betingede)" />
                        <Tally count={1} label="Breakup (fælles)" />
                        <Tally count={1} label="Klient-reference matcher (Haiku, kun A-flow)" />
                    </div>
                </Section>

                <footer className="mt-20 border-t border-[var(--ink)]/10 pt-8 text-[11px] uppercase tracking-[0.32em] text-[var(--ink)]/45">
                    Carter & Co · Tresyv outreach-arkitektur · {new Date().getFullYear()}
                </footer>
            </div>
        </main>
    );
}

function Header() {
    return (
        <header className="mb-14 border-b border-[var(--ink)]/10 pb-10">
            <p className="tabular mb-5 text-[11px] uppercase tracking-[0.32em] text-[var(--clay)]">
                Tresyv · outreach-arkitektur
            </p>
            <h1 className="font-display text-[44px] leading-[1.05] tracking-[-0.01em] sm:text-[56px]">
                Hvordan beskeden bygges<br />per modtager.
            </h1>
            <p className="mt-6 max-w-2xl text-[15px] leading-relaxed text-[var(--ink)]/70">
                Tre tekstlinjer (A1, A2, B), to kanaler (tekst, video), ét fælles opfølgningsflow drevet
                af engagement-signaler. En lille AI-matcher (Claude Haiku) afgør per prospekt om vi kan
                nævne en konkret tidligere kunde — eller om vi holder os generelt.
            </p>
        </header>
    );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section className="mt-16">
            <h2 className="font-display mb-7 text-[24px] tracking-[-0.005em] text-[var(--ink)]">
                {title}
            </h2>
            {children}
        </section>
    );
}

function DecisionTree() {
    return (
        <div className="rounded-md border border-[var(--ink)]/12 bg-white/40 p-6 sm:p-8">
            <ol className="space-y-5">
                <TreeStep
                    number="1"
                    label="Prospekt accepterer connection-anmodning"
                    detail="Sendpilot fyrer webhook → outreach_pipeline-row oprettes"
                />
                <Branch />
                <TreeStep
                    number="2"
                    label="Vælg kanal"
                    detail="Video-flow eller tekst-kun? — afgøres af kampagne-konfiguration (eller render-fejl-fallback)"
                />
                <div className="ml-3 grid gap-4 border-l border-[var(--ink)]/15 pl-7 sm:grid-cols-2">
                    <TreeBranchCard
                        label="Video-flow"
                        body="Sendspark renderer personlig video. Tekst bliver kort → Lane B."
                        accent
                    />
                    <TreeBranchCard
                        label="Tekst-kun-flow"
                        body="Ingen video. Haiku matcher kunde-references. Match → Lane A1. Intet match → Lane A2."
                    />
                </div>
                <Branch />
                <TreeStep
                    number="3"
                    label="Send besked"
                    detail="LinkedIn DM via Sendpilot. Engagement-signaler (viewed / watched_end / cta_clicked / reply) modtages."
                />
                <Branch />
                <TreeStep
                    number="4"
                    label="Opfølgning efter 3-5 dages stilhed"
                    detail="outreach-engagement-tick vælger followup-variant ud fra modtagne signaler."
                />
                <Branch />
                <TreeStep
                    number="5"
                    label="Breakup efter endnu en stilhedsperiode"
                    detail="Én fælles, blød afslutning. Højeste svar-rate i kolde sekvenser."
                />
            </ol>
        </div>
    );
}

function TreeStep({ number, label, detail }: { number: string; label: string; detail: string }) {
    return (
        <li className="flex items-start gap-4">
            <span className="font-display flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-[var(--clay)]/35 bg-[var(--cream)] text-[16px] text-[var(--clay)]">
                {number}
            </span>
            <div>
                <p className="font-display text-[18px] leading-[1.25] text-[var(--ink)]">{label}</p>
                <p className="mt-1 text-[13px] leading-relaxed text-[var(--ink)]/65">{detail}</p>
            </div>
        </li>
    );
}

function Branch() {
    return (
        <div className="ml-4 flex h-3 w-px flex-col items-start">
            <div className="h-full w-px bg-[var(--ink)]/20" />
        </div>
    );
}

function TreeBranchCard({
    label,
    body,
    accent,
}: {
    label: string;
    body: string;
    accent?: boolean;
}) {
    return (
        <div
            className={`rounded-md border p-4 ${accent ? "border-[var(--clay)]/35 bg-[var(--clay)]/[0.05]" : "border-[var(--ink)]/12 bg-[var(--cream)]"
                }`}
        >
            <p className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--clay)]">
                {label}
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--ink)]/80">{body}</p>
        </div>
    );
}

function LaneCard({ lane }: { lane: (typeof LANES)[number] }) {
    return (
        <article className="flex flex-col rounded-md border border-[var(--ink)]/12 bg-white/40 p-5">
            <div className="flex items-baseline justify-between">
                <span className="font-display text-[34px] leading-none text-[var(--clay)]">
                    {lane.code}
                </span>
                <span className="tabular text-[9px] uppercase tracking-[0.28em] text-[var(--ink)]/45">
                    {lane.channel}
                </span>
            </div>
            <h3 className="font-display mt-2 text-[20px] leading-[1.2] text-[var(--ink)]">
                {lane.title}
            </h3>
            <p className="mt-3 text-[12px] leading-relaxed text-[var(--ink)]/60">{lane.when}</p>
            <pre className="mt-5 flex-1 whitespace-pre-wrap rounded-sm border border-[var(--ink)]/10 bg-[var(--cream)] p-4 font-sans text-[12px] leading-relaxed text-[var(--ink)]/85">
                {lane.body}
            </pre>
        </article>
    );
}

function FollowupTable() {
    return (
        <div className="overflow-x-auto rounded-md border border-[var(--ink)]/12 bg-white/40">
            <table className="w-full border-collapse text-left text-[13px]">
                <thead>
                    <tr className="border-b border-[var(--ink)]/15">
                        <th className="tabular px-5 py-3 text-[10px] uppercase tracking-[0.28em] text-[var(--ink)]/55">
                            Engagement-signal
                        </th>
                        <th className="tabular px-5 py-3 text-[10px] uppercase tracking-[0.28em] text-[var(--ink)]/55">
                            Vinkel
                        </th>
                        <th className="tabular px-5 py-3 text-[10px] uppercase tracking-[0.28em] text-[var(--ink)]/55">
                            Besked (udkast)
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {FOLLOWUPS.map((f, i) => (
                        <tr
                            key={f.signal}
                            className={i < FOLLOWUPS.length - 1 ? "border-b border-[var(--ink)]/8" : ""}
                        >
                            <td className="w-1/4 px-5 py-4 align-top text-[var(--ink)]/85">{f.signal}</td>
                            <td className="w-1/5 px-5 py-4 align-top text-[var(--clay)]">{f.angle}</td>
                            <td className="px-5 py-4 align-top leading-relaxed text-[var(--ink)]/75">
                                {f.copy}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function Tally({ count, label }: { count: number; label: string }) {
    return (
        <div className="flex items-baseline gap-4 rounded-md border border-[var(--ink)]/12 bg-white/40 px-5 py-4">
            <span className="font-display text-[34px] leading-none text-[var(--forest)]">{count}</span>
            <span className="text-[13px] leading-tight text-[var(--ink)]/75">{label}</span>
        </div>
    );
}
