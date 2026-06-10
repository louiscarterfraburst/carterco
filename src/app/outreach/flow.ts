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
  // A reply outranks everything: if they engaged, that's where they are — even
  // if the send was flagged "failed" (a 500 can be a false failure that still
  // delivered, e.g. they replied to it).
  if (r.last_reply_at) {
    const intent = r.last_reply_intent ?? "other";
    return KNOWN_REPLY_INTENTS.has(intent) ? `reply:${intent}` : "reply:other";
  }
  if (r.status === "rejected") return "rejected";
  if (r.status === "rejected_by_icp") return "rejected_by_icp";
  if (r.status === "failed") return "failed";
  if (r.sequence_completed_at) return "sequence_completed";
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
      { id: "invited", label: STATUS_LABELS.invited, col: 0, tone: "neutral", kind: "status", lane: (arms.length - 1) / 2 },
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
  // Labels come from STATUS_LABELS so nodeLabel-driven list views match.
  const nodes: NodeDef[] = [
    { id: "invited", label: STATUS_LABELS.invited, col: 0, tone: "neutral", kind: "status" },
    { id: "accepted", label: STATUS_LABELS.accepted, col: 1, tone: "neutral", kind: "status" },
    { id: "pending_pre_render", label: STATUS_LABELS.pending_pre_render, col: 2, tone: "neutral", kind: "status", sublabel: "kold video" },
    { id: "pending_ai_draft", label: STATUS_LABELS.pending_ai_draft, col: 2, tone: "neutral", kind: "status", sublabel: "tekst, ingen video" },
    { id: "pre_connected", label: STATUS_LABELS.pre_connected, col: 2, tone: "neutral", kind: "status", sublabel: "allerede forbundet" },
    { id: "pending_alt_review", label: STATUS_LABELS.pending_alt_review, col: 2, tone: "neutral", kind: "status" },
    { id: "rendering", label: STATUS_LABELS.rendering, col: 3, tone: "neutral", kind: "status" },
    { id: "rendered", label: STATUS_LABELS.rendered, col: 3, tone: "neutral", kind: "status" },
    { id: "pending_approval", label: STATUS_LABELS.pending_approval, col: 3, tone: "active", kind: "status" },
  ];

  // "Sendt" — the AI-personalised first DM (this branch only runs when there
  // are no A/B arms).
  nodes.push({
    id: "sent",
    label: STATUS_LABELS.sent,
    col: 4,
    tone: "active",
    kind: "status",
    sublabel: "AI-personaliseret 1. DM",
  });

  // Sequence chains below "Sendt": each sequence is its OWN vertical lane and
  // its steps chain straight down (col 5 + stepIndex), so follow-ups never run
  // horizontally. Each sequence gets a lane; steps stack beneath it.
  const seen = new Set<string>();
  const laneOf = new Map<string, number>();
  const defs = sequences.filter((s) => s.steps?.length);
  defs.forEach((seq, i) => laneOf.set(seq.id, i));
  for (const r of rows) {
    if (r.sequence_id && !laneOf.has(r.sequence_id)) laneOf.set(r.sequence_id, laneOf.size);
  }
  const center = (laneOf.size - 1) / 2;

  for (const seq of defs) {
    const lane = (laneOf.get(seq.id) ?? 0) - center;
    seq.steps.forEach((step, idx) => {
      const id = `seq:${seq.id}:${idx}`;
      seen.add(id);
      nodes.push({
        id,
        label: step.id || `trin ${idx}`,
        col: 5 + idx,
        tone: "active",
        kind: "sequence",
        sublabel: seq.id,
        lane,
      });
    });
  }
  // Catch rows pointing at a step with no definition loaded.
  for (const r of rows) {
    if (r.sequence_id && r.sequence_step != null && !r.sequence_completed_at) {
      const id = `seq:${r.sequence_id}:${r.sequence_step}`;
      if (!seen.has(id)) {
        seen.add(id);
        nodes.push({
          id,
          label: `trin ${r.sequence_step}`,
          col: 5 + r.sequence_step,
          tone: "active",
          kind: "sequence",
          sublabel: r.sequence_id,
          lane: (laneOf.get(r.sequence_id) ?? 0) - center,
        });
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

// Danish labels for the status tree nodes — the single source: buildTreeNodes
// builds its spine NodeDefs from this map, and nodeLabel reads it, so list
// views (play roster, Kontakter step column) can never drift from the tree.
export const STATUS_LABELS: Record<string, string> = {
  invited: "Inviteret",
  accepted: "Accepteret",
  pending_pre_render: "Afventer pre-render",
  pending_ai_draft: "AI-draft",
  pre_connected: "Pre-forbundet",
  pending_alt_review: "Alt-review",
  rendering: "Renderer",
  rendered: "Renderet",
  pending_approval: "Til godkendelse",
  sent: "Sendt",
};

// Pipeline rows still being worked: not terminal, not finished, not replied.
export const PLAY_TERMINAL_STATUSES = new Set(["rejected", "rejected_by_icp", "failed"]);

// Structural subset of the page's Play type that resolution/stats need.
export type PlayLite = {
  id: string;
  workspace_id: string | null;
  position: number;
};

// Registry resolution, mirroring outreach_sequences: a workspace-specific row
// overrides the global row with the same id, regardless of arrival order;
// the resolved set sorts by position.
export function resolvePlays<T extends PlayLite>(rows: T[]): T[] {
  const byId = new Map<string, T>();
  for (const p of rows) {
    const existing = byId.get(p.id);
    if (!existing || (existing.workspace_id === null && p.workspace_id !== null)) {
      byId.set(p.id, p);
    }
  }
  return [...byId.values()].sort((a, b) => a.position - b.position);
}

// Per-play headline numbers for the Plays tab. A replied contact counts as
// svar but NOT aktiv (the reply ends the automated flow); terminal and
// sequence-completed rows aren't aktive either. Rows whose play isn't in
// playIds are dropped — callers surface those separately if needed.
export type PlayStatRow = {
  play: string | null;
  status: string;
  sent_at: string | null;
  last_reply_at: string | null;
  sequence_completed_at: string | null;
};

export function playStats<R extends PlayStatRow>(
  playIds: string[],
  rows: R[],
): Map<string, { pipe: R[]; active: number; sent: number; replied: number }> {
  const m = new Map<string, { pipe: R[]; active: number; sent: number; replied: number }>();
  for (const id of playIds) m.set(id, { pipe: [], active: 0, sent: 0, replied: 0 });
  for (const r of rows) {
    const s = m.get(r.play ?? "");
    if (!s) continue;
    s.pipe.push(r);
    if (r.sent_at) s.sent++;
    if (r.last_reply_at) s.replied++;
    else if (!PLAY_TERMINAL_STATUSES.has(r.status) && !r.sequence_completed_at) s.active++;
  }
  return m;
}

// Sequences relevant to one play's scoped view: lanes holding the play's
// contacts, plus the play's own trigger sequence (so its skeleton shows even
// at 0 leads). Without this, a play-filtered tree renders the OTHER play's
// follow-up lanes as empty skeleton — exactly the "which steps belong to this
// flow?" confusion the play filter exists to remove.
export function scopeSequencesToPlay(
  sequences: SeqLite[],
  scopedRows: Pick<FlowRow, "sequence_id">[],
  triggerSequenceId?: string | null,
): SeqLite[] {
  const used = new Set(scopedRows.map((r) => r.sequence_id).filter(Boolean));
  return sequences.filter((s) => used.has(s.id) || s.id === triggerSequenceId);
}

// Human label for any classifyNode() id — status node, arm, sequence step or
// outcome. Lets list views (play roster, Kontakter step column) name a
// contact's current position with the exact wording the Flow tree uses.
export function nodeLabel(id: string, sequences: SeqLite[]): string {
  const seqStep = lookupSeqStep(id, sequences);
  if (seqStep) return seqStep.step.id || `trin ${seqStep.index}`;
  if (id.startsWith("seq:")) return `trin ${id.slice(id.lastIndexOf(":") + 1)}`;
  if (id.startsWith("arm:")) return ARM_META[id.slice(4)]?.label ?? id.slice(4);
  const outcome = OUTCOME_DEFS.find((o) => o.id === id);
  if (outcome) return outcome.label;
  return STATUS_LABELS[id] ?? id;
}

// Relative compact age for flow cards and roster rows ("45 min", "3 t", "6 d").
export function flowTimeAgo(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60000);
  if (min < 60) return `${Math.max(0, min)} min`;
  const hrs = Math.round(min / 60);
  if (hrs < 24) return `${hrs} t`;
  return `${Math.round(hrs / 24)} d`;
}

// LinkedIn URLs arrive with trailing slashes, query params and mixed case —
// normalize before using as a map key so staged leads match pipeline rows.
// Query strip runs BEFORE slash strip so ".../mette-hansen/?utm=x" and
// ".../mette-hansen" collide.
export function normLinkedinUrl(u: string | null): string {
  return (u ?? "").split("?")[0].replace(/\/+$/, "").toLowerCase();
}

// Structural subset of a pipeline row that stage derivation needs.
export type StageMarks = {
  last_reply_at: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  invited_at: string | null;
};

// Per-lead stage, derived by matching the staged lead to its pipeline row
// (if invited yet) via a prebuilt normalized-URL map — O(1) per lead instead
// of scanning the pipeline per row. Drives the row status pill.
export function stagedLeadStage<R extends StageMarks>(
  l: { linkedin_url: string | null },
  pipeByUrl: Map<string, R>,
): string {
  const r = pipeByUrl.get(normLinkedinUrl(l.linkedin_url));
  if (!r) return "Klargjort";
  if (r.last_reply_at) return "Svar";
  if (r.sent_at) return "Video";
  if (r.accepted_at) return "Accepteret";
  if (r.invited_at) return "Inviteret";
  return "Klargjort";
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
