"use client";

import {
  ChangeEvent,
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/client";
import { useWorkspace, type Workspace } from "@/utils/workspace";
import { clampToBusinessHours } from "@/utils/businessHours";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  type Node as RFNode,
  type Edge as RFEdge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ARM_META,
  OUTCOME_DEFS,
  activeArms,
  buildTreeNodes,
  buildTreeEdges,
  classifyNode,
  lookupSeqStep,
  nodeLabel,
  playStats,
  resolvePlays,
  flowTimeAgo,
  normLinkedinUrl,
  scopeSequencesToPlay,
  stagedLeadStage,
  type ArmStat,
  type FlowTone,
  type NodeDef,
  type SeqLite,
} from "./flow";
import { PlayPills } from "./playUi";
import {
  buildThread,
  projectUpcoming,
  isPossiblyForgotten,
  type TimelineContact,
} from "./contact-timeline";

type EmailRow = { pipeline_lead_id: string; subject: string; body: string; sent_at: string | null };
type ActionRow = { sendpilot_lead_id: string; rule_id: string; action_type: string; fired_at: string; result: unknown };

const VAPID_PUBLIC_KEY =
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ??
  "BFxkts1k-dL9mbX23uPtalmaBnt-bHfXL4Xn7E6xImhFd1XlKR_mFHVXLfELe2PIVoM-c4a3_M9YXIOAlhooFUM";

type Status =
  | "invited"
  | "accepted"
  | "pending_pre_render"
  | "pending_ai_draft"
  | "rendering"
  | "rendered"
  | "pending_approval"
  | "sent"
  | "rejected"
  | "rejected_by_icp"
  | "pending_alt_review"
  | "failed"
  | "pre_connected";

// AI-message clients (currently OdaGroup) skip the SendSpark video render and
// have their first DM written by Claude. The strategy/rationale columns are
// populated by draft_first_message; absence means it's a video-render lead.
type MessageStrategy =
  // OdaGroup
  | "commercial_excellence"
  | "crm_platform"
  | "ai_innovation"
  | "medical_affairs"
  // CarterCo (ad-spending DK SMBs)
  | "ad_funnel_leak";

const STRATEGY_LABELS: Record<MessageStrategy, string> = {
  commercial_excellence: "CommEx",
  crm_platform: "CRM/Veeva",
  ai_innovation: "AI/Innov",
  medical_affairs: "Med Affairs",
  ad_funnel_leak: "Ad-leak",
};

type Intent = "interested" | "question" | "decline" | "ooo" | "other" | "referral";

// Outcome = final result of a lead's journey. Logged manually by Louis from
// the Sendt or Svar surfaces. Foundation for the weekly self-improvement
// loop: outcomes labelled against ICP scores tell us where the prompt is
// over- or under-scoring.
type Outcome =
  | "won"                    // became customer / signed
  | "meeting_booked"         // booked a meeting (intent confirmed)
  | "interested"             // engaged but not yet a meeting
  | "not_interested"         // explicit no
  | "wrong_person_confirmed" // they verified they're not the buyer
  | "ghosted";               // no response after enough time

const OUTCOME_OPTIONS: { value: Outcome; label: string }[] = [
  { value: "won",                    label: "Vundet" },
  { value: "meeting_booked",         label: "Møde booket" },
  { value: "interested",             label: "Interesseret" },
  { value: "not_interested",         label: "Nej tak" },
  { value: "wrong_person_confirmed", label: "Forkert person" },
  { value: "ghosted",                label: "Ghosted" },
];

type LeadEnrich = {
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  title: string | null;
  website: string | null;
};

type PipelineRow = {
  sendpilot_lead_id: string;
  linkedin_url: string;
  contact_email: string;
  is_cold: boolean | null;
  status: Status;
  play: string | null;
  video_link: string | null;
  embed_link: string | null;
  thumbnail_url: string | null;
  rendered_message: string | null;
  invited_at: string | null;
  accepted_at: string | null;
  rendered_at: string | null;
  sent_at: string | null;
  queued_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  last_reply_at: string | null;
  last_reply_intent: Intent | null;
  viewed_at: string | null;
  played_at: string | null;
  watched_end_at: string | null;
  cta_clicked_at: string | null;
  liked_at: string | null;
  render_failed_at: string | null;
  last_engagement_at: string | null;
  sequence_id: string | null;
  sequence_step: number | null;
  sequence_parked_until: string | null;
  sequence_completed_at: string | null;
  error: string | null;
  updated_at: string;
  icp_company_score: number | null;
  icp_person_score: number | null;
  icp_rationale: string | null;
  icp_scored_at: string | null;
  alt_search_id: string | null;
  alt_search_status: "pending" | "completed" | "empty" | "failed" | null;
  alt_decided_at: string | null;
  alt_decided_by: string | null;
  outcome: Outcome | null;
  outcome_at: string | null;
  outcome_note: string | null;
  message_strategy: MessageStrategy | null;
  message_strategy_rationale: string | null;
  message_model: string | null;
  message_language: "da" | "en" | null;
  // Becc-bucket personalization (CarterCo). The hook is baked into
  // rendered_message at render-ready; bucket + trace are shown as context.
  personalized_hook: string | null;
  hook_bucket: string | null;
  hook_trace: string | null;
  hook_context: string | null;
  hook_lang: "da" | "en" | null;
  // Tresyv 3-arm A/B. v1_long / v2_short are text-only (no SendSpark render),
  // v3_video uses the existing video flow. Null for non-Tresyv workspaces.
  first_dm_variant: "v1_long" | "v2_short" | "v3_video" | null;
  // Thread-trust: set by the sync when our captured message count for this
  // lead's thread diverges from SendPilot's (see docs/outreach-thread-trust.md).
  // True means "you may be seeing only part of this conversation".
  thread_out_of_sync: boolean | null;
  lead?: LeadEnrich;
};

type AltContact = {
  id: string;
  pipeline_lead_id: string | null;
  signal_id: string | null;
  name: string;
  linkedin_url: string;
  title: string | null;
  seniority: string | null;
  employees: string | null;
  company: string | null;
  source: "sendpilot" | "team_page" | "reply_referral" | "signal";
  surfaced_at: string;
  acted_on_at: string | null;
  error: string | null;
};

type Reply = {
  id: string;
  sendpilot_lead_id: string;
  linkedin_url: string;
  message: string;
  intent: Intent | null;
  confidence: number | null;
  reasoning: string | null;
  classified_at: string | null;
  received_at: string;
  handled: boolean;
  handled_by: string | null;
  direction: "inbound" | "outbound";
  suggested_reply: string | null;
  suggested_reply_generated_at: string | null;
  triage_priority: number | null;
  triage_action: string | null;
  triage_draft: string | null;
  triage_signals: Record<string, unknown> | null;
  triage_processed_at: string | null;
  scheduled_followup_at: string | null;
  lead?: LeadEnrich;
};

// Match between a signal company (by domain) and existing outreach_leads rows.
// Lets the Signaler card surface "we already have 3 people at Vela Wood, one
// already in outreach" instead of treating the signal as cold.
type SignalLeadMatch = {
  contact_email: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  linkedin_url: string | null;
  company: string | null;
  in_pipeline: boolean;
  pipeline_status: string | null;
  pipeline_last_reply_at: string | null;
  pipeline_sent_at: string | null;
};

type Signal = {
  id: string;
  source: string;
  signal_type: string | null;
  identified_at: string;
  person_name: string | null;
  person_title: string | null;
  person_linkedin_url: string | null;
  person_email: string | null;
  company_name: string | null;
  company_domain: string | null;
  company_industry: string | null;
  company_size: string | null;
  geo: Record<string, unknown> | null;
  page_views: unknown;
  payload: Record<string, unknown>;
  icp_score: number | null;
  icp_reasoning: string | null;
  handled: boolean;
  notes: string | null;
  phone_direct: string | null;
  phone_office: string | null;
  phone_source: string | null;
  phone_scouted_at: string | null;
  alt_search_id: string | null;
  alt_search_status: "pending" | "completed" | "empty" | "failed" | null;
};

type Tab = "i_dag" | "opgaver" | "signaler" | "inbox" | "replies" | "sent" | "all" | "icp_rejected" | "icp" | "flow" | "kontakter" | "besog" | "plays";

// One play from the outreach_plays registry, resolved for the active workspace
// (a workspace-specific row overrides the global with the same id — same
// resolution as outreach_sequences). The registry is the ONLY source of play
// names in the UI; nothing renders from a hardcoded play id.
type Play = {
  id: string;
  workspace_id: string | null;
  label: string;
  description: string;
  status: "active" | "paused";
  position: number;
  is_default: boolean;
  trigger_sequence_id: string | null;
};

// A play-tagged lead staged in outreach_leads, before any invite has fired
// (so it isn't in outreach_pipeline yet). Powers the Plays overview funnel.
type StagedLead = {
  linkedin_url: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  title: string | null;
  play: string;
};

// One execution of the hiring-signal pipeline (run_hiring_pipeline.sh), cron or
// manual. Surfaced in the Plays overview so the daily automation is visible.
type HiringRun = {
  ran_at: string;
  trigger: string;
  companies_found: number | null;
  decision_makers: number | null;
  leads_staged: number | null;
  leads_added_sendpilot: number | null;
  skipped_existing: number | null;
  skipped_cross_workspace: number | null;
  unresolved: number | null;
  held_company_dialogue: number | null;
  status: string;
};

// Returned by outreach-ai draft_email — what the EmailActionBar uses to open mailto.
type EmailDraft = {
  id: string;
  subject: string;
  body: string;
  strategy: string;
  rationale: string;
  language: string;
  to: string;
};

// Call-outcome enum, mirrors /leads.Outcome. Wider than the persisted set —
// the UI also writes 'answered' for "talte med, intet aftalt endnu", which
// /leads doesn't currently use but keeps room for follow-up bumping.
type CallOutcome =
  | "no_answer"
  | "left_voicemail"
  | "answered"
  | "callback"
  | "interested"
  | "not_interested"
  | "booked"
  | "unqualified";

// vw_action_queue row shape — one entry per action item across replies,
// approvals, referrals, and signals. The "I dag" tab is the unified surface.
type ActionQueueRow = {
  id: string;                  // composite: kind:ref_id
  workspace_id: string;
  kind: "reply" | "approval" | "referral" | "signal" | "call" | "email";
  subkind: string;             // draft_ready, needs_response, approve_send, needs_draft, ...
  ref_lead_id: string | null;  // sendpilot_lead_id or null
  ref_id: string;              // underlying table PK as text
  surfaced_at: string;
  snippet: string;
  contact_name: string | null;
  company: string | null;
  title: string | null;
  intent: string | null;
  linkedin_url: string | null;
  priority_score: number;
  phone_direct: string | null;
  phone_office: string | null;
  email_direct: string | null;
  email_office: string | null;
  email_draft_id: string | null;
  email_subject: string | null;
};

type IcpVersion = {
  id: string;
  version: number;
  company_fit: string;
  person_fit: string;
  alternate_search_titles: string[];
  alternate_search_locations: string[];
  min_company_score: number;
  min_person_score: number;
  is_active: boolean;
  created_at: string;
  created_by: string | null;
  rationale: string | null;
};

type IcpProposal = {
  id: string;
  generated_at: string;
  contradictions_count: number;
  contradictions: unknown;
  proposed_company_fit: string | null;
  proposed_person_fit: string | null;
  proposed_min_company_score: number | null;
  proposed_min_person_score: number | null;
  rationale: string;
  status: "open" | "applied" | "rejected";
  decided_at: string | null;
  decided_by: string | null;
  becomes_version_id: string | null;
};
type SortKey = "queued_oldest" | "queued_newest" | "name";
type ColdFilter = "all" | "cold" | "warm";

// Identity drives the click-to-handoff message templates on Signaler cards
// (sms:, mailto:, vCard). Same shape as /leads; sourced from user_settings.
type Identity = {
  displayName: string;
  companyName: string;
  calendlyUrl: string;
  signoff: string;
};

function firstName(name: string | null) {
  if (!name) return "der";
  return name.trim().split(/\s+/)[0] ?? name;
}

// Strip protocol, www, path. Lowercases. Returns null if there's nothing
// that looks like a domain. Used to match signals (which store bare domain
// like "velawood.com") against outreach_leads.website (which may have full
// URLs like "http://www.velawood.com/contact").
function normalizeSignalDomain(raw: string | null): string | null {
  if (!raw) return null;
  const stripped = raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0];
  const cleaned = stripped.toLowerCase().trim();
  return cleaned && cleaned.includes(".") ? cleaned : null;
}

// Cold opener — assumes you've just dialled and got no answer, or you're
// reaching out shortly after seeing the visit. Refine per workspace later.
function buildSignalSmsBody(name: string | null, identity: Identity, companyName: string | null) {
  const where = companyName ? `fra ${companyName} ` : "";
  return `Hej ${firstName(name)}, det er ${identity.displayName} fra ${identity.companyName} – så I ${where}kiggede på vores side. Kort snak om jeres flow? /${identity.signoff}`;
}

function buildSignalEmailDraft(name: string | null, identity: Identity, companyName: string | null) {
  const where = companyName ? `hos ${companyName}` : "i jeres team";
  const subject = `Hilsen efter jeres besøg på ${identity.companyName}`;
  const body = `Hej ${firstName(name)},

Det er ${identity.displayName} fra ${identity.companyName}. Jeg så I ${where} kiggede på vores side – formentlig fordi noget af det vi gør er relevant lige nu.

Har du 20 minutter til en kort snak om, hvordan vi kan gøre jeres leads varme hurtigere?

Du kan også booke direkte her: ${identity.calendlyUrl}

/${identity.signoff}`;
  return { subject, body };
}

function signalMailtoHref(email: string | null, name: string | null, identity: Identity, companyName: string | null) {
  if (!email) return "#";
  const { subject, body } = buildSignalEmailDraft(name, identity, companyName);
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function signalSmsHref(phone: string | null, name: string | null, identity: Identity, companyName: string | null) {
  if (!phone) return "#";
  return `sms:${phone}?&body=${encodeURIComponent(buildSignalSmsBody(name, identity, companyName))}`;
}

// LinkedIn people-search URL for a signal company. Prefers the company's
// /people/ subpage (most reliable, lists actual employees) and falls back to
// the global people-search keyword query. Used as the manual escape hatch
// when SendPilot's lead-DB has no coverage for the company.
function linkedinPeopleSearchUrl(companyLinkedinUrl: string | null, companyName: string | null): string | null {
  if (companyLinkedinUrl && /linkedin\.com\/company\//i.test(companyLinkedinUrl)) {
    return companyLinkedinUrl.replace(/\/+$/, "") + "/people/";
  }
  if (companyName) {
    return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(companyName)}`;
  }
  return null;
}

export default function OutreachPage() {
  const supabase = useMemo(() => createClient(), []);
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const { workspace, workspaces, loading: workspaceLoading } = useWorkspace(supabase, user);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(() =>
    typeof window === "undefined" ? "" : window.localStorage.getItem("outreach_workspace_id") ?? "",
  );
  const [rows, setRows] = useState<PipelineRow[]>([]);
  const [replies, setReplies] = useState<Reply[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  // Keyed by normalized domain (no protocol, no www) → leads at that company
  const [signalLeadMatches, setSignalLeadMatches] = useState<Record<string, SignalLeadMatch[]>>({});
  const [altContacts, setAltContacts] = useState<AltContact[]>([]);
  const [actionQueue, setActionQueue] = useState<ActionQueueRow[]>([]);
  const [gmailConnected, setGmailConnected] = useState<boolean>(false);
  const [activeIcp, setActiveIcp] = useState<IcpVersion | null>(null);
  const [icpProposals, setIcpProposals] = useState<IcpProposal[]>([]);
  const [identity, setIdentity] = useState<Identity>({
    displayName: "Louis",
    companyName: "Carter & Co",
    calendlyUrl: "https://cal.com/louis-carter-3twilu/20min",
    signoff: "Louis",
  });
  const [loading, setLoading] = useState(true);
  const [busyLead, setBusyLead] = useState<string | null>(null);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [editing, setEditing] = useState<{ leadId: string; message: string } | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>("i_dag");
  const [sequences, setSequences] = useState<SeqLite[]>([]);
  const [plays, setPlays] = useState<Play[]>([]);
  // Active play scope for Flow + Kontakter ("all" = no filter). Lifted here so
  // the Plays tab can deep-link into a filtered Flow tree / contact list.
  const [playFilter, setPlayFilter] = useState<string>("all");
  const [stagedPlays, setStagedPlays] = useState<StagedLead[]>([]);
  const [hiringRuns, setHiringRuns] = useState<HiringRun[]>([]);
  const [armStats, setArmStats] = useState<ArmStat[]>([]);
  const [sentEmails, setSentEmails] = useState<EmailRow[]>([]);
  const [engagementActions, setEngagementActions] = useState<ActionRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filterCompany, setFilterCompany] = useState("");
  const [filterRole, setFilterRole] = useState("");
  const [filterCold, setFilterCold] = useState<ColdFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("queued_oldest");
  const [playing, setPlaying] = useState<Set<string>>(new Set());
  const [pushStatus, setPushStatus] = useState<string>("…");

  const reloadTimer = useRef<number | null>(null);
  const activeWorkspace = useMemo(() => {
    if (!workspaces.length) return null;
    return workspaces.find((w) => w.id === selectedWorkspaceId) ?? workspace ?? workspaces[0];
  }, [selectedWorkspaceId, workspace, workspaces]);
  const activeWorkspaceId = activeWorkspace?.id ?? "";

  function chooseWorkspace(id: string) {
    setSelectedWorkspaceId(id);
    setPlayFilter("all"); // plays are workspace-scoped; a stale filter would blank the views
    if (typeof window !== "undefined") {
      window.localStorage.setItem("outreach_workspace_id", id);
    }
  }

  // ---------- auth ----------
  useEffect(() => {
    let mounted = true;
    supabase.auth.getUser().then(({ data }) => {
      if (!mounted) return;
      setUser(data.user);
      setLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => {
      setUser(s?.user ?? null);
    });
    return () => { mounted = false; subscription.unsubscribe(); };
  }, [supabase]);

  // Identity: pulled from user_settings, used by the click-to-handoff message
  // templates on Signaler. Same shape as /leads — when /leads moves to a
  // shared util this duplication goes away.
  useEffect(() => {
    if (!user?.email) return;
    let cancelled = false;
    (async () => {
      const { data: settings } = await supabase
        .from("user_settings")
        .select("display_name, company_name, calendly_url, signoff")
        .eq("user_email", user.email)
        .maybeSingle();
      if (cancelled || !settings) return;
      setIdentity({
        displayName: settings.display_name?.trim() || "Louis",
        companyName: settings.company_name?.trim() || "Carter & Co",
        calendlyUrl: settings.calendly_url?.trim() || "https://cal.com/louis-carter-3twilu/20min",
        signoff: settings.signoff?.trim() || settings.display_name?.trim() || "Louis",
      });
    })();
    return () => { cancelled = true; };
  }, [user, supabase]);

  // ---------- data load ----------
  const load = useCallback(async () => {
    setErr(null);
    if (!activeWorkspaceId) return;
    const { data: pipe, error: pipeErr } = await supabase
      .from("outreach_pipeline")
      .select("*")
      .eq("workspace_id", activeWorkspaceId)
      .order("updated_at", { ascending: false })
      .limit(1000);
    if (pipeErr) { setErr(pipeErr.message); return; }
    const emails = Array.from(new Set((pipe ?? []).map((r) => r.contact_email).filter(Boolean)));
    const { data: leads } = await supabase
      .from("outreach_leads")
      .select("contact_email, first_name, last_name, company, title, website")
      .eq("workspace_id", activeWorkspaceId)
      .in("contact_email", emails.length ? emails : [""]);
    const leadMap = new Map((leads ?? []).map((l) => [l.contact_email, l as LeadEnrich]));
    setRows(((pipe ?? []) as PipelineRow[]).map((r) => ({ ...r, lead: leadMap.get(r.contact_email) })));

    // Play registry — global + workspace rows, workspace override wins by id
    // (mirrors the outreach_sequences resolution below). Drives the Plays tab
    // and the play filter on Flow/Kontakter.
    const { data: playRows } = await supabase
      .from("outreach_plays")
      .select("id, workspace_id, label, description, status, position, is_default, trigger_sequence_id")
      .or(`workspace_id.is.null,workspace_id.eq.${activeWorkspaceId}`)
      .order("position", { ascending: true });
    const resolvedPlays = resolvePlays((playRows ?? []) as Play[]);
    setPlays(resolvedPlays);

    // Play-tagged leads staged in outreach_leads but not yet invited (no
    // pipeline row). Drives the Plays overview "staged" count. The default
    // play's "staged" set is the whole lead universe (every imported CSV row),
    // so only non-default plays get one — which play is default comes from the
    // registry, not a literal.
    const defaultPlayId = resolvedPlays.find((p) => p.is_default)?.id ?? null;
    const { data: stagedLeads } = defaultPlayId
      ? await supabase
          .from("outreach_leads")
          .select("linkedin_url, first_name, last_name, company, title, play")
          .eq("workspace_id", activeWorkspaceId)
          .neq("play", defaultPlayId)
          .limit(1000)
      : { data: [] as StagedLead[] };
    setStagedPlays((stagedLeads ?? []) as StagedLead[]);

    // Recent hiring-signal pipeline runs (cron + manual) — drives the daily-run
    // panel in the Plays overview. Global to CarterCo, not workspace-scoped.
    const { data: runRows } = await supabase
      .from("hiring_pipeline_runs")
      .select("ran_at, trigger, companies_found, decision_makers, leads_staged, leads_added_sendpilot, skipped_existing, skipped_cross_workspace, unresolved, held_company_dialogue, status")
      .order("ran_at", { ascending: false })
      .limit(14);
    setHiringRuns((runRows ?? []) as HiringRun[]);

    const { data: replyRows } = await supabase
      .from("outreach_replies")
      .select("*")
      .eq("workspace_id", activeWorkspaceId)
      .order("received_at", { ascending: false })
      .limit(200);
    const replyLeadIds = Array.from(new Set((replyRows ?? []).map((r) => r.sendpilot_lead_id)));
    const { data: replyLeads } = replyLeadIds.length
      ? await supabase
          .from("outreach_pipeline")
          .select("sendpilot_lead_id, contact_email")
          .eq("workspace_id", activeWorkspaceId)
          .in("sendpilot_lead_id", replyLeadIds)
      : { data: [] as { sendpilot_lead_id: string; contact_email: string }[] };
    const replyEmailById = new Map((replyLeads ?? []).map((r) => [r.sendpilot_lead_id, r.contact_email]));
    setReplies(((replyRows ?? []) as Reply[]).map((r) => ({
      ...r,
      lead: leadMap.get(replyEmailById.get(r.sendpilot_lead_id) ?? ""),
    })));

    // Include actioned alts too — they're shown with an "Inviteret ✓" badge
    // so the user keeps context on what's already been pushed into outreach.
    // Without this, e.g. Ole Cramer-Bach vanishes from Marc's row the moment
    // he's invited, even though he's the relevant action.
    const { data: alts } = await supabase
      .from("outreach_alt_contacts")
      .select("*")
      .eq("workspace_id", activeWorkspaceId)
      .order("surfaced_at", { ascending: false })
      .limit(500);
    setAltContacts((alts ?? []) as AltContact[]);

    const { data: signalRows } = await supabase
      .from("outreach_signals")
      .select("*")
      .eq("workspace_id", activeWorkspaceId)
      .order("identified_at", { ascending: false })
      .limit(200);
    setSignals((signalRows ?? []) as Signal[]);

    // Unified action queue — vw_action_queue unions replies needing action,
    // pending approvals, referral alt_contacts, and unhandled signals into one
    // ranked list. Drives the "I dag" tab. The view respects RLS on underlying
    // tables (security_invoker=on), so the workspace filter is belt-and-braces.
    const { data: queueRows } = await supabase
      .from("vw_action_queue")
      .select("*")
      .eq("workspace_id", activeWorkspaceId)
      // I dag = the do-now kinds only. Approvals have their own home (Indbakke),
      // referrals are a backlog, signals live in Besøg — keeping them all here
      // turned "I dag" into a 200-item dump instead of a daily action list.
      .in("kind", ["reply", "call", "email", "signal"])
      .order("priority_score", { ascending: false })
      .order("surfaced_at", { ascending: false })
      .limit(200);
    setActionQueue((queueRows ?? []) as ActionQueueRow[]);

    // Lead-match for each signal domain. Two queries: (1) leads at that domain,
    // (2) pipeline rows for those lead emails so we can show "already in
    // outreach" badges. Skipped entirely if no signal has a domain.
    const signalDomains = Array.from(new Set(
      ((signalRows ?? []) as Signal[])
        .map((s) => normalizeSignalDomain(s.company_domain))
        .filter(Boolean) as string[],
    ));
    if (signalDomains.length === 0) {
      setSignalLeadMatches({});
    } else {
      const orFilter = signalDomains.map((d) => `website.ilike.%${d}%`).join(",");
      const { data: matchedLeads } = await supabase
        .from("outreach_leads")
        .select("contact_email, first_name, last_name, title, linkedin_url, company, website")
        .eq("workspace_id", activeWorkspaceId)
        .or(orFilter)
        .limit(200);
      const matchedEmails = (matchedLeads ?? []).map((l) => l.contact_email).filter(Boolean);
      const { data: pipelineForMatches } = matchedEmails.length
        ? await supabase
            .from("outreach_pipeline")
            .select("contact_email, status, last_reply_at, sent_at")
            .eq("workspace_id", activeWorkspaceId)
            .in("contact_email", matchedEmails)
        : { data: [] as { contact_email: string; status: string; last_reply_at: string | null; sent_at: string | null }[] };
      const pipeByEmail = new Map(
        (pipelineForMatches ?? []).map((p) => [p.contact_email, p]),
      );
      const matchMap: Record<string, SignalLeadMatch[]> = {};
      for (const lead of (matchedLeads ?? []) as Array<{
        contact_email: string; first_name: string | null; last_name: string | null;
        title: string | null; linkedin_url: string | null; company: string | null; website: string | null;
      }>) {
        const norm = normalizeSignalDomain(lead.website);
        if (!norm || !signalDomains.includes(norm)) continue;
        const pipe = pipeByEmail.get(lead.contact_email);
        const entry: SignalLeadMatch = {
          contact_email: lead.contact_email,
          first_name: lead.first_name,
          last_name: lead.last_name,
          title: lead.title,
          linkedin_url: lead.linkedin_url,
          company: lead.company,
          in_pipeline: !!pipe,
          pipeline_status: pipe?.status ?? null,
          pipeline_last_reply_at: pipe?.last_reply_at ?? null,
          pipeline_sent_at: pipe?.sent_at ?? null,
        };
        if (!matchMap[norm]) matchMap[norm] = [];
        matchMap[norm].push(entry);
      }
      setSignalLeadMatches(matchMap);
    }

    // Active ICP version + recent proposals (last 20) — drives the Læring tab.
    const [{ data: ver }, { data: props }] = await Promise.all([
      supabase.from("icp_versions").select("*")
        .eq("workspace_id", activeWorkspaceId).eq("is_active", true).maybeSingle(),
      supabase.from("icp_tuning_proposals").select("*")
        .eq("workspace_id", activeWorkspaceId)
        .order("generated_at", { ascending: false }).limit(20),
    ]);
    setActiveIcp((ver as IcpVersion | null) ?? null);
    setIcpProposals((props ?? []) as IcpProposal[]);

    // Sequence definitions for the Flow map. Fetch global (workspace_id null)
    // + this workspace, then resolve: a workspace-specific row overrides a
    // global with the same id. Drives the step labels + message templates.
    const { data: seqRows } = await supabase
      .from("outreach_sequences")
      .select("id, workspace_id, description, trigger_signal, steps, position, match_first_dm_variant")
      .or(`workspace_id.is.null,workspace_id.eq.${activeWorkspaceId}`)
      .eq("is_active", true)
      .order("position", { ascending: true });
    const seqById = new Map<string, SeqLite>();
    for (const s of (seqRows ?? []) as SeqLite[]) {
      const existing = seqById.get(s.id);
      if (!existing || (existing.workspace_id === null && s.workspace_id !== null)) {
        seqById.set(s.id, s);
      }
    }
    setSequences(Array.from(seqById.values()));

    // A/B scoreboard per first-DM arm (vw_first_dm_ab: assigned/sent/replied/reply_pct).
    const { data: abRows } = await supabase
      .from("vw_first_dm_ab")
      .select("first_dm_variant, assigned, sent, replied, reply_pct")
      .eq("workspace_id", activeWorkspaceId);
    setArmStats((abRows ?? []) as ArmStat[]);

    // Sent emails + follow-up DM fires — the outbound half of each contact's
    // thread (inbound replies already load above). Drives the Kontakter timeline.
    const { data: emailRows } = await supabase
      .from("outreach_emails")
      .select("pipeline_lead_id, subject, body, sent_at")
      .eq("workspace_id", activeWorkspaceId)
      .not("sent_at", "is", null)
      .order("sent_at", { ascending: false })
      .limit(1000);
    setSentEmails((emailRows ?? []) as EmailRow[]);

    const { data: actionRows } = await supabase
      .from("outreach_engagement_actions")
      .select("sendpilot_lead_id, rule_id, action_type, fired_at, result")
      .eq("workspace_id", activeWorkspaceId)
      .eq("action_type", "auto_send")
      .order("fired_at", { ascending: false })
      .limit(1000);
    setEngagementActions((actionRows ?? []) as ActionRow[]);
  }, [activeWorkspaceId, supabase]);

  const scheduleReload = useCallback(() => {
    if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => void load(), 600);
  }, [load]);

  useEffect(() => {
    if (user && activeWorkspaceId) void Promise.resolve().then(load);
  }, [user, activeWorkspaceId, load]);

  // Gmail connection status — checks once per session. Reads gmail_tokens
  // scoped to the signed-in user's email via RLS.
  useEffect(() => {
    if (!user?.email) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("gmail_tokens")
        .select("user_email")
        .eq("user_email", user.email)
        .maybeSingle();
      if (!cancelled) setGmailConnected(!!data);
    })();
    return () => { cancelled = true; };
  }, [user, supabase]);

  // Surface ?gmail_connected=1 / ?gmail_error=... from the OAuth callback.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("gmail_connected") === "1") {
      setInfo("Gmail forbundet — svar fra prospekter dukker op i Svar-fanen indenfor 5 min.");
      setGmailConnected(true);
      // strip the param from the URL so a refresh doesn't re-show
      const url = new URL(window.location.href);
      url.searchParams.delete("gmail_connected");
      window.history.replaceState({}, "", url.toString());
    }
    const err = params.get("gmail_error");
    if (err) {
      setErr(`Gmail-forbindelse fejlede: ${err}`);
      const url = new URL(window.location.href);
      url.searchParams.delete("gmail_error");
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  // Workspaces without an active ICP version don't have ICP tabs. Snap back
  // to inbox if the user switches to such a workspace while parked on one.
  const hasActiveIcp = !!activeIcp;
  useEffect(() => {
    if (!hasActiveIcp && (tab === "icp_rejected" || tab === "icp")) {
      setTab("inbox");
    }
  }, [hasActiveIcp, tab]);

  // ---------- realtime ----------
  useEffect(() => {
    if (!user || !activeWorkspaceId) return;
    const filter = `workspace_id=eq.${activeWorkspaceId}`;
    const ch = supabase
      .channel(`outreach-live-${activeWorkspaceId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "outreach_pipeline", filter }, () => scheduleReload())
      .on("postgres_changes", { event: "*", schema: "public", table: "outreach_replies",  filter }, () => scheduleReload())
      .on("postgres_changes", { event: "*", schema: "public", table: "outreach_alt_contacts", filter }, () => scheduleReload())
      .on("postgres_changes", { event: "*", schema: "public", table: "outreach_signals",      filter }, () => scheduleReload())
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [user, activeWorkspaceId, supabase, scheduleReload]);

  // ---------- push ----------
  useEffect(() => { if (user) void refreshPushStatus(); }, [user]); // eslint-disable-line

  async function refreshPushStatus() {
    if (typeof window === "undefined" || !("Notification" in window) || !("serviceWorker" in navigator)) {
      setPushStatus("Ikke understøttet"); return;
    }
    if (!("PushManager" in window)) { setPushStatus("Installer appen"); return; }
    if (Notification.permission === "denied") { setPushStatus("Blokeret"); return; }
    if (Notification.permission !== "granted") { setPushStatus("Ikke aktiv"); return; }
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      setPushStatus(sub ? "Aktiv" : "Ikke aktiv");
    } catch {
      setPushStatus("Ikke aktiv");
    }
  }

  async function enableNotifications() {
    setErr(null); setInfo(null);
    if (typeof window === "undefined" || !("Notification" in window) || !("serviceWorker" in navigator)) {
      setErr("Push understøttes ikke."); return;
    }
    if (!("PushManager" in window)) {
      setErr("På iPhone: gem siden på hjemmeskærmen, åbn appen, prøv igen."); return;
    }
    setPushStatus("Beder om adgang");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { setPushStatus("Ikke aktiv"); setErr("Notifikationer blev ikke slået til."); return; }
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      const key = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
      if (sub && !arrayBuffersEqual(sub.options.applicationServerKey, key)) {
        await sub.unsubscribe();
        sub = null;
      }
      const subscription = sub ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const json = subscription.toJSON();
      const { error } = await supabase.from("push_subscriptions").upsert({
        endpoint: subscription.endpoint,
        p256dh: json.keys?.p256dh,
        auth: json.keys?.auth,
        user_agent: navigator.userAgent,
        workspace_id: activeWorkspace?.id,
      }, { onConflict: "endpoint" });
      if (error) throw error;
      setPushStatus("Aktiv");
      setInfo("Notifikationer slået til på denne enhed.");
    } catch (e) {
      setPushStatus("Ikke aktiv");
      setErr(e instanceof Error ? e.message : "Kunne ikke aktivere.");
    }
  }

  // ---------- approval flow ----------
  async function decide(leadId: string, decision: "approve" | "reject" | "render", messageOverride?: string) {
    setBusyLead(leadId); setErr(null);
    const { data, error } = await supabase.functions.invoke("outreach-approve", {
      body: { leadId, decision, ...(messageOverride ? { messageOverride } : {}) },
    });
    setBusyLead(null);
    if (error) { setErr(error.message ?? String(error)); return false; }
    if (data?.error) { setErr(`${data.error}${data.details ? `: ${data.details}` : ""}`); return false; }
    return true;
  }

  async function bulkDecide(decision: "approve" | "reject") {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    setBulkProgress({ done: 0, total: ids.length });
    let succeeded = 0;
    for (let i = 0; i < ids.length; i++) {
      const ok = await decide(ids[i], decision);
      if (ok) succeeded++;
      setBulkProgress({ done: i + 1, total: ids.length });
    }
    setBulkProgress(null);
    setSelected(new Set());
    setInfo(`${decision === "approve" ? "Godkendt" : "Afvist"}: ${succeeded}/${ids.length}.`);
    await load();
  }

  async function singleDecide(r: PipelineRow, decision: "approve" | "reject") {
    const message = editing?.leadId === r.sendpilot_lead_id ? editing.message : undefined;
    const ok = await decide(r.sendpilot_lead_id, decision, message);
    if (ok) {
      setInfo(decision === "approve" ? "Sendt." : "Afvist.");
      setEditing(null);
      await load();
    }
  }

  async function generateProposal() {
    setBusyLead("__icp__"); setErr(null); setInfo(null);
    const { data, error } = await supabase.functions.invoke("generate-icp-tuning-proposal", { body: {} });
    setBusyLead(null);
    if (error) { setErr(error.message ?? String(error)); return; }
    if (data?.error) { setErr(String(data.error)); return; }
    if (data?.action === "skipped_insufficient_data") {
      setInfo(`For lidt data — ${data.contradictions_count}/${data.required} modsigelser. Tag flere resultater.`);
    } else if (data?.action === "proposal_generated") {
      setInfo(`Forslag genereret fra ${data.contradictions_count} modsigelser.`);
    } else {
      setInfo("Færdig.");
    }
    await load();
  }

  async function decideProposal(proposalId: string, decision: "apply" | "reject") {
    setBusyLead("__icp__"); setErr(null); setInfo(null);
    const { data, error } = await supabase.functions.invoke("apply-icp-tuning-proposal", {
      body: { proposalId, decision },
    });
    setBusyLead(null);
    if (error) { setErr(error.message ?? String(error)); return; }
    if (data?.error) { setErr(String(data.error)); return; }
    setInfo(decision === "apply"
      ? `Anvendt — ny version ${data?.new_version_number ?? "?"} aktiv.`
      : "Afvist.");
    await load();
  }

  async function setOutcome(leadId: string, outcome: Outcome | null) {
    setBusyLead(leadId); setErr(null);
    const patch = outcome
      ? { outcome, outcome_at: new Date().toISOString() }
      : { outcome: null, outcome_at: null };
    const { error } = await supabase
      .from("outreach_pipeline")
      .update(patch)
      .eq("sendpilot_lead_id", leadId);
    setBusyLead(null);
    if (error) setErr(error.message);
    else await load();
  }

  // Persists a call outcome on outreach_pipeline. last_called_at always
  // stamps now() so the rate-limit predicates in vw_action_queue can hide
  // a no_answer for 20 hours or a left_voicemail for 3 days. Callback
  // outcomes also stamp callback_at (clamped business-hours upstream).
  async function recordCallOutcome(
    leadId: string,
    outcome: CallOutcome,
    callbackAt?: string,
  ) {
    setBusyLead(leadId); setErr(null);
    const now = new Date().toISOString();
    const patch: Record<string, string | null> = {
      call_outcome: outcome,
      call_outcome_at: now,
      last_called_at: now,
      callback_at: outcome === "callback" ? (callbackAt ?? null) : null,
    };
    const { error } = await supabase
      .from("outreach_pipeline")
      .update(patch)
      .eq("sendpilot_lead_id", leadId);
    setBusyLead(null);
    if (error) setErr(error.message);
    else await load();
  }

  // Calls outreach-ai draft_email — returns the draft (subject, body,
  // strategy, rationale, language, to) and persists the row to outreach_emails
  // server-side. The UI opens a mailto: with the body pre-filled; user clicks
  // "Markér sendt" in EmailActionBar after sending to stamp sent_at.
  async function draftEmail(leadId: string): Promise<EmailDraft | null> {
    setErr(null);
    const { data, error } = await supabase.functions.invoke("outreach-ai?op=draft_email", {
      body: { leadId },
    });
    if (error) {
      setErr(`Email draft failed: ${error.message}`);
      return null;
    }
    const d = data as EmailDraft & { error?: string };
    if (d.error) { setErr(`Email draft: ${d.error}`); return null; }
    return d;
  }

  async function markEmailSent(emailDraftId: string) {
    setErr(null);
    const now = new Date().toISOString();
    const { data: row, error: fetchErr } = await supabase
      .from("outreach_emails")
      .select("pipeline_lead_id")
      .eq("id", emailDraftId)
      .single();
    if (fetchErr || !row) { setErr("email draft not found"); return; }
    const userEmail = user?.email ?? null;
    await supabase.from("outreach_emails")
      .update({ sent_at: now, created_by: userEmail })
      .eq("id", emailDraftId);
    await supabase.from("outreach_pipeline")
      .update({ last_email_at: now })
      .eq("sendpilot_lead_id", row.pipeline_lead_id);
    await load();
  }

  async function markReplyHandled(replyId: string) {
    const { error } = await supabase
      .from("outreach_replies")
      .update({ handled: true, handled_at: new Date().toISOString(), handled_by: user?.email ?? null })
      .eq("id", replyId);
    if (error) setErr(error.message); else await load();
  }

  async function markSignalsHandled(signalIds: string[]) {
    if (signalIds.length === 0) return;
    const { error } = await supabase
      .from("outreach_signals")
      .update({ handled: true, handled_at: new Date().toISOString(), handled_by: user?.email ?? null })
      .in("id", signalIds);
    if (error) setErr(error.message); else await load();
  }

  async function searchSignalPeople(signalId: string) {
    setErr(null); setInfo(null);
    setBusyLead(`signal-search:${signalId}`);
    const { data, error } = await supabase.functions.invoke("signal-search-people", {
      body: { signalId },
    });
    setBusyLead(null);
    if (error) { setErr(error.message ?? String(error)); return; }
    if (data?.error) { setErr(`${data.error}${data.details ? `: ${data.details}` : ""}`); return; }
    setInfo("Søgning startet via SendPilot — kandidater dukker op om ~2 minutter.");
    await load();
  }

  async function scoutSignalPhones(signalId: string) {
    setErr(null); setInfo(null);
    setBusyLead(`signal:${signalId}`);
    const { data, error } = await supabase.functions.invoke("signal-scout-phones", {
      body: { signalId },
    });
    setBusyLead(null);
    if (error) { setErr(error.message ?? String(error)); return; }
    if (data?.error) { setErr(`${data.error}${data.details ? `: ${data.details}` : ""}`); return; }
    const direct = data?.phone_direct as string | null;
    const office = data?.phone_office as string | null;
    if (direct) setInfo(`Telefon fundet: ${direct} (${data?.phone_source ?? "?"})`);
    else if (office) setInfo(`Kun hovednummer fundet: ${office}`);
    else setInfo("Ingen telefon fundet.");
    await load();
  }

  async function sendReply(replyId: string, messageOverride: string): Promise<boolean> {
    setErr(null); setInfo(null);
    const { data, error } = await supabase.functions.invoke("outreach-approve", {
      body: { decision: "reply", replyId, messageOverride },
    });
    if (error) { setErr(error.message ?? String(error)); return false; }
    if (data?.error) { setErr(`${data.error}${data.details ? `: ${data.details}` : ""}`); return false; }
    if (data?.ok) {
      setInfo("Svar sendt via SendPilot.");
      await load();
      return true;
    }
    setErr(`SendPilot HTTP ${data?.status ?? "?"}`);
    return false;
  }

  // (Re)generate an AI reply draft for one inbound reply via ai-triage-reply
  // (Sonnet + Louis's voice brief + humanize). Returns the freshly stored,
  // humanized triage_draft so the compose box can show it immediately, without
  // waiting on a full reload to round-trip through component state.
  async function generateReply(replyId: string): Promise<string | null> {
    setErr(null); setInfo(null);
    const { data, error } = await supabase.functions.invoke("ai-triage-reply", {
      body: { replyId },
    });
    if (error) { setErr(error.message ?? String(error)); return null; }
    if (data?.error) { setErr(`${data.error}${data.details ? `: ${data.details}` : ""}`); return null; }
    const { data: row } = await supabase
      .from("outreach_replies")
      .select("triage_draft")
      .eq("id", replyId)
      .maybeSingle();
    setInfo("Svar genereret.");
    await load();
    return (row?.triage_draft as string | null) ?? null;
  }

  async function overrideIcpRejection(leadId: string) {
    // If the row has unactioned alts surfaced from a prior alt-search, send
    // it BACK to "Vælg rigtig person" instead of pending_pre_render — that
    // way the alt context (existing candidates, "Use original" escape hatch)
    // doesn't vanish behind the row landing as a fresh-looking lead in
    // Klar-til-render. If there are no alts, fall back to the original
    // pending_pre_render behaviour.
    const altsForLead = altByLead.get(leadId) ?? [];
    const hasUnactionedAlts = altsForLead.some((a) => !a.acted_on_at);

    const target: Status = hasUnactionedAlts ? "pending_alt_review" : "pending_pre_render";
    const promptMsg = hasUnactionedAlts
      ? `Denne lead har ${altsForLead.length} alternativer surfaced. Send tilbage til "Vælg rigtig person" så du kan se dem?`
      : "Send personen til render-køen alligevel?";

    if (!confirm(promptMsg)) return;
    setBusyLead(leadId); setErr(null); setInfo(null);
    const patch: Partial<PipelineRow> = { status: target };
    if (hasUnactionedAlts) {
      // Reopen alt_search_status if it had been marked completed — alts are
      // still pending decision from a UX point of view.
      patch.alt_search_status = "completed";
    }
    const { error } = await supabase
      .from("outreach_pipeline")
      .update(patch)
      .eq("sendpilot_lead_id", leadId);
    setBusyLead(null);
    if (error) {
      setErr(error.message);
    } else {
      setInfo(hasUnactionedAlts
        ? "Sendt tilbage til Vælg rigtig person."
        : "Override – sendt tilbage til afventer.");
      await load();
    }
  }

  async function useOriginal(leadId: string) {
    setBusyLead(leadId); setErr(null); setInfo(null);
    const { error } = await supabase
      .from("outreach_pipeline")
      .update({
        status: "pending_pre_render",
        alt_decided_at: new Date().toISOString(),
        alt_decided_by: user?.email ?? null,
      })
      .eq("sendpilot_lead_id", leadId);
    setBusyLead(null);
    if (error) setErr(error.message); else { setInfo("Bruger original – afventer render."); await load(); }
  }

  async function inviteAlt(altContactId: string, leadId: string) {
    setBusyLead(leadId); setErr(null); setInfo(null);
    const { data, error } = await supabase.functions.invoke("invite-alt-contact", {
      body: { altContactId },
    });
    setBusyLead(null);
    if (error) { setErr(error.message ?? String(error)); return; }
    if (data?.error) { setErr(`${data.error}${data.details ? `: ${data.details}` : ""}`); return; }
    if (data?.ok) {
      setInfo("Forbindelsesanmodning sendt til alternativ kontakt.");
      await load();
    } else {
      setErr(`SendPilot HTTP ${data?.status ?? "?"}`);
    }
  }

  // ---------- auth UI helpers ----------
  async function sendOtp(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setErr(null); setInfo(null);
    const t = email.trim().toLowerCase();
    if (!t) { setErr("Indtast din e-mail."); return; }
    // Access is gated by workspace_members (page falls back to "Adgang
    // afventer" for users without a workspace). Allow auth.users creation so
    // first-time invitees can self-onboard via OTP — gating on
    // shouldCreateUser:false silently locks out members added to a workspace
    // before they've ever signed in (e.g. rm@tresyv.dk, haugefrom).
    const { error } = await supabase.auth.signInWithOtp({ email: t, options: { shouldCreateUser: true } });
    if (error) setErr(error.message); else setInfo("Tjek din mail for kode.");
  }
  async function verifyOtp(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setErr(null);
    const { error } = await supabase.auth.verifyOtp({
      email: email.trim().toLowerCase(), token: token.trim(), type: "email",
    });
    if (error) setErr(error.message); else { setToken(""); setInfo(null); }
  }
  async function signOut() {
    await supabase.auth.signOut();
    setUser(null); setRows([]); setReplies([]); setSignals([]); setSignalLeadMatches({}); setAltContacts([]);
  }

  // ---------- derived ----------
  const stats = useMemo(() => {
    const c = {
      total: rows.length, invited: 0, accepted: 0, rendering: 0,
      pending: 0, sent: 0, rejected: 0, failed: 0, replied: 0,
      icp_rejected: 0, alt_review: 0,
    };
    for (const r of rows) {
      if (r.status === "invited") c.invited++;
      else if (r.status === "accepted" || r.status === "pending_pre_render") c.accepted++;
      else if (r.status === "rendering" || r.status === "rendered") c.rendering++;
      else if (r.status === "pending_approval") c.pending++;
      else if (r.status === "sent") c.sent++;
      else if (r.status === "rejected") c.rejected++;
      else if (r.status === "rejected_by_icp") c.icp_rejected++;
      else if (r.status === "pending_alt_review") c.alt_review++;
      else if (r.status === "failed") c.failed++;
      if (r.last_reply_at) c.replied++;
    }
    return c;
  }, [rows]);

  const icpRejected = useMemo(
    () => rows.filter((r) => r.status === "rejected_by_icp")
      .sort((a, b) => (b.icp_scored_at ?? "").localeCompare(a.icp_scored_at ?? "")),
    [rows],
  );

  const altReview = useMemo(
    () => rows.filter((r) => r.status === "pending_alt_review")
      .sort((a, b) => (b.icp_scored_at ?? "").localeCompare(a.icp_scored_at ?? "")),
    [rows],
  );

  const altByLead = useMemo(() => {
    const m = new Map<string, AltContact[]>();
    for (const a of altContacts) {
      if (!a.pipeline_lead_id) continue;
      const arr = m.get(a.pipeline_lead_id) ?? [];
      arr.push(a);
      m.set(a.pipeline_lead_id, arr);
    }
    return m;
  }, [altContacts]);

  // Referrals are alt_contacts with source='reply_referral' — spawned by
  // classifyReplyAsync when a prospect tells us to talk to someone else.
  // Surfaced inline under the triggering reply in the Svar tab (the lead's
  // status is 'sent', so the Vælg-rigtig-person flow doesn't touch them).
  const referralsByLead = useMemo(() => {
    const m = new Map<string, AltContact[]>();
    for (const a of altContacts) {
      if (a.source !== "reply_referral") continue;
      if (!a.pipeline_lead_id) continue;
      const arr = m.get(a.pipeline_lead_id) ?? [];
      arr.push(a);
      m.set(a.pipeline_lead_id, arr);
    }
    return m;
  }, [altContacts]);

  const sparkline = useMemo(() => buildSparkline(rows, 30), [rows]);
  // Only inbound replies count as "unhandled" — outbound messages are by
  // definition already our own action.
  // Auto-inferred "needs my response" — no manual marking. A contact's inbound
  // reply surfaces only while it's their NEWEST message (you haven't replied
  // after it), its intent warrants a reply (decline/OOO skipped), and it hasn't
  // been manually dismissed. An outbound reply (cockpit, or synced from
  // LinkedIn via sync-sendpilot-messages) auto-resolves it.
  const unhandledReplies = useMemo(() => {
    const latestAt = new Map<string, number>();
    for (const r of replies) {
      const t = new Date(r.received_at).getTime();
      const cur = latestAt.get(r.sendpilot_lead_id);
      if (cur === undefined || t > cur) latestAt.set(r.sendpilot_lead_id, t);
    }
    return replies.filter(
      (r) =>
        r.direction === "inbound" &&
        !r.handled &&
        r.intent !== "decline" &&
        r.intent !== "ooo" &&
        latestAt.get(r.sendpilot_lead_id) === new Date(r.received_at).getTime(),
    );
  }, [replies]);

  const unhandledSignals = useMemo(
    () => signals.filter((s) => !s.handled),
    [signals],
  );

  // Besøg: site visitors who AREN'T already a contact, ranked by ICP fit — warm
  // inbound to pursue. (Matched visitors land on their contact's timeline.)
  const unmatchedSignals = useMemo(() => {
    const normLi = (u: string) => u.replace(/\/+$/, "").split("?")[0].toLowerCase();
    const liSet = new Set<string>();
    const emailSet = new Set<string>();
    for (const r of rows) {
      if (r.linkedin_url) liSet.add(normLi(r.linkedin_url));
      if (r.contact_email) emailSet.add(r.contact_email.toLowerCase());
    }
    return unhandledSignals
      .filter((s) => {
        const li = s.person_linkedin_url && liSet.has(normLi(s.person_linkedin_url));
        const em = s.person_email && emailSet.has(s.person_email.toLowerCase());
        return !li && !em;
      })
      .sort((a, b) => (b.icp_score ?? -1) - (a.icp_score ?? -1));
  }, [rows, unhandledSignals]);

  // Triage'd unhandled replies sorted by priority + due date for the
  // Opgaver tab. Exclude "done" bucket (priority 1) — those are decline-
  // like and don't need active surfacing. Items with a due_at sort by it.
  const opgaver = useMemo(
    () => unhandledReplies
      .filter((r) => (r.triage_priority ?? 0) >= 3)
      .sort((a, b) => {
        // Due-at items first, sorted by date asc (soonest first)
        const aDue = a.scheduled_followup_at ? new Date(a.scheduled_followup_at).getTime() : null;
        const bDue = b.scheduled_followup_at ? new Date(b.scheduled_followup_at).getTime() : null;
        if (aDue !== null && bDue !== null) return aDue - bDue;
        if (aDue !== null) return -1;
        if (bDue !== null) return 1;
        // Then by priority desc
        return (b.triage_priority ?? 0) - (a.triage_priority ?? 0);
      }),
    [unhandledReplies],
  );

  const pending = useMemo(() => {
    const filtered = rows.filter((r) => r.status === "pending_approval")
      .filter((r) => filterCold === "all" || (filterCold === "cold" ? r.is_cold : !r.is_cold))
      .filter((r) => !filterCompany || (r.lead?.company ?? "").toLowerCase().includes(filterCompany.toLowerCase()))
      .filter((r) => !filterRole || (r.lead?.title ?? "").toLowerCase().includes(filterRole.toLowerCase()));
    return [...filtered].sort(sortPipeline(sortKey));
  }, [rows, filterCompany, filterRole, filterCold, sortKey]);

  const sent = useMemo(
    () => rows.filter((r) => r.status === "sent").sort((a, b) =>
      (b.sent_at ?? b.updated_at).localeCompare(a.sent_at ?? a.updated_at)).slice(0, 50),
    [rows],
  );

  // Accepted-but-no-approved-video: leads we know accepted, including the
  // pre-render review queue plus failed/stuck renders that need attention.
  const accepted = useMemo(() => {
    return rows
      .filter((r) => {
        if (!r.accepted_at) return false;
        // Terminal or already-actioned statuses do NOT belong in "Klar til render":
        // they have their own surfaces (Sendt, ICP-afvist, Vælg rigtig person)
        // or are stale (failed). To re-render an ICP-rejected lead, use the
        // override button on the ICP-afvist tab, which flips back to
        // pending_pre_render and lands the row here.
        const off: PipelineRow["status"][] = [
          "pending_approval", "sent", "rejected",
          "rejected_by_icp", "pending_alt_review", "failed",
        ];
        return !off.includes(r.status);
      })
      .sort((a, b) => (b.accepted_at ?? "").localeCompare(a.accepted_at ?? ""));
  }, [rows]);

  async function renderLead(leadId: string) {
    setBusyLead(leadId); setErr(null); setInfo(null);
    const { data, error } = await supabase.functions.invoke("outreach-approve", {
      body: { leadId, decision: "render" },
    });
    setBusyLead(null);
    if (error) { setErr(error.message ?? String(error)); return; }
    if (data?.error) { setErr(`${data.error}${data.details ? `: ${data.details}` : ""}`); return; }
    setInfo("Render kickstartet — videoen lander i Afventer når SendSpark er færdig.");
    await load();
  }

  const allRecent = useMemo(
    () => [...rows].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 100),
    [rows],
  );

  // ---------- render ----------
  if (loading) {
    return (
      <main className="safe-screen flex min-h-screen items-center justify-center bg-[var(--sand)] px-6 text-[var(--ink)]">
        <p className="tabular text-[11px] uppercase tracking-[0.4em] text-[var(--ink)]/40">Indlæser</p>
      </main>
    );
  }

  if (!user) {
    return <LoginGate
      email={email} setEmail={setEmail}
      token={token} setToken={setToken}
      sendOtp={sendOtp} verifyOtp={verifyOtp}
      info={info} err={err}
    />;
  }

  if (!workspaceLoading && !activeWorkspace) {
    return (
      <main className="safe-screen safe-pad-top safe-pad-bottom safe-px relative min-h-screen overflow-hidden bg-[var(--sand)] text-[var(--ink)]">
        <div className="grain-overlay" />
        <div className="relative mx-auto flex min-h-screen w-full max-w-md flex-col justify-between px-6 py-8 sm:py-10">
          <Link href="/" className="tabular text-[10px] uppercase tracking-[0.35em] text-[var(--ink)]/45">CarterCo · Outreach</Link>
          <section>
            <p className="tabular text-[10px] uppercase tracking-[0.32em] text-[var(--ink)]/40">Ingen workspace</p>
            <h1 className="font-display mt-4 text-5xl italic leading-[0.9] tracking-[-0.02em] text-[var(--ink)]">Adgang afventer</h1>
            <p className="mt-6 max-w-xs text-sm leading-relaxed text-[var(--ink)]/55">
              Din e-mail er ikke tilknyttet noget workspace endnu. Kontakt support, så får du adgang.
            </p>
            <button onClick={() => void signOut()} className="focus-cream mt-8 tabular text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/70 hover:underline">Log ud →</button>
          </section>
          <p className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--ink)]/25">{user.email}</p>
        </div>
      </main>
    );
  }

  const navCounts: NavCounts = {
    i_dag: actionQueue.length,
    opgaver: opgaver.length,
    signaler: unhandledSignals.length,
    inbox: stats.pending + accepted.length + altReview.length,
    replies: unhandledReplies.length,
    sent: stats.sent,
    all: stats.total,
    icp_rejected: icpRejected.length,
    icp_open_proposals: icpProposals.filter((p) => p.status === "open").length,
    flow: stats.total,
    kontakter: stats.total,
    besog: unmatchedSignals.length,
    plays: stagedPlays.length,
  };

  return (
    <main className="safe-screen safe-pad-bottom relative min-h-screen overflow-x-hidden bg-[var(--sand)] text-[var(--ink)]">
      <div className="grain-overlay" />

      <Header
        pushStatus={pushStatus} onEnablePush={enableNotifications}
        onReload={load} onSignOut={signOut}
        workspaces={workspaces}
        activeWorkspace={activeWorkspace}
        onWorkspaceChange={chooseWorkspace}
        gmailConnected={gmailConnected}
      />

      <section className="mx-auto w-full max-w-[1400px] px-4 pt-10 pb-6 sm:px-8 sm:pt-14 lg:px-12">
        <div className="flex items-end justify-between gap-6">
          <div>
            <p className="tabular text-[10px] uppercase tracking-[0.32em] text-[var(--ink)]/40">Status</p>
            <h1 className="font-display mt-2 text-[12vw] italic leading-[0.85] tracking-[-0.03em] text-[var(--ink)] sm:text-[64px]">
              Outreach
            </h1>
          </div>
          <div className="hidden sm:block shrink-0">
            <Sparkline data={sparkline} />
          </div>
        </div>

        <Funnel stats={stats} />
      </section>

      {info ? <Banner kind="info">{info}</Banner> : null}
      {err ? <Banner kind="error">{err}</Banner> : null}
      {bulkProgress ? <Banner kind="info">Behandler {bulkProgress.done}/{bulkProgress.total}…</Banner> : null}

      <div className="mx-auto mt-2 w-full max-w-[1400px] px-4 pb-12 sm:px-8 lg:flex lg:items-start lg:gap-8 lg:px-12">
        <SideNav tab={tab} setTab={setTab} showIcpTabs={hasActiveIcp} counts={navCounts} />
        <div className="min-w-0 lg:flex-1">
          <Tabs tab={tab} setTab={setTab} showIcpTabs={hasActiveIcp} counts={navCounts} />
          <section>
        {tab === "i_dag" ? (
          <IDagTab
            queue={actionQueue}
            onJumpTo={setTab}
            onCallOutcome={(leadId, outcome, callbackAt) =>
              void recordCallOutcome(leadId, outcome, callbackAt)}
            onDraftEmail={draftEmail}
            onMarkEmailSent={(id) => void markEmailSent(id)}
          />
        ) : tab === "opgaver" ? (
          <OpgaverTab
            tasks={opgaver}
            onMarkHandled={(id) => void markReplyHandled(id)}
          />
        ) : tab === "signaler" ? (
          <SignalerTab
            signals={unhandledSignals}
            busyLead={busyLead}
            identity={identity}
            leadMatches={signalLeadMatches}
            altContacts={altContacts}
            onMarkHandled={(ids) => void markSignalsHandled(ids)}
            onScoutPhones={(id) => void scoutSignalPhones(id)}
            onSearchPeople={(id) => void searchSignalPeople(id)}
          />
        ) : tab === "inbox" ? (
          <InboxTab
            pendingRows={pending}
            acceptedRows={accepted}
            altReviewRows={altReview}
            altsByLead={altByLead}
            selected={selected}
            setSelected={setSelected}
            filters={{ company: filterCompany, role: filterRole, cold: filterCold }}
            setFilters={{
              setCompany: setFilterCompany, setRole: setFilterRole, setCold: setFilterCold,
            }}
            sortKey={sortKey} setSortKey={setSortKey}
            playing={playing} setPlaying={setPlaying}
            editing={editing} setEditing={setEditing}
            busyLead={busyLead}
            onApproveOne={(r) => void singleDecide(r, "approve")}
            onRejectOne={(r) => void singleDecide(r, "reject")}
            onBulkApprove={() => void bulkDecide("approve")}
            onBulkReject={() => void bulkDecide("reject")}
            onRender={(id) => void renderLead(id)}
            onUseOriginal={(id) => void useOriginal(id)}
            onInviteAlt={(altId, leadId) => void inviteAlt(altId, leadId)}
          />
        ) : tab === "replies" ? (
          <RepliesTab
            replies={replies}
            referralsByLead={referralsByLead}
            busyLead={busyLead}
            onMarkHandled={(id) => void markReplyHandled(id)}
            onInviteAlt={(altId, leadId) => void inviteAlt(altId, leadId)}
            onSendReply={sendReply}
            onGenerateReply={generateReply}
          />
        ) : tab === "sent" ? (
          <SentTab
            rows={sent}
            busyLead={busyLead}
            onSetOutcome={(id, o) => void setOutcome(id, o)}
          />
        ) : tab === "icp_rejected" ? (
          <IcpRejectedTab rows={icpRejected} busyLead={busyLead}
            onOverride={(id) => void overrideIcpRejection(id)} />
        ) : tab === "icp" ? (
          <LaeringTab
            activeIcp={activeIcp}
            proposals={icpProposals}
            outcomes={rows}
            busy={busyLead === "__icp__"}
            onGenerateProposal={() => void generateProposal()}
            onDecide={(id, d) => void decideProposal(id, d)}
          />
        ) : tab === "flow" ? (
          <FlowTab rows={rows} sequences={sequences} replies={replies} armStats={armStats}
            plays={plays} playFilter={playFilter} onPlayFilter={setPlayFilter}
            busyLead={busyLead}
            onRetry={(id) => void decide(id, "approve").then((ok) => { if (ok) { setInfo("Sendt — prøvede igen."); void load(); } })} />
        ) : tab === "kontakter" ? (
          <KontakterTab
            rows={rows}
            replies={replies}
            emails={sentEmails}
            actions={engagementActions}
            signals={signals}
            sequences={sequences}
            plays={plays}
            playFilter={playFilter}
            onPlayFilter={setPlayFilter}
            onSetOutcome={(id, o) => void setOutcome(id, o)}
            onOverrideIcp={(id) => void overrideIcpRejection(id)}
          />
        ) : tab === "besog" ? (
          <BesogTab
            signals={unmatchedSignals}
            busyLead={busyLead}
            onSearchPeople={(id) => void searchSignalPeople(id)}
            onDismiss={(ids) => void markSignalsHandled(ids)}
          />
        ) : tab === "plays" ? (
          <PlaysOverview
            plays={plays}
            staged={stagedPlays}
            rows={rows}
            runs={hiringRuns}
            sequences={sequences}
            onOpenFlow={(playId) => { setPlayFilter(playId); setTab("flow"); }}
            onOpenContacts={(playId) => { setPlayFilter(playId); setTab("kontakter"); }}
          />
        ) : (
          <AllTab rows={allRecent} />
        )}
          </section>
        </div>
      </div>
    </main>
  );
}

// ============================== sub-components ==============================

function Header({ pushStatus, onEnablePush, onReload, onSignOut, workspaces, activeWorkspace, onWorkspaceChange, gmailConnected }: {
  pushStatus: string; onEnablePush: () => Promise<void>;
  onReload: () => Promise<void>; onSignOut: () => Promise<void>;
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  onWorkspaceChange: (id: string) => void;
  gmailConnected: boolean;
}) {
  return (
    <div className="safe-pad-top sticky top-0 z-20 border-b border-[var(--ink)]/[0.10] bg-[var(--sand)]/85 backdrop-blur-xl">
      <div className="mx-auto flex w-full max-w-[1400px] items-center justify-between gap-3 px-4 py-3 sm:gap-4 sm:px-8 lg:px-12">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/" className="tabular truncate text-[10px] uppercase tracking-[0.24em] text-[var(--ink)]/50 hover:text-[var(--ink)]/80 sm:tracking-[0.35em]">
            CarterCo<span className="mx-2 text-[var(--ink)]/25">/</span><span className="text-[var(--ink)]/75">Outreach</span>
          </Link>
          {workspaces.length > 1 ? (
            <select
              value={activeWorkspace?.id ?? ""}
              onChange={(e) => onWorkspaceChange(e.target.value)}
              className="focus-cream tabular rounded-sm border border-[var(--ink)]/15 bg-transparent px-2 py-1.5 text-[10px] uppercase tracking-[0.18em] text-[var(--ink)]/65 outline-none hover:border-[var(--ink)]/35 focus:border-[var(--ink)]/35"
              title="Dashboard"
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link href="/outreach/clients"
            className="focus-cream tabular rounded-sm border border-[var(--ink)]/15 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/65 hover:border-[var(--ink)]/35 hover:text-[var(--ink)]"
            title="Klient-oversigt (read-only)"
          >Clients</Link>
          <button type="button" onClick={() => void onEnablePush()}
            className="focus-cream tabular rounded-sm border border-[var(--ink)]/15 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/65 hover:border-[var(--ink)]/35 hover:text-[var(--ink)]"
            title="Push-notifikationer"
          >Push: {pushStatus}</button>
          {gmailConnected ? (
            <span className="tabular rounded-sm border border-[var(--forest)]/30 bg-[var(--forest)]/10 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] text-[var(--forest)]"
              title="Email-svar fra prospekter pulles ind i Svar-fanen automatisk">
<IconMail className="mr-1.5" />Gmail ✓
            </span>
          ) : (
            <a href="/api/auth/gmail/start"
              className="focus-cream tabular rounded-sm border border-[var(--clay)]/30 bg-[var(--clay)]/10 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] text-[var(--clay)] hover:bg-[var(--clay)]/20"
              title="Forbind Gmail så email-svar fra prospekter pulles automatisk ind i Svar-fanen">
<IconMail className="mr-1.5" />Forbind Gmail
            </a>
          )}
          <button type="button" onClick={() => void onReload()}
            className="focus-cream tabular rounded-sm border border-[var(--ink)]/15 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/65 hover:border-[var(--ink)]/35 hover:text-[var(--ink)]">Opdater</button>
          <button type="button" onClick={() => void onSignOut()}
            className="focus-cream tabular rounded-sm border border-[var(--ink)]/15 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/65 hover:border-[var(--ink)]/35 hover:text-[var(--ink)]">Log ud</button>
        </div>
      </div>
    </div>
  );
}

type FunnelStats = {
  invited: number;
  accepted: number;
  rendering: number;
  pending: number;
  sent: number;
  rejected: number;
  failed: number;
  replied: number;
  total: number;
};

// ------------------------------- Flow map --------------------------------
// Branching automation tree (React Flow): invited → accept → render/approve →
// first DM (forks into the A/B arms) → each arm's follow-up sequence. Replies
// and terminal states are cross-cutting outcomes shown in a strip below the
// tree. Click any node/outcome for its message blueprint + the contacts in it;
// click a contact for their actual text.

const FLOW_TONE_CLASS: Record<FlowTone, { card: string; bar: string }> = {
  neutral: { card: "border-[var(--ink)]/15 bg-[var(--cream)]", bar: "var(--ink)" },
  active: { card: "border-[var(--forest)]/35 bg-[var(--cream)]", bar: "var(--forest)" },
  good: { card: "border-[var(--forest)]/45 bg-[var(--forest)]/8", bar: "var(--forest)" },
  warn: { card: "border-[var(--clay)]/45 bg-[var(--clay)]/8", bar: "var(--clay)" },
  bad: { card: "border-[var(--clay)]/55 bg-[var(--clay)]/12", bar: "var(--clay)" },
};

type FlowNodeData = {
  label: string;
  count: number;
  tone: FlowTone;
  sublabel?: string;
  isSelected: boolean;
  armStat?: ArmStat | null;
  // Age of the longest-waiting contact in this node ("6 d") — surfaces stuck
  // leads directly on the tree instead of only inside the contact list.
  // Hidden under 1 h; oldestStale tints it clay at ≥5 days.
  oldestAgo?: string | null;
  oldestStale?: boolean;
};

// React Flow custom node — a tone-tinted card with label, live count, optional
// arm scoreboard line, and (hidden) connection handles.
function FlowCardNode({ data }: NodeProps) {
  const d = data as FlowNodeData;
  const tone = FLOW_TONE_CLASS[d.tone];
  return (
    <div
      className={`rounded-md border px-3 py-2 ${tone.card} ${d.isSelected ? "ring-2 ring-[var(--ink)]/40" : ""} ${d.count === 0 && !d.armStat ? "opacity-50" : ""}`}
      style={{ width: 188 }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] leading-tight text-[var(--ink)]">{d.label}</span>
        <span className="font-display text-lg italic leading-none text-[var(--ink)]">{d.count}</span>
      </div>
      {d.sublabel ? (
        <div className="tabular mt-0.5 truncate text-[9px] uppercase tracking-[0.14em] text-[var(--ink)]/35">{d.sublabel}</div>
      ) : null}
      {d.count > 0 && d.oldestAgo ? (
        <div className={`tabular mt-0.5 text-[9px] tracking-[0.1em] ${d.oldestStale ? "text-[var(--clay)]" : "text-[var(--ink)]/40"}`}>
          ældste {d.oldestAgo}
        </div>
      ) : null}
      {d.armStat ? (
        <div className="mt-1.5 flex items-baseline gap-2 border-t border-[var(--ink)]/10 pt-1.5">
          <span className="tabular text-[9px] uppercase tracking-[0.12em] text-[var(--ink)]/40">{d.armStat.sent} sendt</span>
          <span className="tabular text-[10px] font-semibold text-[var(--forest)]">{d.armStat.reply_pct ?? 0}% svar</span>
        </div>
      ) : null}
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}

const FLOW_NODE_TYPES = { flowCard: FlowCardNode };

// Universal spine — always shown so the main flow never disconnects, even when
// a stage is momentarily empty. Everything else shows only when it holds
// contacts (workspace-aware), so client-specific side-branches don't clutter.
const FLOW_SPINE = new Set([
  "invited", "accepted", "pending_pre_render", "rendering", "rendered", "pending_approval", "sent",
]);

function MessageBlueprint({ nodeId, seqStep }: {
  nodeId: string;
  seqStep: ReturnType<typeof lookupSeqStep>;
}) {
  if (seqStep) {
    const branches = seqStep.step.branches ?? [];
    return (
      <div className="mt-4 rounded-md border border-[var(--ink)]/10 bg-[var(--sand)]/50 p-4">
        <div className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/40">
          Skabelon · {seqStep.seq.id} · trin {seqStep.index}
          {seqStep.seq.match_first_dm_variant ? ` · arm ${seqStep.seq.match_first_dm_variant}` : ""}
        </div>
        {branches.length === 0 ? (
          <p className="mt-2 text-[13px] text-[var(--ink)]/45">Ingen besked på dette trin.</p>
        ) : branches.map((b, i) => (
          <div key={i} className="mt-3">
            <div className="tabular text-[10px] uppercase tracking-[0.16em] text-[var(--ink)]/35">
              {b.action?.type ?? "—"}{b.requires?.length ? ` · kræver: ${b.requires.join(", ")}` : ""}
            </div>
            <pre className="mt-1 whitespace-pre-wrap font-body text-[13px] leading-relaxed text-[var(--ink)]/80">
              {b.action?.template || "(tom)"}
            </pre>
          </div>
        ))}
        <p className="mt-3 text-[11px] text-[var(--ink)]/40">
          {"{firstName}"}, {"{company}"}, {"{videoLink}"} udfyldes per kontakt ved afsendelse.
        </p>
      </div>
    );
  }
  if (nodeId === "sent" || nodeId.startsWith("arm:")) {
    const arm = nodeId.startsWith("arm:") ? nodeId.slice(4) : null;
    return (
      <div className="mt-4 rounded-md border border-[var(--forest)]/25 bg-[var(--forest)]/5 p-4">
        <div className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--forest)]">
          {arm ? `A/B-arm · ${ARM_META[arm]?.label ?? arm}` : "AI-personaliseret · 1. DM"}
        </div>
        <p className="mt-2 text-[13px] text-[var(--ink)]/70">
          Første besked skrives per kontakt{arm ? " i denne arm" : ""} — ingen fast skabelon.
          Klik en kontakt for at se den faktiske tekst.
        </p>
      </div>
    );
  }
  return null;
}

function ContactMessages({ row, reply }: { row: PipelineRow; reply: Reply | null }) {
  const blocks: { label: string; body: string; good?: boolean }[] = [];
  if (row.personalized_hook) {
    blocks.push({ label: `AI-hook${row.hook_bucket ? ` · bucket ${row.hook_bucket}` : ""}`, body: row.personalized_hook });
  }
  if (row.rendered_message) {
    blocks.push({ label: "Sendt besked", body: row.rendered_message });
  }
  if (reply?.message) {
    blocks.push({ label: `Svar${reply.intent ? ` · ${reply.intent}` : ""}`, body: reply.message, good: true });
  }
  return (
    <div className="pb-4 pl-1">
      {blocks.length === 0 ? (
        <p className="text-[12px] text-[var(--ink)]/40">Ingen beskedtekst gemt for denne kontakt endnu.</p>
      ) : blocks.map((b, i) => (
        <div key={i} className={`mt-2 rounded-md border p-3 ${b.good ? "border-[var(--forest)]/25 bg-[var(--forest)]/5" : "border-[var(--ink)]/10 bg-[var(--sand)]/50"}`}>
          <div className="tabular text-[10px] uppercase tracking-[0.16em] text-[var(--ink)]/40">{b.label}</div>
          <pre className="mt-1 whitespace-pre-wrap font-body text-[13px] leading-relaxed text-[var(--ink)]/85">{b.body}</pre>
        </div>
      ))}
      {row.hook_context ? (
        <p className="mt-2 text-[11px] italic text-[var(--ink)]/45">Hvorfor: {row.hook_context}</p>
      ) : null}
    </div>
  );
}

// Play scope pills shared by Flow and Kontakter. Rendered when the workspace
// runs more than one play OR a filter is active — an active filter must
// always be visible and clearable, even in a single-play workspace (the
// Plays tab's deep-links set it unconditionally).
function FlowTab({ rows, sequences, replies, armStats, plays, playFilter, onPlayFilter, busyLead, onRetry }: {
  rows: PipelineRow[];
  sequences: SeqLite[];
  replies: Reply[];
  armStats: ArmStat[];
  plays: Play[];
  playFilter: string;
  onPlayFilter: (playId: string) => void;
  busyLead: string | null;
  onRetry: (leadId: string) => void;
}) {
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [openContact, setOpenContact] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  // Scroll the contacts panel into view on node click — it sits below a tall
  // canvas, so otherwise the click appears to do nothing.
  useEffect(() => {
    if (selectedNode) detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selectedNode]);

  // Play scope: the tree shows one play's contacts at a time (or all). With
  // several plays running concurrently in one workspace, an unfiltered tree
  // interleaves their contacts and can't answer "which contacts are in which
  // flow" — the pills make the play axis a first-class view.
  const scopedRows = useMemo(
    () => (playFilter === "all" ? rows : rows.filter((r) => (r.play ?? "") === playFilter)),
    [rows, playFilter],
  );

  // Sequence skeleton follows the play scope: only lanes holding this play's
  // contacts (plus the play's trigger sequence) render — not the other play's
  // empty follow-up chains.
  const scopedSequences = useMemo(() => {
    if (playFilter === "all") return sequences;
    const play = plays.find((p) => p.id === playFilter);
    return scopeSequencesToPlay(sequences, scopedRows, play?.trigger_sequence_id);
  }, [sequences, scopedRows, plays, playFilter]);

  const { counts, byNode, oldestByNode } = useMemo(() => {
    const counts = new Map<string, number>();
    const byNode = new Map<string, PipelineRow[]>();
    const oldestByNode = new Map<string, string>();
    for (const r of scopedRows) {
      const id = classifyNode(r);
      counts.set(id, (counts.get(id) ?? 0) + 1);
      const list = byNode.get(id);
      if (list) list.push(r); else byNode.set(id, [r]);
      const when = r.last_engagement_at ?? r.last_reply_at ?? r.sent_at ?? r.updated_at;
      // Compare as dates, not strings — mixed-offset ISO timestamps ("+02:00"
      // vs "Z") sort wrong lexicographically.
      const prev = oldestByNode.get(id);
      if (when && (!prev || Date.parse(when) < Date.parse(prev))) oldestByNode.set(id, when);
    }
    return { counts, byNode, oldestByNode };
  }, [scopedRows]);

  // replies arrive newest-first; keep the first seen per lead.
  const replyByLead = useMemo(() => {
    const m = new Map<string, Reply>();
    for (const rep of replies) if (!m.has(rep.sendpilot_lead_id)) m.set(rep.sendpilot_lead_id, rep);
    return m;
  }, [replies]);

  const armByVariant = useMemo(() => {
    const m = new Map<string, ArmStat>();
    for (const a of armStats) m.set(a.first_dm_variant, a);
    return m;
  }, [armStats]);

  const bestArm = useMemo(() => {
    let best: string | null = null, bestPct = -1;
    for (const a of armStats) {
      const pct = a.reply_pct ?? -1;
      if ((a.sent ?? 0) > 0 && pct > bestPct) { bestPct = pct; best = a.first_dm_variant; }
    }
    return best;
  }, [armStats]);

  const treeDefs = useMemo(() => buildTreeNodes(scopedSequences, scopedRows, armStats), [scopedSequences, scopedRows, armStats]);
  const treeEdges = useMemo(() => buildTreeEdges(treeDefs, scopedSequences), [treeDefs, scopedSequences]);

  // Pill counts: live pipeline rows per play (unscoped, so the numbers don't
  // change as you click through plays).
  const playCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const p = r.play ?? "";
      m.set(p, (m.get(p) ?? 0) + 1);
    }
    return m;
  }, [rows]);

  // Workspace-aware visibility: always keep the universal spine + any arm node,
  // and any node that actually holds contacts. Empty side-branches a workspace
  // doesn't use (e.g. OdaGroup's AI-draft path on the CarterCo board) drop out,
  // so each client sees its own flow instead of the union of everyone's.
  const visibleIds = useMemo(() => {
    const s = new Set<string>();
    for (const n of treeDefs) {
      // Always show the spine, arms, and the sequence skeleton (so every arm
      // shows its follow-ups even at 0 leads); plus anything holding contacts.
      if (FLOW_SPINE.has(n.id) || n.kind === "arm" || n.kind === "sequence" || (counts.get(n.id) ?? 0) > 0) s.add(n.id);
    }
    return s;
  }, [treeDefs, counts]);

  const rfNodes = useMemo<RFNode[]>(() => {
    // Vertical tree: each level is a row going DOWN (y); siblings within a
    // level spread across (x), centered so the trunk stays roughly mid-canvas.
    const byCol = new Map<number, NodeDef[]>();
    for (const n of treeDefs) {
      if (!visibleIds.has(n.id)) continue;
      const list = byCol.get(n.col);
      if (list) list.push(n); else byCol.set(n.col, [n]);
    }
    const LEVEL_H = 132, NODE_W = 220;
    const widest = Math.max(...[...byCol.values()].map((l) => l.length), 1);
    const out: RFNode[] = [];
    for (const [col, list] of byCol) {
      list.forEach((n, i) => {
        const arm = n.kind === "arm" && n.arm ? (armByVariant.get(n.arm) ?? null) : null;
        // Arm mode: x is fixed by lane so each arm's chain stays vertical.
        // Otherwise center this level's row of siblings.
        const x = n.lane != null
          ? n.lane * NODE_W + (widest * NODE_W) / 2
          : (i - (list.length - 1) / 2) * NODE_W + (widest * NODE_W) / 2;
        out.push({
          id: n.id,
          type: "flowCard",
          position: { x, y: col * LEVEL_H },
          data: (() => {
            // Wait info is a STUCK signal, not ambient metadata: hide it for
            // young nodes (<1 h — "ældste 0 min" is noise) and tint it clay
            // once the oldest contact has sat ≥5 days.
            const oldest = oldestByNode.get(n.id) ?? null;
            const ageMs = oldest ? Date.now() - Date.parse(oldest) : 0;
            return {
              label: n.label,
              count: counts.get(n.id) ?? 0,
              tone: n.tone,
              sublabel: n.sublabel,
              isSelected: n.id === selectedNode,
              armStat: arm,
              oldestAgo: ageMs >= 60 * 60_000 ? flowTimeAgo(oldest) || null : null,
              oldestStale: ageMs >= 5 * 24 * 60 * 60_000,
            };
          })(),
          draggable: false,
        });
      });
    }
    return out;
  }, [treeDefs, visibleIds, counts, oldestByNode, selectedNode, armByVariant]);

  const rfEdges = useMemo<RFEdge[]>(() =>
    treeEdges
      .filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
      .map((e) => ({
        id: e.id, source: e.source, target: e.target, type: "smoothstep",
        style: { stroke: "var(--ink)", strokeOpacity: 0.2, strokeWidth: 1.5 },
      })), [treeEdges, visibleIds]);

  const selectedRows = selectedNode ? (byNode.get(selectedNode) ?? []) : [];
  const seqStep = selectedNode ? lookupSeqStep(selectedNode, sequences) : null;
  const selectedLabel = useMemo(() => {
    if (!selectedNode) return "";
    const def = treeDefs.find((n) => n.id === selectedNode);
    if (def) return def.label;
    return OUTCOME_DEFS.find((o) => o.id === selectedNode)?.label ?? selectedNode;
  }, [selectedNode, treeDefs]);

  const arms = activeArms(sequences, scopedRows, armStats);

  return (
    <div>
      <PlayPills plays={plays} value={playFilter} onChange={onPlayFilter}
        countFor={(id) => id === "all" ? rows.length : (playCounts.get(id) ?? 0)} />
      {arms.length ? (
        <div className="mb-5 rounded-lg border border-[var(--ink)]/12 bg-[var(--cream)] p-4">
          <div className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/40">A/B-test · første DM</div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {arms.map((a) => {
              const st = armByVariant.get(a);
              const meta = ARM_META[a] ?? { label: a, sublabel: "" };
              const lead = bestArm === a;
              return (
                <button key={a} type="button"
                  onClick={() => { setSelectedNode(`arm:${a}`); setOpenContact(null); }}
                  className={`rounded-md border p-3 text-left transition ${lead ? "border-[var(--forest)]/50 bg-[var(--forest)]/5" : "border-[var(--ink)]/12 bg-[var(--sand)]/40"}`}>
                  <div className="flex items-baseline justify-between">
                    <span className="text-[13px] text-[var(--ink)]">{meta.label}</span>
                    {lead ? <span className="tabular text-[9px] uppercase tracking-[0.14em] text-[var(--forest)]">fører</span> : null}
                  </div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="font-display text-2xl italic text-[var(--ink)]">{st?.reply_pct ?? 0}%</span>
                    <span className="tabular text-[10px] uppercase tracking-[0.14em] text-[var(--ink)]/45">svarrate</span>
                  </div>
                  <div className="tabular mt-1 text-[10px] text-[var(--ink)]/45">{st?.assigned ?? 0} tildelt · {st?.sent ?? 0} sendt · {st?.replied ?? 0} svar</div>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="rounded-lg border border-[var(--ink)]/12 bg-[var(--sand)]/30" style={{ height: 640 }}>
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={FLOW_NODE_TYPES}
          onNodeClick={(_, n) => { setSelectedNode(n.id === selectedNode ? null : n.id); setOpenContact(null); }}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          nodesConnectable={false}
          minZoom={0.3}
        >
          <Background color="var(--ink)" gap={20} size={1} style={{ opacity: 0.05 }} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      <div className="mt-5">
        <div className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/40">Udfald · svar og terminal (uanset arm)</div>
        <div className="mt-2 flex flex-wrap gap-2">
          {OUTCOME_DEFS.map((o) => {
            const count = counts.get(o.id) ?? 0;
            const tone = FLOW_TONE_CLASS[o.tone];
            const isSel = o.id === selectedNode;
            return (
              <button key={o.id} type="button"
                onClick={() => { setSelectedNode(isSel ? null : o.id); setOpenContact(null); }}
                className={`rounded-md border px-3 py-2 text-left ${tone.card} ${isSel ? "ring-2 ring-[var(--ink)]/40" : ""} ${count === 0 ? "opacity-50" : ""}`}
                style={{ minWidth: 124 }}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[12px] text-[var(--ink)]">{o.label}</span>
                  <span className="font-display text-lg italic text-[var(--ink)]">{count}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {selectedNode ? (
        <div ref={detailRef} className="mt-6 scroll-mt-20 rounded-lg border border-[var(--ink)]/12 bg-[var(--cream)] p-5">
          <div className="flex items-baseline justify-between gap-4">
            <div>
              <h3 className="font-display text-2xl italic text-[var(--ink)]">{selectedLabel}</h3>
              <span className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/40">Kontakter i node</span>
            </div>
            <span className="tabular text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/45">{selectedRows.length} kontakter her</span>
          </div>

          <MessageBlueprint nodeId={selectedNode} seqStep={seqStep} />

          <div className="mt-5 divide-y divide-[var(--ink)]/8 border-t border-[var(--ink)]/8">
            {selectedRows.length === 0 ? (
              <p className="py-4 text-[13px] text-[var(--ink)]/45">Ingen kontakter sidder her lige nu.</p>
            ) : selectedRows.slice(0, 200).map((r) => {
              const open = openContact === r.sendpilot_lead_id;
              const name = `${r.lead?.first_name ?? ""} ${r.lead?.last_name ?? ""}`.trim() || r.contact_email || r.sendpilot_lead_id;
              const when = r.last_engagement_at ?? r.last_reply_at ?? r.sent_at ?? r.updated_at;
              return (
                <div key={r.sendpilot_lead_id}>
                  <button type="button" onClick={() => setOpenContact(open ? null : r.sendpilot_lead_id)}
                    className="flex w-full items-baseline justify-between gap-3 py-2.5 text-left">
                    <span className="truncate text-[14px] text-[var(--ink)]">{name}</span>
                    <span className="flex shrink-0 items-baseline gap-3">
                      <span className="max-w-[160px] truncate text-[12px] text-[var(--ink)]/45">{r.lead?.company ?? ""}</span>
                      <span className="tabular text-[11px] text-[var(--ink)]/40">{flowTimeAgo(when)}</span>
                    </span>
                  </button>
                  {r.error ? (
                    <div className="-mt-1 flex items-center gap-2 pb-1">
                      <p className="text-[11px] text-[var(--clay)]">⚠ {r.error}</p>
                      {r.status === "failed" && !r.last_reply_at ? (
                        <button type="button" disabled={busyLead === r.sendpilot_lead_id}
                          onClick={() => onRetry(r.sendpilot_lead_id)}
                          className="tabular shrink-0 rounded-full border border-[var(--forest)]/40 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-[var(--forest)] transition hover:border-[var(--forest)]/60 disabled:opacity-50">
                          {busyLead === r.sendpilot_lead_id ? "Sender…" : "Prøv igen"}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  {open ? <ContactMessages row={r} reply={replyByLead.get(r.sendpilot_lead_id) ?? null} /> : null}
                </div>
              );
            })}
            {selectedRows.length > 200 ? (
              <p className="py-3 text-[12px] text-[var(--ink)]/40">+{selectedRows.length - 200} flere…</p>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="mt-6 text-[13px] text-[var(--ink)]/45">Klik en node eller et udfald for at se beskedteksten og kontakterne.</p>
      )}
    </div>
  );
}


// ------------------------------ Kontakter --------------------------------
// Contact-first view: a searchable contact list (at-risk first) + a per-contact
// timeline — the full thread (past) plus projected upcoming sends (future).

function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString("da-DK", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

// Status → human label + tone, so lists read by colour at a glance (Lemlist/
// Instantly pattern) instead of raw lowercase enum text. Colours stay inside
// the house palette (forest / clay / ink) — no generic SaaS blue.
const STATUS_META: Record<string, { label: string; tone: "wait" | "go" | "act" | "good" | "bad" }> = {
  invited: { label: "Inviteret", tone: "wait" },
  accepted: { label: "Accepteret", tone: "go" },
  pending_pre_render: { label: "Afventer video", tone: "wait" },
  pending_ai_draft: { label: "AI-draft", tone: "wait" },
  rendering: { label: "Renderer", tone: "wait" },
  rendered: { label: "Renderet", tone: "go" },
  pending_approval: { label: "Til godkendelse", tone: "act" },
  pending_alt_review: { label: "Alt-review", tone: "act" },
  sent: { label: "Sendt", tone: "go" },
  pre_connected: { label: "Pre-forbundet", tone: "wait" },
  rejected: { label: "Afvist", tone: "bad" },
  rejected_by_icp: { label: "ICP-afvist", tone: "bad" },
  failed: { label: "Fejlet", tone: "bad" },
};

const STATUS_TONE_CLASS: Record<string, string> = {
  wait: "bg-[var(--ink)]/8 text-[var(--ink)]/55 border-[var(--ink)]/15",
  go: "bg-[var(--forest)]/8 text-[var(--forest)] border-[var(--forest)]/25",
  act: "bg-[var(--clay)]/10 text-[var(--clay)] border-[var(--clay)]/30",
  good: "bg-[var(--forest)]/12 text-[var(--forest)] border-[var(--forest)]/35",
  bad: "bg-[var(--clay)]/12 text-[var(--clay)] border-[var(--clay)]/35",
};

function StatusBadge({ status, intent }: { status: string; intent?: string | null }) {
  // an interested reply outranks the raw status for at-a-glance reading
  const meta = intent === "interested"
    ? { label: "Interesseret", tone: "good" as const }
    : STATUS_META[status] ?? { label: status, tone: "wait" as const };
  return (
    <span className={`tabular inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] ${STATUS_TONE_CLASS[meta.tone]}`}>
      {meta.label}
    </span>
  );
}

function ContactTimeline({ contact, lead, replies, emails, actions, signals, sequences, onSetOutcome, onOverrideIcp }: {
  contact: PipelineRow;
  lead?: LeadEnrich;
  replies: Reply[];
  emails: EmailRow[];
  actions: ActionRow[];
  signals: Signal[];
  sequences: SeqLite[];
  onSetOutcome: (leadId: string, outcome: Outcome | null) => void;
  onOverrideIcp: (leadId: string) => void;
}) {
  const tc = contact as unknown as TimelineContact;
  const thread = useMemo(() => buildThread(tc, replies, emails, actions, signals), [tc, replies, emails, actions, signals]);
  const upcoming = useMemo(() => projectUpcoming(tc, sequences), [tc, sequences]);
  const forgotten = isPossiblyForgotten(tc, upcoming);

  const name = `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim() || contact.contact_email || contact.sendpilot_lead_id;
  const seqLabel = contact.sequence_id
    ? `${contact.sequence_id} · trin ${contact.sequence_step ?? 0}`
    : "intet aktivt forløb";

  return (
    <div className="rounded-lg border border-[var(--ink)]/12 bg-[var(--cream)] p-5">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h3 className="font-display text-2xl italic text-[var(--ink)]">{name}</h3>
          <p className="mt-0.5 text-[12px] text-[var(--ink)]/55">
            {[lead?.title, lead?.company].filter(Boolean).join(" · ") || contact.contact_email}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <StatusBadge status={contact.status} intent={contact.last_reply_intent} />
          <div className="tabular text-[10px] text-[var(--ink)]/40">{seqLabel}</div>
          {contact.thread_out_of_sync ? (
            <span
              title="Vores kopi af tråden matcher ikke SendPilot — du ser måske kun en del af samtalen. Tjek på LinkedIn."
              className="tabular rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-700">
              ⚠ Tråd ude af sync
            </span>
          ) : null}
        </div>
      </div>

      {/* quick-actions — mark outcome / open LinkedIn, without leaving the contact */}
      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        {OUTCOME_OPTIONS.map((o) => {
          const on = contact.outcome === o.value;
          return (
            <button key={o.value} type="button"
              onClick={() => onSetOutcome(contact.sendpilot_lead_id, on ? null : o.value)}
              className={`tabular rounded-full border px-2.5 py-1 text-[11px] transition ${
                on
                  ? "border-[var(--forest)]/50 bg-[var(--forest)]/10 text-[var(--forest)]"
                  : "border-[var(--ink)]/15 text-[var(--ink)]/55 hover:border-[var(--ink)]/30"
              }`}>
              {o.label}
            </button>
          );
        })}
        {contact.linkedin_url ? (
          <a href={contact.linkedin_url} target="_blank" rel="noreferrer"
            className="tabular rounded-full border border-[var(--ink)]/15 px-2.5 py-1 text-[11px] text-[var(--ink)]/55 transition hover:border-[var(--ink)]/30">
            LinkedIn ↗
          </a>
        ) : null}
        {contact.status === "rejected_by_icp" ? (
          <button type="button" onClick={() => onOverrideIcp(contact.sendpilot_lead_id)}
            className="tabular rounded-full border border-[var(--clay)]/40 px-2.5 py-1 text-[11px] text-[var(--clay)] transition hover:border-[var(--clay)]/60">
            Send til render →
          </button>
        ) : null}
      </div>

      {forgotten ? (
        <div className="mt-4 rounded-md border border-[var(--clay)]/45 bg-[var(--clay)]/10 px-3 py-2 text-[13px] text-[var(--ink)]/80">
          Ingen næste handling planlagt — sendt, intet svar, intet forløb. Kan være glemt.
        </div>
      ) : null}

      {/* Thread (past) */}
      <div className="mt-5">
        <div className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/40">Tråd</div>
        {thread.length === 0 ? (
          <p className="mt-2 text-[13px] text-[var(--ink)]/45">Ingen beskeder endnu.</p>
        ) : (
          <div className="mt-2 space-y-2">
            {thread.map((m, i) => (
              <div key={i} className={`rounded-md border p-3 ${
                m.direction === "in"
                  ? "border-[var(--forest)]/25 bg-[var(--forest)]/5"
                  : "border-[var(--ink)]/10 bg-[var(--sand)]/40"
              }`}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="tabular text-[10px] uppercase tracking-[0.16em] text-[var(--ink)]/45">
                    {m.direction === "in" ? "← " : "→ "}{m.label} · {m.channel}
                  </span>
                  <span className="tabular text-[10px] text-[var(--ink)]/40">{fmtWhen(m.at)}</span>
                </div>
                {m.subject ? <div className="mt-1 text-[12px] font-semibold text-[var(--ink)]/75">{m.subject}</div> : null}
                {m.text ? (
                  <pre className="mt-1 whitespace-pre-wrap font-body text-[13px] leading-relaxed text-[var(--ink)]/85">{m.text}</pre>
                ) : (
                  <p className="mt-1 text-[12px] italic text-[var(--ink)]/40">(sendt — tekst ikke gemt)</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Upcoming (projected) */}
      <div className="mt-5">
        <div className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/40">Kommende (forventet)</div>
        {upcoming.length === 0 ? (
          <p className="mt-2 text-[13px] text-[var(--ink)]/45">
            {contact.sequence_completed_at ? "Forløb afsluttet." : "Intet planlagt."}
          </p>
        ) : (
          <div className="mt-2 space-y-2">
            {upcoming.map((u, i) => (
              <div key={i} className="rounded-md border border-dashed border-[var(--ink)]/20 bg-[var(--cream)] p-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="tabular text-[10px] uppercase tracking-[0.16em] text-[var(--ink)]/45">
                    {u.stepId}{u.conditional ? " · betinget" : ""}
                  </span>
                  <span className="tabular text-[10px] text-[var(--forest)]">{fmtWhen(u.at)}</span>
                </div>
                {u.template ? (
                  <pre className="mt-1 whitespace-pre-wrap font-body text-[13px] leading-relaxed text-[var(--ink)]/70">{u.template}</pre>
                ) : null}
              </div>
            ))}
            <p className="text-[11px] text-[var(--ink)]/40">Datoer er fremskrevet ud fra forløbets ventetider — kan ændre sig ved svar.</p>
          </div>
        )}
      </div>
    </div>
  );
}

const KONTAKTER_SCOPES: { id: "all" | "sent" | "forgotten" | "icp_rejected"; label: string }[] = [
  { id: "all", label: "Alle" },
  { id: "sent", label: "Sendt" },
  { id: "forgotten", label: "Glemt?" },
  { id: "icp_rejected", label: "ICP-afvist" },
];

function KontakterTab({ rows, replies, emails, actions, signals, sequences, plays, playFilter, onPlayFilter, onSetOutcome, onOverrideIcp }: {
  rows: PipelineRow[];
  replies: Reply[];
  emails: EmailRow[];
  actions: ActionRow[];
  signals: Signal[];
  sequences: SeqLite[];
  plays: Play[];
  playFilter: string;
  onPlayFilter: (playId: string) => void;
  onSetOutcome: (leadId: string, outcome: Outcome | null) => void;
  onOverrideIcp: (leadId: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "sent" | "forgotten" | "icp_rejected">("all");

  // Play scope — same axis as the Flow tree's pills, so a node count over
  // there and this list are two views of the same query.
  const scopedRows = useMemo(
    () => (playFilter === "all" ? rows : rows.filter((r) => (r.play ?? "") === playFilter)),
    [rows, playFilter],
  );

  const repliesByLead = useMemo(() => {
    const m = new Map<string, Reply[]>();
    for (const r of replies) (m.get(r.sendpilot_lead_id) ?? m.set(r.sendpilot_lead_id, []).get(r.sendpilot_lead_id)!).push(r);
    return m;
  }, [replies]);
  const emailsByLead = useMemo(() => {
    const m = new Map<string, EmailRow[]>();
    for (const e of emails) (m.get(e.pipeline_lead_id) ?? m.set(e.pipeline_lead_id, []).get(e.pipeline_lead_id)!).push(e);
    return m;
  }, [emails]);
  const actionsByLead = useMemo(() => {
    const m = new Map<string, ActionRow[]>();
    for (const a of actions) (m.get(a.sendpilot_lead_id) ?? m.set(a.sendpilot_lead_id, []).get(a.sendpilot_lead_id)!).push(a);
    return m;
  }, [actions]);

  // Match inbound signals (RB2B site visits etc.) to contacts by LinkedIn URL or
  // email, so a known contact revisiting your site lands on their timeline + warm.
  const signalsByLead = useMemo(() => {
    const normLi = (u: string) => u.replace(/\/+$/, "").split("?")[0].toLowerCase();
    const byLi = new Map<string, string>();
    const byEmail = new Map<string, string>();
    for (const r of rows) {
      if (r.linkedin_url) byLi.set(normLi(r.linkedin_url), r.sendpilot_lead_id);
      if (r.contact_email) byEmail.set(r.contact_email.toLowerCase(), r.sendpilot_lead_id);
    }
    const m = new Map<string, Signal[]>();
    for (const s of signals) {
      const id = (s.person_linkedin_url && byLi.get(normLi(s.person_linkedin_url)))
        || (s.person_email && byEmail.get(s.person_email.toLowerCase()));
      if (id) (m.get(id) ?? m.set(id, []).get(id)!).push(s);
    }
    return m;
  }, [rows, signals]);

  // Warm (just revisited your site) first, then at-risk (forgotten), then recent.
  const enriched = useMemo(() => {
    return scopedRows.map((r) => {
      const up = projectUpcoming(r as unknown as TimelineContact, sequences);
      return {
        row: r,
        forgotten: isPossiblyForgotten(r as unknown as TimelineContact, up),
        warm: signalsByLead.has(r.sendpilot_lead_id),
        nextAt: up[0]?.at ?? null,
      };
    }).sort((a, b) => {
      if (a.warm !== b.warm) return a.warm ? -1 : 1;
      if (a.forgotten !== b.forgotten) return a.forgotten ? -1 : 1;
      return new Date(b.row.updated_at).getTime() - new Date(a.row.updated_at).getTime();
    });
  }, [scopedRows, sequences, signalsByLead]);

  const filtered = useMemo(() => {
    const byScope = enriched.filter(({ row, forgotten }) =>
      scope === "all" ? true
      : scope === "sent" ? !!row.sent_at
      : scope === "forgotten" ? forgotten
      : scope === "icp_rejected" ? row.status === "rejected_by_icp"
      : true,
    );
    const q = query.trim().toLowerCase();
    if (!q) return byScope;
    return byScope.filter(({ row }) => {
      const hay = `${row.lead?.first_name ?? ""} ${row.lead?.last_name ?? ""} ${row.lead?.company ?? ""} ${row.contact_email}`.toLowerCase();
      return hay.includes(q);
    });
  }, [enriched, query, scope]);

  const forgottenCount = enriched.filter((e) => e.forgotten).length;
  // Resolve against scopedRows so flipping the play pill can't leave a
  // now-hidden contact's timeline open next to a list it isn't in.
  const selected = selectedId ? scopedRows.find((r) => r.sendpilot_lead_id === selectedId) ?? null : null;

  const playCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const p = r.play ?? "";
      m.set(p, (m.get(p) ?? 0) + 1);
    }
    return m;
  }, [rows]);

  return (
    <div className="grid gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
      <div>
        <PlayPills plays={plays} value={playFilter} onChange={onPlayFilter}
          countFor={(id) => id === "all" ? rows.length : (playCounts.get(id) ?? 0)} />
        <div className="mb-2 flex flex-wrap gap-1.5">
          {KONTAKTER_SCOPES.map((s) => (
            <button key={s.id} type="button" onClick={() => setScope(s.id)}
              className={`tabular rounded-full border px-2.5 py-1 text-[11px] uppercase tracking-[0.12em] transition ${
                scope === s.id
                  ? "border-[var(--ink)]/40 bg-[var(--sand)]/60 text-[var(--ink)]"
                  : "border-[var(--ink)]/15 text-[var(--ink)]/50 hover:border-[var(--ink)]/30"
              }`}>
              {s.label}
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
          placeholder="Søg navn, firma, email…"
          className="focus-cream w-full rounded-md border border-[var(--ink)]/15 bg-[var(--cream)] px-3 py-2 text-[13px] text-[var(--ink)] outline-none"
        />
        {forgottenCount > 0 ? (
          <div className="tabular mt-2 text-[11px] uppercase tracking-[0.16em] text-[var(--clay)]">
            {forgottenCount} muligvis glemt
          </div>
        ) : null}
        <div className="mt-2 max-h-[640px] overflow-y-auto rounded-md border border-[var(--ink)]/10 divide-y divide-[var(--ink)]/8">
          {filtered.slice(0, 400).map(({ row, forgotten, warm, nextAt }) => {
            const name = `${row.lead?.first_name ?? ""} ${row.lead?.last_name ?? ""}`.trim() || row.contact_email || row.sendpilot_lead_id;
            const active = row.sendpilot_lead_id === selectedId;
            return (
              <button key={row.sendpilot_lead_id} type="button"
                onClick={() => setSelectedId(row.sendpilot_lead_id)}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition ${active ? "bg-[var(--sand)]/60" : "hover:bg-[var(--sand)]/30"}`}>
                {/* Initial avatar; clay ring = warm (just revisited the site), replacing the
                    off-brand 🔥 emoji prefix (DESIGN.md forbids emoji as design). */}
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border bg-[var(--cream)] font-display text-[13px] italic leading-none text-[var(--ink)] ${warm ? "border-[var(--clay)]" : "border-[var(--ink)]/15"}`}>
                  {name.trim().charAt(0).toUpperCase() || "?"}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[14px] text-[var(--ink)]">{name}</span>
                    {warm ? <span className="shrink-0 text-[10px] text-[var(--clay)]">besøg</span>
                      : forgotten ? <span className="shrink-0 text-[10px] text-[var(--clay)]">● glemt?</span>
                      : nextAt ? <span className="tabular shrink-0 text-[10px] text-[var(--ink)]/40">{fmtWhen(nextAt)}</span> : null}
                  </span>
                  <span className="flex items-center gap-2">
                    <StatusBadge status={row.status} intent={row.last_reply_intent} />
                    {/* Current flow position (sequence step / arm) — the same
                        label the Flow tree uses, so list and tree line up. */}
                    {row.sequence_id && row.sequence_step != null && !row.sequence_completed_at ? (
                      <span className="tabular shrink-0 text-[10px] text-[var(--ink)]/50">
                        {nodeLabel(classifyNode(row), sequences)}
                      </span>
                    ) : null}
                    <span className="truncate text-[11px] text-[var(--ink)]/45">{row.lead?.company ?? ""}</span>
                  </span>
                </span>
              </button>
            );
          })}
          {filtered.length > 400 ? (
            <div className="px-3 py-2 text-[11px] text-[var(--ink)]/40">+{filtered.length - 400} flere — søg for at indsnævre</div>
          ) : null}
        </div>
      </div>

      <div>
        {selected ? (
          <ContactTimeline
            contact={selected}
            lead={selected.lead}
            replies={repliesByLead.get(selected.sendpilot_lead_id) ?? []}
            emails={emailsByLead.get(selected.sendpilot_lead_id) ?? []}
            actions={actionsByLead.get(selected.sendpilot_lead_id) ?? []}
            signals={signalsByLead.get(selected.sendpilot_lead_id) ?? []}
            sequences={sequences}
            onSetOutcome={onSetOutcome}
            onOverrideIcp={onOverrideIcp}
          />
        ) : (
          <p className="text-[13px] text-[var(--ink)]/45">Vælg en kontakt for at se hele tråden og hvad de modtager næste gang.</p>
        )}
      </div>
    </div>
  );
}

// ------------------------------- Besøg -----------------------------------
// Site visitors who aren't already a contact, ranked by ICP fit — warm inbound
// to pursue. The matched ones land on their contact's timeline (Kontakter).

function icpFit(score: number | null): { label: string; tone: "good" | "act" | "bad" | "wait" } {
  if (score == null) return { label: "ukendt fit", tone: "wait" };
  if (score >= 7) return { label: "ICP-match", tone: "good" };
  if (score >= 4) return { label: "delvist", tone: "act" };
  return { label: "lav fit", tone: "bad" };
}

// Signal layout helpers. The Signal type carries source/signal_type, page_views
// and company_size that the old card ignored — surface them for hierarchy.
function signalKindLabel(s: Signal): string {
  const t = `${s.signal_type ?? ""} ${s.source ?? ""}`.toLowerCase();
  if (/rb2b|visit|bes[øo]g|site/.test(t)) return "Besøg";
  if (/hir|job|stilling/.test(t)) return "Hiring";
  if (/meta|ad|leadgen|annonce/.test(t)) return "Annonce";
  const raw = (s.signal_type || s.source || "signal").replace(/[_-]+/g, " ");
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function pageViewCount(pv: unknown): number | null {
  if (typeof pv === "number") return pv > 0 ? pv : null;
  if (Array.isArray(pv)) return pv.length || null;
  return null;
}

// Four-dot intent meter from the ICP score (0-100). Filled dots in clay.
function IntentDots({ score, title }: { score: number; title?: string }) {
  const filled = Math.max(0, Math.min(4, Math.round(score / 25)));
  return (
    <span className="flex items-center gap-0.5" title={title} aria-label={`intent ${score}`}>
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className={`h-1.5 w-1.5 rounded-full ${i < filled ? "bg-[var(--clay)]" : "bg-[var(--ink)]/15"}`} />
      ))}
    </span>
  );
}

function BesogTab({ signals, busyLead, onSearchPeople, onDismiss }: {
  signals: Signal[];
  busyLead: string | null;
  onSearchPeople: (id: string) => void;
  onDismiss: (ids: string[]) => void;
}) {
  if (!signals.length) {
    return (
      <p className="text-[13px] text-[var(--ink)]/45">
        Ingen nye besøg lige nu. Når nogen scanner din side og ikke allerede er en kontakt,
        dukker de op her — sorteret efter ICP-fit.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {signals.slice(0, 100).map((s) => {
        const fit = icpFit(s.icp_score);
        const name = s.person_name || s.company_name || s.company_domain || "?";
        const busy = busyLead === `signal-search:${s.id}`;
        const pages = pageViewCount(s.page_views);
        const meta = [
          pages != null ? `${pages} ${pages === 1 ? "side" : "sider"} set` : null,
          s.company_size ? `${s.company_size} ansatte` : null,
        ].filter(Boolean);
        return (
          <div key={s.id} className="rounded-lg border border-[var(--ink)]/12 bg-[var(--cream)] p-4">
            {/* header: signal type + recency */}
            <div className="flex items-center justify-between gap-2">
              <span className="tabular rounded-sm border border-[var(--ink)]/15 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.18em] text-[var(--ink)]/55">
                {signalKindLabel(s)}
              </span>
              <span className="tabular shrink-0 text-[10px] text-[var(--ink)]/40">{fmtWhen(s.identified_at)}</span>
            </div>
            {/* name + intent meter */}
            <div className="mt-2 flex items-baseline justify-between gap-3">
              <span className="truncate text-[16px] text-[var(--ink)]">{name}</span>
              {s.icp_score != null ? (
                <span className="flex shrink-0 items-center gap-1.5">
                  <IntentDots score={s.icp_score} title={fit.label} />
                  <span className="tabular text-[11px] text-[var(--ink)]/55">{s.icp_score}</span>
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 truncate text-[12px] text-[var(--ink)]/55">
              {[s.person_title, s.company_industry || s.company_name].filter(Boolean).join(" · ") || s.company_domain}
            </div>
            {meta.length ? (
              <div className="tabular mt-1 text-[11px] text-[var(--ink)]/45">{meta.join(" · ")}</div>
            ) : null}
            {/* rationale, collapsed by default */}
            {s.icp_reasoning ? (
              <details className="group mt-2">
                <summary className="tabular cursor-pointer list-none text-[10px] uppercase tracking-[0.14em] text-[var(--ink)]/40 transition hover:text-[var(--ink)]/65">
                  hvorfor <span className="inline-block transition group-open:rotate-180">⌄</span>
                </summary>
                <p className="mt-1.5 text-[12px] italic leading-relaxed text-[var(--ink)]/55">{s.icp_reasoning}</p>
              </details>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {s.person_linkedin_url ? (
                <a href={s.person_linkedin_url} target="_blank" rel="noreferrer"
                  className="tabular rounded-full border border-[var(--ink)]/15 px-2.5 py-1 text-[11px] text-[var(--ink)]/60 transition hover:border-[var(--ink)]/30">
                  LinkedIn ↗
                </a>
              ) : null}
              <button type="button" disabled={busy} onClick={() => onSearchPeople(s.id)}
                className="tabular rounded-full border border-[var(--forest)]/40 px-2.5 py-1 text-[11px] text-[var(--forest)] transition hover:border-[var(--forest)]/60 disabled:opacity-50">
                {busy ? "Finder…" : "Find personer →"}
              </button>
              <button type="button" onClick={() => onDismiss([s.id])}
                className="tabular rounded-full border border-[var(--ink)]/15 px-2.5 py-1 text-[11px] text-[var(--ink)]/50 transition hover:border-[var(--ink)]/30">
                Afvis
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Funnel({ stats }: { stats: FunnelStats }) {
  const stages = [
    { label: "Inviteret", value: stats.invited + stats.accepted + stats.rendering + stats.pending + stats.sent + stats.rejected + stats.failed },
    { label: "Accept", value: stats.accepted + stats.rendering + stats.pending + stats.sent + stats.rejected + stats.failed },
    { label: "Sendt", value: stats.sent },
    { label: "Reply", value: stats.replied },
  ];
  const max = Math.max(...stages.map((s) => s.value), 1);
  return (
    <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
      {stages.map((s, i) => {
        const pct = Math.max(8, Math.round((s.value / max) * 100));
        // conversion from the previous stage — the read that says "is this healthy?"
        const prev = i > 0 ? stages[i - 1].value : 0;
        const conv = i > 0 && prev > 0 ? Math.round((s.value / prev) * 100) : null;
        return (
          <div key={s.label}>
            <dd className="font-display text-3xl italic leading-tight tracking-tight text-[var(--ink)]">{s.value}</dd>
            <div className="mt-1 h-1.5 rounded-sm bg-[var(--ink)]/10" aria-hidden>
              <div className="h-full rounded-sm" style={{
                width: `${pct}%`,
                background: i === 3 ? "var(--forest)" : i === 0 ? "var(--ink)" : i === 1 ? "var(--clay)" : "var(--forest)",
                opacity: i === 0 ? 0.55 : 1,
              }} />
            </div>
            <dt className="tabular mt-1 flex items-baseline gap-1.5 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/45">
              <span>{s.label}</span>
              {conv !== null ? <span className="text-[var(--forest)] normal-case tracking-normal">{conv}%</span> : null}
            </dt>
          </div>
        );
      })}
    </dl>
  );
}

function Sparkline({ data }: { data: { day: string; count: number }[] }) {
  if (!data.length) return null;
  const max = Math.max(...data.map((d) => d.count), 1);
  const W = 320, H = 36, pad = 2;
  const stepX = (W - 2 * pad) / Math.max(1, data.length - 1);
  const ptY = (v: number) => H - pad - (v / max) * (H - 2 * pad);
  const line = data.map((d, i) => `${i === 0 ? "M" : "L"} ${pad + i * stepX} ${ptY(d.count)}`).join(" ");
  const total = data.reduce((s, d) => s + d.count, 0);
  return (
    <div className="flex items-end gap-3">
      <div>
        <div className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/45">Sendt seneste 30 d</div>
        <div className="font-display text-2xl italic leading-tight tracking-tight text-[var(--ink)]">{total}</div>
      </div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="text-[var(--forest)]" aria-hidden>
        <path d={line} fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </div>
  );
}

// Grouped IA shared by the desktop sidebar (SideNav) and the mobile bar (Tabs)
// so they can't drift. Gør nu = act now, Kontakter = the contact spine, Indsigt
// = the map + learning.
type NavCounts = {
  i_dag: number; opgaver: number; signaler: number; inbox: number; replies: number; sent: number; all: number;
  icp_rejected: number; icp_open_proposals: number; flow: number; kontakter: number; besog: number;
  plays: number;
};
type NavItem = { id: Tab; label: string; count: number; accent?: boolean; icpOnly?: boolean; group: string };
const NAV_GROUP_ORDER = ["Gør nu", "Kontakter", "Indsigt"];

// Inline stroke icons. fill=none + stroke=currentColor means each icon inherits
// the button's text color (clay/forest/ink). These replace the emoji that used
// to prefix action buttons — DESIGN.md forbids emoji as design elements.
function IconMail({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`inline-block align-[-1px] ${className}`}>
      <rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3.5 7 8.5 6 8.5-6" />
    </svg>
  );
}
function IconPhone({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`inline-block align-[-1px] ${className}`}>
      <path d="M5 4h3.5l1.8 4.5-2.3 1.6a11 11 0 0 0 5.1 5.1l1.6-2.3 4.5 1.8V19a2 2 0 0 1-2.2 2A16 16 0 0 1 3 6.2 2 2 0 0 1 5 4Z" />
    </svg>
  );
}
function IconPen({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`inline-block align-[-1px] ${className}`}>
      <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

// outreach_leads keeps the raw Apify URL; the pipeline row's URL comes from
// SendPilot — normalise both before matching (same reason normLi exists).
const STAGE_PILL: Record<string, string> = {
  Klargjort: "border-[var(--ink)]/20 text-[var(--ink)]/45",
  Inviteret: "border-[var(--clay)]/40 text-[var(--clay)]",
  Accepteret: "border-[var(--forest)]/40 text-[var(--forest)]",
  Video: "border-[var(--clay)]/40 text-[var(--clay)]",
  Svar: "border-[var(--clay)] bg-[var(--clay)]/10 text-[var(--clay)]",
};

// Relative "X siden" for the daily-pipeline panel (Danish, compact).
function hiringRunAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "nu";
  if (m < 60) return `${m} min siden`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} t siden`;
  return `${Math.floor(h / 24)} d siden`;
}

// The Plays tab: one row per play from the outreach_plays registry —
// ActiveCampaign-automations-list shaped. Status pill, live counts, reply rate,
// and a per-play detail (funnel, intake runs, contact roster) that used to be
// the hiring-signal-only layout. Play rows render purely from the registry —
// new plays appear the moment their row exists (one exception: the intake-runs
// panel in PlayDetail is keyed to the hiring play until hiring_pipeline_runs
// grows a play column).
function PlaysOverview({ plays, staged, rows, runs, sequences, onOpenFlow, onOpenContacts }: {
  plays: Play[];
  staged: StagedLead[];
  rows: PipelineRow[];
  runs: HiringRun[];
  sequences: SeqLite[];
  onOpenFlow: (playId: string) => void;
  onOpenContacts: (playId: string) => void;
}) {
  const [openPlay, setOpenPlay] = useState<string | null>(null);

  // Counting rules live (tested) in flow.ts playStats; staged leads group here.
  const statsByPlay = useMemo(() => {
    const m = playStats(plays.map((p) => p.id), rows) as Map<string, {
      pipe: PipelineRow[]; stagedLeads: StagedLead[];
      active: number; sent: number; replied: number;
    }>;
    for (const s of m.values()) s.stagedLeads = [];
    for (const l of staged) m.get(l.play)?.stagedLeads.push(l);
    return m;
  }, [plays, rows, staged]);

  return (
    <div className="space-y-7">
      <div>
        <h2 className="font-display text-3xl italic leading-tight tracking-[-0.01em] text-[var(--ink)]">Plays</h2>
        <p className="mt-1 max-w-xl text-sm text-[var(--ink)]/60">
          De outbound-spor dette workspace kører samtidig. Hver kontakt der
          arbejdes på, hører til præcis ét play — tallene her og Flow-træet er
          to visninger af samme data.
        </p>
      </div>

      <ul className="divide-y divide-[var(--ink)]/10 border-y border-[var(--ink)]/10">
        {plays.map((p) => {
          const s = statsByPlay.get(p.id) ?? { pipe: [], stagedLeads: [], active: 0, sent: 0, replied: 0 };
          const replyPct = s.sent > 0 ? Math.round((s.replied / s.sent) * 100) : null;
          const open = openPlay === p.id;
          return (
            <li key={p.id} className="py-4">
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={() => setOpenPlay(open ? null : p.id)}
                  aria-expanded={open}
                  className="focus-cream flex min-w-0 flex-1 items-baseline gap-3 text-left">
                  {/* Disclosure affordance — the row expands into the detail panel. */}
                  <span aria-hidden className={`tabular shrink-0 text-[11px] text-[var(--ink)]/40 transition-transform ${open ? "rotate-90" : ""}`}>›</span>
                  <span className="font-display text-xl italic leading-tight text-[var(--ink)]">{p.label}</span>
                  <span className={`tabular shrink-0 rounded-full border px-2 py-0.5 text-[9px] uppercase tracking-[0.14em] ${
                    p.status === "active"
                      ? "border-[var(--forest)]/40 text-[var(--forest)]"
                      : "border-[var(--ink)]/20 text-[var(--ink)]/45"
                  }`}>
                    {p.status === "active" ? "Aktiv" : "På pause"}
                  </span>
                  {p.is_default ? (
                    <span className="tabular shrink-0 text-[9px] uppercase tracking-[0.14em] text-[var(--ink)]/35">standard</span>
                  ) : null}
                </button>
                <div className="tabular flex shrink-0 items-baseline gap-4 text-[12px] text-[var(--ink)]/65">
                  {s.stagedLeads.length ? <span>{s.stagedLeads.length} klargjort</span> : null}
                  <span><span className="text-[var(--ink)]">{s.active}</span> aktive</span>
                  <span>{s.sent} sendt</span>
                  <span>
                    {s.replied} svar
                    {replyPct != null ? <span className="text-[var(--forest)]"> · {replyPct}%</span> : null}
                  </span>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button type="button" onClick={() => onOpenFlow(p.id)}
                    className="focus-cream tabular rounded-full border border-[var(--ink)]/20 px-2.5 py-1 text-[10px] uppercase tracking-[0.12em] text-[var(--ink)]/70 transition hover:border-[var(--ink)]/40">
                    Flow →
                  </button>
                  <button type="button" onClick={() => onOpenContacts(p.id)}
                    className="focus-cream tabular rounded-full border border-[var(--ink)]/20 px-2.5 py-1 text-[10px] uppercase tracking-[0.12em] text-[var(--ink)]/70 transition hover:border-[var(--ink)]/40">
                    Kontakter →
                  </button>
                </div>
              </div>
              {p.description ? (
                <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-[var(--ink)]/50">{p.description}</p>
              ) : null}
              {open ? (
                <PlayDetail play={p} pipe={s.pipe} stagedLeads={s.stagedLeads}
                  runs={runs} sequences={sequences} onOpenContacts={onOpenContacts} />
              ) : null}
            </li>
          );
        })}
        {plays.length === 0 ? (
          <li className="py-4 text-sm text-[var(--ink)]/50">
            Ingen plays registreret — tilføj rækker i <code className="text-[var(--clay)]">outreach_plays</code>.
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function PlayDetail({ play, pipe, stagedLeads, runs, sequences, onOpenContacts }: {
  play: Play;
  pipe: PipelineRow[];
  stagedLeads: StagedLead[];
  runs: HiringRun[];
  sequences: SeqLite[];
  onOpenContacts: (playId: string) => void;
}) {
  const lastRun = runs[0];
  // Intake-run panel: hiring_pipeline_runs is the hiring-signal play's intake
  // infrastructure (run_hiring_pipeline.sh). Keyed on the play id here because
  // the runs table has no play column yet — generalising intake runs to other
  // plays means adding one and dropping this check.
  const showRuns = play.id === "hiring_signal";

  // Funnel stages in flow order; "Klargjort" only exists for plays whose
  // intake pre-stages leads (the default play's universe is every imported
  // lead).
  const stages: [string, number][] = [
    ...(stagedLeads.length || !play.is_default ? [["Klargjort", stagedLeads.length] as [string, number]] : []),
    ["Inviteret", pipe.filter((r) => r.invited_at).length],
    ["Accepteret", pipe.filter((r) => r.accepted_at).length],
    ["Sendt", pipe.filter((r) => r.sent_at).length],
    ["Svar", pipe.filter((r) => r.last_reply_at).length],
  ];

  // One normalized-URL map instead of a pipe-scan per staged lead — the
  // staged list grows with every intake run and pipe is up to 1000 rows.
  const pipeByUrl = useMemo(() => {
    const m = new Map<string, PipelineRow>();
    for (const r of pipe) m.set(normLinkedinUrl(r.linkedin_url), r);
    return m;
  }, [pipe]);

  return (
    <div className="mt-4 space-y-5">
      {/* Funnel as a flow: stages with conversion % between them; spent stages
          accented in clay, stages not yet reached dimmed. Reads left-to-right. */}
      <div className="flex items-end overflow-x-auto border-y border-[var(--ink)]/10 py-4">
        {stages.flatMap(([label, n], i) => {
          const cell = (
            <div key={label} className="flex shrink-0 flex-col items-center px-2" style={{ minWidth: 66 }}>
              <div className={`font-display text-3xl italic leading-none ${n > 0 ? "text-[var(--clay)]" : "text-[var(--ink)]/25"}`}>{n}</div>
              <div className="tabular mt-1.5 text-[9px] uppercase tracking-[0.16em] text-[var(--ink)]/50">{label}</div>
            </div>
          );
          if (i === stages.length - 1) return [cell];
          const prev = stages[i][1];
          const next = stages[i + 1][1];
          const conv = prev > 0 ? `${Math.round((next / prev) * 100)}%` : "·";
          const connector = (
            <div key={`${label}-c`} className="flex flex-1 flex-col items-center pb-4" style={{ minWidth: 36 }}>
              <div className="tabular text-[9px] tracking-wide text-[var(--ink)]/35">{conv}</div>
              <div className="mt-1 h-px w-full bg-[var(--ink)]/15" />
            </div>
          );
          return [cell, connector];
        })}
      </div>

      {showRuns ? (
        /* Daily pipeline — follow the automation. Each row = one run of
           run_hiring_pipeline.sh (cron 08:00 or manual). */
        <div className="rounded-lg border border-[var(--ink)]/10 bg-[var(--cream)]/40 p-4">
          <div className="flex items-baseline justify-between">
            <h3 className="tabular text-[11px] uppercase tracking-[0.18em] text-[var(--ink)]/55">Daglig pipeline</h3>
            {lastRun ? (
              <span className="tabular text-[10px] text-[var(--ink)]/45">
                sidst kørt {hiringRunAgo(lastRun.ran_at)} · {lastRun.trigger === "cron" ? "auto" : "manuelt"}
              </span>
            ) : (
              <span className="tabular text-[10px] text-[var(--ink)]/40">kører dagligt 08:00</span>
            )}
          </div>
          {runs.length === 0 ? (
            <p className="mt-2 text-xs text-[var(--ink)]/45">Ingen kørsler endnu — første run lægger sig her.</p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {runs.slice(0, 7).map((r, i) => (
                <li key={i} className="flex items-center gap-3 text-[12px]">
                  <span className="tabular w-24 shrink-0 text-[var(--ink)]/45">{hiringRunAgo(r.ran_at)}</span>
                  <span className={`tabular shrink-0 rounded-full px-1.5 py-px text-[8px] uppercase tracking-[0.12em] ${r.trigger === "cron" ? "bg-[var(--ink)]/8 text-[var(--ink)]/55" : "bg-[var(--clay)]/12 text-[var(--clay)]"}`}>
                    {r.trigger === "cron" ? "auto" : "manuel"}
                  </span>
                  <span className="tabular flex-1 text-[var(--ink)]/65">
                    {r.companies_found ?? 0} virksomheder · {r.decision_makers ?? 0} beslutningstagere
                  </span>
                  <span className="tabular shrink-0 text-[var(--ink)]/70">
                    {(r.leads_added_sendpilot ?? 0) > 0
                      ? <span className="text-[var(--clay)]">+{r.leads_added_sendpilot} nye</span>
                      : <span className="text-[var(--ink)]/40">0 nye</span>}
                  </span>
                  {(r.held_company_dialogue ?? 0) > 0 && (
                    <span className="tabular shrink-0 text-[10px] text-[var(--ink)]/50">{r.held_company_dialogue} holdt · dialog</span>
                  )}
                  {r.status !== "ok" && <span className="shrink-0 text-[10px] text-[var(--clay)]">fejl</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {/* Roster. Plays with pre-staged intake list the staged universe (the
          stage pill tracks each lead into the pipeline); the default play
          lists its live pipeline contacts with their current flow position. */}
      {stagedLeads.length > 0 ? (
        <ul className="divide-y divide-[var(--ink)]/10 border-t border-[var(--ink)]/10">
          {stagedLeads.slice(0, 100).map((l) => {
            const name = [l.first_name, l.last_name].filter(Boolean).join(" ") || "—";
            const stage = stagedLeadStage(l, pipeByUrl);
            const initial = (l.first_name || l.company || "?").trim().charAt(0).toUpperCase();
            return (
              <li key={l.linkedin_url} className="flex items-center gap-3 py-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--clay)]/30 bg-[var(--cream)] font-display text-base italic leading-none text-[var(--ink)]">
                  {initial}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-display text-lg italic leading-tight text-[var(--ink)]">{name}</div>
                  <div className="tabular truncate text-[11px] text-[var(--ink)]/50">
                    {[l.title, l.company].filter(Boolean).join(" · ") || "—"}
                  </div>
                </div>
                <span className={`tabular shrink-0 rounded-full border px-2 py-0.5 text-[9px] uppercase tracking-[0.14em] ${STAGE_PILL[stage] ?? STAGE_PILL.Klargjort}`}>
                  {stage}
                </span>
                <a href={l.linkedin_url} target="_blank" rel="noreferrer"
                  className="tabular shrink-0 text-[11px] text-[var(--clay)] hover:underline">LinkedIn ↗</a>
              </li>
            );
          })}
          {stagedLeads.length > 100 ? (
            <li className="py-3">
              <button type="button" onClick={() => onOpenContacts(play.id)}
                className="focus-cream tabular text-[12px] text-[var(--clay)] hover:underline">
                +{stagedLeads.length - 100} flere — åbn Kontakter →
              </button>
            </li>
          ) : null}
        </ul>
      ) : pipe.length > 0 ? (
        <ul className="divide-y divide-[var(--ink)]/10 border-t border-[var(--ink)]/10">
          {pipe.slice(0, 100).map((r) => {
            const name = `${r.lead?.first_name ?? ""} ${r.lead?.last_name ?? ""}`.trim() || r.contact_email || r.sendpilot_lead_id;
            const when = r.last_engagement_at ?? r.last_reply_at ?? r.sent_at ?? r.updated_at;
            return (
              <li key={r.sendpilot_lead_id} className="flex items-baseline gap-3 py-2.5">
                <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--ink)]">{name}</span>
                <span className="max-w-[180px] shrink-0 truncate text-[12px] text-[var(--ink)]/45">{r.lead?.company ?? ""}</span>
                <span className="tabular shrink-0 text-[11px] text-[var(--ink)]/55">{nodeLabel(classifyNode(r), sequences)}</span>
                <span className="tabular w-14 shrink-0 text-right text-[11px] text-[var(--ink)]/40">{flowTimeAgo(when)}</span>
              </li>
            );
          })}
          {pipe.length > 100 ? (
            <li className="py-3">
              <button type="button" onClick={() => onOpenContacts(play.id)}
                className="focus-cream tabular text-[12px] text-[var(--clay)] hover:underline">
                +{pipe.length - 100} flere — åbn Kontakter →
              </button>
            </li>
          ) : null}
        </ul>
      ) : (
        <p className="text-sm text-[var(--ink)]/50">Ingen kontakter i dette play endnu.</p>
      )}
    </div>
  );
}

function buildNavItems(counts: NavCounts, showIcpTabs: boolean): NavItem[] {
  const all: NavItem[] = [
    // Gør nu: I dag is the unified queue; Indbakke (approvals) + Svar (replies)
    // are the rich workflows Louis works in. Opgaver/Signaler were redundant
    // (their items already surface in I dag) — dropped from the nav.
    { id: "i_dag", label: "I dag", count: counts.i_dag, accent: counts.i_dag > 0, group: "Gør nu" },
    { id: "inbox", label: "Indbakke", count: counts.inbox, accent: counts.inbox > 0, group: "Gør nu" },
    { id: "replies", label: "Svar", count: counts.replies, accent: counts.replies > 0, group: "Gør nu" },
    { id: "besog", label: "Besøg", count: counts.besog, accent: counts.besog > 0, group: "Gør nu" },
    // Sendt / Alle / ICP-afvist folded into Kontakter as filter chips.
    { id: "kontakter", label: "Kontakter", count: counts.kontakter, group: "Kontakter" },
    { id: "plays", label: "Plays", count: counts.plays, accent: counts.plays > 0, group: "Indsigt" },
    { id: "flow", label: "Flow", count: counts.flow, group: "Indsigt" },
    { id: "icp", label: "Læring", count: counts.icp_open_proposals, accent: counts.icp_open_proposals > 0, icpOnly: true, group: "Indsigt" },
  ];
  return all.filter((it) => !it.icpOnly || showIcpTabs);
}

// Desktop: vertical sidebar (Lemlist/Instantly pattern). Hidden on mobile,
// where Tabs renders the horizontal grouped bar instead.
function SideNav({ tab, setTab, showIcpTabs, counts }: {
  tab: Tab; setTab: (t: Tab) => void; showIcpTabs: boolean; counts: NavCounts;
}) {
  const items = buildNavItems(counts, showIcpTabs);
  return (
    <nav className="hidden lg:block lg:w-48 lg:shrink-0 lg:sticky lg:top-24 lg:self-start">
      {NAV_GROUP_ORDER.map((g) => {
        const groupItems = items.filter((it) => it.group === g);
        if (!groupItems.length) return null;
        return (
          <div key={g} className="mb-4">
            <div className="tabular mb-1 px-2 text-[9px] uppercase tracking-[0.2em] text-[var(--ink)]/30">{g}</div>
            {groupItems.map((it) => {
              const active = it.id === tab;
              return (
                <button key={it.id} type="button" onClick={() => setTab(it.id)}
                  className={`tabular flex w-full items-baseline justify-between gap-2 rounded-md px-2 py-1.5 text-[12px] uppercase tracking-[0.14em] transition ${
                    active ? "bg-[var(--sand)]/60 text-[var(--ink)] font-semibold" : "text-[var(--ink)]/50 hover:bg-[var(--sand)]/30 hover:text-[var(--ink)]/80"
                  }`}>
                  <span className="truncate">{it.label}</span>
                  <span className={`tabular text-[10px] ${it.accent ? "text-[var(--clay)]" : "text-[var(--ink)]/40"}`}>{it.count}</span>
                </button>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

function Tabs({ tab, setTab, showIcpTabs, counts }: {
  tab: Tab; setTab: (t: Tab) => void; showIcpTabs: boolean; counts: NavCounts;
}) {
  const items = buildNavItems(counts, showIcpTabs);
  return (
    <nav className="mb-4 lg:hidden">
      <div className="flex items-stretch overflow-x-auto border-b border-[var(--ink)]/10">
        {NAV_GROUP_ORDER.map((g, gi) => {
          const groupItems = items.filter((it) => it.group === g);
          if (!groupItems.length) return null;
          return (
            <div key={g} className="flex items-center">
              {gi > 0 ? <span className="mx-2 h-4 w-px self-center bg-[var(--ink)]/15" aria-hidden /> : null}
              <span className="tabular mr-1 self-center whitespace-nowrap text-[9px] uppercase tracking-[0.2em] text-[var(--ink)]/30">{g}</span>
              {groupItems.map((it) => {
                const active = it.id === tab;
                return (
                  <button key={it.id} type="button" onClick={() => setTab(it.id)}
                    className={`relative tabular flex items-baseline gap-1.5 whitespace-nowrap px-3 py-2 text-[12px] uppercase tracking-[0.22em] transition ${
                      active ? "text-[var(--ink)] font-semibold" : "text-[var(--ink)]/50 hover:text-[var(--ink)]/80"
                    }`}>
                    <span>{it.label}</span>
                    <span className={`tabular text-[10px] ${it.accent ? "text-[var(--clay)]" : "text-[var(--ink)]/40"}`}>
                      {it.count}
                    </span>
                    {active ? <span className="absolute inset-x-0 -bottom-px h-[2px] bg-[var(--clay)]" /> : null}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </nav>
  );
}

function PendingTab(props: {
  rows: PipelineRow[];
  selected: Set<string>; setSelected: (s: Set<string>) => void;
  filters: { company: string; role: string; cold: ColdFilter };
  setFilters: { setCompany: (v: string) => void; setRole: (v: string) => void; setCold: (v: ColdFilter) => void };
  sortKey: SortKey; setSortKey: (s: SortKey) => void;
  playing: Set<string>; setPlaying: (s: Set<string>) => void;
  editing: { leadId: string; message: string } | null;
  setEditing: (e: { leadId: string; message: string } | null) => void;
  busyLead: string | null;
  onApproveOne: (r: PipelineRow) => void;
  onRejectOne: (r: PipelineRow) => void;
  onBulkApprove: () => void; onBulkReject: () => void;
}) {
  const { rows, selected, setSelected, filters, setFilters, sortKey, setSortKey,
    playing, setPlaying, editing, setEditing, busyLead, onApproveOne, onRejectOne, onBulkApprove, onBulkReject } = props;

  function toggleSel(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  }

  function togglePlay(id: string) {
    const next = new Set(playing);
    if (next.has(id)) next.delete(id); else next.add(id);
    setPlaying(next);
  }

  return (
    <>
      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-3 border-b border-[var(--ink)]/10 pb-3">
        <label className="flex flex-col gap-1">
          <span className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/45">Firma</span>
          <input
            value={filters.company}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setFilters.setCompany(e.target.value)}
            placeholder="Filtrér…"
            className="focus-cream tabular w-40 rounded-sm border border-[var(--ink)]/15 bg-transparent px-2 py-1.5 text-[12px] text-[var(--ink)] outline-none placeholder:text-[var(--ink)]/30 focus:border-[var(--ink)]/35"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/45">Titel</span>
          <input
            value={filters.role}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setFilters.setRole(e.target.value)}
            placeholder="Filtrér…"
            className="focus-cream tabular w-40 rounded-sm border border-[var(--ink)]/15 bg-transparent px-2 py-1.5 text-[12px] text-[var(--ink)] outline-none placeholder:text-[var(--ink)]/30 focus:border-[var(--ink)]/35"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/45">Type</span>
          <select
            value={filters.cold}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => setFilters.setCold(e.target.value as ColdFilter)}
            className="focus-cream tabular rounded-sm border border-[var(--ink)]/15 bg-transparent px-2 py-1.5 text-[12px] text-[var(--ink)] outline-none focus:border-[var(--ink)]/35"
          >
            <option value="all">Alle</option>
            <option value="cold">Kun kolde</option>
            <option value="warm">Kun forbundne</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/45">Sortér</span>
          <select
            value={sortKey}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => setSortKey(e.target.value as SortKey)}
            className="focus-cream tabular rounded-sm border border-[var(--ink)]/15 bg-transparent px-2 py-1.5 text-[12px] text-[var(--ink)] outline-none focus:border-[var(--ink)]/35"
          >
            <option value="queued_oldest">Ældste først</option>
            <option value="queued_newest">Nyeste først</option>
            <option value="name">Efter navn</option>
          </select>
        </label>

        <div className="ml-auto flex items-center gap-2">
          <span className="tabular text-[11px] text-[var(--ink)]/55">{selected.size} valgt</span>
          <button type="button" disabled={selected.size === 0} onClick={onBulkReject}
            className="focus-cream tabular rounded-sm border border-[var(--clay)]/40 px-3 py-1.5 text-[11px] uppercase tracking-[0.22em] text-[var(--clay)] hover:bg-[var(--clay)]/5 disabled:opacity-30">
            Afvis valgte
          </button>
          <button type="button" disabled={selected.size === 0} onClick={onBulkApprove}
            className="focus-orange tabular rounded-sm bg-[var(--forest)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--cream)] hover:bg-[#2f5e4e] disabled:opacity-40">
            Godkend valgte
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="tabular py-12 text-center text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/35">
          Ingen ventende beskeder lige nu.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {rows.map((r) => {
            const isEditing = editing?.leadId === r.sendpilot_lead_id;
            const message = isEditing ? editing.message : r.rendered_message ?? "";
            const isSelected = selected.has(r.sendpilot_lead_id);
            const isPlaying = playing.has(r.sendpilot_lead_id);
            return (
              <li key={r.sendpilot_lead_id}
                className={`rounded-sm border bg-[var(--cream)]/40 p-4 sm:p-6 transition ${
                  isSelected ? "border-[var(--forest)]/60" : "border-[var(--ink)]/12"
                }`}>
                <div className="flex items-start gap-3">
                  <label className="mt-1 inline-flex cursor-pointer items-center">
                    <input type="checkbox" checked={isSelected}
                      onChange={() => toggleSel(r.sendpilot_lead_id)}
                      className="h-4 w-4 cursor-pointer accent-[var(--forest)]" />
                  </label>

                  <div className="flex flex-1 flex-wrap gap-4">
                    {/* video preview / thumbnail — only for video-render clients.
                        AI-drafted clients (OdaGroup, message_strategy != null)
                        skip this block. Tresyv text arms (first_dm_variant =
                        v1_long / v2_short) also skip — they're text-only DMs
                        with no video, so the empty "Video mangler" placeholder
                        was wasted real estate squeezing the body. */}
                    {(r.message_strategy
                      || r.first_dm_variant === "v1_long"
                      || r.first_dm_variant === "v2_short") ? null : (
                    <div className="w-full sm:w-[280px] shrink-0">
                      {r.embed_link ? (
                        isPlaying ? (
                          <div className="aspect-video overflow-hidden rounded-sm border border-[var(--ink)]/15 bg-black">
                            <iframe src={r.embed_link} allow="autoplay; fullscreen"
                              className="h-full w-full" />
                          </div>
                        ) : (
                          <button type="button" onClick={() => togglePlay(r.sendpilot_lead_id)}
                            className="group relative block aspect-video w-full overflow-hidden rounded-sm border border-[var(--ink)]/15 bg-[var(--ink)]/5">
                            {r.thumbnail_url ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={r.thumbnail_url} alt="Video preview"
                                className="h-full w-full object-cover" />
                            ) : (
                              <div className="flex h-full items-center justify-center text-[var(--ink)]/30 text-xs">Video</div>
                            )}
                            <div className="absolute inset-0 flex items-center justify-center bg-black/15 transition group-hover:bg-black/25">
                              <div className="rounded-full bg-white/90 p-3 shadow">
                                <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"
                                  className="text-[var(--ink)]"><path d="M5 4l11 6L5 16z" /></svg>
                              </div>
                            </div>
                          </button>
                        )
                      ) : (
                        <div className="aspect-video rounded-sm border border-dashed border-[var(--ink)]/15 bg-[var(--ink)]/5 flex items-center justify-center text-[11px] text-[var(--ink)]/40">
                          Video mangler
                        </div>
                      )}
                    </div>
                    )}

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <div className="font-display text-2xl italic leading-tight tracking-tight text-[var(--ink)]">
                          {r.lead?.first_name} {r.lead?.last_name}
                        </div>
                        <div className="flex items-center gap-2">
                          {r.message_strategy ? (
                            <span
                              title={r.message_strategy_rationale ?? r.message_strategy}
                              className="tabular inline-block rounded-sm px-2 py-0.5 text-[10px] uppercase tracking-[0.18em]"
                              style={{ background: "rgba(35,90,67,0.10)", color: "var(--forest)" }}>
                              {STRATEGY_LABELS[r.message_strategy]}
                              {r.message_language ? ` · ${r.message_language}` : ""}
                            </span>
                          ) : null}
                          {r.is_cold === false ? <Pill kind="warm" label="forbundet" /> : null}
                          {r.is_cold === true ? <Pill kind="cold" label="kold" /> : null}
                        </div>
                      </div>
                      <div className="tabular mt-0.5 text-[12px] text-[var(--ink)]/60">
                        {r.lead?.company}
                        {" · "}
                        <a href={r.linkedin_url} target="_blank" rel="noreferrer"
                          className="underline underline-offset-2 hover:text-[var(--ink)]">LinkedIn ↗</a>
                        {r.video_link ? <>
                          {" · "}
                          <a href={r.video_link} target="_blank" rel="noreferrer"
                            className="underline underline-offset-2 hover:text-[var(--ink)]">Video ↗</a>
                        </> : null}
                      </div>
                      <div className="tabular mt-0.5 text-[11px] text-[var(--ink)]/40">
                        Køet {fmtRelative(r.queued_at ?? r.rendered_at)}{r.lead?.title ? ` · ${r.lead.title.slice(0, 80)}` : ""}
                      </div>
                      {r.message_strategy_rationale ? (
                        <div className="tabular mt-1 text-[11px] italic text-[var(--ink)]/45">
                          AI: {r.message_strategy_rationale}
                        </div>
                      ) : null}
                      {r.hook_bucket ? (
                        <div className="tabular mt-1 text-[11px] text-[var(--ink)]/45">
                          <span className="rounded-sm bg-[var(--ink)]/8 px-1.5 py-0.5 font-medium text-[var(--ink)]/65">
                            {r.hook_bucket === "1" ? "Eget opslag"
                              : r.hook_bucket === "2" ? "Engageret"
                              : r.hook_bucket === "3" ? "Profiltekst"
                              : r.hook_bucket === "5" ? "Baggrund"
                              : r.hook_bucket === "6" ? "Virksomhed"
                              : "Standard"}
                          </span>
                          {r.hook_context ? <span className="ml-1.5 italic">{r.hook_context}</span> : null}
                        </div>
                      ) : null}
                      {r.personalized_hook ? (
                        <div className="mt-1 border-l-2 border-[var(--ink)]/15 pl-2 text-[12px] leading-relaxed text-[var(--ink)]/70">
                          {r.personalized_hook}
                        </div>
                      ) : null}

                      <textarea
                        value={message}
                        onChange={(e) => setEditing({ leadId: r.sendpilot_lead_id, message: e.target.value })}
                        rows={Math.max(6, message.split("\n").length + 1)}
                        className="focus-cream mt-3 w-full resize-y rounded-sm border border-[var(--ink)]/12 bg-[var(--sand)] p-3 text-sm leading-relaxed text-[var(--ink)] outline-none focus:border-[var(--ink)]/35"
                      />

                      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                        <button type="button" disabled={busyLead === r.sendpilot_lead_id}
                          onClick={() => onRejectOne(r)}
                          className="focus-cream tabular rounded-sm border border-[var(--clay)]/40 px-4 py-2 text-[11px] uppercase tracking-[0.22em] text-[var(--clay)] hover:bg-[var(--clay)]/5 disabled:opacity-40">
                          Afvis
                        </button>
                        <button type="button" disabled={busyLead === r.sendpilot_lead_id}
                          onClick={() => onApproveOne(r)}
                          className="focus-orange tabular rounded-sm bg-[var(--forest)] px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--cream)] hover:bg-[#2f5e4e] disabled:opacity-50">
                          {busyLead === r.sendpilot_lead_id ? "Sender…" : "Godkend & send"}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function AcceptedTab({ rows, busyLead, onRender, onReject }: {
  rows: PipelineRow[];
  busyLead: string | null;
  onRender: (leadId: string) => void;
  onReject: (row: PipelineRow) => void;
}) {
  if (rows.length === 0) {
    return (
      <p className="mt-4 text-sm text-[var(--ink)]/45">
        Ingen accepterede leads venter på en video. Når en lead på SendPilot accepterer
        connection-requesten lander de her, så du kan godkende video-render før SendSpark bruger credits.
      </p>
    );
  }
  return (
    <ul className="mt-4 flex flex-col gap-3">
      {rows.map((r) => {
        const canRender = r.status === "pending_pre_render" || r.status === "failed" || r.status === "invited" || r.status === "accepted";
        const renderLabel = r.status === "failed" ? "Retry render" : "Godkend render";
        return (
          <li key={r.sendpilot_lead_id}
            className="rounded-sm border border-[var(--ink)]/12 bg-[var(--cream)]/40 p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-display text-xl italic leading-tight tracking-tight text-[var(--ink)]">
                  {r.lead?.first_name} {r.lead?.last_name}
                </div>
                <div className="tabular mt-0.5 text-[12px] text-[var(--ink)]/55">
                  {r.lead?.company}
                  {" · "}
                  <a href={r.linkedin_url} target="_blank" rel="noreferrer"
                    className="underline underline-offset-2 hover:text-[var(--ink)]">LinkedIn ↗</a>
                  {" · accepted "}{fmtRelative(r.accepted_at)}
                </div>
                <div className="tabular mt-0.5 text-[11px] text-[var(--ink)]/40">
                  {r.lead?.title?.slice(0, 100)}
                </div>
                {r.error ? (
                  <p className="tabular mt-2 text-[11px] italic text-[var(--clay)]">{r.error}</p>
                ) : null}
              </div>
              <div className="flex flex-shrink-0 items-center gap-2">
                <StatusPill status={r.status} />
                {canRender ? (
                  <>
                    <button type="button" disabled={busyLead === r.sendpilot_lead_id}
                      onClick={() => onReject(r)}
                      className="focus-cream tabular rounded-sm border border-[var(--clay)]/40 px-4 py-2 text-[11px] uppercase tracking-[0.22em] text-[var(--clay)] hover:bg-[var(--clay)]/5 disabled:opacity-40">
                      Afvis
                    </button>
                    <button type="button" disabled={busyLead === r.sendpilot_lead_id}
                      onClick={() => onRender(r.sendpilot_lead_id)}
                      className="focus-orange tabular rounded-sm bg-[var(--forest)] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--cream)] hover:bg-[#2f5e4e] disabled:opacity-50">
                      {busyLead === r.sendpilot_lead_id ? "Renderer…" : renderLabel}
                    </button>
                  </>
                ) : (
                  <span className="tabular text-[11px] text-[var(--ink)]/45">Render i gang…</span>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// "I dag" — the unified action queue. Renders rows from vw_action_queue,
// already sorted server-side by priority_score desc then surfaced_at desc.
// Each row is one thing to act on today. Clicking "Gå til" jumps to the tab
// that actually performs the action; rows with a phone get inline outcome
// buttons so you can run a call-sprint without leaving the queue.
function IDagTab({ queue, onJumpTo, onCallOutcome, onDraftEmail, onMarkEmailSent }: {
  queue: ActionQueueRow[];
  onJumpTo: (t: Tab) => void;
  onCallOutcome: (leadId: string, outcome: CallOutcome, callbackAt?: string) => void;
  onDraftEmail: (leadId: string) => Promise<EmailDraft | null>;
  onMarkEmailSent: (emailDraftId: string) => void;
}) {
  if (queue.length === 0) {
    return (
      <div className="mt-8 rounded-lg border border-[var(--ink)]/10 bg-[var(--paper)]/60 p-8 text-center text-[var(--ink)]/60">
        Intet at handle på lige nu. Indbakken er tom og ingen åbne signaler.
      </div>
    );
  }

  const tabForKind: Record<ActionQueueRow["kind"], Tab> = {
    reply: "replies",
    approval: "inbox",
    referral: "replies",
    signal: "signaler",
    call: "i_dag",
    email: "i_dag",
  };

  const kindLabel: Record<ActionQueueRow["kind"], string> = {
    reply: "SVAR",
    approval: "GODKEND",
    referral: "HENVIST",
    signal: "SIGNAL",
    call: "RING",
    email: "EMAIL",
  };

  const kindColor: Record<ActionQueueRow["kind"], string> = {
    reply: "bg-[var(--clay)]/15 text-[var(--clay)]",
    approval: "bg-[var(--forest)]/15 text-[var(--forest)]",
    referral: "bg-[var(--ink)]/10 text-[var(--ink)]/80",
    signal: "bg-[var(--ink)]/10 text-[var(--ink)]/80",
    call: "bg-[var(--clay)]/20 text-[var(--clay)]",
    email: "bg-[var(--forest)]/15 text-[var(--forest)]",
  };

  function subkindLabel(row: ActionQueueRow): string {
    if (row.kind === "reply") {
      return row.subkind === "draft_ready" ? "udkast klar" : "kræver svar";
    }
    if (row.kind === "approval") {
      return row.subkind === "approve_send" ? "klar til send" : "video renderer";
    }
    if (row.kind === "referral") {
      return row.subkind === "find_linkedin" ? "find LinkedIn" : "send invite";
    }
    if (row.kind === "call") {
      const map: Record<string, string> = {
        new_accept: "ny accept",
        no_answer: "intet svar",
        left_voicemail: "lagt voicemail",
        answered: "talt med",
        callback: "callback",
        interested: "interesseret",
      };
      return map[row.subkind] ?? row.subkind;
    }
    if (row.kind === "email") {
      return row.subkind === "draft_ready" ? "udkast klar" : "skriv email";
    }
    return row.subkind;
  }

  function timeAgo(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}t`;
    const days = Math.floor(hrs / 24);
    return `${days}d`;
  }

  function formatPhone(raw: string): string {
    // +4520935087 → +45 20 93 50 87 for readability. Falls back to raw for
    // non-DK or non-standard lengths.
    const digits = raw.replace(/[^\d+]/g, "");
    const dk = digits.match(/^(\+45)(\d{2})(\d{2})(\d{2})(\d{2})$/);
    if (dk) return `${dk[1]} ${dk[2]} ${dk[3]} ${dk[4]} ${dk[5]}`;
    return digits;
  }

  return (
    <ul className="mt-4 space-y-2">
      {queue.map((row) => (
        <li
          key={row.id}
          className="flex items-start gap-4 rounded-lg border border-[var(--ink)]/10 bg-[var(--paper)]/40 px-4 py-3 transition hover:bg-[var(--paper)]/70"
        >
          <div className="flex w-16 shrink-0 flex-col items-start gap-1">
            <span className={`rounded px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] ${kindColor[row.kind]}`}>
              {kindLabel[row.kind]}
            </span>
            <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--ink)]/40">
              {timeAgo(row.surfaced_at)}
            </span>
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="font-semibold text-[var(--ink)]">
                {row.contact_name ?? "Ukendt"}
              </span>
              {row.company ? (
                <span className="text-[12px] text-[var(--ink)]/60">@ {row.company}</span>
              ) : null}
              {row.title ? (
                <span className="text-[11px] text-[var(--ink)]/40">· {row.title}</span>
              ) : null}
            </div>
            <p className="mt-1 line-clamp-2 text-[13px] text-[var(--ink)]/75 whitespace-pre-wrap">
              {row.snippet}
            </p>
            <div className="mt-1 flex items-center gap-3 text-[10px] uppercase tracking-[0.18em] text-[var(--ink)]/45">
              <span>{subkindLabel(row)}</span>
              {row.intent ? <span>· intent: {row.intent}</span> : null}
              <span>· score {row.priority_score}</span>
              {row.phone_direct ? (
                <span className="text-[var(--clay)]">· <IconPhone className="mx-0.5" />{formatPhone(row.phone_direct)}</span>
              ) : row.phone_office ? (
                <span className="text-[var(--ink)]/35">· <IconPhone className="mx-0.5" />kontor {formatPhone(row.phone_office)}</span>
              ) : null}
            </div>
          </div>

          <div className="flex shrink-0 flex-col gap-1.5 min-w-[180px]">
            {row.kind === "email" && row.ref_lead_id ? (
              <EmailActionBar row={row} onDraft={onDraftEmail} onSent={onMarkEmailSent} />
            ) : null}
            {(row.phone_direct || row.phone_office) && row.ref_lead_id && row.kind !== "email" ? (
              <>
                <a
                  href={`tel:${row.phone_direct || row.phone_office}`}
                  className="rounded border border-[var(--clay)]/40 bg-[var(--clay)]/10 px-3 py-1.5 text-center text-[11px] uppercase tracking-[0.22em] text-[var(--clay)] hover:bg-[var(--clay)]/20"
                >
<IconPhone className="mr-1.5" />Ring
                </a>
                <CallOutcomeBar
                  leadId={row.ref_lead_id}
                  onOutcome={onCallOutcome}
                />
              </>
            ) : null}
            {row.kind !== "call" && row.kind !== "email" ? (
              <button
                type="button"
                onClick={() => onJumpTo(tabForKind[row.kind])}
                className="rounded border border-[var(--ink)]/20 px-3 py-1.5 text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/70 hover:bg-[var(--ink)]/5"
              >
                Gå til →
              </button>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

// EmailActionBar — two states. needs_draft shows a "Skriv email" button that
// calls outreach-ai draft_email → fetches subject/body/strategy → opens
// mailto: with body pre-filled. draft_ready shows subject + an "Åbn i mail"
// button (re-opens the same mailto) + "Markér sendt" to stamp sent_at.
function EmailActionBar({ row, onDraft, onSent }: {
  row: ActionQueueRow;
  onDraft: (leadId: string) => Promise<EmailDraft | null>;
  onSent: (emailDraftId: string) => void;
}) {
  const [draft, setDraft] = useState<EmailDraft | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleDraft() {
    if (!row.ref_lead_id) return;
    setBusy(true);
    const d = await onDraft(row.ref_lead_id);
    setBusy(false);
    if (d) {
      setDraft(d);
      // Auto-open mailto so the user can review + send immediately
      const href = mailtoHrefFromDraft(d);
      if (typeof window !== "undefined") window.location.href = href;
    }
  }

  function openMailto() {
    if (!draft) return;
    const href = mailtoHrefFromDraft(draft);
    if (typeof window !== "undefined") window.location.href = href;
  }

  function markSent() {
    if (!draft) return;
    onSent(draft.id);
  }

  if (draft) {
    return (
      <>
        <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--forest)]/70">
          {draft.strategy} · {draft.language}
        </div>
        <button
          type="button"
          onClick={openMailto}
          className="rounded border border-[var(--forest)]/40 bg-[var(--forest)]/10 px-3 py-1.5 text-center text-[11px] uppercase tracking-[0.22em] text-[var(--forest)] hover:bg-[var(--forest)]/20"
        >
<IconMail className="mr-1.5" />Åbn i mail
        </button>
        <button
          type="button"
          onClick={markSent}
          className="rounded border border-[var(--ink)]/20 px-3 py-1.5 text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/70 hover:bg-[var(--ink)]/5"
        >
          ✓ Markér sendt
        </button>
      </>
    );
  }

  return (
    <button
      type="button"
      onClick={handleDraft}
      disabled={busy}
      className="rounded border border-[var(--forest)]/40 bg-[var(--forest)]/10 px-3 py-1.5 text-center text-[11px] uppercase tracking-[0.22em] text-[var(--forest)] hover:bg-[var(--forest)]/20 disabled:opacity-60"
    >
      <IconPen className="mr-1.5" />{busy ? "Skriver…" : "Skriv email"}
    </button>
  );
}

function mailtoHrefFromDraft(d: EmailDraft): string {
  const q = `subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body)}`;
  return `mailto:${d.to}?${q}`;
}

// Compact outcome bar shown next to the Ring button. First click logs a
// terminal outcome — re-clicking after the row has updated lets you bump
// between states. "Callback" prompts for a number of hours (clamped to
// business hours via clampToBusinessHours so 22:00 → 09:00 next day).
function CallOutcomeBar({ leadId, onOutcome }: {
  leadId: string;
  onOutcome: (leadId: string, outcome: CallOutcome, callbackAt?: string) => void;
}) {
  function handleCallback() {
    const raw = window.prompt("Ring tilbage om hvor mange timer? (fx 24 = i morgen)", "24");
    if (!raw) return;
    const hours = parseFloat(raw);
    if (!Number.isFinite(hours) || hours <= 0) return;
    const requested = new Date(Date.now() + hours * 3600_000).toISOString();
    const clamped = clampToBusinessHours(requested);
    onOutcome(leadId, "callback", clamped);
  }
  return (
    <div className="flex flex-wrap gap-1">
      <OutcomeChip label="Intet svar" onClick={() => onOutcome(leadId, "no_answer")} />
      <OutcomeChip label="VM lagt" onClick={() => onOutcome(leadId, "left_voicemail")} />
      <OutcomeChip label="Talt" onClick={() => onOutcome(leadId, "answered")} />
      <OutcomeChip label="Callback" onClick={handleCallback} />
      <OutcomeChip label="Ikke rel." onClick={() => onOutcome(leadId, "not_interested")} muted />
      <OutcomeChip label="Booked" onClick={() => onOutcome(leadId, "booked")} forest />
    </div>
  );
}

function OutcomeChip({ label, onClick, muted, forest }: {
  label: string;
  onClick: () => void;
  muted?: boolean;
  forest?: boolean;
}) {
  const cls = forest
    ? "border-[var(--forest)]/40 bg-[var(--forest)]/10 text-[var(--forest)] hover:bg-[var(--forest)]/20"
    : muted
    ? "border-[var(--ink)]/15 bg-[var(--ink)]/5 text-[var(--ink)]/50 hover:bg-[var(--ink)]/10"
    : "border-[var(--ink)]/20 text-[var(--ink)]/70 hover:bg-[var(--ink)]/5";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.18em] ${cls}`}
    >
      {label}
    </button>
  );
}

function OpgaverTab({ tasks, onMarkHandled }: {
  tasks: Reply[];
  onMarkHandled: (id: string) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (tasks.length === 0) {
    return (
      <p className="mt-12 text-center tabular text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/35">
        Ingen opgaver lige nu. Alle replies er behandlet eller markeret som done.
      </p>
    );
  }

  function bucketPill(bucket: string | undefined) {
    if (bucket === "high") return { label: "Nu", cls: "border-[var(--clay)]/40 bg-[var(--clay)]/10 text-[var(--clay)]" };
    if (bucket === "medium") return { label: "Medium", cls: "border-[var(--ink)]/25 bg-[var(--ink)]/5 text-[var(--ink)]/70" };
    if (bucket === "low") return { label: "Lav", cls: "border-[var(--ink)]/15 text-[var(--ink)]/45" };
    return { label: "—", cls: "border-[var(--ink)]/10 text-[var(--ink)]/40" };
  }

  function fmtDue(iso: string | null): string | null {
    if (!iso) return null;
    const due = new Date(iso);
    const now = new Date();
    const sameDay = due.toDateString() === now.toDateString();
    const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
    const isTomorrow = due.toDateString() === tomorrow.toDateString();
    const time = due.toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" });
    if (sameDay) return `I dag ${time}`;
    if (isTomorrow) return `I morgen ${time}`;
    return due.toLocaleDateString("da-DK", { day: "numeric", month: "short" }) + " " + time;
  }

  function dueIsPast(iso: string | null): boolean {
    if (!iso) return false;
    return new Date(iso).getTime() < Date.now();
  }

  return (
    <ul className="mt-2 flex flex-col gap-2">
      {tasks.map((t) => {
        const bucket = (t.triage_signals as Record<string, unknown> | null)?.["priority_bucket"] as string | undefined;
        const pill = bucketPill(bucket);
        const due = fmtDue(t.scheduled_followup_at);
        const past = dueIsPast(t.scheduled_followup_at);
        const expanded = expandedId === t.id;
        const name = `${t.lead?.first_name ?? ""} ${t.lead?.last_name ?? ""}`.trim() || "(ukendt)";
        const company = t.lead?.company;
        const hasDraft = !!t.triage_draft;

        return (
          <li key={t.id}
            className={`group rounded-sm border bg-[var(--cream)]/30 transition ${
              past ? "border-[var(--clay)]/45" : "border-[var(--ink)]/12"
            }`}>
            <button type="button" onClick={() => setExpandedId(expanded ? null : t.id)}
              className="flex w-full items-start gap-3 px-4 py-3 text-left sm:px-5">
              <span className={`tabular shrink-0 rounded-full border px-2 py-0.5 text-[9px] uppercase tracking-[0.22em] ${pill.cls}`}>
                {pill.label}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] leading-snug text-[var(--ink)]/90">
                  {t.triage_action ?? <em className="text-[var(--ink)]/45">(ingen opgave-tekst — venter på AI)</em>}
                </div>
                <div className="tabular mt-1 text-[11px] text-[var(--ink)]/55">
                  <span className="font-medium text-[var(--ink)]/70">{name}</span>
                  {company ? <span> · {company}</span> : null}
                  {due ? (
                    <span className={past ? "ml-2 text-[var(--clay)]" : "ml-2 text-[var(--ink)]/65"}>
                      · {due}
                    </span>
                  ) : null}
                  {hasDraft ? <span className="ml-2 text-[var(--forest)]">· udkast klar</span> : null}
                </div>
              </div>
              <span className="tabular shrink-0 self-center text-[10px] text-[var(--ink)]/35">
                {expanded ? "−" : "+"}
              </span>
            </button>

            {expanded ? (
              <div className="border-t border-[var(--ink)]/8 px-4 py-3 sm:px-5">
                <p className="text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/45">Original besked</p>
                <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--ink)]/75">{t.message}</p>

                {t.triage_draft ? (
                  <>
                    <p className="mt-4 text-[10px] uppercase tracking-[0.22em] text-[var(--forest)]">Udkast til svar</p>
                    <div className="mt-1 rounded-sm border border-[var(--forest)]/20 bg-[var(--forest)]/5 p-3">
                      <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--ink)]/90">{t.triage_draft}</p>
                      <button type="button" onClick={() => { navigator.clipboard?.writeText(t.triage_draft ?? ""); }}
                        className="focus-cream mt-3 tabular rounded-sm border border-[var(--forest)]/30 px-2.5 py-1 text-[10px] uppercase tracking-[0.22em] text-[var(--forest)] hover:border-[var(--forest)]/60">
                        Kopiér udkast
                      </button>
                    </div>
                  </>
                ) : null}

                <div className="mt-4 flex flex-wrap gap-2">
                  <a href={t.linkedin_url} target="_blank" rel="noreferrer"
                    className="tabular text-[11px] uppercase tracking-[0.22em] text-[var(--forest)] underline-offset-[6px] hover:underline">
                    Åbn LinkedIn ↗
                  </a>
                  <button type="button" onClick={() => onMarkHandled(t.id)}
                    className="focus-cream tabular rounded-sm border border-[var(--ink)]/15 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/65 hover:border-[var(--ink)]/35 hover:text-[var(--ink)]">
                    Skjul
                  </button>
                </div>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function SignalerTab({ signals, busyLead, identity, leadMatches, altContacts, onMarkHandled, onScoutPhones, onSearchPeople }: {
  signals: Signal[];
  busyLead: string | null;
  identity: Identity;
  leadMatches: Record<string, SignalLeadMatch[]>;
  altContacts: AltContact[];
  onMarkHandled: (ids: string[]) => void;
  onScoutPhones: (id: string) => void;
  onSearchPeople: (id: string) => void;
}) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  if (signals.length === 0) {
    return (
      <p className="mt-12 text-center tabular text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/35">
        Ingen signaler endnu. Når RB2B identificerer en besøgende, lander de her.
      </p>
    );
  }

  function fmtWhen(iso: string): string {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" });
    if (sameDay) return `I dag ${time}`;
    const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return `I går ${time}`;
    return d.toLocaleDateString("da-DK", { day: "numeric", month: "short" }) + " " + time;
  }

  // Group signals by company so multiple visits from the same prospect collapse
  // into a single card with a visit timeline. Key prefers company_name, falls
  // back to company_domain so missing-name rows still group correctly.
  type CompanyGroup = {
    key: string;
    companyName: string;
    companyDomain: string | null;
    companyLinkedinUrl: string | null;
    companyIndustry: string | null;
    companySize: string | null;
    companyRevenue: string | null;
    location: string | null;
    visits: Signal[];          // sorted desc
    totalPageViews: number;     // sum of count across visits
    lastVisitAt: string;
    inPipeline: boolean;       // future: lead-matching lookup
    latestPersonName: string | null;
    latestPersonEmail: string | null;
    latestPersonLinkedinUrl: string | null;
    // Phone fields derived from the latest signal that has been scouted
    phoneDirect: string | null;
    phoneOffice: string | null;
    phoneSource: string | null;
    phoneScoutedAt: string | null;
    latestId: string;
    // SendPilot alt-contact search state — derived from the most-recent
    // visit that has an alt_search_id set.
    altSearchStatus: "pending" | "completed" | "empty" | "failed" | null;
    altContactsForCompany: AltContact[];
    // Velocity-weighted recency score for sorting hot prospects to the top.
    // Higher = more pageviews packed into less time + more recent.
    heatScore: number;
    // Plain-Danish velocity description for the meta line ("5 sider på 12 min",
    // "3 sider i dag", "2 sider · 8 dage"). Hides the magic number behind a
    // human-readable cue.
    velocityLabel: string;
    firstVisitAt: string;
  };

  const groups: CompanyGroup[] = (() => {
    const map = new Map<string, Signal[]>();
    for (const s of signals) {
      const key = (s.company_name ?? s.company_domain ?? s.id).toLowerCase();
      const list = map.get(key) ?? [];
      list.push(s);
      map.set(key, list);
    }
    return Array.from(map.entries()).map(([key, list]) => {
      const sorted = [...list].sort((a, b) =>
        new Date(b.identified_at).getTime() - new Date(a.identified_at).getTime(),
      );
      const latest = sorted[0];
      const pickNonNull = <K extends keyof Signal>(k: K): Signal[K] | null => {
        for (const s of sorted) {
          const v = s[k];
          if (v !== null && v !== undefined && v !== "") return v;
        }
        return null;
      };
      const totalPageViews = sorted.reduce((acc, s) => {
        const pv = s.page_views as Array<{ count?: number }> | null;
        if (!pv) return acc;
        return acc + pv.reduce((sum, p) => sum + (p.count ?? 1), 0);
      }, 0);
      // Phone fields: use the most-recently-scouted signal across the group
      const scouted = sorted.find((s) => s.phone_scouted_at !== null);
      const geo = latest.geo as { raw?: string; city?: string; country?: string } | null;
      const location = geo?.raw ?? ([geo?.city, geo?.country].filter(Boolean).join(", ") || null);
      // Alt-search state — pick the latest signal that has any search activity.
      const visitIds = new Set(sorted.map((s) => s.id));
      const altContactsForCompany = altContacts.filter(
        (ac) => ac.signal_id !== null && visitIds.has(ac.signal_id),
      );
      const searchedVisit = sorted.find((s) => s.alt_search_status !== null);
      const altSearchStatus = searchedVisit?.alt_search_status ?? null;

      // Velocity: how many pageviews compressed into how short a window. Hot
      // prospects load /pricing and /demo in the same session; cold ones drift
      // back once a week. Score = pageviews per hour over the visit window,
      // capped so a single super-old visit doesn't dominate. Recency boost so
      // a fresh signal beats a stale one with the same density.
      const firstVisitAt = sorted[sorted.length - 1].identified_at;
      const firstMs = new Date(firstVisitAt).getTime();
      const lastMs = new Date(latest.identified_at).getTime();
      const windowHours = Math.max(0.25, (lastMs - firstMs) / 3_600_000);
      const viewsPerHour = totalPageViews / windowHours;
      const hoursSinceLast = Math.max(0.1, (Date.now() - lastMs) / 3_600_000);
      const recencyMultiplier = 1 / Math.log2(hoursSinceLast + 2); // ~1 if just now, ~0.3 a week out
      const heatScore = viewsPerHour * recencyMultiplier;

      const velocityLabel = (() => {
        const minutes = Math.round((lastMs - firstMs) / 60_000);
        const pv = totalPageViews;
        const pvWord = `${pv} side${pv === 1 ? "" : "r"}`;
        if (pv === 1) return `1 side · ${fmtWhen(latest.identified_at).toLowerCase()}`;
        if (minutes < 60) return `${pvWord} på ${minutes || "<1"} min`;
        const hours = Math.round(minutes / 60);
        if (hours < 24) return `${pvWord} på ${hours} t`;
        const days = Math.round(hours / 24);
        return `${pvWord} · ${days} ${days === 1 ? "dag" : "dage"}`;
      })();

      return {
        key,
        companyName: (latest.company_name ?? latest.company_domain ?? "(ukendt firma)") as string,
        companyDomain: latest.company_domain,
        companyLinkedinUrl: latest.payload && (latest.payload as { company_linkedin_url?: string }).company_linkedin_url
          ? (latest.payload as { company_linkedin_url?: string }).company_linkedin_url!
          : null,
        companyIndustry: pickNonNull("company_industry") as string | null,
        companySize: pickNonNull("company_size") as string | null,
        companyRevenue: (latest.payload as { company_revenue?: string } | null)?.company_revenue ?? null,
        location,
        visits: sorted,
        totalPageViews,
        lastVisitAt: latest.identified_at,
        inPipeline: false,
        latestPersonName: pickNonNull("person_name") as string | null,
        latestPersonEmail: pickNonNull("person_email") as string | null,
        latestPersonLinkedinUrl: pickNonNull("person_linkedin_url") as string | null,
        phoneDirect: scouted?.phone_direct ?? null,
        phoneOffice: scouted?.phone_office ?? null,
        phoneSource: scouted?.phone_source ?? null,
        phoneScoutedAt: scouted?.phone_scouted_at ?? null,
        latestId: latest.id,
        altSearchStatus,
        altContactsForCompany,
        heatScore,
        velocityLabel,
        firstVisitAt,
      };
    }).sort((a, b) => b.heatScore - a.heatScore);
  })();

  return (
    <ul className="mt-2 flex flex-col gap-2">
      {groups.map((g) => {
        const expanded = expandedKey === g.key;
        const visitCount = g.visits.length;
        const isRepeatProspect = visitCount > 1 || g.totalPageViews > 1;
        const knownPeople = (g.companyDomain ? leadMatches[g.companyDomain] : null) ?? [];
        const inPipelineCount = knownPeople.filter((p) => p.in_pipeline).length;
        // Hot = high heat score + recent. Used to bump the velocity label
        // visually so the card grabs the eye when it warrants action now.
        const isHot = g.heatScore > 1.5;
        const sublineParts = [
          g.companyIndustry,
          g.companySize ? `${g.companySize} ansatte` : null,
          g.companyRevenue,
        ].filter(Boolean);
        const metaParts = [
          g.companyDomain,
          g.location,
          isRepeatProspect ? "genbesøg" : null,
        ].filter(Boolean) as string[];

        return (
          <li key={g.key} className="group rounded-sm border border-[var(--ink)]/12 bg-[var(--cream)]/30 transition">
            <button type="button" onClick={() => setExpandedKey(expanded ? null : g.key)}
              className="flex w-full items-start gap-3 px-4 py-3 text-left sm:px-5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2 text-[14px] leading-snug text-[var(--ink)]/90">
                  <span className="font-medium">{g.companyName}</span>
                  {inPipelineCount > 0 ? (
                    <span className="tabular shrink-0 rounded-full border border-[var(--clay)]/40 bg-[var(--clay)]/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-[var(--clay)]">
                      {inPipelineCount} i pipeline
                    </span>
                  ) : knownPeople.length > 0 ? (
                    <span className="tabular shrink-0 rounded-full border border-[var(--forest)]/25 bg-[var(--forest)]/8 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.22em] text-[var(--forest)]">
                      {knownPeople.length} kendt{knownPeople.length === 1 ? "" : "e"}
                    </span>
                  ) : null}
                </div>
                {sublineParts.length ? (
                  <div className="text-[12px] text-[var(--ink)]/65">{sublineParts.join(" · ")}</div>
                ) : null}
                <div className="tabular mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[var(--ink)]/55">
                  <span className={isHot ? "font-medium text-[var(--clay)]" : ""}>
                    {g.velocityLabel}
                  </span>
                  {metaParts.length ? <span className="text-[var(--ink)]/30">·</span> : null}
                  {metaParts.map((p, i) => (
                    <span key={i}>{p}{i < metaParts.length - 1 ? <span className="text-[var(--ink)]/30"> · </span> : null}</span>
                  ))}
                </div>
              </div>
              <span className="tabular shrink-0 self-center text-[10px] text-[var(--ink)]/35">
                {expanded ? "−" : "+"}
              </span>
            </button>

            {expanded ? (
              <div className="border-t border-[var(--ink)]/8 px-4 py-3 sm:px-5">
                {(() => {
                  // SendPilot lead-DB search panel — only shown when we don't
                  // already know people at this company (otherwise it's noise).
                  if (knownPeople.length > 0) return null;
                  const candidates = g.altContactsForCompany;
                  const busy = busyLead === `signal-search:${g.latestId}`;
                  const pending = g.altSearchStatus === "pending";
                  const empty = g.altSearchStatus === "empty";
                  const failed = g.altSearchStatus === "failed";
                  const linkedinManualUrl = linkedinPeopleSearchUrl(g.companyLinkedinUrl, g.companyName);

                  if (candidates.length > 0) {
                    return (
                      <>
                        <p className="text-[10px] uppercase tracking-[0.22em] text-[var(--forest)]">
                          Forslag fra SendPilot ({candidates.length})
                        </p>
                        <ul className="mt-2 mb-4 flex flex-col gap-2">
                          {candidates.map((c) => (
                            <li key={c.id} className="flex flex-wrap items-baseline gap-2 rounded-sm border border-[var(--ink)]/8 bg-[var(--cream)]/40 px-3 py-2">
                              <span className="text-[13px] font-medium text-[var(--ink)]/90">{c.name}</span>
                              {c.title ? <span className="text-[12px] text-[var(--ink)]/60">{c.title}</span> : null}
                              {c.seniority ? <span className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/45">{c.seniority}</span> : null}
                              <span className="flex-1" />
                              <a href={c.linkedin_url} target="_blank" rel="noreferrer"
                                className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--forest)] underline-offset-[4px] hover:underline">
                                LinkedIn ↗
                              </a>
                            </li>
                          ))}
                        </ul>
                      </>
                    );
                  }
                  return (
                    <div className="mb-4 rounded-sm border border-dashed border-[var(--ink)]/15 bg-[var(--cream)]/30 px-3 py-3 text-[12px]">
                      {pending ? (
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-[var(--ink)]/65">Søger personer hos <strong>{g.companyName}</strong> via SendPilot… ~2 minutter.</p>
                          {linkedinManualUrl ? (
                            <a href={linkedinManualUrl} target="_blank" rel="noreferrer"
                              className="tabular shrink-0 text-[10px] uppercase tracking-[0.22em] text-[var(--forest)] underline-offset-[4px] hover:underline">
                              Research selv ↗
                            </a>
                          ) : null}
                        </div>
                      ) : empty ? (
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-[var(--ink)]/65">SendPilot fandt ingen — research selv på LinkedIn.</p>
                          {linkedinManualUrl ? (
                            <a href={linkedinManualUrl} target="_blank" rel="noreferrer"
                              className="focus-cream tabular rounded-sm border border-[var(--forest)]/30 bg-[var(--forest)]/5 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] text-[var(--forest)] hover:border-[var(--forest)]/60">
                              Åbn LinkedIn ↗
                            </a>
                          ) : null}
                        </div>
                      ) : failed ? (
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-[var(--clay)]">SendPilot-søgning fejlede.</p>
                          <div className="flex items-center gap-2">
                            {linkedinManualUrl ? (
                              <a href={linkedinManualUrl} target="_blank" rel="noreferrer"
                                className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--forest)] underline-offset-[4px] hover:underline">
                                Research selv ↗
                              </a>
                            ) : null}
                            <button type="button" onClick={() => onSearchPeople(g.latestId)} disabled={busy}
                              className="focus-cream tabular rounded-sm border border-[var(--clay)]/40 px-2.5 py-1 text-[10px] uppercase tracking-[0.22em] text-[var(--clay)] hover:border-[var(--clay)]/60 disabled:opacity-40">
                              Prøv igen
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-[var(--ink)]/70">Vi kender ingen hos {g.companyName} endnu.</p>
                          <div className="flex items-center gap-2">
                            {linkedinManualUrl ? (
                              <a href={linkedinManualUrl} target="_blank" rel="noreferrer"
                                className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--forest)] underline-offset-[4px] hover:underline">
                                Research selv ↗
                              </a>
                            ) : null}
                            <button type="button" onClick={() => onSearchPeople(g.latestId)} disabled={busy}
                              className="focus-cream tabular rounded-sm border border-[var(--forest)]/30 bg-[var(--forest)]/5 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] text-[var(--forest)] hover:border-[var(--forest)]/60 disabled:opacity-40">
                              {busy ? "Starter…" : "Find personer"}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {knownPeople.length > 0 ? (
                  <>
                    <p className="text-[10px] uppercase tracking-[0.22em] text-[var(--forest)]">
                      Kendte personer ({knownPeople.length})
                    </p>
                    <ul className="mt-2 mb-4 flex flex-col gap-2">
                      {knownPeople.map((p) => {
                        const fullName = [p.first_name, p.last_name].filter(Boolean).join(" ").trim() || p.contact_email;
                        const pipelineBadge = p.in_pipeline
                          ? p.pipeline_last_reply_at
                            ? { label: "Svaret", cls: "border-[var(--clay)]/40 bg-[var(--clay)]/10 text-[var(--clay)]" }
                            : p.pipeline_sent_at
                              ? { label: "Sendt", cls: "border-[var(--forest)]/30 bg-[var(--forest)]/5 text-[var(--forest)]" }
                              : { label: p.pipeline_status ?? "I pipeline", cls: "border-[var(--ink)]/20 bg-[var(--ink)]/5 text-[var(--ink)]/65" }
                          : { label: "Lead-DB", cls: "border-[var(--ink)]/15 text-[var(--ink)]/50" };
                        return (
                          <li key={p.contact_email} className="flex flex-wrap items-baseline gap-2 rounded-sm border border-[var(--ink)]/8 bg-[var(--cream)]/40 px-3 py-2">
                            <span className="text-[13px] font-medium text-[var(--ink)]/90">{fullName}</span>
                            {p.title ? (
                              <span className="text-[12px] text-[var(--ink)]/60">{p.title}</span>
                            ) : null}
                            <span className={`tabular shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.22em] ${pipelineBadge.cls}`}>
                              {pipelineBadge.label}
                            </span>
                            <span className="flex-1" />
                            {p.linkedin_url ? (
                              <a href={p.linkedin_url} target="_blank" rel="noreferrer"
                                className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--forest)] underline-offset-[4px] hover:underline">
                                LinkedIn ↗
                              </a>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                ) : null}

                <p className="text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/45">Besøgshistorik</p>
                <ul className="mt-1 flex flex-col gap-1 text-[12px] text-[var(--ink)]/80">
                  {g.visits.map((v) => {
                    const pv = v.page_views as Array<{ url?: string; count?: number }> | null;
                    const pages = pv?.[0];
                    const isRepeatVisit = v.signal_type === "visitor.repeat";
                    return (
                      <li key={v.id} className="tabular flex flex-wrap items-center gap-x-2">
                        <span className="text-[var(--ink)]/55">{fmtWhen(v.identified_at)}</span>
                        <span className="text-[var(--ink)]/30">·</span>
                        {pages?.url ? (
                          <a href={pages.url} target="_blank" rel="noreferrer"
                            className="text-[var(--forest)] underline-offset-[4px] hover:underline">
                            {new URL(pages.url).pathname || "/"}
                          </a>
                        ) : pages?.count ? (
                          <span>{pages.count} sider</span>
                        ) : (
                          <span className="text-[var(--ink)]/45">—</span>
                        )}
                        {isRepeatVisit ? (
                          <span className="tabular ml-1 rounded-full bg-[var(--clay)]/10 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.22em] text-[var(--clay)]">
                            genbesøg
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>

                {(g.phoneDirect || g.phoneOffice) ? (
                  <div className="mt-4 rounded-sm border border-[var(--forest)]/20 bg-[var(--forest)]/5 p-3">
                    <p className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--forest)]">Telefon</p>
                    {g.phoneDirect ? (
                      <p className="mt-1 text-[13px] text-[var(--ink)]/90">
                        <a href={`tel:${g.phoneDirect}`} className="font-medium underline-offset-[4px] hover:underline">{g.phoneDirect}</a>
                        <span className="tabular ml-2 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/45">direkte · {g.phoneSource ?? "?"}</span>
                      </p>
                    ) : null}
                    {g.phoneOffice ? (
                      <p className="mt-1 text-[13px] text-[var(--ink)]/75">
                        <a href={`tel:${g.phoneOffice}`} className="underline-offset-[4px] hover:underline">{g.phoneOffice}</a>
                        <span className="tabular ml-2 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/45">hovednummer</span>
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {(() => {
                  const callable = g.phoneDirect ?? g.phoneOffice;
                  const smsable = g.phoneDirect;
                  const emailable = g.latestPersonEmail;
                  if (!callable && !smsable && !emailable) return null;
                  return (
                    <div className="mt-4 grid gap-2 sm:grid-cols-3">
                      {callable ? (
                        <a href={`tel:${callable}`}
                          className="focus-cream tabular flex items-center justify-center gap-2 rounded-sm border border-[var(--forest)]/30 bg-[var(--forest)]/5 px-3 py-2 text-[11px] uppercase tracking-[0.22em] text-[var(--forest)] hover:border-[var(--forest)]/60">
                          Ring {g.phoneDirect ? "direkte" : "hovednr."}
                        </a>
                      ) : null}
                      {smsable ? (
                        <a href={signalSmsHref(smsable, g.latestPersonName, identity, g.companyName)}
                          className="focus-cream tabular flex items-center justify-center gap-2 rounded-sm border border-[var(--ink)]/20 px-3 py-2 text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/75 hover:border-[var(--ink)]/40 hover:text-[var(--ink)]">
                          SMS
                        </a>
                      ) : null}
                      {emailable ? (
                        <a href={signalMailtoHref(emailable, g.latestPersonName, identity, g.companyName)}
                          className="focus-cream tabular flex items-center justify-center gap-2 rounded-sm border border-[var(--ink)]/20 px-3 py-2 text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/75 hover:border-[var(--ink)]/40 hover:text-[var(--ink)]">
                          Mail
                        </a>
                      ) : null}
                    </div>
                  );
                })()}

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  {g.latestPersonLinkedinUrl ? (
                    <a href={g.latestPersonLinkedinUrl} target="_blank" rel="noreferrer"
                      className="tabular text-[11px] uppercase tracking-[0.22em] text-[var(--forest)] underline-offset-[6px] hover:underline">
                      Åbn LinkedIn (person) ↗
                    </a>
                  ) : g.companyLinkedinUrl ? (
                    <a href={g.companyLinkedinUrl} target="_blank" rel="noreferrer"
                      className="tabular text-[11px] uppercase tracking-[0.22em] text-[var(--forest)] underline-offset-[6px] hover:underline">
                      Åbn LinkedIn ↗
                    </a>
                  ) : null}
                  {g.companyDomain ? (
                    <a href={`https://${g.companyDomain}`} target="_blank" rel="noreferrer"
                      className="tabular text-[11px] uppercase tracking-[0.22em] text-[var(--forest)] underline-offset-[6px] hover:underline">
                      Åbn website ↗
                    </a>
                  ) : null}
                  <button type="button" onClick={() => onScoutPhones(g.latestId)}
                    disabled={busyLead === `signal:${g.latestId}`}
                    className="focus-cream tabular rounded-sm border border-[var(--forest)]/30 bg-[var(--forest)]/5 px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.22em] text-[var(--forest)] hover:border-[var(--forest)]/60 disabled:opacity-40">
                    {busyLead === `signal:${g.latestId}` ? "Søger…" : g.phoneScoutedAt ? "Søg igen" : "Find telefon"}
                  </button>
                  <span className="flex-1" />
                  <button type="button" onClick={() => onMarkHandled(g.visits.map((v) => v.id))}
                    className="focus-cream tabular rounded-sm border border-[var(--ink)]/12 px-2.5 py-1 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/50 hover:border-[var(--ink)]/25 hover:text-[var(--ink)]/80">
                    Skjul
                  </button>
                </div>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function RepliesTab({ replies, referralsByLead, busyLead, onMarkHandled, onInviteAlt, onSendReply, onGenerateReply }: {
  replies: Reply[];
  referralsByLead: Map<string, AltContact[]>;
  busyLead: string | null;
  onMarkHandled: (id: string) => void;
  onInviteAlt: (altId: string, leadId: string) => void;
  onSendReply: (replyId: string, messageOverride: string) => Promise<boolean>;
  onGenerateReply: (replyId: string) => Promise<string | null>;
}) {
  if (replies.length === 0) {
    return (
      <p className="tabular py-12 text-center text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/35">
        Ingen svar endnu.
      </p>
    );
  }

  // Group replies by contact (linkedin_url) — one card per person regardless
  // of how many sendpilot_lead_id campaigns they appear in. Within each card
  // we render the message thread newest-first so the most-recent reply is the
  // first thing you scan, and tag each message with its direction so the
  // inbound vs outbound styling is unambiguous.
  //
  // Svar tab semantics: only show contacts who actually replied. Outbound-only
  // threads (we sent, no response yet) belong in the Sendt tab, not here.
  const byContact = new Map<string, Reply[]>();
  for (const r of replies) {
    const key = r.linkedin_url;
    if (!byContact.has(key)) byContact.set(key, []);
    byContact.get(key)!.push(r);
  }
  for (const [key, arr] of byContact) {
    if (!arr.some((r) => r.direction === "inbound")) {
      byContact.delete(key);
      continue;
    }
    arr.sort((a, b) => (b.received_at ?? "").localeCompare(a.received_at ?? ""));
  }
  if (byContact.size === 0) {
    return (
      <p className="tabular py-12 text-center text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/35">
        Ingen svar endnu.
      </p>
    );
  }
  // Card sort: latest INBOUND first.
  const latestInboundAt = (arr: Reply[]) =>
    arr.find((r) => r.direction === "inbound")?.received_at ?? arr[0]?.received_at ?? "";
  const contacts = Array.from(byContact.entries()).sort(
    ([, a], [, b]) => latestInboundAt(b).localeCompare(latestInboundAt(a)),
  );

  return (
    <ul className="mt-2 flex flex-col gap-3">
      {contacts.map(([linkedinUrl, contactReplies]) => {
        // Header signals + IntentPill should reflect the latest INBOUND.
        // Outbound has no intent classification (we sent it, we know why).
        const latestInbound = contactReplies.find((r) => r.direction === "inbound") ?? contactReplies[0]!;
        const latest = contactReplies[0]!;
        const unhandledCount = contactReplies.filter((r) => r.direction === "inbound" && !r.handled).length;
        const allHandled = unhandledCount === 0;

        // Aggregate referrals from every campaign this contact appears in,
        // dedupe by alt.id. Use the latest-touched sendpilot_lead_id as the
        // anchor for the Inviter callback (any lead_id of this contact would
        // work; latest keeps the invite tied to the most recent campaign).
        const seenAltIds = new Set<string>();
        const aggregatedReferrals: AltContact[] = [];
        let referralAnchorLeadId: string | null = null;
        for (const r of contactReplies) {
          const refs = referralsByLead.get(r.sendpilot_lead_id);
          if (!refs || refs.length === 0) continue;
          if (!referralAnchorLeadId) referralAnchorLeadId = r.sendpilot_lead_id;
          for (const alt of refs) {
            if (!seenAltIds.has(alt.id)) {
              seenAltIds.add(alt.id);
              aggregatedReferrals.push(alt);
            }
          }
        }

        return (
          <li key={linkedinUrl}
            className={`rounded-sm border p-4 sm:p-5 transition ${
              allHandled ? "border-[var(--ink)]/8 bg-transparent opacity-60" : "border-[var(--ink)]/12 bg-[var(--cream)]/40"
            }`}>
            {/* Contact header */}
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-display text-xl italic leading-tight tracking-tight text-[var(--ink)]">
                  {latest.lead?.first_name} {latest.lead?.last_name}
                </div>
                <div className="tabular mt-0.5 text-[12px] text-[var(--ink)]/55">
                  {latest.lead?.company}
                  {" · "}
                  <a href={linkedinUrl} target="_blank" rel="noreferrer"
                    className="underline underline-offset-2 hover:text-[var(--ink)]">LinkedIn ↗</a>
                  {" · "}
                  {fmtRelative(latest.received_at)}
                  {contactReplies.length > 1 ? (
                    <span className="text-[var(--ink)]/40">{" · "}{contactReplies.length} beskeder</span>
                  ) : null}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <IntentPill intent={latestInbound.intent} confidence={latestInbound.confidence} />
                {unhandledCount > 0 && contactReplies.length > 1 ? (
                  <span className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--clay)]">
                    {unhandledCount} ubehandlet
                  </span>
                ) : null}
              </div>
            </div>

            {/* Message thread — inbound left, outbound right, chat-style */}
            <ul className={`flex flex-col gap-3 ${contactReplies.length > 1 ? "mt-4" : "mt-3"}`}>
              {contactReplies.map((r, idx) => {
                const isLatest = idx === 0;
                const isOutbound = r.direction === "outbound";
                const showHandleButton = !isOutbound && !r.handled;
                return (
                  <li key={r.id}
                    className={`flex ${isOutbound ? "justify-end" : "justify-start"} ${r.handled ? "opacity-50" : ""}`}>
                    <div className={`max-w-[88%] sm:max-w-[78%] ${isOutbound ? "text-right" : ""}`}>
                      <div className={`tabular flex flex-wrap items-center gap-2 text-[11px] ${
                        isOutbound ? "justify-end text-[var(--ink)]/45" : "text-[var(--ink)]/50"
                      }`}>
                        <span>{isOutbound ? "Du" : "Dem"} · {fmtRelative(r.received_at)}</span>
                        {!isOutbound && !isLatest && r.intent !== latestInbound.intent ? (
                          <span className="inline-block align-middle">
                            <IntentPill intent={r.intent} confidence={r.confidence} />
                          </span>
                        ) : null}
                        {showHandleButton ? (
                          <button type="button" onClick={() => onMarkHandled(r.id)}
                            className="focus-cream tabular rounded-sm border border-[var(--ink)]/15 px-2.5 py-1 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/65 hover:border-[var(--ink)]/35 hover:text-[var(--ink)]">
                            Skjul
                          </button>
                        ) : null}
                      </div>
                      <p className={`whitespace-pre-wrap rounded-sm px-3 py-2 text-sm leading-relaxed text-left ${
                        isOutbound
                          ? "mt-1 bg-[var(--forest)]/[0.18] text-[var(--ink)]/90 ring-1 ring-[var(--forest)]/30"
                          : "mt-1 bg-[var(--cream)] text-[var(--ink)]/90 ring-1 ring-[var(--ink)]/10"
                      }`}>{r.message}</p>
                      {!isOutbound && r.reasoning ? (
                        <p className="tabular mt-1 text-[11px] text-[var(--ink)]/55">AI: {r.reasoning}</p>
                      ) : null}
                      {!isOutbound && r.id === latestInbound.id ? (
                        <SuggestedReply replyId={r.id} text={r.triage_draft ?? r.suggested_reply ?? ""} onSend={onSendReply} onGenerate={onGenerateReply} />
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>

            {/* Aggregated referrals across all of this contact's campaigns */}
            {aggregatedReferrals.length > 0 && referralAnchorLeadId ? (
              <div className="mt-4 rounded-sm border border-[var(--clay)]/30 bg-[var(--clay)]/5 p-3">
                <p className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--clay)]">
                  Henviser til {aggregatedReferrals.length === 1 ? "" : `${aggregatedReferrals.length} personer`}
                </p>
                <ul className="mt-2 space-y-2">
                  {aggregatedReferrals.map((alt) => (
                    <li key={alt.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-[var(--ink)]">{alt.name}</div>
                        <div className="tabular text-[11px] text-[var(--ink)]/55">
                          {alt.title ?? "—"}{alt.company ? ` · ${alt.company}` : ""}
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-3">
                        {alt.linkedin_url ? (
                          <a href={alt.linkedin_url} target="_blank" rel="noopener noreferrer"
                            className="tabular text-[11px] uppercase tracking-[0.2em] text-[var(--forest)] underline-offset-[6px] hover:underline">
                            LinkedIn →
                          </a>
                        ) : (
                          <span className="tabular text-[11px] uppercase tracking-[0.2em] text-[var(--ink)]/45">Mangler LinkedIn</span>
                        )}
                        {alt.linkedin_url && !alt.acted_on_at ? (
                          <button onClick={() => onInviteAlt(alt.id, referralAnchorLeadId!)} disabled={busyLead === referralAnchorLeadId}
                            className="tabular text-[11px] uppercase tracking-[0.2em] text-[var(--clay)] underline-offset-[6px] hover:underline disabled:opacity-50">
                            Inviter →
                          </button>
                        ) : null}
                        {alt.acted_on_at ? (
                          <span className="tabular text-[11px] uppercase tracking-[0.2em] text-[var(--forest)]">Inviteret ✓</span>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function SentTab({ rows, busyLead, onSetOutcome }: {
  rows: PipelineRow[];
  busyLead: string | null;
  onSetOutcome: (leadId: string, outcome: Outcome | null) => void;
}) {
  if (rows.length === 0) {
    return (
      <p className="tabular py-12 text-center text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/35">
        Endnu intet sendt.
      </p>
    );
  }
  return (
    <ul className="mt-4 flex flex-col divide-y divide-[var(--ink)]/8 border-y border-[var(--ink)]/8">
      {rows.map((r) => (
        <li key={r.sendpilot_lead_id} className="grid grid-cols-12 gap-3 py-3 text-sm">
          <span className="col-span-3 sm:col-span-2 tabular text-[12px] text-[var(--ink)]/55">{fmtShort(r.sent_at ?? r.updated_at)}</span>
          <span className="col-span-9 sm:col-span-3 truncate text-[var(--ink)]/80">{r.lead?.first_name} {r.lead?.last_name}</span>
          <span className="hidden sm:block sm:col-span-2 truncate text-[var(--ink)]/60">{r.lead?.company}</span>
          <span className="col-span-12 sm:col-span-2 flex flex-wrap items-center gap-1">
            {r.last_reply_intent ? <IntentPill intent={r.last_reply_intent} confidence={null} /> : null}
            <SequencePill row={r} />
          </span>
          <span className="col-span-12 sm:col-span-3 flex items-center justify-end">
            <OutcomePicker
              outcome={r.outcome}
              busy={busyLead === r.sendpilot_lead_id}
              onChange={(o) => onSetOutcome(r.sendpilot_lead_id, o)}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}

function OutcomePicker({ outcome, busy, onChange }: {
  outcome: Outcome | null;
  busy: boolean;
  onChange: (o: Outcome | null) => void;
}) {
  return (
    <select
      value={outcome ?? ""}
      onChange={(e) => onChange((e.target.value as Outcome) || null)}
      disabled={busy}
      className="focus-cream tabular rounded-sm border border-[var(--ink)]/15 bg-transparent px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-[var(--ink)]/65 hover:border-[var(--ink)]/35 disabled:opacity-50"
      title="Tag resultat — bruges til at tune ICP-scoring over tid"
    >
      <option value="">— Tag resultat —</option>
      {OUTCOME_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function AllTab({ rows }: { rows: PipelineRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="tabular py-12 text-center text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/35">
        Ingenting endnu.
      </p>
    );
  }
  return (
    <ul className="mt-4 flex flex-col divide-y divide-[var(--ink)]/8 border-y border-[var(--ink)]/8">
      {rows.map((r) => (
        <li key={r.sendpilot_lead_id} className="grid grid-cols-12 gap-3 py-3 text-sm">
          <span className="col-span-3 sm:col-span-2 tabular text-[12px] text-[var(--ink)]/55">{fmtShort(r.updated_at)}</span>
          <span className="col-span-3 sm:col-span-2 flex flex-wrap items-center gap-1"><StatusPill status={r.status} /><SequencePill row={r} /></span>
          <span className="col-span-6 sm:col-span-3 truncate text-[var(--ink)]/80">{r.lead?.first_name} {r.lead?.last_name}</span>
          <span className="hidden sm:block sm:col-span-3 truncate text-[var(--ink)]/60">{r.lead?.company}</span>
          <span className="col-span-12 sm:col-span-2 truncate text-[12px] text-[var(--ink)]/45">{r.error ?? r.decided_by ?? ""}</span>
        </li>
      ))}
    </ul>
  );
}

function LoginGate({ email, setEmail, token, setToken, sendOtp, verifyOtp, info, err }: {
  email: string; setEmail: (s: string) => void;
  token: string; setToken: (s: string) => void;
  sendOtp: (e: FormEvent<HTMLFormElement>) => Promise<void>;
  verifyOtp: (e: FormEvent<HTMLFormElement>) => Promise<void>;
  info: string | null; err: string | null;
}) {
  return (
    <main className="safe-screen safe-pad-top safe-pad-bottom safe-px relative min-h-screen overflow-hidden bg-[var(--sand)] text-[var(--ink)]">
      <div className="grain-overlay" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[60vh] bg-[radial-gradient(ellipse_at_top,rgba(185,112,65,0.14),transparent_60%)]" />
      <div className="safe-screen relative mx-auto flex min-h-screen w-full max-w-md min-w-0 flex-col justify-between px-6 py-8 sm:py-10">
        <Link href="/" className="tabular text-[10px] uppercase tracking-[0.35em] text-[var(--ink)]/45 hover:text-[var(--ink)]/70">
          CarterCo · Outreach
        </Link>
        <section>
          <p className="tabular text-[10px] uppercase tracking-[0.32em] text-[var(--ink)]/40">Privat arbejdsrum</p>
          <h1 className="font-display mt-4 text-6xl italic leading-[0.9] tracking-[-0.02em] text-[var(--ink)] sm:text-7xl">Outreach</h1>
          <p className="mt-6 max-w-xs text-sm leading-relaxed text-[var(--ink)]/55">
            Godkend personaliserede beskeder før de sendes til allerede forbundne leads.
          </p>
          <form onSubmit={sendOtp} className="mt-10 flex flex-col gap-3">
            <label className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--ink)]/40">E-mail</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email"
              className="focus-orange border-b border-[var(--ink)]/15 bg-transparent py-3 text-base text-[var(--ink)] outline-none transition focus:border-[var(--forest)]" />
            <button type="submit" className="focus-orange mt-4 flex items-center justify-between rounded-sm bg-[var(--forest)] px-5 py-3.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--cream)] transition hover:bg-[#2f5e4e]">
              <span>Send login-link</span><span aria-hidden>→</span>
            </button>
          </form>
          <form onSubmit={verifyOtp} className="mt-8 flex flex-col gap-3">
            <label className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--ink)]/40">Eller indtast kode</label>
            <input type="text" value={token} onChange={(e) => setToken(e.target.value)} inputMode="numeric"
              autoComplete="one-time-code" placeholder="6-cifret"
              className="focus-cream tabular border-b border-[var(--ink)]/15 bg-transparent py-3 text-base text-[var(--ink)] outline-none transition placeholder:text-[var(--ink)]/25 focus:border-[var(--ink)]/45" />
            <button type="submit" className="focus-cream mt-2 self-start text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/70 underline-offset-[6px] hover:text-[var(--ink)] hover:underline">Verificer →</button>
          </form>
          {info ? <p className="mt-8 border-l border-[var(--forest)]/50 pl-3 text-sm text-[var(--ink)]/70">{info}</p> : null}
          {err ? <p className="mt-8 border-l border-[var(--clay)]/50 pl-3 text-sm text-[var(--clay)]">{err}</p> : null}
        </section>
        <p className="tabular text-[10px] uppercase tracking-[0.28em] text-[var(--ink)]/25">{new Date().getFullYear()} · CarterCo Outreach</p>
      </div>
    </main>
  );
}

function SuggestedReply({ replyId, text, onSend, onGenerate }: {
  replyId: string;
  text: string;
  onSend: (replyId: string, messageOverride: string) => Promise<boolean>;
  onGenerate: (replyId: string) => Promise<string | null>;
}) {
  const hasSuggestion = !!text.trim();
  const [draft, setDraft] = useState(text);
  const [editing, setEditing] = useState(!hasSuggestion); // no AI draft → open compose
  const [sending, setSending] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;

  async function regenerate() {
    if (generating || sending) return;
    setGenerating(true);
    const fresh = await onGenerate(replyId);
    setGenerating(false);
    // Fresh draft drops straight into the box, ready to review/edit/send. If
    // generation failed (null), keep whatever was there.
    if (fresh) { setDraft(fresh); setEditing(false); }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  }

  async function send() {
    if (!draft.trim() || sending) return;
    if (!confirm("Send svaret via SendPilot nu?")) return;
    setSending(true);
    const ok = await onSend(replyId, draft.trim());
    setSending(false);
    if (ok) setHidden(true);
  }

  return (
    <div className="mt-2 rounded-sm border border-dashed border-[var(--forest)]/30 bg-[var(--forest)]/[0.04] p-3 text-left">
      <div className="tabular flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.22em] text-[var(--forest)]">
        <span>{hasSuggestion ? "Foreslået svar" : "Svar direkte"}</span>
        <div className="flex gap-1">
          <button type="button" onClick={() => void regenerate()} disabled={generating || sending}
            className="focus-cream rounded-sm border border-[var(--forest)]/30 px-2 py-0.5 text-[10px] uppercase tracking-[0.22em] text-[var(--forest)] hover:bg-[var(--forest)]/10 disabled:opacity-40">
            {generating ? "Genererer…" : hasSuggestion ? "Generér igen" : "Generér svar"}
          </button>
          {!editing ? (
            <button type="button" onClick={() => setEditing(true)}
              className="focus-cream rounded-sm border border-[var(--ink)]/15 px-2 py-0.5 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/55 hover:border-[var(--ink)]/35 hover:text-[var(--ink)]/80">
              Rediger
            </button>
          ) : (
            <button type="button" onClick={() => { setDraft(text); setEditing(false); }}
              className="focus-cream rounded-sm border border-[var(--ink)]/15 px-2 py-0.5 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/55 hover:border-[var(--ink)]/35 hover:text-[var(--ink)]/80">
              Annullér
            </button>
          )}
          <button type="button" onClick={() => void copy()}
            className="focus-cream rounded-sm border border-[var(--forest)]/30 px-2 py-0.5 text-[10px] uppercase tracking-[0.22em] text-[var(--forest)] hover:bg-[var(--forest)]/10">
            {copied ? "Kopieret ✓" : "Kopiér"}
          </button>
          <button type="button" onClick={() => void send()} disabled={sending || !draft.trim()}
            className="focus-orange rounded-sm bg-[var(--forest)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--cream)] hover:bg-[#2f5e4e] disabled:opacity-40">
            {sending ? "Sender…" : "Send"}
          </button>
          <button type="button" onClick={() => setHidden(true)}
            className="focus-cream rounded-sm border border-[var(--ink)]/15 px-2 py-0.5 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/55 hover:border-[var(--ink)]/35 hover:text-[var(--ink)]/80">
            Skjul
          </button>
        </div>
      </div>
      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={Math.max(3, draft.split("\n").length + 1)}
          className="focus-cream mt-2 w-full resize-y whitespace-pre-wrap rounded-sm border border-[var(--forest)]/30 bg-[var(--cream)]/40 px-3 py-2 text-sm leading-relaxed text-[var(--ink)]/90 outline-none focus:border-[var(--forest)]/60"
        />
      ) : (
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-[var(--ink)]/85">{draft}</p>
      )}
    </div>
  );
}

function Banner({ kind, children }: { kind: "info" | "error"; children: ReactNode }) {
  const isError = kind === "error";
  const color = isError ? "var(--clay)" : "var(--forest)";
  return (
    <section className="mx-auto mb-3 w-full max-w-[1400px] px-4 sm:px-8 lg:px-12">
      <p
        className="flex items-start gap-2 rounded-sm border-l-2 py-2 pl-3 pr-3 text-sm"
        style={{
          borderColor: color,
          background: isError ? "rgba(185,112,65,0.06)" : "rgba(56,89,73,0.06)",
          color: isError ? color : "rgb(0 0 0 / 0.75)",
        }}
      >
        <span aria-hidden className="tabular text-[11px] font-semibold uppercase tracking-[0.18em] mt-0.5" style={{ color }}>
          {isError ? "Fejl" : "Info"}
        </span>
        <span>{children}</span>
      </p>
    </section>
  );
}

function Pill({ kind, label }: { kind: "warm" | "cold"; label: string }) {
  return (
    <span className="tabular inline-block rounded-sm px-2 py-0.5 text-[10px] uppercase tracking-[0.18em]"
      style={{
        background: kind === "warm" ? "rgba(185,112,65,0.14)" : "rgba(35,90,67,0.14)",
        color: kind === "warm" ? "var(--clay)" : "var(--forest)",
      }}>{label}</span>
  );
}

function StatusPill({ status }: { status: Status }) {
  const map: Record<Status, { label: string; bg: string; fg: string }> = {
    invited: { label: "Inviteret", bg: "rgb(0 0 0 / .06)", fg: "rgb(0 0 0 / .55)" },
    accepted: { label: "Accept", bg: "rgb(0 0 0 / .06)", fg: "rgb(0 0 0 / .55)" },
    pending_pre_render: { label: "Review", bg: "rgba(185,112,65,0.14)", fg: "var(--clay)" },
    pending_ai_draft: { label: "Skriver…", bg: "rgb(0 0 0 / .06)", fg: "rgb(0 0 0 / .55)" },
    rendering: { label: "Render", bg: "rgb(0 0 0 / .06)", fg: "rgb(0 0 0 / .55)" },
    rendered: { label: "Klar", bg: "rgb(0 0 0 / .06)", fg: "rgb(0 0 0 / .55)" },
    pending_approval: { label: "Afventer", bg: "rgba(185,112,65,0.14)", fg: "var(--clay)" },
    sent: { label: "Sendt", bg: "rgba(35,90,67,0.14)", fg: "var(--forest)" },
    rejected: { label: "Afvist", bg: "rgb(0 0 0 / .06)", fg: "rgb(0 0 0 / .45)" },
    rejected_by_icp: { label: "ICP-afvist", bg: "rgb(0 0 0 / .06)", fg: "rgb(0 0 0 / .50)" },
    pending_alt_review: { label: "Person?", bg: "rgba(185,112,65,0.14)", fg: "var(--clay)" },
    failed: { label: "Fejl", bg: "rgba(185,112,65,0.14)", fg: "var(--clay)" },
    pre_connected: { label: "Eksisterende", bg: "rgba(35,90,67,0.10)", fg: "var(--forest)" },
  };
  const s = map[status];
  return (
    <span className="tabular inline-block rounded-sm px-2 py-0.5 text-[10px] uppercase tracking-[0.18em]"
      style={{ background: s.bg, color: s.fg }}>{s.label}</span>
  );
}

function SequencePill({ row }: { row: PipelineRow }) {
  if (!row.sequence_id || row.sequence_id === "pre_feature_backfill") return null;
  const label = row.sequence_id.replace(/_v\d+$/, "").replaceAll("_", " ");
  if (row.sequence_completed_at) {
    return (
      <span
        className="tabular inline-block rounded-sm px-2 py-0.5 text-[10px] uppercase tracking-[0.18em]"
        style={{ background: "rgb(0 0 0 / .04)", color: "rgb(0 0 0 / .45)" }}
        title={`Sekvens ${row.sequence_id} kompleteret`}
      >
        {label} · ✓
      </span>
    );
  }
  const stepNo = (row.sequence_step ?? 0) + 1;
  const wakes = fmtRelativeFuture(row.sequence_parked_until);
  return (
    <span
      className="tabular inline-block rounded-sm px-2 py-0.5 text-[10px] uppercase tracking-[0.18em]"
      style={{ background: "rgba(35,90,67,0.10)", color: "var(--forest)" }}
      title={`Sekvens ${row.sequence_id} · trin ${stepNo}${wakes ? ` · vågner ${wakes}` : ""}`}
    >
      {label} · {stepNo}{wakes ? ` · ${wakes}` : ""}
    </span>
  );
}

function IntentPill({ intent, confidence }: { intent: Intent | null; confidence: number | null }) {
  if (!intent) return <span className="tabular text-[10px] text-[var(--ink)]/35">…</span>;
  const map: Record<Intent, { label: string; bg: string; fg: string }> = {
    interested: { label: "interesseret", bg: "rgba(35,90,67,0.16)", fg: "var(--forest)" },
    question:   { label: "spørgsmål",     bg: "rgba(185,112,65,0.12)", fg: "var(--clay)" },
    decline:    { label: "nej tak",       bg: "rgb(0 0 0 / .08)", fg: "rgb(0 0 0 / .55)" },
    ooo:        { label: "fravær",        bg: "rgb(0 0 0 / .06)", fg: "rgb(0 0 0 / .45)" },
    other:      { label: "andet",         bg: "rgb(0 0 0 / .06)", fg: "rgb(0 0 0 / .45)" },
    referral:   { label: "henvisning",    bg: "rgba(185,112,65,0.18)", fg: "var(--clay)" },
  };
  const s = map[intent];
  return (
    <span className="tabular inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-[10px] uppercase tracking-[0.18em]"
      style={{ background: s.bg, color: s.fg }}>
      {s.label}
      {confidence != null ? <span className="opacity-60">{Math.round(confidence * 100)}%</span> : null}
    </span>
  );
}

// =================================== utils ==================================

function fmtRelative(ts: string | null | undefined): string {
  if (!ts) return "—";
  const ms = Date.now() - new Date(ts).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s siden`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m siden`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}t siden`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d siden`;
  return new Date(ts).toLocaleDateString("da-DK", { day: "2-digit", month: "short" });
}

function fmtRelativeFuture(ts: string | null | undefined): string {
  if (!ts) return "";
  const ms = new Date(ts).getTime() - Date.now();
  if (ms <= 0) return "snart";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `om ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `om ${h}t`;
  const d = Math.round(h / 24);
  return `om ${d}d`;
}

function fmtShort(ts: string | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("da-DK", { dateStyle: "short", timeStyle: "short" });
}

function sortPipeline(key: SortKey) {
  return (a: PipelineRow, b: PipelineRow) => {
    if (key === "name") {
      const an = `${a.lead?.first_name ?? ""} ${a.lead?.last_name ?? ""}`.trim().toLowerCase();
      const bn = `${b.lead?.first_name ?? ""} ${b.lead?.last_name ?? ""}`.trim().toLowerCase();
      return an.localeCompare(bn);
    }
    const at = a.queued_at ?? a.rendered_at ?? a.updated_at;
    const bt = b.queued_at ?? b.rendered_at ?? b.updated_at;
    return key === "queued_oldest" ? at.localeCompare(bt) : bt.localeCompare(at);
  };
}

function buildSparkline(rows: PipelineRow[], days: number) {
  const out: { day: string; count: number }[] = [];
  const now = new Date();
  const map = new Map<string, number>();
  for (const r of rows) {
    if (!r.sent_at) continue;
    const d = new Date(r.sent_at);
    const key = d.toISOString().slice(0, 10);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    out.push({ day: key, count: map.get(key) ?? 0 });
  }
  return out;
}

function urlBase64ToUint8Array(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function arrayBuffersEqual(left: ArrayBuffer | null | undefined, right: Uint8Array) {
  if (!left || left.byteLength !== right.byteLength) return false;
  const lb = new Uint8Array(left);
  return lb.every((b, i) => b === right[i]);
}

// ===================== Inbox (consolidated to-do) =====================

function InboxTab(props: {
  pendingRows: PipelineRow[];
  acceptedRows: PipelineRow[];
  altReviewRows: PipelineRow[];
  altsByLead: Map<string, AltContact[]>;
  selected: Set<string>; setSelected: (s: Set<string>) => void;
  filters: { company: string; role: string; cold: ColdFilter };
  setFilters: { setCompany: (v: string) => void; setRole: (v: string) => void; setCold: (v: ColdFilter) => void };
  sortKey: SortKey; setSortKey: (s: SortKey) => void;
  playing: Set<string>; setPlaying: (s: Set<string>) => void;
  editing: { leadId: string; message: string } | null;
  setEditing: (e: { leadId: string; message: string } | null) => void;
  busyLead: string | null;
  onApproveOne: (r: PipelineRow) => void;
  onRejectOne: (r: PipelineRow) => void;
  onBulkApprove: () => void; onBulkReject: () => void;
  onRender: (id: string) => void;
  onUseOriginal: (id: string) => void;
  onInviteAlt: (altId: string, leadId: string) => void;
}) {
  const { pendingRows, acceptedRows, altReviewRows, altsByLead, ...rest } = props;
  const total = pendingRows.length + acceptedRows.length + altReviewRows.length;

  if (total === 0) {
    return (
      <p className="tabular py-12 text-center text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/35">
        Indbakken er tom — intet kræver din opmærksomhed lige nu.
      </p>
    );
  }

  return (
    <div className="space-y-12">
      {pendingRows.length > 0 ? (
        <InboxSection
          label="Godkend & send"
          hint="Beskeder klar til godkendelse — både rendered videoer og tekst-DMs. Godkend for at sende."
          count={pendingRows.length}
        >
          <PendingTab
            rows={pendingRows}
            selected={rest.selected} setSelected={rest.setSelected}
            filters={rest.filters} setFilters={rest.setFilters}
            sortKey={rest.sortKey} setSortKey={rest.setSortKey}
            playing={rest.playing} setPlaying={rest.setPlaying}
            editing={rest.editing} setEditing={rest.setEditing}
            busyLead={rest.busyLead}
            onApproveOne={rest.onApproveOne} onRejectOne={rest.onRejectOne}
            onBulkApprove={rest.onBulkApprove} onBulkReject={rest.onBulkReject}
          />
        </InboxSection>
      ) : null}

      {acceptedRows.length > 0 ? (
        <InboxSection
          label="Klar til render"
          hint="Nye accepter — bekræft ICP-score og start render når du er klar."
          count={acceptedRows.length}
        >
          <AcceptedTab
            rows={acceptedRows}
            busyLead={rest.busyLead}
            onRender={rest.onRender}
            onReject={rest.onRejectOne}
          />
        </InboxSection>
      ) : null}

      {altReviewRows.length > 0 ? (
        <InboxSection
          label="Vælg rigtig person"
          hint="Den accepterede person scorede lavt — vælg en alternativ kontakt eller brug originalen."
          count={altReviewRows.length}
        >
          <AltReviewTab
            rows={altReviewRows}
            altsByLead={altsByLead}
            busyLead={rest.busyLead}
            onUseOriginal={rest.onUseOriginal}
            onInviteAlt={rest.onInviteAlt}
            onRejectOne={rest.onRejectOne}
          />
        </InboxSection>
      ) : null}
    </div>
  );
}

function InboxSection({ label, hint, count, children }: {
  label: string; hint: string; count: number; children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-4 border-b border-[var(--ink)]/[0.10] pb-2">
        <div className="flex items-baseline gap-3">
          <h2 className="font-display text-xl italic tracking-tight text-[var(--ink)]">{label}</h2>
          <span className="tabular text-[11px] uppercase tracking-[0.22em] text-[var(--clay)]">{count}</span>
        </div>
        <p className="tabular mt-1 text-[11px] uppercase tracking-[0.16em] text-[var(--ink)]/50">{hint}</p>
      </div>
      {children}
    </section>
  );
}

// ===================== ICP tabs =====================

// Lead names live in outreach_leads, joined by sendpilot_lead_id. A lead
// invited directly in SendPilot (outside the CSV import) has no outreach_leads
// row, so first/last are absent — and the alt-review / ICP-rejected cards used
// to render a bare "?". Fall back to the name carried in the LinkedIn slug
// (…/in/jan-joergensen-48343060 → "Jan Joergensen"); company/title stay blank
// because the URL doesn't carry them and we don't invent data.
function humanizeLinkedinSlug(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/in\/([^/?#]+)/i);
  if (!m) return null;
  let slug: string;
  try { slug = decodeURIComponent(m[1]); } catch { slug = m[1]; }
  const parts = slug.split("-").filter(Boolean);
  // LinkedIn appends a disambiguating id token (digits / hex) — drop it.
  if (parts.length > 1 && /\d/.test(parts[parts.length - 1])) parts.pop();
  const name = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ").trim();
  return name || null;
}

function leadDisplayName(r: PipelineRow): string {
  const joined = `${r.lead?.first_name ?? ""} ${r.lead?.last_name ?? ""}`.trim();
  return joined || humanizeLinkedinSlug(r.linkedin_url) || "(ukendt)";
}

function IcpRejectedTab({ rows, busyLead, onOverride }: {
  rows: PipelineRow[];
  busyLead: string | null;
  onOverride: (leadId: string) => void;
}) {
  if (rows.length === 0) {
    return <p className="tabular py-12 text-center text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/35">Ingen ICP-afviste leads.</p>;
  }
  return (
    <ul className="divide-y divide-[var(--ink)]/[0.08]">
      {rows.map((r) => {
        const name = leadDisplayName(r);
        return (
          <li key={r.sendpilot_lead_id} className="py-5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-medium text-[var(--ink)]">{name}</span>
              <span className="tabular text-[10px] uppercase tracking-[0.18em] text-[var(--ink)]/45">{r.lead?.title ?? "—"}</span>
            </div>
            <div className="mt-1 tabular text-[11px] text-[var(--ink)]/55">
              {r.lead?.company ?? "(intet firma)"} · score {r.icp_company_score ?? "?"}/{r.icp_person_score ?? "?"}
            </div>
            {r.icp_rationale ? (
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--ink)]/65">{r.icp_rationale}</p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-3">
              <a href={r.linkedin_url} target="_blank" rel="noopener noreferrer"
                className="tabular text-[11px] uppercase tracking-[0.2em] text-[var(--forest)] underline-offset-[6px] hover:underline">
                LinkedIn →
              </a>
              <button onClick={() => onOverride(r.sendpilot_lead_id)} disabled={busyLead === r.sendpilot_lead_id}
                className="tabular text-[11px] uppercase tracking-[0.2em] text-[var(--clay)] underline-offset-[6px] hover:underline disabled:opacity-50">
                Override – send til afventer
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function AltReviewTab({ rows, altsByLead, busyLead, onUseOriginal, onInviteAlt, onRejectOne }: {
  rows: PipelineRow[];
  altsByLead: Map<string, AltContact[]>;
  busyLead: string | null;
  onUseOriginal: (leadId: string) => void;
  onInviteAlt: (altId: string, leadId: string) => void;
  onRejectOne: (r: PipelineRow) => void;
}) {
  if (rows.length === 0) {
    return <p className="tabular py-12 text-center text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/35">Ingen leads under person-review.</p>;
  }
  return (
    <ul className="divide-y divide-[var(--ink)]/[0.08]">
      {rows.map((r) => {
        const name = leadDisplayName(r);
        const alts = altsByLead.get(r.sendpilot_lead_id) ?? [];
        return (
          <li key={r.sendpilot_lead_id} className="py-6">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-medium text-[var(--ink)]">{name}</span>
              <span className="tabular text-[10px] uppercase tracking-[0.18em] text-[var(--ink)]/45">{r.lead?.title ?? "—"}</span>
            </div>
            <div className="mt-1 tabular text-[11px] text-[var(--ink)]/55">
              {r.lead?.company ?? "(intet firma)"} · score {r.icp_company_score ?? "?"}/{r.icp_person_score ?? "?"}
            </div>
            {r.icp_rationale ? (
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--ink)]/65">{r.icp_rationale}</p>
            ) : null}

            <div className="mt-4">
              {r.alt_search_status === "pending" ? (
                <p className="tabular text-[11px] uppercase tracking-[0.2em] text-[var(--ink)]/45">Søger alternative kontakter …</p>
              ) : r.alt_search_status === "empty" || (r.alt_search_status === "completed" && alts.length === 0) ? (
                <p className="tabular text-[11px] uppercase tracking-[0.2em] text-[var(--ink)]/45">
                  Ingen automatiske kandidater – undersøg manuelt på{" "}
                  <a href={r.linkedin_url} target="_blank" rel="noopener noreferrer"
                    className="text-[var(--forest)] underline underline-offset-[3px]">LinkedIn</a>.
                </p>
              ) : r.alt_search_status === "failed" ? (
                <p className="tabular text-[11px] uppercase tracking-[0.2em] text-[var(--clay)]">Søgning fejlede.</p>
              ) : (
                <ul className="space-y-3">
                  {alts.map((a) => (
                    <li key={a.id} className={`rounded-sm border p-3 ${a.acted_on_at ? "border-[var(--forest)]/20 bg-[var(--forest)]/5" : "border-[var(--ink)]/15"}`}>
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <div className="min-w-0">
                          <div className="font-medium text-[var(--ink)]">{a.name}</div>
                          <div className="tabular text-[11px] text-[var(--ink)]/55">
                            {a.title ?? "—"}{a.seniority ? ` · ${a.seniority}` : ""}{a.employees ? ` · ${a.employees}` : ""}
                          </div>
                        </div>
                        <div className="flex shrink-0 gap-3">
                          {a.linkedin_url ? (
                            <a href={a.linkedin_url} target="_blank" rel="noopener noreferrer"
                              className="tabular text-[11px] uppercase tracking-[0.2em] text-[var(--forest)] underline-offset-[6px] hover:underline">
                              LinkedIn →
                            </a>
                          ) : null}
                          {a.acted_on_at ? (
                            <span className="tabular text-[11px] uppercase tracking-[0.2em] text-[var(--forest)]" title={`Inviteret ${fmtRelative(a.acted_on_at)}`}>
                              Inviteret ✓
                            </span>
                          ) : (
                            <button onClick={() => onInviteAlt(a.id, r.sendpilot_lead_id)} disabled={busyLead === r.sendpilot_lead_id}
                              className="tabular text-[11px] uppercase tracking-[0.2em] text-[var(--clay)] underline-offset-[6px] hover:underline disabled:opacity-50">
                              Inviter →
                            </button>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="mt-4 flex flex-wrap gap-4">
              <a href={r.linkedin_url} target="_blank" rel="noopener noreferrer"
                className="tabular text-[11px] uppercase tracking-[0.2em] text-[var(--ink)]/60 underline-offset-[6px] hover:underline">
                Se original-profil →
              </a>
              <button onClick={() => onUseOriginal(r.sendpilot_lead_id)} disabled={busyLead === r.sendpilot_lead_id}
                className="tabular text-[11px] uppercase tracking-[0.2em] text-[var(--ink)]/70 underline-offset-[6px] hover:underline disabled:opacity-50">
                Brug original alligevel →
              </button>
              <button onClick={() => onRejectOne(r)} disabled={busyLead === r.sendpilot_lead_id}
                className="tabular text-[11px] uppercase tracking-[0.2em] text-[var(--ink)]/55 underline-offset-[6px] hover:underline disabled:opacity-50">
                Drop leadet →
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function LaeringTab({ activeIcp, proposals, outcomes, busy, onGenerateProposal, onDecide }: {
  activeIcp: IcpVersion | null;
  proposals: IcpProposal[];
  outcomes: PipelineRow[];
  busy: boolean;
  onGenerateProposal: () => void;
  onDecide: (id: string, decision: "apply" | "reject") => void;
}) {
  const taggedRows = outcomes.filter((r) => r.outcome != null);
  const byOutcome = new Map<string, number>();
  for (const r of taggedRows) {
    if (!r.outcome) continue;
    byOutcome.set(r.outcome, (byOutcome.get(r.outcome) ?? 0) + 1);
  }
  const openProposal = proposals.find((p) => p.status === "open") ?? null;
  const history = proposals.filter((p) => p.status !== "open").slice(0, 10);

  return (
    <div className="mx-auto max-w-3xl py-4 text-[14px] leading-relaxed text-[var(--ink)]/80">
      <p className="tabular text-[10px] uppercase tracking-[0.32em] text-[var(--ink)]/40">Self-improvement loop</p>
      <h2 className="font-display mt-2 text-3xl italic text-[var(--ink)]">Læring</h2>

      <section className="mt-6 rounded-sm border border-[var(--ink)]/15 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <p className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/45">Aktiv ICP-version</p>
            <p className="font-display text-2xl italic text-[var(--ink)]">
              v{activeIcp?.version ?? "—"}
            </p>
          </div>
          <p className="tabular text-[11px] text-[var(--ink)]/45">
            {activeIcp ? `Aktiveret ${fmtRelative(activeIcp.created_at)} af ${activeIcp.created_by ?? "—"}` : "Bruger fallback (factory default)"}
          </p>
        </div>
        {activeIcp?.rationale ? (
          <p className="mt-3 text-[13px] italic text-[var(--ink)]/60">{activeIcp.rationale}</p>
        ) : null}
      </section>

      <section className="mt-6">
        <h3 className="tabular text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/65">
          Tagged outcomes ({taggedRows.length}/{outcomes.length})
        </h3>
        {taggedRows.length === 0 ? (
          <p className="mt-2 text-[13px] text-[var(--ink)]/55">
            Endnu ingen — tag resultater i Sendt-tabben for at fodre læringsloopet.
          </p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-[var(--ink)]/75">
            {OUTCOME_OPTIONS.map((o) => (
              <li key={o.value}>
                <span className="tabular text-[10px] uppercase tracking-[0.18em] text-[var(--ink)]/45">{o.label}</span>{" "}
                <span className="font-medium text-[var(--ink)]">{byOutcome.get(o.value) ?? 0}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h3 className="tabular text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/65">Genereret forslag</h3>
          <button onClick={onGenerateProposal} disabled={busy}
            className="focus-cream tabular rounded-sm border border-[var(--ink)]/15 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/65 hover:border-[var(--ink)]/35 hover:text-[var(--ink)] disabled:opacity-50">
            {busy ? "Genererer…" : "Foreslå tuning"}
          </button>
        </div>

        {openProposal ? (
          <article className="mt-3 rounded-sm border border-[var(--clay)]/40 bg-[var(--clay)]/5 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="tabular text-[10px] uppercase tracking-[0.22em] text-[var(--clay)]">
                Genereret {fmtRelative(openProposal.generated_at)} · {openProposal.contradictions_count} modsigelser
              </span>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--ink)]/85">{openProposal.rationale}</p>

            {openProposal.proposed_company_fit && activeIcp ? (
              <details className="mt-3">
                <summary className="cursor-pointer tabular text-[11px] uppercase tracking-[0.18em] text-[var(--ink)]/60 hover:text-[var(--ink)]">Vis forslag til firma-fit</summary>
                <pre className="mt-2 whitespace-pre-wrap rounded-sm bg-[var(--ink)]/[0.04] p-3 font-sans text-[12px] text-[var(--ink)]/80">{openProposal.proposed_company_fit}</pre>
              </details>
            ) : null}
            {openProposal.proposed_person_fit && activeIcp ? (
              <details className="mt-2">
                <summary className="cursor-pointer tabular text-[11px] uppercase tracking-[0.18em] text-[var(--ink)]/60 hover:text-[var(--ink)]">Vis forslag til person-fit</summary>
                <pre className="mt-2 whitespace-pre-wrap rounded-sm bg-[var(--ink)]/[0.04] p-3 font-sans text-[12px] text-[var(--ink)]/80">{openProposal.proposed_person_fit}</pre>
              </details>
            ) : null}
            {openProposal.proposed_min_company_score != null || openProposal.proposed_min_person_score != null ? (
              <p className="mt-2 tabular text-[11px] text-[var(--ink)]/60">
                Tærskel-forslag:{" "}
                {openProposal.proposed_min_company_score != null ? `min company score = ${openProposal.proposed_min_company_score}` : ""}
                {openProposal.proposed_min_company_score != null && openProposal.proposed_min_person_score != null ? " · " : ""}
                {openProposal.proposed_min_person_score != null ? `min person score = ${openProposal.proposed_min_person_score}` : ""}
              </p>
            ) : null}

            <div className="mt-4 flex flex-wrap gap-3">
              <button onClick={() => onDecide(openProposal.id, "apply")} disabled={busy}
                className="focus-orange tabular rounded-sm bg-[var(--forest)] px-4 py-2 text-[11px] uppercase tracking-[0.22em] text-[var(--cream)] hover:bg-[#2f5e4e] disabled:opacity-50">
                Anvend → ny version
              </button>
              <button onClick={() => onDecide(openProposal.id, "reject")} disabled={busy}
                className="focus-cream tabular rounded-sm border border-[var(--ink)]/15 px-4 py-2 text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/65 hover:border-[var(--ink)]/35 disabled:opacity-50">
                Afvis
              </button>
            </div>
          </article>
        ) : (
          <p className="mt-3 text-[13px] text-[var(--ink)]/55">
            Intet åbent forslag. Tag flere resultater på Sendt, og klik "Foreslå tuning" — Sonnet læser modsigelserne og foreslår prompt-edits.
          </p>
        )}
      </section>

      {history.length > 0 ? (
        <section className="mt-8">
          <h3 className="tabular text-[11px] uppercase tracking-[0.22em] text-[var(--ink)]/65">Historik</h3>
          <ul className="mt-2 divide-y divide-[var(--ink)]/[0.08]">
            {history.map((p) => (
              <li key={p.id} className="py-3 text-[12px]">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className={`tabular uppercase tracking-[0.18em] ${p.status === "applied" ? "text-[var(--forest)]" : "text-[var(--ink)]/45"}`}>
                    {p.status === "applied" ? "Anvendt" : "Afvist"}
                  </span>
                  <span className="tabular text-[11px] text-[var(--ink)]/45">
                    {fmtRelative(p.decided_at ?? p.generated_at)} · {p.contradictions_count} modsigelser
                  </span>
                </div>
                <p className="mt-1 text-[12px] italic text-[var(--ink)]/65">{p.rationale}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
