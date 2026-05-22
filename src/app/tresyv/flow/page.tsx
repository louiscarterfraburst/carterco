import type { Metadata } from "next";

export const metadata: Metadata = {
    title: "Tresyv outreach — flow oversigt",
    description:
        "Tre spor (V1/V2/V3) i 33/33/33 fordeling, opfølgning per spor drevet af engagement-signaler.",
};

const LANES = [
    {
        code: "V1",
        title: "Lang ren tekst",
        share: "≈33%",
        when: "Den voksne, forklarende variant. Haiku afgør per prospekt om vi indsætter en konkret kunde-reference eller holder os generelt.",
        channel: "Tekst-kun",
        body: `Hej [fornavn]

Tak for forbindelsen.

Jeg har kigget kort på [hjemmeside], og jeg tror, der er nogle ret oplagte muligheder for at gøre brugerrejsen tydeligere og få mere ud af de besøgende, I allerede har.

Min kollega Tue og jeg har arbejdet med UX, design og brugerpsykologi i over 25 år og hjælper dagligt stærke brands med websites, der er lettere at forstå, lettere at bruge og bedre til at konvertere.

[Når Haiku finder match: "Vi har bl.a. hjulpet …"]

Hvis det er relevant, giver vi gerne en kort og uforpligtende gennemgang af jeres website. Bagefter får I 5-10 konkrete forbedringspunkter, som I kan bruge med det samme.

Kunne det være relevant for jer?

De venligste hilsner
Rasmus`,
    },
    {
        code: "V2",
        title: "Kort krog — ren tekst",
        share: "≈33%",
        when: "Madding-varianten. Ren tekst, ingen video. Vi afprøver om kort hook slår lang forklaring.",
        channel: "Tekst-kun",
        body: `Hej [fornavn]

Tak for forbindelsen.

Jeg har kigget kort på [hjemmeside], og jeg tror, der er et par ret oplagte greb, som kan gøre websitet skarpere og få flere besøgende til at tage næste skridt.

Skal jeg sende dig 2-3 konkrete ting, jeg især ville få kigget på?

De venligste hilsner
Rasmus`,
    },
    {
        code: "V3",
        title: "Video",
        share: "≈33%",
        when: "Det eneste spor med video. Sendspark renderer personlig video; teksten under er kort fordi videoen bærer beskeden.",
        channel: "Video + kort caption",
        body: `[venter på V3-caption fra Rasmus — videoen bærer beskeden, kort intro under]

▶ video.tresyv.dk/share/{render-id}`,
    },
] as const;

const FOLLOWUPS = [
    {
        track: "V1 — lang tekst",
        signal: "Ingen svar efter 3-5 dage",
        angle: "Opfølgning med blød exit",
        copy: `Hej [fornavn]

Jeg følger bare lige op.

Jeg tror, der er et par oplagte steder, hvor jeres website kan blive tydeligere og konvertere bedre.

Skal jeg sende et par konkrete bud?

Hvis ikke, er det helt fair – så lukker jeg den bare herfra.

De venligste hilsner
Rasmus`,
    },
    {
        track: "V2 — kort tekst",
        signal: "Ingen svar efter 3-5 dage",
        angle: "Nudge — 2-3 ting",
        copy: `Hej [fornavn]

Jeg følger bare lige op.

Skal jeg sende dig de 2-3 ting, jeg især ville kigge på for at gøre jeres website skarpere og få flere besøgende til at tage næste skridt?

Hvis ikke, er det helt fair.

De venligste hilsner
Rasmus`,
    },
    {
        track: "V3 — video",
        signal: "Video set til ende eller CTA klikket",
        angle: "Pull-the-meeting",
        copy: `Hej [fornavn]

Jeg håber, videoen gav mening.

Skal vi tage en kort snak om, hvor vi ser de største muligheder for at gøre jeres website tydeligere og få flere besøgende til at tage næste skridt?

Jeg sender gerne et par forslag til tider.

De venligste hilsner
Rasmus`,
    },
    {
        track: "V3 — video",
        signal: "Video åbnet, men ikke set til ende",
        angle: "Soft nudge — konkrete greb",
        copy: `Hej [fornavn]

Jeg følger bare lige op på videoen fra forleden.

Den korte version er, at vi tror, der er nogle konkrete greb, der kan gøre jeres website tydeligere og få flere besøgende til at tage næste skridt.

Skal jeg sende et par forslag til tider, hvor vi kan tage en kort snak?

De venligste hilsner
Rasmus`,
    },
    {
        track: "V3 — video",
        signal: "Ingen aktivitet på videoen",
        angle: "Generisk nudge",
        copy: `Hej [fornavn]

Jeg følger bare lige op.

Jeg tror, der er nogle oplagte muligheder for at gøre jeres website tydeligere og få flere besøgende til at tage næste skridt.

Skal jeg sende et par forslag til tider, hvor vi kan tage en kort snak?

De venligste hilsner
Rasmus`,
    },
];

export default function TresyvFlowPage() {
    return (
        <main className="min-h-screen bg-[var(--cream)] text-[var(--ink)]">
            <div className="mx-auto max-w-5xl px-5 py-16 sm:px-8 sm:py-20">
                <Header />
                <Section title="Beslutningstræ">
                    <DecisionTree />
                </Section>

                <Section title="Tre spor — V1 / V2 / V3">
                    <div className="grid gap-6 sm:grid-cols-3">
                        {LANES.map((lane) => (
                            <LaneCard key={lane.code} lane={lane} />
                        ))}
                    </div>
                </Section>

                <Section title="Opfølgning — per spor, drevet af engagement-signaler">
                    <FollowupTable />
                </Section>

                <Section title="Skabeloner i alt">
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Tally count={3} label="Første-besked tekster (V1, V2, V3)" />
                        <Tally count={5} label="Opfølgnings-varianter (V1 + V2 + V3 × 3)" />
                        <Tally count={1} label="Klient-reference matcher (Haiku, kun V1)" />
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
                Tre spor i parallel,<br />ét beslutningstræ.
            </h1>
            <p className="mt-6 max-w-2xl text-[15px] leading-relaxed text-[var(--ink)]/70">
                Hver accepteret connection tildeles tilfældigt et af tre spor: V1 (lang ren tekst),
                V2 (kort ren tekst), eller V3 (video). Inden for V1 afgør Claude Haiku om vi nævner
                en konkret tidligere Tresyv-kunde — eller holder os generelt. Opfølgning vælges per
                spor og engagement-signal.
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
                    detail="Sendpilot fyrer webhook → outreach_pipeline-row oprettes."
                />
                <Branch />
                <TreeStep
                    number="2"
                    label="Tildel spor — 33/33/33"
                    detail="Tilfældig fordeling V1 / V2 / V3 ved acceptance. Sporet persisteres på pipeline-row så al senere logik (besked, opfølgning) følger sporet."
                />
                <div className="ml-3 grid gap-4 border-l border-[var(--ink)]/15 pl-7 sm:grid-cols-3">
                    <TreeBranchCard label="V1 — lang tekst" body="Haiku afgør ref. Ingen video." />
                    <TreeBranchCard label="V2 — kort tekst" body="Ingen ref-logik. Ingen video." accent />
                    <TreeBranchCard label="V3 — video" body="Sendspark renderer. Caption under." accent />
                </div>
                <Branch />
                <TreeStep
                    number="3"
                    label="Send besked"
                    detail="LinkedIn DM via Sendpilot. Engagement-signaler (viewed / watched_end / cta_clicked / reply) modtages og lagres."
                />
                <Branch />
                <TreeStep
                    number="4"
                    label="Opfølgning efter 3-5 dages stilhed"
                    detail="outreach-engagement-tick vælger opfølgning ud fra (spor, signaler). V1 og V2 har én opfølgning hver. V3 har tre — afhængig af video-engagement. Stille leads udløber uden breakup."
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
                    {lane.share} · {lane.channel}
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
                        <th className="tabular w-[18%] px-5 py-3 text-[10px] uppercase tracking-[0.28em] text-[var(--ink)]/55">
                            Spor
                        </th>
                        <th className="tabular w-[22%] px-5 py-3 text-[10px] uppercase tracking-[0.28em] text-[var(--ink)]/55">
                            Engagement-signal
                        </th>
                        <th className="tabular w-[18%] px-5 py-3 text-[10px] uppercase tracking-[0.28em] text-[var(--ink)]/55">
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
                            key={`${f.track}-${f.signal}`}
                            className={i < FOLLOWUPS.length - 1 ? "border-b border-[var(--ink)]/8" : ""}
                        >
                            <td className="px-5 py-4 align-top text-[var(--ink)]/85">{f.track}</td>
                            <td className="px-5 py-4 align-top text-[var(--ink)]/75">{f.signal}</td>
                            <td className="px-5 py-4 align-top text-[var(--clay)]">{f.angle}</td>
                            <td className="px-5 py-4 align-top text-[var(--ink)]/75">
                                <pre className="whitespace-pre-wrap font-sans text-[12px] leading-relaxed">
                                    {f.copy}
                                </pre>
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
