import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { promises as fs } from "node:fs";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only client-overview endpoint. Aggregates per-workspace config the user
// needs in one place to avoid editing the wrong client's flow: voice playbook,
// active ICP, agent brief (for AI-drafted clients), and live pipeline counts.

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://znpaevzwlcfuzqxsbyie.supabase.co";
const SUPABASE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  "sb_publishable_rKCrGrKGUr48lEhjqWj3dw_V0kAEKQl";

// Mirrors supabase/functions/_shared/workspaces.ts. The Next app cannot import
// across that boundary, so we duplicate the small mapping here. When you add a
// client, update both files.
const WORKSPACE_OUTREACH_STYLE: Record<string, "video_render" | "ai_drafted_dm"> = {
  "1e067f9a-d453-41a7-8bc4-9fdb5644a5fa": "video_render",  // CarterCo
  "2740ba1f-d5d5-4008-bf43-b45367c73134": "video_render",  // Tresyv
  "f4777612-4615-4734-94de-4745eade3318": "video_render",  // Haugefrom
  "cdfd80d8-33bb-4b64-b778-0a2c5ab78cc6": "ai_drafted_dm", // OdaGroup
};

// Maps workspace UUID → slug under clients/<slug>/agent-brief.md.
const WORKSPACE_BRIEF_SLUG: Record<string, string> = {
  "cdfd80d8-33bb-4b64-b778-0a2c5ab78cc6": "odagroup",
};

type VoicePlaybook = {
  owner_first_name: string | null;
  value_prop: string | null;
  guidelines: string | null;
  cta_preference: string | null;
  booking_link: string | null;
  updated_at: string | null;
};

type IcpVersion = {
  version: number;
  company_fit: string | null;
  person_fit: string | null;
  alternate_search_titles: string[] | null;
  alternate_search_locations: string[] | null;
  min_company_score: number | null;
  min_person_score: number | null;
  created_at: string | null;
};

type AgentBrief = {
  slug: string;
  path: string;
  content: string;
  strategies: string[];
};

type PipelineCounts = Record<string, number>;

export type FirstMessageFlow = {
  kind: "video_render" | "ai_drafted_dm";
  trigger: string;
  summary: string;
  steps: { label: string; detail: string; ref: string }[];
};

export type SharedSequenceStep = {
  id: string;
  wait_hours: number;
  template: string;
};

export type SharedSequence = {
  id: string;
  description: string;
  trigger: string;
  excludes_global: string[];
  steps: SharedSequenceStep[];
  source: "global" | "workspace";  // where the row lives in outreach_sequences
};

export type ClientConfig = {
  workspace: { id: string; name: string; owner_email: string | null };
  outreach_style: "video_render" | "ai_drafted_dm";
  voice_playbook: VoicePlaybook | null;
  active_icp: IcpVersion | null;
  agent_brief: AgentBrief | null;
  first_message_flow: FirstMessageFlow;
  sequences: SharedSequence[];     // resolved per-workspace from outreach_sequences
  pipeline_counts: PipelineCounts;
  pipeline_total_30d: number;
  sent_30d: number;
  replied_30d: number;
};

// Shape of one outreach_sequences row (the `steps` jsonb mirrors the
// SequenceStep type in supabase/functions/_shared/sequences.ts).
type SequenceRow = {
  id: string;
  workspace_id: string | null;
  description: string | null;
  trigger_signal: string;
  excludes_global: string[] | null;
  position: number;
  steps: Array<{
    id: string;
    waitHours: number;
    branches?: Array<{ action: { type: string; template?: string } }>;
  }>;
};

// Resolve workspace-scoped sequences from the full row set. Workspace-specific
// rows override globals by matching id. Mirrors the logic in
// supabase/functions/_shared/sequences.ts so the page and the engine agree
// about which sequences a given lead would enrol into.
function resolveForWorkspace(rows: SequenceRow[], workspaceId: string): SharedSequence[] {
  const byId = new Map<string, SequenceRow>();
  for (const r of rows) if (r.workspace_id === null) byId.set(r.id, r);
  for (const r of rows) if (r.workspace_id === workspaceId) byId.set(r.id, r);
  return Array.from(byId.values())
    .sort((a, b) => a.position - b.position)
    .map(rowToShared);
}

function rowToShared(r: SequenceRow): SharedSequence {
  // Pull the first auto_send template out of each step's branches. The page
  // only renders the message body, not the full branch structure, since the
  // current sequences all use a single unconditional branch per step.
  const steps: SharedSequenceStep[] = r.steps.map((s) => {
    const firstAutoSend = (s.branches ?? []).find((b) => b.action?.type === "auto_send");
    return {
      id: s.id,
      wait_hours: s.waitHours,
      template: firstAutoSend?.action.template ?? "(no template — branch is not auto_send)",
    };
  });
  return {
    id: r.id,
    description: r.description ?? "",
    trigger: r.trigger_signal,
    excludes_global: r.excludes_global ?? ["replied"],
    steps,
    source: r.workspace_id === null ? "global" : "workspace",
  };
}

function firstMessageFlowFor(style: "video_render" | "ai_drafted_dm"): FirstMessageFlow {
  if (style === "ai_drafted_dm") {
    return {
      kind: "ai_drafted_dm",
      trigger: "connection.accepted (SendPilot webhook)",
      summary:
        "Claude drafter første DM ud fra agent-brief + lead-data. Brugeren godkender i /outreach inden afsendelse.",
      steps: [
        {
          label: "1. Connection request",
          detail: "Sendes fra SendPilot (kampagne / cadence — uden for kodebasen).",
          ref: "SendPilot UI",
        },
        {
          label: "2. Accept → draft",
          detail: "sendpilot-webhook routes til workspace, kalder draftFirstMessage.",
          ref: "supabase/functions/sendpilot-webhook/index.ts",
        },
        {
          label: "3. Claude skriver",
          detail: "draftFirstMessage læser agent-brief, vælger strategi, skriver DM.",
          ref: "supabase/functions/_shared/draft-first-message.ts",
        },
        {
          label: "4. Godkendelse",
          detail: "Draften lander i /outreach som pending_approval. Du godkender → SendPilot sender.",
          ref: "/outreach (Approve)",
        },
      ],
    };
  }
  return {
    kind: "video_render",
    trigger: "connection.accepted (SendPilot webhook)",
    summary:
      "SendSpark renderer en personlig video. Når render er færdig, sendes DM med video-link via SendPilot.",
    steps: [
      {
        label: "1. Connection request",
        detail: "Sendes fra SendPilot (kampagne / cadence — uden for kodebasen).",
        ref: "SendPilot UI",
      },
      {
        label: "2. Accept → render",
        detail: "sendpilot-webhook starter SendSpark-render med per-workspace creds.",
        ref: "supabase/functions/sendpilot-webhook/index.ts + _shared/sendspark-config.ts",
      },
      {
        label: "3. Render done",
        detail: "sendspark-webhook fanger 'rendered' og markerer leadet klar.",
        ref: "supabase/functions/sendspark-webhook/index.ts",
      },
      {
        label: "4. Godkendelse",
        detail: "Du previewer videoen i /outreach og godkender → SendPilot sender DM med link.",
        ref: "/outreach (Approve)",
      },
    ],
  };
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Build a Supabase client that carries the user's JWT so RLS scopes the
  // query to the workspaces they're a member of.
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data: workspaces, error: wsErr } = await sb
    .from("workspaces")
    .select("id, name, owner_email")
    .order("name", { ascending: true });

  if (wsErr) {
    return NextResponse.json({ error: wsErr.message }, { status: 500 });
  }

  // Pull every accessible sequence row in one go. RLS already scopes to
  // (workspace_id IS NULL OR I'm a workspace_member). For a few workspaces
  // and a handful of sequences this is a single small query.
  const { data: sequenceRows, error: seqErr } = await sb
    .from("outreach_sequences")
    .select("id, workspace_id, description, trigger_signal, excludes_global, position, steps")
    .eq("is_active", true)
    .order("position", { ascending: true });
  if (seqErr) {
    return NextResponse.json({ error: seqErr.message }, { status: 500 });
  }
  const allSequences = (sequenceRows ?? []) as SequenceRow[];

  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const configs: ClientConfig[] = await Promise.all(
    (workspaces ?? []).map(async (ws) => {
      const [playbook, icp, pipeline] = await Promise.all([
        sb.from("outreach_voice_playbooks")
          .select("owner_first_name, value_prop, guidelines, cta_preference, booking_link, updated_at")
          .eq("workspace_id", ws.id)
          .maybeSingle(),
        sb.from("icp_versions")
          .select("version, company_fit, person_fit, alternate_search_titles, alternate_search_locations, min_company_score, min_person_score, created_at")
          .eq("workspace_id", ws.id)
          .eq("is_active", true)
          .maybeSingle(),
        sb.from("outreach_pipeline")
          .select("status, sent_at, replied_at, created_at")
          .eq("workspace_id", ws.id)
          .gte("created_at", since30d),
      ]);

      const counts: PipelineCounts = {};
      let sent30d = 0;
      let replied30d = 0;
      for (const row of pipeline.data ?? []) {
        const status = (row as { status: string | null }).status ?? "unknown";
        counts[status] = (counts[status] ?? 0) + 1;
        const sentAt = (row as { sent_at: string | null }).sent_at;
        const repliedAt = (row as { replied_at: string | null }).replied_at;
        if (sentAt && sentAt >= since30d) sent30d += 1;
        if (repliedAt && repliedAt >= since30d) replied30d += 1;
      }

      let agentBrief: AgentBrief | null = null;
      const slug = WORKSPACE_BRIEF_SLUG[ws.id];
      if (slug) {
        try {
          const briefPath = path.join(process.cwd(), "clients", slug, "agent-brief.md");
          const content = await fs.readFile(briefPath, "utf8");
          agentBrief = {
            slug,
            path: `clients/${slug}/agent-brief.md`,
            content,
            strategies: extractStrategies(content),
          };
        } catch {
          agentBrief = null;
        }
      }

      const style = WORKSPACE_OUTREACH_STYLE[ws.id] ?? "video_render";
      return {
        workspace: { id: ws.id, name: ws.name, owner_email: ws.owner_email ?? null },
        outreach_style: style,
        voice_playbook: (playbook.data as VoicePlaybook | null) ?? null,
        active_icp: (icp.data as IcpVersion | null) ?? null,
        agent_brief: agentBrief,
        first_message_flow: firstMessageFlowFor(style),
        sequences: resolveForWorkspace(allSequences, ws.id),
        pipeline_counts: counts,
        pipeline_total_30d: (pipeline.data ?? []).length,
        sent_30d: sent30d,
        replied_30d: replied30d,
      } satisfies ClientConfig;
    }),
  );

  return NextResponse.json({ configs });
}

// Pulls the H3 strategy titles out of "## 4. The strategies" in the agent
// brief. Loose match: we accept "## 4. The strategies" or "## The strategies"
// and read every "### …" line until the next "## ".
function extractStrategies(md: string): string[] {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inStrategies = false;
  for (const line of lines) {
    if (/^##\s+(\d+\.\s+)?(the\s+)?strateg/i.test(line)) {
      inStrategies = true;
      continue;
    }
    if (inStrategies && /^##\s+/.test(line)) break;
    if (inStrategies) {
      const m = line.match(/^###\s+(.+?)\s*$/);
      if (m) out.push(m[1].trim());
    }
  }
  return out;
}
