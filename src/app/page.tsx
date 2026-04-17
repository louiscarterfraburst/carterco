const services = [
  "Brand positioning",
  "Website design",
  "Lead capture",
  "Launch systems",
];

const stats = [
  { value: "01", label: "Clear offer" },
  { value: "02", label: "Premium presence" },
  { value: "03", label: "Simple next step" },
];

export default function Home() {
  return (
    <main className="min-h-screen overflow-hidden bg-[var(--sand)] text-[var(--ink)]">
      <section className="relative isolate px-5 py-6 sm:px-8 lg:px-12">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_18%_15%,rgba(185,112,65,0.22),transparent_28%),radial-gradient(circle_at_80%_5%,rgba(25,70,58,0.22),transparent_30%),linear-gradient(135deg,#f6efe4_0%,#efe2cf_52%,#e8d5bc_100%)]" />
        <div className="absolute left-1/2 top-28 -z-10 h-[540px] w-[540px] -translate-x-1/2 rounded-full border border-[rgba(41,38,31,0.08)] bg-white/20 blur-3xl" />

        <nav className="mx-auto flex max-w-7xl items-center justify-between rounded-full border border-black/10 bg-white/35 px-4 py-3 shadow-[0_18px_80px_rgba(44,35,24,0.08)] backdrop-blur">
          <a className="text-sm font-bold uppercase tracking-[0.32em]" href="#">
            CarterCo
          </a>
          <a
            className="rounded-full bg-[var(--ink)] px-4 py-2 text-sm font-semibold text-[var(--sand)] transition hover:-translate-y-0.5 hover:bg-[var(--forest)]"
            href="mailto:hello@carterco.co"
          >
            Start a project
          </a>
        </nav>

        <div className="mx-auto grid max-w-7xl gap-12 pb-20 pt-16 lg:grid-cols-[1.05fr_0.95fr] lg:pb-28 lg:pt-24">
          <div className="flex flex-col justify-center">
            <p className="mb-5 w-fit rounded-full border border-black/10 bg-white/35 px-4 py-2 text-xs font-bold uppercase tracking-[0.28em] text-[var(--forest)]">
              Independent digital studio
            </p>
            <h1 className="font-display max-w-5xl text-6xl leading-[0.9] tracking-[-0.07em] sm:text-7xl lg:text-8xl">
              Websites that make the next move obvious.
            </h1>
            <p className="mt-7 max-w-2xl text-lg leading-8 text-[var(--muted)] sm:text-xl">
              CarterCo builds polished, conversion-minded web experiences for
              companies that need to look sharper, explain faster, and turn
              attention into action.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <a
                className="rounded-full bg-[var(--clay)] px-6 py-4 text-center text-sm font-bold uppercase tracking-[0.18em] text-white shadow-[0_18px_50px_rgba(185,112,65,0.24)] transition hover:-translate-y-1 hover:bg-[var(--ink)]"
                href="mailto:hello@carterco.co"
              >
                Book intro
              </a>
              <a
                className="rounded-full border border-black/15 bg-white/30 px-6 py-4 text-center text-sm font-bold uppercase tracking-[0.18em] transition hover:-translate-y-1 hover:bg-white/60"
                href="#approach"
              >
                See approach
              </a>
            </div>
          </div>

          <div className="relative min-h-[520px] rounded-[2rem] border border-black/10 bg-[var(--ink)] p-5 text-white shadow-[0_40px_120px_rgba(39,35,27,0.24)]">
            <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-[var(--clay)] blur-2xl" />
            <div className="absolute -bottom-12 left-10 h-48 w-48 rounded-full bg-[var(--forest)] blur-3xl" />
            <div className="relative flex h-full flex-col justify-between overflow-hidden rounded-[1.5rem] border border-white/10 bg-[linear-gradient(160deg,rgba(255,255,255,0.14),rgba(255,255,255,0.02))] p-6 backdrop-blur">
              <div>
                <div className="flex items-center justify-between text-xs font-bold uppercase tracking-[0.24em] text-white/55">
                  <span>Launch board</span>
                  <span>Live</span>
                </div>
                <div className="mt-12 space-y-4">
                  {services.map((service, index) => (
                    <div
                      className="flex items-center justify-between rounded-3xl border border-white/10 bg-white/[0.07] p-5"
                      key={service}
                    >
                      <span className="text-lg font-semibold">{service}</span>
                      <span className="font-display text-3xl text-[var(--cream)]">
                        0{index + 1}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="mt-10 rounded-[1.4rem] bg-[var(--cream)] p-5 text-[var(--ink)]">
                <p className="font-display text-4xl leading-none tracking-[-0.05em]">
                  Built to feel calm, premium, and easy to buy from.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section
        className="border-y border-black/10 bg-[var(--cream)] px-5 py-12 sm:px-8 lg:px-12"
        id="approach"
      >
        <div className="mx-auto grid max-w-7xl gap-5 md:grid-cols-3">
          {stats.map((item) => (
            <div
              className="rounded-[1.5rem] border border-black/10 bg-white/45 p-6"
              key={item.label}
            >
              <p className="font-display text-5xl tracking-[-0.06em] text-[var(--clay)]">
                {item.value}
              </p>
              <p className="mt-4 text-lg font-semibold">{item.label}</p>
              <p className="mt-2 leading-7 text-[var(--muted)]">
                Every page should reduce confusion and make it easier for the
                right customer to say yes.
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-[var(--sand)] px-5 py-16 sm:px-8 lg:px-12">
        <div className="mx-auto flex max-w-7xl flex-col gap-8 rounded-[2rem] bg-[var(--forest)] p-8 text-white sm:p-12 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.28em] text-white/55">
              Ready when you are
            </p>
            <h2 className="font-display mt-4 max-w-3xl text-5xl leading-none tracking-[-0.06em] sm:text-6xl">
              Let’s shape the first version, then make it sharper.
            </h2>
          </div>
          <a
            className="w-fit rounded-full bg-white px-6 py-4 text-sm font-bold uppercase tracking-[0.18em] text-[var(--forest)] transition hover:-translate-y-1 hover:bg-[var(--cream)]"
            href="mailto:hello@carterco.co"
          >
            Contact CarterCo
          </a>
        </div>
      </section>
    </main>
  );
}
