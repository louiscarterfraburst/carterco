import { notFound } from "next/navigation";
import Link from "next/link";
import { createAdminClient } from "@/utils/supabase/admin";
import { SetupForm, type SetupEngagement, type SetupItem } from "./setup-form";

export const dynamic = "force-dynamic";

type Params = { slug: string };

export default async function SetupPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug } = await params;
  if (!/^[a-z0-9-]{8,64}$/.test(slug)) notFound();

  const sb = createAdminClient();
  const { data: engagement } = await sb
    .from("setup_engagements")
    .select("id, slug, client_name, contact_name, contact_email, intro_md, status, completed_at")
    .eq("slug", slug)
    .maybeSingle<SetupEngagement>();

  if (!engagement) notFound();

  const { data: items } = await sb
    .from("setup_items")
    .select("id, section_key, section_title, item_key, label, help_md, placeholder, kind, required, value, completed, sort_section, sort_item")
    .eq("engagement_id", engagement.id)
    .order("sort_section", { ascending: true })
    .order("sort_item", { ascending: true })
    .returns<SetupItem[]>();

  return (
    <main className="safe-screen safe-pad-top safe-pad-bottom relative min-h-screen overflow-hidden bg-[var(--sand)] text-[var(--ink)]">
      <div className="grain-overlay" />

      <div className="relative mx-auto w-full max-w-[880px] px-5 pt-10 pb-24 sm:px-8 sm:pt-16">
        <Link
          href="/"
          className="tabular text-[10px] uppercase tracking-[0.32em] text-[var(--ink)]/45 hover:text-[var(--ink)]/80"
        >
          Carter &amp; Co<span className="mx-2 text-[var(--ink)]/25">/</span>
          <span className="text-[var(--ink)]/75">Onboarding</span>
        </Link>

        <header className="mt-8 border-b border-[var(--ink)]/10 pb-10">
          <p className="tabular text-[10px] uppercase tracking-[0.3em] text-[var(--ink)]/45">
            Opstart · {engagement.client_name}
          </p>
          <h1 className="font-display mt-3 text-[44px] italic leading-[0.95] tracking-[-0.02em] text-[var(--ink)] sm:text-[64px]">
            Det jeg skal bruge,
            <br />
            før jeg bygger.
          </h1>
          {engagement.intro_md ? (
            <div className="mt-6 max-w-[60ch] text-[15px] leading-[1.7] text-[var(--ink)]/75 whitespace-pre-wrap">
              {renderIntro(engagement.intro_md)}
            </div>
          ) : null}
        </header>

        <SetupForm engagement={engagement} items={items ?? []} />
      </div>
    </main>
  );
}

// Minimal markdown — we control the source, so just bold + paragraphs.
function renderIntro(md: string): React.ReactNode {
  const parts = md.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => {
    const m = /^\*\*([^*]+)\*\*$/.exec(p);
    if (m) return <strong key={i} className="text-[var(--ink)]">{m[1]}</strong>;
    return <span key={i}>{p}</span>;
  });
}
