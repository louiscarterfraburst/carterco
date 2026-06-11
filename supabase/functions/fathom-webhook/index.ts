// fathom-webhook
//
// Receives Fathom's "new meeting content ready" webhook (fires a few minutes
// after each recorded call finishes processing), matches the meeting to a
// lead, summarizes the transcript with Claude in Danish, and inserts the
// note into lead_conversation_events (channel='note', source='fathom') so
// it shows on the lead's timeline in /leads. Purely event-driven — no cron.
//
// Lead matching, in order:
//   1. external calendar-invitee email ↔ leads.email (ilike) — the same key
//      cal-webhook/calendly-webhook use, so booked meetings always hit
//   2. fallback: corporate domain of an external invitee ↔ leads.email
//      domain, only when exactly one lead matches (colleague joined the
//      call instead of / alongside the booked contact)
//   3. fallback: leads.meeting_at within ±30 min of the meeting start
//      (covers invitees who joined from a different address)
// Internal-only meetings and unmatched recordings are acknowledged and
// dropped — Fathom retries on non-2xx, so never error on "not for us".
//
// Idempotency: source_id = String(recording_id); the partial unique index
// lead_conversation_events_source_key makes webhook retries a no-op.
//
// Setup (docs/fathom-meeting-notes.md): create the webhook with
// scripts/fathom/register-webhook.mjs — include_transcript +
// include_summary + include_action_items, triggered_for my_recordings.
//
// Required env (Functions → Secrets):
//   FATHOM_WEBHOOK_SECRET — whsec_… returned when the webhook is created;
//                           when set, signatures are verified (Svix-style:
//                           webhook-id / webhook-timestamp / webhook-signature)
//   ANTHROPIC_API_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Deployed --no-verify-jwt (Fathom sends no Supabase JWT).

import { createClient } from "npm:@supabase/supabase-js@2.103.3";
import {
  buildTranscriptText,
  corporateDomains,
  durationMinutes,
  externalInviteeEmails,
  type FathomInvitee,
  type FathomTranscriptItem,
  type LeadCandidate,
  matchLeadByMeetingTime,
  MEETING_MATCH_TOLERANCE_MS,
  noteSubject,
  truncateTranscript,
  verifyFathomSignature,
} from "../_shared/fathom-notes.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, webhook-id, webhook-timestamp, webhook-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUMMARY_SYSTEM = `Du skriver interne mødenoter for Louis Carter (Carter & Co) ud fra et transkript af en salgssamtale. Skriv på dansk, kort og konkret. Brug præcis disse linjestartere og udelad sektioner uden indhold:

Resultat: én linje om hvor samtalen landede.
Situation: kundens setup og smerter, 2-4 linjer.
Indvendinger: hvad holdt dem tilbage, hvis noget.
Næste skridt: hvad blev aftalt, med dato hvis nævnt.

Ingen indledning, ingen markdown, ingen gentagelse af transkriptet.`;

type FathomPayload = {
  recording_id?: number | string;
  title?: string | null;
  meeting_title?: string | null;
  url?: string | null;
  share_url?: string | null;
  meeting_url?: string | null;
  scheduled_start_time?: string | null;
  scheduled_end_time?: string | null;
  recording_start_time?: string | null;
  recording_end_time?: string | null;
  calendar_invitees_domains_type?: string | null;
  calendar_invitees?: FathomInvitee[];
  transcript?: FathomTranscriptItem[];
  default_summary?: { markdown_formatted?: string | null } | null;
  action_items?: unknown[];
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method === "GET") return json({ ok: true, name: "fathom-webhook" });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const rawBody = await request.text();

  const secret = Deno.env.get("FATHOM_WEBHOOK_SECRET");
  if (secret) {
    const ok = await verifyFathomSignature(
      {
        id: request.headers.get("webhook-id"),
        timestamp: request.headers.get("webhook-timestamp"),
        signature: request.headers.get("webhook-signature"),
      },
      rawBody,
      secret,
    );
    if (!ok) return json({ error: "Invalid signature" }, 401);
  }

  let payload: FathomPayload | null = null;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const recordingId = payload?.recording_id != null ? String(payload.recording_id) : null;
  if (!recordingId) return json({ error: "Missing recording_id" }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Missing Supabase env" }, 500);
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // Internal meeting (no external invitees) — not a sales call, drop early.
  if (payload?.calendar_invitees_domains_type === "only_internal") {
    return json({ ok: true, ignored: "only_internal" });
  }

  const startedAt = payload?.recording_start_time ??
    payload?.scheduled_start_time ?? null;

  // 1. Match by external invitee email — the same key the booking webhooks
  //    write, so a cal.com-booked meeting always resolves here.
  let lead: LeadCandidate | null = null;
  const emails = externalInviteeEmails(payload?.calendar_invitees ?? []);
  for (const email of emails) {
    const { data, error } = await supabase
      .from("leads")
      .select("id, workspace_id, name, company, email, meeting_at")
      .eq("is_draft", false)
      .ilike("email", email)
      .limit(1);
    if (error) return json({ error: error.message }, 500);
    if (data && data.length > 0) {
      lead = data[0];
      break;
    }
  }

  // 2. Fallback: corporate domain of an external invitee — covers the
  //    common case where a colleague of the booked contact sits in the
  //    call (e.g. jjk@ joins while the lead row is cad@ same domain).
  //    Free-mail domains are excluded, and an ambiguous domain (several
  //    leads) matches nothing: a call note on the wrong person's timeline
  //    is worse than no note.
  if (!lead) {
    for (const domain of corporateDomains(emails)) {
      const { data, error } = await supabase
        .from("leads")
        .select("id, workspace_id, name, company, email, meeting_at")
        .eq("is_draft", false)
        .ilike("email", `%@${domain}`)
        .limit(2);
      if (error) return json({ error: error.message }, 500);
      if (data && data.length === 1) {
        lead = data[0];
        break;
      }
    }
  }

  // 3. Fallback: booked meeting time.
  if (!lead && startedAt) {
    const windowStart = new Date(
      Date.parse(startedAt) - MEETING_MATCH_TOLERANCE_MS,
    ).toISOString();
    const windowEnd = new Date(
      Date.parse(startedAt) + MEETING_MATCH_TOLERANCE_MS,
    ).toISOString();
    const { data, error } = await supabase
      .from("leads")
      .select("id, workspace_id, name, company, email, meeting_at")
      .eq("is_draft", false)
      .not("meeting_at", "is", null)
      .gte("meeting_at", windowStart)
      .lte("meeting_at", windowEnd);
    if (error) return json({ error: error.message }, 500);
    lead = matchLeadByMeetingTime(data ?? [], startedAt);
  }

  if (!lead) {
    // Not an error: Fathom retries non-2xx, and "no matching lead" is final.
    return json({ ok: true, ignored: "no_lead_match", recording_id: recordingId });
  }

  const transcriptText = truncateTranscript(
    buildTranscriptText(payload?.transcript ?? []),
  );
  const fathomSummary = payload?.default_summary?.markdown_formatted?.trim() ?? "";
  const summaryInput = transcriptText || fathomSummary;
  if (!summaryInput) {
    return json({ ok: true, ignored: "no_content", recording_id: recordingId });
  }

  let body: string;
  try {
    body = await summarize(summaryInput, lead, startedAt);
  } catch (e) {
    // Non-2xx → Fathom redelivers later, so a transient Claude failure
    // retries instead of dropping the note.
    return json({ error: `summarize failed: ${msg(e)}` }, 502);
  }

  const durationMin = durationMinutes(
    payload?.recording_start_time,
    payload?.recording_end_time,
  );
  const { error: insertErr } = await supabase
    .from("lead_conversation_events")
    .insert({
      lead_id: lead.id,
      workspace_id: lead.workspace_id ?? null,
      channel: "note",
      direction: "internal",
      occurred_at: startedAt ?? new Date().toISOString(),
      subject: noteSubject(payload?.meeting_title ?? payload?.title, durationMin),
      body,
      source: "fathom",
      source_id: recordingId,
      metadata: {
        recording_id: recordingId,
        fathom_url: payload?.url ?? null,
        share_url: payload?.share_url ?? null,
        meeting_url: payload?.meeting_url ?? null,
        meeting_title: payload?.meeting_title ?? payload?.title ?? null,
        started_at: startedAt,
        ended_at: payload?.recording_end_time ?? null,
        duration_minutes: durationMin,
        invitees: (payload?.calendar_invitees ?? []).map((i) => ({
          name: i.name ?? null,
          email: i.email ?? null,
          is_external: i.is_external ?? null,
        })),
        action_items: payload?.action_items ?? [],
        fathom_summary: fathomSummary || null,
        transcript: transcriptText || null,
      },
    });
  if (insertErr) {
    // Unique (source, source_id) — webhook redelivery, already stored.
    if (`${insertErr.message}`.includes("duplicate key")) {
      return json({ ok: true, duplicate: true, recording_id: recordingId });
    }
    return json({ error: insertErr.message }, 500);
  }

  return json({ ok: true, lead_id: lead.id, recording_id: recordingId });
});

async function summarize(
  input: string,
  lead: LeadCandidate,
  startedAt: string | null,
): Promise<string> {
  if (!ANTHROPIC_API_KEY) throw new Error("Missing ANTHROPIC_API_KEY");
  const who = [lead.name, lead.company].filter(Boolean).join(" · ") ||
    lead.email || "ukendt lead";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 700,
      system: SUMMARY_SYSTEM,
      messages: [{
        role: "user",
        content: `Lead: ${who}\nMødestart: ${startedAt ?? "ukendt"}\n\nTranskript:\n${input}`,
      }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`anthropic ${res.status}: ${body.slice(0, 200)}`);
  }
  const body = await res.json();
  const blocks = (body.content ?? []) as Array<{ type: string; text?: string }>;
  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("anthropic returned empty summary");
  return text;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
