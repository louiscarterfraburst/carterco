// Cron-triggered (daily, weekdays 07:00 UTC). For each tracked_companies row
// due for a refresh:
//   1. Fetch the careers page via Jina Reader (Markdown).
//   2. Parse it with Haiku → JSON list of active job postings.
//   3. Upsert into job_postings; for each NEW row, push-notify subscribers.
//   4. Mark previously-open postings not seen this poll as closed_at = now().
// Notification format mirrors notify-new-lead / notify-pending-approval:
//   title = "<Workspace> /hiring · <Company> — <Role>"
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.103.3";
import webpush from "npm:web-push@3.6.7";
import { workspaceLabel } from "../_shared/workspaces.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const JINA_API_KEY = Deno.env.get("JINA_API_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const POLL_STALE_HOURS = Number(Deno.env.get("HIRING_POLL_STALE_HOURS") ?? "20");

type TrackedCompany = {
  id: string;
  workspace_id: string;
  name: string;
  careers_url: string;
};

type ParsedPosting = {
  title: string;
  snippet?: string;
  source_url?: string;
};

type PushSubscriptionRow = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

type WebPushError = Error & { statusCode?: number };

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method === "GET") return json({ ok: true, name: "track-job-postings" });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const vapidSubject = Deno.env.get("VAPID_SUBJECT") ?? "mailto:louis@carterco.dk";
  const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
  const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
  if (vapidPublicKey && vapidPrivateKey) {
    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  }

  const cutoff = new Date(Date.now() - POLL_STALE_HOURS * 3600 * 1000).toISOString();
  const { data: companies, error: fetchErr } = await supabase
    .from("tracked_companies")
    .select("id, workspace_id, name, careers_url")
    .or(`last_polled_at.is.null,last_polled_at.lt.${cutoff}`)
    .order("last_polled_at", { ascending: true, nullsFirst: true })
    .limit(200);
  if (fetchErr) return json({ error: fetchErr.message }, 500);

  const summary: Array<Record<string, unknown>> = [];
  for (const company of (companies ?? []) as TrackedCompany[]) {
    summary.push(await pollCompany(company));
  }
  return json({ ok: true, polled: summary.length, summary });
});

async function pollCompany(c: TrackedCompany): Promise<Record<string, unknown>> {
  const pollStartedAt = new Date().toISOString();
  try {
    const markdown = await jinaRead(c.careers_url);
    const postings = await haikuParsePostings(c.name, markdown);
    let inserted = 0;
    let updated = 0;
    let pushed = 0;

    for (const p of postings) {
      const title = (p.title ?? "").trim();
      if (!title) continue;
      const postingKey = normaliseKey(title);
      const existing = await supabase
        .from("job_postings")
        .select("id, closed_at")
        .eq("tracked_company_id", c.id)
        .eq("posting_key", postingKey)
        .maybeSingle();

      if (existing.data) {
        await supabase
          .from("job_postings")
          .update({
            last_seen_at: pollStartedAt,
            closed_at: null,
            title,
            snippet: (p.snippet ?? "").slice(0, 280) || null,
            source_url: p.source_url ?? null,
          })
          .eq("id", existing.data.id);
        updated++;
      } else {
        const { error: insErr } = await supabase.from("job_postings").insert({
          workspace_id: c.workspace_id,
          tracked_company_id: c.id,
          posting_key: postingKey,
          title,
          snippet: (p.snippet ?? "").slice(0, 280) || null,
          source_url: p.source_url ?? null,
          first_seen_at: pollStartedAt,
          last_seen_at: pollStartedAt,
        });
        if (insErr) {
          console.error("insert posting failed", { company: c.name, title, err: insErr.message });
          continue;
        }
        inserted++;
        if (vapidConfigured()) {
          const sent = await fanOutPush(c, title, p.snippet ?? "");
          pushed += sent;
        }
      }
    }

    // Anything we had open that wasn't seen this poll → closed.
    const { data: closedRows } = await supabase
      .from("job_postings")
      .update({ closed_at: pollStartedAt })
      .eq("tracked_company_id", c.id)
      .is("closed_at", null)
      .lt("last_seen_at", pollStartedAt)
      .select("id");
    const closed = (closedRows ?? []).length;

    await supabase
      .from("tracked_companies")
      .update({
        last_polled_at: pollStartedAt,
        last_poll_status: "ok",
        last_poll_error: null,
      })
      .eq("id", c.id);

    return { company: c.name, inserted, updated, closed, pushed };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase
      .from("tracked_companies")
      .update({
        last_polled_at: pollStartedAt,
        last_poll_status: "error",
        last_poll_error: msg.slice(0, 500),
      })
      .eq("id", c.id);
    return { company: c.name, error: msg.slice(0, 500) };
  }
}

function vapidConfigured(): boolean {
  return Boolean(Deno.env.get("VAPID_PUBLIC_KEY") && Deno.env.get("VAPID_PRIVATE_KEY"));
}

function normaliseKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

async function jinaRead(url: string): Promise<string> {
  const target = "https://r.jina.ai/" + url;
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0",
    "Accept": "text/plain",
  };
  if (JINA_API_KEY) headers["Authorization"] = `Bearer ${JINA_API_KEY}`;
  const res = await fetch(target, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`jina ${res.status}: ${body.slice(0, 200)}`);
  }
  const text = await res.text();
  // Cap input we send to Haiku — careers pages can be huge.
  return text.slice(0, 40_000);
}

const HAIKU_SYSTEM = `You extract active job openings from the Markdown of a careers page.
Return ONLY a JSON array, no markdown fences, no commentary.
Each element: {"title": string, "snippet": string, "source_url": string?}.
Rules:
- Include only currently-open job postings. Skip "we're not hiring" copy, internships listed but closed, perks/benefits, application FAQs, generic CTA buttons, and team-photo captions.
- title = the role exactly as displayed (preserve language: Danish or English).
- snippet = up to 200 chars summarising location/department/seniority if present in the page; otherwise "".
- source_url = the per-posting link if the page exposes one; otherwise omit.
- If the page lists no active openings, return [].`;

async function haikuParsePostings(company: string, markdown: string): Promise<ParsedPosting[]> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      system: HAIKU_SYSTEM,
      messages: [{
        role: "user",
        content: `Company: ${company}\n\nCareers page (Markdown):\n${markdown}`,
      }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`haiku ${res.status}: ${body.slice(0, 200)}`);
  }
  const body = await res.json();
  const blocks = (body.content ?? []) as Array<{ type: string; text?: string }>;
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
  // Haiku occasionally wraps in ```json fences and/or appends prose after the
  // array despite the instruction. Strip fences, then extract from the first
  // '[' to the matching ']' so trailing commentary doesn't break JSON.parse.
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  const slice = start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped;
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    throw new Error(`haiku returned non-JSON: ${stripped.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("haiku output not an array");
  return parsed.filter((p): p is ParsedPosting =>
    typeof p === "object" && p !== null && typeof (p as ParsedPosting).title === "string"
  );
}

async function fanOutPush(c: TrackedCompany, title: string, snippet: string): Promise<number> {
  const { data: subs } = await supabase
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("workspace_id", c.workspace_id);
  if (!subs || subs.length === 0) return 0;

  const payload = JSON.stringify({
    title: `${workspaceLabel(c.workspace_id)} /hiring · ${c.name} — ${title}`,
    body: snippet || `Ny stilling hos ${c.name}`,
    url: "/hiring",
  });

  const results = await Promise.allSettled(
    (subs as PushSubscriptionRow[]).map((sub) =>
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      ),
    ),
  );

  // Clean up expired endpoints (matches notify-new-lead behaviour).
  const expired: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      const reason = r.reason as WebPushError;
      if (reason.statusCode === 404 || reason.statusCode === 410) {
        expired.push((subs as PushSubscriptionRow[])[i].endpoint);
      } else {
        console.error("hiring push failed", reason);
      }
    }
  });
  if (expired.length > 0) {
    await supabase.from("push_subscriptions").delete().in("endpoint", expired);
  }
  return results.filter((r) => r.status === "fulfilled").length;
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
