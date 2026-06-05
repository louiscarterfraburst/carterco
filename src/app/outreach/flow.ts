// Flow-map model for the /outreach automation tree.
//
// The visual is a branching decision tree (React Flow), not a linear pipeline:
// invited → accept branches → render/approve → FIRST DM (which forks into the
// A/B arms) → each arm's matched follow-up sequence. Replies and terminal
// states are cross-cutting OUTCOMES, rendered in a strip below the tree rather
// than as tree nodes (a lead can reply or fail from any branch).
//
// The top-level status state machine lives in edge-function code
// (sendpilot-webhook), so the node/edge SHAPE is authored here. Sequence-step
// labels + message templates + arm routing are read live from
// outreach_sequences; the A/B scoreboard numbers come from the vw_first_dm_ab
// view (assigned / sent / replied / reply_pct per arm).
//
// classifyNode assigns each contact to exactly ONE id (a tree node or an
// outcome), so counts sum to the workspace's live total.

export type FlowTone = "neutral" | "active" | "good" | "warn" | "bad";
export type FlowKind = "status" | "arm" | "sequence";

// Structural subset of PipelineRow that classifyNode needs.
export type FlowRow = {
  status: string;
  sent_at: string | null;
  last_reply_at: string | null;
  last_reply_intent: string | null;
  sequence_id: string | null;
  sequence_step: number | null;
  sequence_completed_at: string | null;
  first_dm_variant: string | null;
};

// One row of vw_first_dm_ab — the per-arm A/B scoreboard.
export type ArmStat = {
  first_dm_variant: string;
  assigned: number;
  sent: number;
  replied: number;
  reply_pct: number | null;
};

export type SeqBranchLite = { requires?: string[]; action?: { type?: string; template?: string } };
export type SeqStepLite = { id: string; waitHours?: number; branches?: SeqBranchLite[] };
export type SeqLite = {
  id: string;
  description?: string | null;
  workspace_id: string | null;
  trigger_signal?: string | null;
  match_first_dm_variant?: string | null;
  steps: SeqStepLite[];
};

export const ARM_META: Record<string, { label: string; sublabel: string }> = {
  v1_long: { label: "V1 · lang tekst", sublabel: "voksen, forklarende" },
  v2_short: { label: "V2 · kort tekst", sublabel: "krog: 2-3 ting?" },
  v3_video: { label: "V3 · video", sublabel: "SendSpark" },
};
export const ARM_ORDER = ["v1_long", "v2_short", "v3_video"];

export type NodeDef = {
  id: string;
  label: string;
  col: number;        // vertical depth (top→bottom)
  tone: FlowTone;
  kind: FlowKind;
  sublabel?: string;
  arm?: string;
  lane?: number;      // horizontal lane (arm mode): keeps each arm's chain vertical
};

export type EdgeDef = { id: string; source: string; target: string };

const KNOWN_REPLY_INTENTS = new Set(["interested", "question", "referral", "ooo", "decline"]);

// Most-advanced-first. Returns the single id (tree node OR outcome) a contact
// currently sits in.
export function classifyNode(r: FlowRow): string {
  if (r.status === "rejected") return "rejected";
  if (r.status === "rejected_by_icp") return "rejected_by_icp";
  if (r.status === "failed") return "failed";
  if (r.sequence_completed_at) return "sequence_completed";
  if (r.last_reply_at) {
    const intent = r.last_reply_intent ?? "other";
    return KNOWN_REPLY_INTENTS.has(intent) ? `reply:${intent}` : "reply:other";
  }
  if (r.sequence_id && r.sequence_step != null) return `seq:${r.sequence_id}:${r.sequence_step}`;
  // An assigned A/B arm (immutable at accept) owns the lead through its whole
  // pre-follow-up life — sent AND pre-send (V3 mid-render etc.) — so arm leads
  // don't scatter across render/approve status nodes.
  if (r.first_dm_variant) return `arm:${r.first_dm_variant}`;
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

// Outcome buckets — rendered in a strip below the tree, not as tree nodes.
export const OUTCOME_DEFS: { id: string; label: string; tone: FlowTone; group: "reply" | "terminal" }[] = [
  { id: "reply:interested", label: "Interesseret", tone: "good", group: "reply" },
  { id: "reply:question", label: "Spørgsmål", tone: "active", group: "reply" },
  { id: "reply:referral", label: "Henvisning", tone: "active", group: "reply" },
  { id: "reply:ooo", label: "Autosvar / OOO", tone: "neutral", group: "reply" },
  { id: "reply:decline", label: "Nej tak", tone: "warn", group: "reply" },
  { id: "reply:other", label: "Andet svar", tone: "neutral", group: "reply" },
  { id: "sequence_completed", label: "Forløb færdigt", tone: "neutral", group: "terminal" },
  { id: "rejected", label: "Afvist", tone: "bad", group: "terminal" },
  { id: "rejected_by_icp", label: "ICP-afvist", tone: "bad", group: "terminal" },
  { id: "failed", label: "Fejlet", tone: "bad", group: "terminal" },
];

// Arms that exist for this workspace — union of scoreboard rows, leads carrying
// a variant, and sequences matched to a variant (so the A/B structure shows
// even before any lead reaches an arm).
export function activeArms(sequences: SeqLite[], rows: FlowRow[], armStats: ArmStat[]): string[] {
  const set = new Set<string>();
  for (const a of armStats) if (a.first_dm_variant) set.add(a.first_dm_variant);
  for (const r of rows) if (r.first_dm_variant) set.add(r.first_dm_variant);
  for (const s of sequences) if (s.match_first_dm_variant) set.add(s.match_first_dm_variant);
  const ordered = ARM_ORDER.filter((a) => set.has(a));
  const extra = [...set].filter((a) => !ARM_ORDER.includes(a));
  return [...ordered, ...extra];
}

// Tree nodes. Outcomes are NOT here — they live in OUTCOME_DEFS.
export function buildTreeNodes(sequences: SeqLite[], rows: FlowRow[], armStats: ArmStat[]): NodeDef[] {
  const arms = activeArms(sequences, rows, armStats);

  // ARM MODE (Tresyv-style A/B): invited → each arm → that arm's matched
  // follow-up steps, chained straight down its own lane. No render spine, no
  // stray "Sendt" — arms fork at the top, every arm shows its own follow-ups.
  if (arms.length) {
    const armNodes: NodeDef[] = [
      { id: "invited", label: "Inviteret", col: 0, tone: "neutral", kind: "status", lane: (arms.length - 1) / 2 },
    ];
    arms.forEach((a, i) => {
      const meta = ARM_META[a] ?? { label: a, sublabel: "" };
      armNodes.push({ id: `arm:${a}`, label: meta.label, col: 1, tone: "active", kind: "arm", sublabel: meta.sublabel, arm: a, lane: i });
    });
    // sequences grouped by arm; multiple sequences in one arm get sub-lanes.
    const seqsByArm = new Map<string, SeqLite[]>();
    for (const seq of sequences) {
      const v = seq.match_first_dm_variant;
      if (v && arms.includes(v) && seq.steps?.length) {
        const list = seqsByArm.get(v); if (list) list.push(seq); else seqsByArm.set(v, [seq]);
      }
    }
    arms.forEach((a, armIdx) => {
      const seqs = seqsByArm.get(a) ?? [];
      seqs.forEach((seq, sj) => {
        const sub = seqs.length > 1 ? (sj - (seqs.length - 1) / 2) * 0.5 : 0;
        seq.steps.forEach((step, idx) => {
          armNodes.push({
            id: `seq:${seq.id}:${idx}`,
            label: step.id || `trin ${idx}`,
            col: 2 + idx,
            tone: "active",
            kind: "sequence",
            sublabel: seq.id,
            arm: a,
            lane: armIdx + sub,
          });
        });
      });
    });
    return armNodes;
  }

  // NON-ARM MODE (CarterCo / OdaGroup): invite → accept → path → render → send.
  const nodes: NodeDef[] = [
    { id: "invited", label: "Inviteret", col: 0, tone: "neutral", kind: "status" },
    { id: "accepted", label: "Accepteret", col: 1, tone: "neutral", kind: "status" },
    { id: "pending_pre_render", label: "Afventer pre-render", col: 2, tone: "neutral", kind: "status", sublabel: "kold video" },
    { id: "pending_ai_draft", label: "AI-draft", col: 2, tone: "neutral", kind: "status", sublabel: "tekst, ingen video" },
    { id: "pre_connected", label: "Pre-forbundet", col: 2, tone: "neutral", kind: "status", sublabel: "allerede forbundet" },
    { id: "pending_alt_review", label: "Alt-review", col: 2, tone: "neutral", kind: "status" },
    { id: "rendering", label: "Renderer", col: 3, tone: "neutral", kind: "status" },
    { id: "rendered", label: "Renderet", col: 3, tone: "neutral", kind: "status" },
    { id: "pending_approval", label: "Til godkendelse", col: 3, tone: "active", kind: "status" },
  ];

  // "Sendt" — the AI-personalised first DM (this branch only runs when there
  // are no A/B arms).
  nodes.push({
    id: "sent",
    label: "Sendt",
    col: 4,
    tone: "active",
    kind: "status",
    sublabel: "AI-personaliseret 1. DM",
  });

  // Sequence nodes (col 5), grouped under their arm via match_first_dm_variant.
  const seen = new Set<string>();
  for (const seq of sequences) {
    seq.steps?.forEach((step, idx) => {
      const id = `seq:${seq.id}:${idx}`;
      seen.add(id);
      nodes.push({
        id,
        label: step.id || `trin ${idx}`,
        col: 5,
        tone: "active",
        kind: "sequence",
        sublabel: seq.id,
        arm: seq.match_first_dm_variant ?? undefined,
      });
    });
  }
  // Catch rows pointing at a step with no definition loaded.
  for (const r of rows) {
    if (r.sequence_id && r.sequence_step != null && !r.sequence_completed_at) {
      const id = `seq:${r.sequence_id}:${r.sequence_step}`;
      if (!seen.has(id)) {
        seen.add(id);
        nodes.push({ id, label: `trin ${r.sequence_step}`, col: 5, tone: "active", kind: "sequence", sublabel: r.sequence_id });
      }
    }
  }
  return nodes;
}

export function buildTreeEdges(nodes: NodeDef[], sequences: SeqLite[]): EdgeDef[] {
  const have = new Set(nodes.map((n) => n.id));
  const edges: EdgeDef[] = [];
  const add = (source: string, target: string) => {
    if (have.has(source) && have.has(target)) {
      edges.push({ id: `${source}=>${target}`, source, target });
    }
  };

  // ARM MODE: invited → each arm → that arm's follow-up step chain.
  const armIds = nodes.filter((n) => n.kind === "arm").map((n) => n.id);
  if (armIds.length) {
    for (const armId of armIds) add("invited", armId);
    for (const seq of sequences) {
      const v = seq.match_first_dm_variant;
      if (!v || !seq.steps?.length || !have.has(`arm:${v}`)) continue;
      add(`arm:${v}`, `seq:${seq.id}:0`);
      for (let i = 0; i < seq.steps.length - 1; i++) add(`seq:${seq.id}:${i}`, `seq:${seq.id}:${i + 1}`);
    }
    return edges;
  }

  // NON-ARM MODE: invited → accepted → the per-client paths fork FROM acceptance.
  add("invited", "accepted");
  add("accepted", "pending_pre_render");
  add("accepted", "pending_ai_draft");
  add("accepted", "pre_connected");
  add("accepted", "pending_alt_review");
  add("pending_pre_render", "rendering");
  add("rendering", "rendered");
  add("rendered", "pending_approval");
  add("pending_ai_draft", "pending_approval");

  // First-DM fork: approval dispatches into "Sendt" + each arm.
  for (const n of nodes.filter((x) => x.col === 4)) add("pending_approval", n.id);

  // Each first-DM node flows into its matched follow-up sequences.
  for (const seq of sequences) {
    if (!seq.steps?.length) continue;
    const parent = seq.match_first_dm_variant ? `arm:${seq.match_first_dm_variant}` : "sent";
    add(parent, `seq:${seq.id}:0`);
    for (let i = 0; i < seq.steps.length - 1; i++) {
      add(`seq:${seq.id}:${i}`, `seq:${seq.id}:${i + 1}`);
    }
  }
  return edges;
}

// Resolve a seq node id back to its sequence + step for the message template.
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
