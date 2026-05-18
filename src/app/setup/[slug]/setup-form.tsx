"use client";

import { useMemo, useState, useTransition } from "react";
import { saveItem, completeEngagement } from "./actions";

export type SetupEngagement = {
  id: string;
  slug: string;
  client_name: string;
  contact_name: string | null;
  contact_email: string | null;
  intro_md: string | null;
  status: string;
  completed_at: string | null;
};

export type SetupItemKind = "text" | "textarea" | "secure_share" | "checkbox" | "radio";

export type SetupItem = {
  id: string;
  section_key: string;
  section_title: string;
  item_key: string;
  label: string;
  help_md: string | null;
  placeholder: string | null;
  kind: SetupItemKind;
  required: boolean;
  value: string | null;
  completed: boolean;
  sort_section: number;
  sort_item: number;
};

type Section = {
  key: string;
  title: string;
  items: SetupItem[];
};

function groupBySection(items: SetupItem[]): Section[] {
  const map = new Map<string, Section>();
  for (const it of items) {
    let s = map.get(it.section_key);
    if (!s) {
      s = { key: it.section_key, title: it.section_title, items: [] };
      map.set(it.section_key, s);
    }
    s.items.push(it);
  }
  return Array.from(map.values());
}

export function SetupForm({
  engagement,
  items: initialItems,
}: {
  engagement: SetupEngagement;
  items: SetupItem[];
}) {
  const [items, setItems] = useState(initialItems);
  const sections = useMemo(() => groupBySection(items), [items]);

  const completedCount = items.filter((i) => i.completed).length;
  const requiredItems = items.filter((i) => i.required);
  const requiredDone = requiredItems.filter((i) => i.completed).length;
  const allRequiredDone = requiredItems.length > 0 && requiredDone === requiredItems.length;

  function patchItem(id: string, patch: Partial<SetupItem>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  if (engagement.status === "completed") {
    return <CompletedState engagement={engagement} />;
  }

  return (
    <>
      <ProgressBar completed={completedCount} total={items.length} />

      <div className="mt-10 space-y-12">
        {sections.map((section, idx) => (
          <SectionBlock
            key={section.key}
            index={idx + 1}
            section={section}
            slug={engagement.slug}
            onPatch={patchItem}
          />
        ))}
      </div>

      <CompleteBlock
        slug={engagement.slug}
        allRequiredDone={allRequiredDone}
        requiredDone={requiredDone}
        requiredTotal={requiredItems.length}
      />
    </>
  );
}

function ProgressBar({ completed, total }: { completed: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((completed / total) * 100);
  return (
    <div className="mt-8">
      <div className="flex items-baseline justify-between">
        <p className="tabular text-[10px] uppercase tracking-[0.3em] text-[var(--ink)]/55">
          Fremgang
        </p>
        <p className="tabular text-[11px] text-[var(--ink)]/65">
          {completed} af {total} udfyldt
        </p>
      </div>
      <div className="mt-2 h-[3px] w-full overflow-hidden rounded-full bg-[var(--ink)]/10">
        <div
          className="h-full rounded-full bg-[var(--forest)] transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function SectionBlock({
  index,
  section,
  slug,
  onPatch,
}: {
  index: number;
  section: Section;
  slug: string;
  onPatch: (id: string, patch: Partial<SetupItem>) => void;
}) {
  const done = section.items.filter((i) => i.completed).length;
  const total = section.items.length;
  const sectionDone = done === total;

  return (
    <section className="rounded-md border border-[var(--ink)]/10 bg-[var(--cream)] p-6 sm:p-8">
      <header className="flex items-baseline justify-between gap-4 border-b border-[var(--ink)]/8 pb-4">
        <div className="flex items-baseline gap-3">
          <span className="tabular text-[10px] uppercase tracking-[0.32em] text-[var(--ink)]/40">
            {String(index).padStart(2, "0")}
          </span>
          <h2 className="font-display text-[22px] italic leading-tight text-[var(--ink)]">
            {section.title}
          </h2>
        </div>
        <span
          className={[
            "tabular shrink-0 text-[10px] uppercase tracking-[0.22em]",
            sectionDone ? "text-[var(--forest)]" : "text-[var(--ink)]/45",
          ].join(" ")}
        >
          {sectionDone ? "Færdig" : `${done}/${total}`}
        </span>
      </header>

      <div className="mt-6 space-y-6">
        {section.items.map((item) => (
          <ItemField key={item.id} item={item} slug={slug} onPatch={onPatch} />
        ))}
      </div>
    </section>
  );
}

function ItemField({
  item,
  slug,
  onPatch,
}: {
  item: SetupItem;
  slug: string;
  onPatch: (id: string, patch: Partial<SetupItem>) => void;
}) {
  const [isPending, startTransition] = useTransition();

  function save(value: string | null, markCompleted: boolean) {
    onPatch(item.id, { value, completed: markCompleted });
    startTransition(async () => {
      const fd = new FormData();
      fd.set("slug", slug);
      fd.set("item_id", item.id);
      if (value !== null) fd.set("value", value);
      fd.set("completed", markCompleted ? "true" : "false");
      await saveItem(fd);
    });
  }

  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <label
          htmlFor={item.id}
          className="text-[14px] font-medium text-[var(--ink)]"
        >
          {item.label}
          {item.required ? (
            <span className="ml-1.5 text-[var(--clay)]" aria-label="required">*</span>
          ) : null}
        </label>
        <StatusDot completed={item.completed} pending={isPending} />
      </div>
      {item.help_md ? (
        <p className="text-[13px] leading-[1.6] text-[var(--ink)]/60">
          {renderInlineBold(item.help_md)}
        </p>
      ) : null}
      {renderInput(item, save)}
      {item.kind === "secure_share" ? (
        <SecureShareHint />
      ) : null}
    </div>
  );
}

function renderInput(
  item: SetupItem,
  save: (value: string | null, markCompleted: boolean) => void,
) {
  const baseInput =
    "focus-cream w-full rounded-sm border border-[var(--ink)]/15 bg-[var(--sand)]/70 px-3 py-2.5 text-[14px] text-[var(--ink)] placeholder:text-[var(--ink)]/35 outline-none transition-colors focus:border-[var(--ink)]/40";

  if (item.kind === "checkbox") {
    return (
      <label className="mt-1 inline-flex cursor-pointer items-center gap-3 select-none">
        <input
          id={item.id}
          type="checkbox"
          defaultChecked={item.completed}
          onChange={(e) => save(null, e.currentTarget.checked)}
          className="h-[18px] w-[18px] cursor-pointer accent-[var(--forest)]"
        />
        <span className="text-[13px] text-[var(--ink)]/75">
          Bekræft — {item.label.toLowerCase()}
        </span>
      </label>
    );
  }

  if (item.kind === "textarea") {
    return (
      <textarea
        id={item.id}
        defaultValue={item.value ?? ""}
        placeholder={item.placeholder ?? ""}
        rows={4}
        onBlur={(e) => {
          const v = e.currentTarget.value;
          save(v, v.trim().length > 0);
        }}
        className={`${baseInput} min-h-[110px] resize-y leading-[1.55]`}
      />
    );
  }

  // text + secure_share
  return (
    <input
      id={item.id}
      type="text"
      defaultValue={item.value ?? ""}
      placeholder={item.placeholder ?? ""}
      autoComplete="off"
      spellCheck={false}
      onBlur={(e) => {
        const v = e.currentTarget.value;
        save(v, v.trim().length > 0);
      }}
      className={baseInput}
    />
  );
}

function StatusDot({ completed, pending }: { completed: boolean; pending: boolean }) {
  if (pending) {
    return (
      <span className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--clay)]">
        Gemmer…
      </span>
    );
  }
  if (completed) {
    return (
      <span className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--forest)]">
        Gemt
      </span>
    );
  }
  return (
    <span className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/30">
      Tom
    </span>
  );
}

function SecureShareHint() {
  return (
    <p className="text-[12px] leading-[1.55] text-[var(--ink)]/50">
      <strong className="text-[var(--ink)]/70">Sådan deler du sikkert:</strong>{" "}
      Gå til{" "}
      <a
        href="https://send.bitwarden.com"
        target="_blank"
        rel="noreferrer"
        className="underline decoration-[var(--ink)]/30 underline-offset-2 hover:text-[var(--ink)]/80"
      >
        send.bitwarden.com
      </a>
      , indsæt nøglen, sæt udløb til 7 dage og max 1 visning, kopiér linket — indsæt det her.
      Jeg henter nøglen én gang og linket dør. Du kan også bruge 1Password share eller en lignende encrypted note.
    </p>
  );
}

function CompleteBlock({
  slug,
  allRequiredDone,
  requiredDone,
  requiredTotal,
}: {
  slug: string;
  allRequiredDone: boolean;
  requiredDone: number;
  requiredTotal: number;
}) {
  const [isPending, startTransition] = useTransition();

  function onSubmit() {
    if (!allRequiredDone) return;
    startTransition(async () => {
      const fd = new FormData();
      fd.set("slug", slug);
      await completeEngagement(fd);
    });
  }

  return (
    <div className="mt-14 border-t border-[var(--ink)]/10 pt-10">
      <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-[22px] italic leading-tight text-[var(--ink)]">
            Klar til afsendelse?
          </h2>
          <p className="mt-1 text-[13px] text-[var(--ink)]/60">
            {allRequiredDone
              ? "Alt det jeg skal bruge er udfyldt. Tryk send — så ved jeg vi er klar."
              : `Mangler ${requiredTotal - requiredDone} obligatorisk${requiredTotal - requiredDone === 1 ? "" : "e"} felt${requiredTotal - requiredDone === 1 ? "" : "er"} (markeret med *). Du kan vende tilbage senere — siden husker det.`}
          </p>
        </div>
        <button
          type="button"
          onClick={onSubmit}
          disabled={!allRequiredDone || isPending}
          className={[
            "focus-cream tabular rounded-full px-7 py-3 text-[12px] uppercase tracking-[0.22em] transition-colors",
            allRequiredDone
              ? "bg-[var(--forest)] text-[var(--cream)] hover:bg-[var(--forest)]/90"
              : "cursor-not-allowed bg-[var(--ink)]/10 text-[var(--ink)]/40",
          ].join(" ")}
        >
          {isPending ? "Sender…" : "Send til Louis →"}
        </button>
      </div>
    </div>
  );
}

function renderInlineBold(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => {
    const m = /^\*\*([^*]+)\*\*$/.exec(p);
    if (m) return <strong key={i} className="text-[var(--ink)]/85">{m[1]}</strong>;
    return <span key={i}>{p}</span>;
  });
}

function CompletedState({ engagement }: { engagement: SetupEngagement }) {
  const completedAt = engagement.completed_at
    ? new Date(engagement.completed_at).toLocaleDateString("da-DK", {
        day: "2-digit",
        month: "long",
        year: "numeric",
      })
    : null;

  return (
    <div className="mt-12 rounded-md border border-[var(--forest)]/20 bg-[var(--cream)] p-8 sm:p-12">
      <p className="tabular text-[10px] uppercase tracking-[0.3em] text-[var(--forest)]">
        Sendt {completedAt}
      </p>
      <h2 className="font-display mt-3 text-[34px] italic leading-tight text-[var(--ink)] sm:text-[44px]">
        Tak — jeg har det jeg skal bruge.
      </h2>
      <p className="mt-5 max-w-[55ch] text-[15px] leading-[1.7] text-[var(--ink)]/75">
        Jeg er notificeret om at du er færdig. Jeg vender tilbage indenfor et døgn med en bekræftelse på opstart og første konkrete leverance.
      </p>
      <p className="mt-6 text-[13px] text-[var(--ink)]/55">
        Du kan stadig se siden, men felterne er låst. Skriv på{" "}
        <a
          href="mailto:louis@carterco.dk"
          className="underline decoration-[var(--ink)]/30 underline-offset-2 hover:text-[var(--ink)]/80"
        >
          louis@carterco.dk
        </a>{" "}
        hvis noget skal rettes.
      </p>
    </div>
  );
}
