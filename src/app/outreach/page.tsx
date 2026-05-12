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

const VAPID_PUBLIC_KEY =
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ??
  "BFxkts1k-dL9mbX23uPtalmaBnt-bHfXL4Xn7E6xImhFd1XlKR_mFHVXLfELe2PIVoM-c4a3_M9YXIOAlhooFUM";

type Status =
  | "invited"
  | "accepted"
  | "pending_pre_render"
  | "rendering"
  | "rendered"
  | "pending_approval"
  | "sent"
  | "rejected"
  | "rejected_by_icp"
  | "pending_alt_review"
  | "failed"
  | "pre_connected";

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
  lead?: LeadEnrich;
};

type AltContact = {
  id: string;
  pipeline_lead_id: string;
  name: string;
  linkedin_url: string;
  title: string | null;
  seniority: string | null;
  employees: string | null;
  company: string | null;
  source: "sendpilot" | "team_page" | "reply_referral";
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
  lead?: LeadEnrich;
};

type Tab = "inbox" | "replies" | "sent" | "all" | "icp_rejected" | "icp";

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
  const [altContacts, setAltContacts] = useState<AltContact[]>([]);
  const [activeIcp, setActiveIcp] = useState<IcpVersion | null>(null);
  const [icpProposals, setIcpProposals] = useState<IcpProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyLead, setBusyLead] = useState<string | null>(null);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [editing, setEditing] = useState<{ leadId: string; message: string } | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>("inbox");
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
  }, [activeWorkspaceId, supabase]);

  const scheduleReload = useCallback(() => {
    if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => void load(), 600);
  }, [load]);

  useEffect(() => {
    if (user && activeWorkspaceId) void Promise.resolve().then(load);
  }, [user, activeWorkspaceId, load]);

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

  async function markReplyHandled(replyId: string) {
    const { error } = await supabase
      .from("outreach_replies")
      .update({ handled: true, handled_at: new Date().toISOString(), handled_by: user?.email ?? null })
      .eq("id", replyId);
    if (error) setErr(error.message); else await load();
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
    setUser(null); setRows([]); setReplies([]); setAltContacts([]);
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
      const arr = m.get(a.pipeline_lead_id) ?? [];
      arr.push(a);
      m.set(a.pipeline_lead_id, arr);
    }
    return m;
  }, [altContacts]);

  const sparkline = useMemo(() => buildSparkline(rows, 30), [rows]);
  // Only inbound replies count as "unhandled" — outbound messages are by
  // definition already our own action.
  const unhandledReplies = useMemo(
    () => replies.filter((r) => r.direction === "inbound" && !r.handled),
    [replies],
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

  return (
    <main className="safe-screen safe-pad-bottom relative min-h-screen overflow-x-hidden bg-[var(--sand)] text-[var(--ink)]">
      <div className="grain-overlay" />

      <Header
        pushStatus={pushStatus} onEnablePush={enableNotifications}
        onReload={load} onSignOut={signOut}
        workspaces={workspaces}
        activeWorkspace={activeWorkspace}
        onWorkspaceChange={chooseWorkspace}
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

      <Tabs tab={tab} setTab={setTab} showIcpTabs={hasActiveIcp} counts={{
        inbox: stats.pending + accepted.length + altReview.length,
        replies: unhandledReplies.length,
        sent: stats.sent,
        all: stats.total,
        icp_rejected: icpRejected.length,
        icp_open_proposals: icpProposals.filter((p) => p.status === "open").length,
      }} />

      <section className="mx-auto w-full max-w-[1400px] px-4 pb-12 sm:px-8 lg:px-12">
        {tab === "inbox" ? (
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
        ) : (
          <AllTab rows={allRecent} />
        )}
      </section>
    </main>
  );
}

// ============================== sub-components ==============================

function Header({ pushStatus, onEnablePush, onReload, onSignOut, workspaces, activeWorkspace, onWorkspaceChange }: {
  pushStatus: string; onEnablePush: () => Promise<void>;
  onReload: () => Promise<void>; onSignOut: () => Promise<void>;
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  onWorkspaceChange: (id: string) => void;
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
          <button type="button" onClick={() => void onEnablePush()}
            className="focus-cream tabular rounded-sm border border-[var(--ink)]/15 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/65 hover:border-[var(--ink)]/35 hover:text-[var(--ink)]"
            title="Push-notifikationer"
          >Push: {pushStatus}</button>
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
            <dt className="tabular mt-1 text-[10px] uppercase tracking-[0.22em] text-[var(--ink)]/45">{s.label}</dt>
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

function Tabs({ tab, setTab, showIcpTabs, counts }: {
  tab: Tab; setTab: (t: Tab) => void;
  showIcpTabs: boolean;
  counts: {
    inbox: number; replies: number; sent: number; all: number;
    icp_rejected: number; icp_open_proposals: number;
  };
}) {
  const all: { id: Tab; label: string; count: number; accent?: boolean; icpOnly?: boolean }[] = [
    { id: "inbox", label: "Indbakke", count: counts.inbox, accent: counts.inbox > 0 },
    { id: "replies", label: "Svar", count: counts.replies, accent: counts.replies > 0 },
    { id: "sent", label: "Sendt", count: counts.sent },
    { id: "icp_rejected", label: "ICP-afvist", count: counts.icp_rejected, icpOnly: true },
    { id: "all", label: "Alle", count: counts.all },
    { id: "icp", label: "Læring", count: counts.icp_open_proposals, accent: counts.icp_open_proposals > 0, icpOnly: true },
  ];
  const items = all.filter((it) => !it.icpOnly || showIcpTabs);
  return (
    <nav className="mx-auto mt-2 mb-4 w-full max-w-[1400px] px-4 sm:px-8 lg:px-12">
      <div className="flex gap-1 overflow-x-auto border-b border-[var(--ink)]/10">
        {items.map((it) => {
          const active = it.id === tab;
          return (
            <button key={it.id} type="button" onClick={() => setTab(it.id)}
              className={`relative tabular flex items-baseline gap-1.5 whitespace-nowrap px-3 py-2 text-[12px] uppercase tracking-[0.22em] transition ${
                active
                  ? "text-[var(--ink)] font-semibold"
                  : "text-[var(--ink)]/50 hover:text-[var(--ink)]/80"
              }`}>
              <span>{it.label}</span>
              <span className={`tabular text-[10px] ${it.accent ? "text-[var(--clay)]" : "text-[var(--ink)]/40"}`}>
                {it.count}
              </span>
              {active ? (
                <span className="absolute inset-x-0 -bottom-px h-[2px] bg-[var(--clay)]" />
              ) : null}
            </button>
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
                    {/* video preview / thumbnail */}
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

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <div className="font-display text-2xl italic leading-tight tracking-tight text-[var(--ink)]">
                          {r.lead?.first_name} {r.lead?.last_name}
                        </div>
                        <div className="flex items-center gap-2">
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

function RepliesTab({ replies, referralsByLead, busyLead, onMarkHandled, onInviteAlt, onSendReply }: {
  replies: Reply[];
  referralsByLead: Map<string, AltContact[]>;
  busyLead: string | null;
  onMarkHandled: (id: string) => void;
  onInviteAlt: (altId: string, leadId: string) => void;
  onSendReply: (replyId: string, messageOverride: string) => Promise<boolean>;
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
                            Markér behandlet
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
                      {!isOutbound && r.suggested_reply ? (
                        <SuggestedReply replyId={r.id} text={r.suggested_reply} onSend={onSendReply} />
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

function SuggestedReply({ replyId, text, onSend }: {
  replyId: string;
  text: string;
  onSend: (replyId: string, messageOverride: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(text);
  const [editing, setEditing] = useState(false);
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;

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
        <span>✦ Foreslået svar</span>
        <div className="flex gap-1">
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
          label="Godkend videoer"
          hint="Rendered videoer afventer godkendelse — godkend for at sende beskeden."
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
        const name = `${r.lead?.first_name ?? ""} ${r.lead?.last_name ?? ""}`.trim() || "?";
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
        const name = `${r.lead?.first_name ?? ""} ${r.lead?.last_name ?? ""}`.trim() || "?";
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
