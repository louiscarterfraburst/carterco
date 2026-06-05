// Flow-map model for the /outreach automation view.
//
// The top-level status state machine lives in edge-function code
// (sendpilot-webhook), not in data, so the node/edge SHAPE is authored here as
// a constant. Only the sequence-step labels + message templates are read live
// from `outreach_sequences` (see buildSequenceNodes / SeqLite).
//
// classifyNode assigns each contact to exactly ONE node — its current position,
// most-advanced-first — so per-node counts sum to the workspace's live total
// and the map reads as "everyone is somewhere".

export type FlowTone = "neutral" | "active" | "good" | "warn" | "bad";
export type FlowKind = "status" | "sequence" | "reply" | "terminal";

export type FlowNode = {
  id: string;
  label: string;
  col: number;
  tone: FlowTone;
  kind: FlowKind;
  sublabel?: string;
};

// Structural subset of PipelineRow that classifyNode needs. PipelineRow is
// structurally compatible, so rows pass through without a cast.
export type FlowRow = {
  status: string;
  sent_at: string | null;
  last_reply_at: string | null;
  last_reply_intent: string | null;
  sequence_id: string | null;
  sequence_step: number | null;
  sequence_completed_at: string | null;
};

// One step's worth of copy, parsed from outreach_sequences.steps (jsonb).
export type SeqBranchLite = {
  requires?: string[];
  action?: { type?: string; template?: string };
};
export type SeqStepLite = { id: string; waitHours?: number; branches?: SeqBranchLite[] };
export type SeqLite = {
  id: string;
  description?: string | null;
  workspace_id: string | null;
  trigger_signal?: string | null;
  steps: SeqStepLite[];
};

export const COLUMN_TITLES = [
  "Invite",
  "Accept",
  "Render & godkend",
  "Sendt",
  "Forløb",
  "Svar",
  "Afsluttet",
] as const;

export const SEQUENCE_COL = 4;

// Static nodes for the fixed columns. Column 4 (sequences) is built at render
// time from the live sequence definitions + any seq ids present in the rows.
export const STATIC_NODES: FlowNode[] = [
  { id: "invited", label: "Inviteret", col: 0, tone: "neutral", kind: "status" },

  { id: "accepted", label: "Accepteret", col: 1, tone: "neutral", kind: "status" },
  { id: "pending_pre_render", label: "Afventer pre-render", col: 1, tone: "neutral", kind: "status", sublabel: "kold video / CarterCo" },
  { id: "pending_ai_draft", label: "AI-draft", col: 1, tone: "neutral", kind: "status", sublabel: "OdaGroup tekst" },
  { id: "pre_connected", label: "Pre-forbundet", col: 1, tone: "neutral", kind: "status", sublabel: "allerede forbundet" },

  { id: "rendering", label: "Renderer", col: 2, tone: "neutral", kind: "status" },
  { id: "rendered", label: "Renderet", col: 2, tone: "neutral", kind: "status" },
  { id: "pending_approval", label: "Til godkendelse", col: 2, tone: "active", kind: "status" },
  { id: "pending_alt_review", label: "Alt-review", col: 2, tone: "neutral", kind: "status" },

  { id: "sent", label: "Sendt", col: 3, tone: "active", kind: "status", sublabel: "AI-personaliseret 1. DM" },

  { id: "reply:interested", label: "Interesseret", col: 5, tone: "good", kind: "reply" },
  { id: "reply:question", label: "Spørgsmål", col: 5, tone: "active", kind: "reply" },
  { id: "reply:referral", label: "Henvisning", col: 5, tone: "active", kind: "reply" },
  { id: "reply:ooo", label: "Autosvar / OOO", col: 5, tone: "neutral", kind: "reply" },
  { id: "reply:decline", label: "Nej tak", col: 5, tone: "warn", kind: "reply" },
  { id: "reply:other", label: "Andet svar", col: 5, tone: "neutral", kind: "reply" },

  { id: "sequence_completed", label: "Forløb færdigt", col: 6, tone: "neutral", kind: "terminal" },
  { id: "rejected", label: "Afvist", col: 6, tone: "bad", kind: "terminal" },
  { id: "rejected_by_icp", label: "ICP-afvist", col: 6, tone: "bad", kind: "terminal" },
  { id: "failed", label: "Fejlet", col: 6, tone: "bad", kind: "terminal" },
];

const KNOWN_REPLY_INTENTS = new Set([
  "interested",
  "question",
  "referral",
  "ooo",
  "decline",
]);

// Most-advanced-first. Returns the single node id a contact currently sits in.
export function classifyNode(r: FlowRow): string {
  if (r.status === "rejected") return "rejected";
  if (r.status === "rejected_by_icp") return "rejected_by_icp";
  if (r.status === "failed") return "failed";
  if (r.sequence_completed_at) return "sequence_completed";
  if (r.last_reply_at) {
    const intent = r.last_reply_intent ?? "other";
    return KNOWN_REPLY_INTENTS.has(intent) ? `reply:${intent}` : "reply:other";
  }
  if (r.sequence_id && r.sequence_step != null) {
    return `seq:${r.sequence_id}:${r.sequence_step}`;
  }
  if (r.status === "sent") return "sent";
  if (r.status === "pending_approval") return "pending_approval";
  if (r.status === "pending_alt_review") return "pending_alt_review";
  if (r.status === "rendered") return "rendered";
  if (r.status === "rendering") return "rendering";
  if (r.status === "pending_pre_render") return "pending_pre_render";
  if (r.status === "pending_ai_draft") return "pending_ai_draft";
  if (r.status === "pre_connected") return "pre_connected";
  if (r.status === "accepted") return "accepted";
  return "invited";
}

// Build the sequence column (col 4) from live definitions + any seq positions
// the rows actually occupy (so an unknown/legacy sequence still shows a node).
export function buildSequenceNodes(sequences: SeqLite[], rows: FlowRow[]): FlowNode[] {
  const nodes = new Map<string, FlowNode>();
  for (const seq of sequences) {
    seq.steps?.forEach((step, idx) => {
      const id = `seq:${seq.id}:${idx}`;
      nodes.set(id, {
        id,
        label: step.id || `trin ${idx}`,
        col: SEQUENCE_COL,
        tone: "active",
        kind: "sequence",
        sublabel: seq.id,
      });
    });
  }
  // Catch rows pointing at a step we have no definition for.
  for (const r of rows) {
    if (r.sequence_id && r.sequence_step != null && !r.sequence_completed_at) {
      const id = `seq:${r.sequence_id}:${r.sequence_step}`;
      if (!nodes.has(id)) {
        nodes.set(id, {
          id,
          label: `trin ${r.sequence_step}`,
          col: SEQUENCE_COL,
          tone: "active",
          kind: "sequence",
          sublabel: r.sequence_id,
        });
      }
    }
  }
  return Array.from(nodes.values());
}

// Resolve a seq node id back to its sequence + step so the UI can show the
// step's message template(s). Returns null for non-sequence nodes.
export function lookupSeqStep(
  nodeId: string,
  sequences: SeqLite[],
): { seq: SeqLite; step: SeqStepLite; index: number } | null {
  if (!nodeId.startsWith("seq:")) return null;
  const lastColon = nodeId.lastIndexOf(":");
  const seqId = nodeId.slice(4, lastColon);
  const index = Number(nodeId.slice(lastColon + 1));
  const seq = sequences.find((s) => s.id === seqId);
  if (!seq) return null;
  const step = seq.steps?.[index];
  if (!step) return null;
  return { seq, step, index };
}
