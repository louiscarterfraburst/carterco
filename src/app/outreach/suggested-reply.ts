// Outcome contract for the "Generér svar" button in SuggestedReply.
//
// ai-triage-reply legitimately returns draft=null when the AI judges that no
// reply is warranted (hard decline, emoji, OOO — priority "done"/"low"). The
// box must say so inline; a silent no-op reads as a dead button (observed
// 2026-06-10: two hard-decline replies triaged fine, UI showed nothing).

export type GenerateReplyResult = {
  ok: boolean;
  draft: string | null;
  action: string | null; // triage_action — the AI's one-line Danish TODO
};

export type GenerateOutcome =
  | { kind: "draft"; draft: string }
  | { kind: "no_draft"; notice: string }
  | { kind: "error"; notice: string };

export function resolveGenerateOutcome(res: GenerateReplyResult): GenerateOutcome {
  if (!res.ok) {
    return { kind: "error", notice: "Generering fejlede. Se fejlbeskeden øverst på siden." };
  }
  const draft = res.draft?.trim() ?? "";
  if (draft) return { kind: "draft", draft };
  return {
    kind: "no_draft",
    notice: res.action
      ? `AI'en vurderer at intet svar er nødvendigt: ${res.action}`
      : "AI'en vurderer at intet svar er nødvendigt her.",
  };
}
