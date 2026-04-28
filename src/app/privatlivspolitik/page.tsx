import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privatlivspolitik — Carter & Co",
  description:
    "Sådan behandler Carter & Co personoplysninger fra carterco.dk: hvilke data vi indsamler, hvorfor, hvor længe vi gemmer dem, og hvordan du udøver dine rettigheder.",
  robots: { index: true, follow: true },
};

export default function Privatlivspolitik() {
  return (
    <main className="min-h-screen bg-[#0f0d0a] text-[var(--cream)]">
      <nav className="mx-auto flex w-full max-w-[840px] items-center justify-between px-8 pt-10 sm:px-12">
        <Link
          href="/"
          className="flex items-center gap-3 text-[10px] font-bold uppercase tracking-[0.3em] text-[var(--cream)]/60 transition hover:text-[var(--cream)]"
        >
          <span aria-hidden>←</span> Tilbage
        </Link>
        <a
          href="mailto:louis@carterco.dk"
          className="text-[10px] font-bold uppercase tracking-[0.3em] text-[var(--cream)]/60 transition hover:text-[var(--cream)]"
        >
          louis@carterco.dk
        </a>
      </nav>

      <article className="mx-auto w-full max-w-[720px] px-8 py-16 sm:px-12 sm:py-24">
        <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-[var(--clay)]">
          Privatliv · carterco.dk
        </p>
        <h1 className="mt-5 font-display text-4xl leading-[0.95] tracking-tight sm:text-5xl">
          Privatlivspolitik
        </h1>
        <p className="mt-4 text-sm text-[var(--cream)]/55">
          Senest opdateret: 28. april 2026
        </p>

        <div className="prose-style mt-12 flex flex-col gap-8 text-[15px] leading-relaxed text-[var(--cream)]/80">
          <section>
            <h2 className="font-display text-2xl tracking-tight text-[var(--cream)]">
              Den dataansvarlige
            </h2>
            <p className="mt-3">
              Carter &amp; Co (Louis Carter), København, Danmark.
              <br />
              Kontakt: <a href="mailto:louis@carterco.dk" className="underline decoration-[#ff6b2c]/60 decoration-2 underline-offset-4 hover:decoration-[#ff6b2c]">louis@carterco.dk</a>
            </p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight text-[var(--cream)]">
              Hvilke data indsamler vi?
            </h2>
            <p className="mt-3">
              Når du udfylder formularen på carterco.dk, indsamler vi de oplysninger, du selv skriver ind: navn, firma, e-mail og telefonnummer. Vi gemmer også teknisk metadata om din henvendelse (browser-type, sidens URL, tidspunkt) for at kunne følge op og forbedre tjenesten.
            </p>
            <p className="mt-3">
              Hvis du forlader formularen, før du sender den, gemmer vi den delvist udfyldte version som et udkast — også kun de felter du selv har skrevet — så vi kan kontakte dig, hvis du er nået langt nok til, at vi kan se du faktisk var interesseret. Du kan altid bede os slette udkastet ved at skrive til <a href="mailto:louis@carterco.dk" className="underline decoration-[#ff6b2c]/60 decoration-2 underline-offset-4 hover:decoration-[#ff6b2c]">louis@carterco.dk</a>.
            </p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight text-[var(--cream)]">
              Hvad bruger vi dem til?
            </h2>
            <p className="mt-3">
              Til at kontakte dig om dit ærinde, booke et opkald, og — hvis vi indgår en aftale — som almindelig kundekontakt. Vi sælger ikke dine oplysninger og bruger dem ikke til andet.
            </p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight text-[var(--cream)]">
              Hvem deler vi dem med?
            </h2>
            <p className="mt-3">
              Vi bruger få, gennemskuelige underdatabehandlere til at få siden til at virke:
            </p>
            <ul className="mt-3 flex flex-col gap-2 pl-5 marker:text-[#ff6b2c]">
              <li className="list-disc"><strong className="text-[var(--cream)]">Supabase</strong> — hosting af databasen hvor leads gemmes (EU-region).</li>
              <li className="list-disc"><strong className="text-[var(--cream)]">Calendly</strong> — booking af opkald, hvis du vælger at bruge kalender-linket.</li>
              <li className="list-disc"><strong className="text-[var(--cream)]">Plausible Analytics</strong> — anonym, cookie-fri trafikmåling. Ingen personoplysninger.</li>
            </ul>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight text-[var(--cream)]">
              Hvor længe gemmer vi dem?
            </h2>
            <p className="mt-3">
              Henvendelser gemmes så længe det er relevant for dialogen — typisk op til 24 måneder fra sidste kontakt. Bogføringsmateriale på faktiske kunder gemmes i 5 år, som loven kræver. Du kan til enhver tid bede os slette dine oplysninger.
            </p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight text-[var(--cream)]">
              Dine rettigheder
            </h2>
            <p className="mt-3">
              Du har ret til indsigt i, berigtigelse af, sletning af, eller begrænsning af behandlingen af dine oplysninger. Du kan også gøre indsigelse mod behandlingen og bede om dataportabilitet. Skriv til <a href="mailto:louis@carterco.dk" className="underline decoration-[#ff6b2c]/60 decoration-2 underline-offset-4 hover:decoration-[#ff6b2c]">louis@carterco.dk</a>, så svarer jeg inden for en uge.
            </p>
            <p className="mt-3">
              Hvis du mener, vi behandler dine oplysninger i strid med reglerne, kan du klage til{" "}
              <a
                href="https://www.datatilsynet.dk"
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-[#ff6b2c]/60 decoration-2 underline-offset-4 hover:decoration-[#ff6b2c]"
              >
                Datatilsynet
              </a>
              .
            </p>
          </section>
        </div>

        <div className="mt-16 border-t border-[var(--cream)]/10 pt-8">
          <Link
            href="/"
            className="text-[11px] font-bold uppercase tracking-[0.3em] text-[var(--cream)]/55 transition hover:text-[var(--cream)]"
          >
            ← Tilbage til carterco.dk
          </Link>
        </div>
      </article>
    </main>
  );
}
