// Polls each user's private iCal URL (e.g. Google Calendar's "Secret address
// in iCal format") and refreshes user_busy_intervals. Cron'd every 15 min via
// pg_cron + net.http_post — see migration. Idempotent on (user_email, source,
// external_id, start_at) so re-runs are safe.
//
// We use a tiny hand-rolled VEVENT parser instead of npm:node-ical so the
// function stays small and edge-runtime-friendly. Recurring events (RRULE)
// expand using rrule via npm.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

type BusyRow = {
  user_email: string;
  workspace_id: string | null;
  source: string;
  external_id: string | null;
  start_at: string;
  end_at: string;
  summary: string | null;
};

const HORIZON_DAYS = 30;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  const { data: users, error } = await supabase
    .from("user_settings")
    .select("user_email, ical_url, workspace_id")
    .not("ical_url", "is", null);
  if (error) return json({ error: error.message }, 500);

  const summary: Record<string, unknown>[] = [];
  for (const u of users ?? []) {
    if (!u.ical_url) continue;
    const r = await pollOne(u.user_email, u.ical_url, u.workspace_id);
    summary.push({ user: u.user_email, ...r });
  }
  return json({ ok: true, polled: summary });
});

async function pollOne(userEmail: string, url: string, workspaceId: string | null): Promise<{ ok: boolean; events: number; error?: string }> {
  let body: string;
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      await markError(userEmail, `fetch HTTP ${res.status}`);
      return { ok: false, events: 0, error: `fetch HTTP ${res.status}` };
    }
    body = await res.text();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markError(userEmail, `fetch error: ${msg}`);
    return { ok: false, events: 0, error: msg };
  }

  const now = new Date();
  const horizonEnd = new Date(now.getTime() + HORIZON_DAYS * 86400000);

  let intervals: BusyRow[] = [];
  try {
    intervals = parseIcal(body, userEmail, workspaceId, now, horizonEnd);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markError(userEmail, `parse error: ${msg}`);
    return { ok: false, events: 0, error: msg };
  }

  // Drop existing intervals for this user/source within the polled window,
  // then re-insert. Simpler than diff-merging and avoids stale recurring
  // expansions when the source RRULE changes.
  const { error: delErr } = await supabase
    .from("user_busy_intervals")
    .delete()
    .eq("user_email", userEmail)
    .eq("source", "gcal")
    .gte("start_at", now.toISOString());
  if (delErr) {
    await markError(userEmail, `delete error: ${delErr.message}`);
    return { ok: false, events: 0, error: delErr.message };
  }

  if (intervals.length > 0) {
    // Chunked insert (Supabase REST has body size limits).
    const CHUNK = 500;
    for (let i = 0; i < intervals.length; i += CHUNK) {
      const { error: insErr } = await supabase
        .from("user_busy_intervals")
        .insert(intervals.slice(i, i + CHUNK));
      if (insErr) {
        await markError(userEmail, `insert error: ${insErr.message}`);
        return { ok: false, events: i, error: insErr.message };
      }
    }
  }

  await supabase.from("user_settings").update({
    last_synced_at: new Date().toISOString(),
    last_sync_error: null,
  }).eq("user_email", userEmail);

  return { ok: true, events: intervals.length };
}

async function markError(userEmail: string, msg: string) {
  await supabase.from("user_settings").update({
    last_synced_at: new Date().toISOString(),
    last_sync_error: msg.slice(0, 500),
  }).eq("user_email", userEmail);
}

// ---------- iCal parsing ----------

function parseIcal(body: string, userEmail: string, workspaceId: string | null, windowStart: Date, windowEnd: Date): BusyRow[] {
  const out: BusyRow[] = [];
  // Unfold lines: continuation lines start with whitespace.
  const lines = body.replace(/\r\n[ \t]/g, "").split(/\r?\n/);

  let inEvent = false;
  let cur: Record<string, string> = {};

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { inEvent = true; cur = {}; continue; }
    if (line === "END:VEVENT") {
      inEvent = false;
      const ev = expandEvent(cur, userEmail, workspaceId, windowStart, windowEnd);
      out.push(...ev);
      continue;
    }
    if (!inEvent) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const left = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const semi = left.indexOf(";");
    const key = (semi < 0 ? left : left.slice(0, semi)).toUpperCase();
    const params = semi < 0 ? "" : left.slice(semi + 1);
    cur[key] = value;
    if (params) cur[`${key}__PARAMS`] = params;
  }
  return out;
}

function expandEvent(
  ev: Record<string, string>,
  userEmail: string,
  workspaceId: string | null,
  windowStart: Date,
  windowEnd: Date,
): BusyRow[] {
  // Skip cancelled events.
  if ((ev["STATUS"] ?? "").toUpperCase() === "CANCELLED") return [];
  // Skip transparent events (they don't block busy time).
  if ((ev["TRANSP"] ?? "").toUpperCase() === "TRANSPARENT") return [];

  const dtstart = parseIcalDate(ev["DTSTART"], ev["DTSTART__PARAMS"]);
  if (!dtstart) return [];
  let dtend = parseIcalDate(ev["DTEND"], ev["DTEND__PARAMS"]);
  if (!dtend) {
    // No DTEND → use DURATION (rare) or assume 0-length; for all-day events
    // assume 24h.
    if ((ev["DTSTART__PARAMS"] ?? "").includes("VALUE=DATE")) {
      dtend = new Date(dtstart.getTime() + 86400000);
    } else {
      dtend = new Date(dtstart.getTime() + 30 * 60000);
    }
  }
  const duration = dtend.getTime() - dtstart.getTime();

  const uid = ev["UID"] ?? null;
  const summary = ev["SUMMARY"] ?? null;
  const rrule = ev["RRULE"];

  const occurrences: Date[] = [];
  if (rrule) {
    // Lightweight RRULE expander for common Google Calendar patterns.
    occurrences.push(...expandRRule(dtstart, rrule, windowStart, windowEnd));
  } else {
    if (dtend >= windowStart && dtstart <= windowEnd) occurrences.push(dtstart);
  }

  return occurrences.map((start) => ({
    user_email: userEmail,
    workspace_id: workspaceId,
    source: "gcal",
    external_id: uid ? `${uid}@${start.toISOString()}` : null,
    start_at: start.toISOString(),
    end_at: new Date(start.getTime() + duration).toISOString(),
    summary,
  }));
}

// Tiny RRULE expander handling FREQ=DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL,
// COUNT, UNTIL, BYDAY. Skips edge cases (BYMONTHDAY/BYSETPOS/etc.) — those
// events fall through with just their original DTSTART, which is acceptable
// for "free slot" computation since the rare unexpanded recurrence might
// cause us to suggest a slot that's actually busy. We can swap in a real
// library later if accuracy matters.
function expandRRule(dtstart: Date, rrule: string, windowStart: Date, windowEnd: Date): Date[] {
  const params: Record<string, string> = {};
  for (const p of rrule.split(";")) {
    const [k, v] = p.split("=");
    if (k && v != null) params[k.toUpperCase()] = v;
  }
  const freq = params.FREQ;
  const interval = Math.max(1, parseInt(params.INTERVAL ?? "1", 10) || 1);
  const count = params.COUNT ? parseInt(params.COUNT, 10) : null;
  let untilDate: Date | null = null;
  if (params.UNTIL) {
    untilDate = parseIcalDate(params.UNTIL, undefined);
  }
  const limit = new Date(Math.min(windowEnd.getTime(), untilDate?.getTime() ?? windowEnd.getTime()));
  const byday = (params.BYDAY ?? "")
    .split(",")
    .map((d) => d.trim().toUpperCase())
    .filter(Boolean);
  const dayMap: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

  const out: Date[] = [];
  if (!freq || !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) {
    if (dtstart >= windowStart && dtstart <= windowEnd) out.push(dtstart);
    return out;
  }

  // Iterate in steps; cap at 365 to avoid runaway loops.
  let n = 0;
  let cur = new Date(dtstart);
  let step: number;
  switch (freq) {
    case "DAILY": step = 86400000 * interval; break;
    case "WEEKLY": step = 7 * 86400000 * interval; break;
    case "MONTHLY": step = 30 * 86400000 * interval; break;  // approximate
    case "YEARLY": step = 365 * 86400000 * interval; break;
    default: step = 0;
  }

  while (cur <= limit && n < 365) {
    if (count && n >= count) break;
    if (cur >= windowStart) {
      if (byday.length === 0) {
        out.push(new Date(cur));
      } else {
        // Expand BYDAY for the current week (WEEKLY) or honour the spec loosely
        for (const d of byday) {
          const target = dayMap[d.slice(-2)];
          if (target == null) continue;
          const offset = (target - cur.getUTCDay() + 7) % 7;
          const occ = new Date(cur.getTime() + offset * 86400000);
          if (occ >= windowStart && occ <= limit) out.push(occ);
        }
      }
    }
    cur = new Date(cur.getTime() + step);
    n++;
  }
  return out;
}

function parseIcalDate(value: string | undefined, params: string | undefined): Date | null {
  if (!value) return null;
  // Normalise: 20260428T080000Z (UTC), 20260428T080000 (floating), 20260428 (date)
  const v = value.trim();
  if (/^\d{8}$/.test(v)) {
    return new Date(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T00:00:00Z`);
  }
  const m = /^(\d{8})T(\d{6})(Z?)$/.exec(v);
  if (!m) return null;
  const [, ymd, hms, z] = m;
  const iso = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}`;
  if (z === "Z") return new Date(`${iso}Z`);
  // TZID-prefixed local times — interpret in TZID if present, else UTC fallback.
  const tzid = (params ?? "").match(/TZID=([^;]+)/i)?.[1];
  if (!tzid) return new Date(`${iso}Z`);
  // Convert "wall time in tzid" → UTC by stamping with the zone.
  // Trick: Date in JS doesn't directly accept arbitrary IANA tz. We use the
  // toLocaleString round-trip approach.
  return wallTimeInZoneToUtc(iso, tzid);
}

function wallTimeInZoneToUtc(localIsoNoZ: string, tz: string): Date {
  // Treat localIsoNoZ as the wall-clock time in `tz`, return UTC Date.
  const [datePart, timePart] = localIsoNoZ.split("T");
  const [Y, M, D] = datePart.split("-").map(Number);
  const [h, m, s] = timePart.split(":").map(Number);
  // Start with a guess (interpret as UTC), then correct by the offset reported
  // for that instant in the target zone.
  const guessUtc = Date.UTC(Y, M - 1, D, h, m, s);
  // Compute zone offset at guessUtc.
  const dt = new Date(guessUtc);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(dt);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const localised = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const offset = localised - guessUtc;
  return new Date(guessUtc - offset);
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
