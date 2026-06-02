// Becc-bucket personalization hook generator (CarterCo's own outbound).
//
// For an accepted CarterCo lead, pulls the prospect's recent LinkedIn posts via
// Apify, then has Haiku write the single opening LINE of the video DM, floor-up:
//   Bucket 1 (original post) / Bucket 2 (repost) > Bucket 3 (role pain).
// Job-search / job-change / personal posts are dropped to the role floor. The
// line is validated (complete clause, ends in colon, no fabrication/meta) with
// one retry, then written onto the pipeline row. sendspark-webhook bakes it into
// rendered_message at render-ready.
//
// Ported from the validated scripts/bucket-hooks/generate_hooks.py.

import { CARTERCO_WORKSPACE_ID } from "./workspaces.ts";

const HAIKU = "claude-haiku-4-5-20251001";
const POSTS_ACTOR = "harvestapi~linkedin-profile-posts";
const FRESH_DAYS = 90;

// deno-lint-ignore no-explicit-any
type AdminClient = { from: (t: string) => any };

type Post = { text: string; age_days: number; is_repost: boolean };
type HookResult = { hook: string; bucket: string; reasoning: string; language?: string; _retried?: string };

const SYS_PROMPT =
`You write the single opening LINE of a cold LinkedIn message for Carter & Co (sender: Louis, Denmark). The message carries a short personalized video. Your line REPLACES this generic line and must lead naturally into the video link that follows it:
"Jeg var lige inde på {website} og optog en kort video om én ting, jeg tror I mister lidt værdi på:"

HARD RULES:
- LANGUAGE: write the ENTIRE hook in the language named by the "WRITE IN" directive at the top of the user message. This is non-negotiable — do not switch to Danish if the directive says English.
- Measured, direct operator voice. No hype, no emojis, no flattery, no buzzwords.
- NEVER fabricate. Only use the signals given. No "jeg så din demo / deltog i / elskede" claims.
- NEVER invent statistics, percentages, or numbers. Banned: "10-15%", "de fleste virksomheder mister X", "3x", any made-up figure. Speak qualitatively, never with fake precision.
- NATURAL DANISH, not Danglish. In a Danish hook use Danish business vocabulary. Do NOT pepper it with English jargon (avoid "sales enablement", "deal progression", "revenue", "actual"). At most ONE English term, and only if genuinely standard in Danish (e.g. "pipeline", "leads").
- ONE sentence, ~25 words max. Tight and punchy beats two clauses.
- VARY your phrasing. Do not lean on one stock metaphor — "værdi/tid siver væk" is overused; reach for the specific friction (dobbeltarbejde, leads der køler af, manuel rapportering, deals der taber fart, overblik der mangler). Each hook reads as individually written.
- The line MUST end in a colon (:) that leads naturally into the video link on the next line. Never end on a dangling preposition (not "... mister værdi på:"). The clause before the colon must be complete.

PERSONALIZATION PRIORITY (use the HIGHEST bucket that has a credible signal):
  Bucket 1 = an ORIGINAL recent post the prospect wrote ABOUT A TOPIC (reference as "dit opslag om ...").
  Bucket 2 = a REPOST the prospect shared (reference as "du delte ...").
  Bucket 3 = their ROLE — open from the concrete pain their title actually owns.
"bucket" in the output is ALWAYS one of "1", "2", or "3" — never "DROP" or anything else. You ALWAYS write a real, sendable hook. "Dropping" a post means silently ignore it and write a Bucket-3 role hook. NEVER tell the prospect you are skipping them, NEVER write a meta-comment about their post — the prospect reads this line.
IGNORE and never reference (write a Bucket-3 role hook instead if these are the only posts):
  - Job-search OR job-change/career-move posts: "søger nyt job", "leaving X", "next adventure", "excited to join", "after N years it's time", new-role / departure announcements. A post about the prospect's OWN career move is off limits even if recent and positive.
  - Pure hiring/recruiting posts ("vi søger en sælger").
  - Personal / humblebrag: marathons, holidays, anniversaries, personal milestones.
  - Anything not a substantive professional point about a topic in their field.
BUCKET 3 FLOOR RULE: open from the pain the title owns, or a concrete observation about the company's setup. NEVER say "jeg var inde på din profil" / "I looked at your profile" — that reads as profile-stalking. Lead with the role's actual pain.

Output ONLY JSON, no fences:
{"hook": "...", "bucket": "1|2|3", "reasoning": "one short sentence", "language": "da|en"}`;

const LANG_NAME: Record<string, string> = { da: "Danish", en: "English" };

const FOREIGN_MARKERS = [" le ", " la ", " les ", " des ", " une ", " qu'", "l'", "d'", " et ",
  " que ", " qui ", " pas ", "après", " für ", " und ", " mit ", " der ", " el ", " los ", " para ", " con "];

// Danish default (CarterCo is a DK operator; Danes posting in English still get
// Danish). Flip to English only when posts are clearly in a foreign language.
function detectTargetLang(posts: Post[]): "da" | "en" {
  const blob = posts.map((p) => p.text.toLowerCase()).join(" ");
  if (!blob.trim()) return "da";
  const count = (s: string, m: string) => s.split(m).length - 1;
  const foreign = FOREIGN_MARKERS.reduce((n, m) => n + count(blob, m), 0);
  const danish = count(blob, "æ") + count(blob, "ø") + count(blob, "å") +
    [" og ", " jeg ", " ikke ", " som ", " til "].reduce((n, m) => n + count(blob, m), 0);
  return foreign >= 3 && foreign > danish ? "en" : "da";
}

const PREPS = new Set(["på", "til", "om", "med", "for", "af", "i", "ved", "fra", "over",
  "under", "mod", "uden", "ad", "efter", "on", "to", "of", "with", "in", "at"]);
const INCOMPLETE = new Set(["skulle", "kunne", "ville", "måtte", "at", "og", "men", "fordi",
  "som", "der", "hvor", "hvis", "når", "the", "a", "and", "that"]);
const META = ["springer over", "skal du handle", "off-limits", "off limits",
  "jeg kan ikke", "i can't", "i'll skip", "i will skip"];

function validateHook(out: HookResult): string | null {
  const h = (out.hook || "").trim();
  if (!h) return "empty hook";
  if (!["1", "2", "3"].includes(String(out.bucket))) return `bucket must be 1/2/3, got '${out.bucket}'`;
  if (!h.endsWith(":")) return "must end with a colon leading into the video";
  const stem = h.replace(/:+$/, "").trim().split(/\s+/);
  const last = (stem[stem.length - 1] || "").toLowerCase().replace(/[,.]/g, "");
  if (PREPS.has(last) || INCOMPLETE.has(last)) return `incomplete clause before the colon (ends '${last}:')`;
  if (h.split(/\s+/).length > 34) return "too long — one tight sentence, ~25 words";
  const low = h.toLowerCase();
  for (const bad of META) if (low.includes(bad)) return `meta-comment to the prospect ('${bad}')`;
  return null;
}

async function anthropic(user: string): Promise<HookResult> {
  const key = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: HAIKU, max_tokens: 500, system: SYS_PROMPT, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`haiku ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const body = await res.json();
  const txt = ((body.content ?? []) as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
  const s = txt.indexOf("{"), e = txt.lastIndexOf("}");
  try {
    return JSON.parse(txt.slice(s, e + 1)) as HookResult;
  } catch {
    return { hook: "", bucket: "?", reasoning: "parse-fail" };
  }
}

async function draftHook(user: string): Promise<HookResult> {
  let out = await anthropic(user);
  const err = validateHook(out);
  if (err) {
    out = await anthropic(user +
      `\n\nYour previous hook was REJECTED: ${err}. Rewrite the hook fixing exactly that. Keep bucket and language the same.`);
    out._retried = err;
  }
  return out;
}

function buildUser(name: string, title: string, company: string, posts: Post[], lang: "da" | "en"): string {
  const lines = [`WRITE IN: ${LANG_NAME[lang]}`, "", `Prospect: ${name} — ${title} at ${company}.`];
  if (posts.length) {
    lines.push("Recent posts (<=90 days):");
    for (const p of posts) lines.push(`- [${p.is_repost ? "REPOST" : "ORIGINAL"}, ${p.age_days}d ago] ${p.text}`);
  } else {
    lines.push("No fresh posts found — use Bucket 3 (role).");
  }
  return lines.join("\n");
}

async function fetchPosts(linkedinUrl: string): Promise<Post[]> {
  const token = Deno.env.get("APIFY_API_TOKEN") ?? "";
  if (!token) return [];
  const url = `https://api.apify.com/v2/acts/${POSTS_ACTOR}/run-sync-get-dataset-items?token=${token}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetUrls: [linkedinUrl], maxPosts: 6, includeReposts: true, includeQuotePosts: true }),
  });
  if (!res.ok) throw new Error(`apify ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
  const arr = await res.json();
  if (!Array.isArray(arr)) return [];
  const now = Date.now();
  const out: Post[] = [];
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    const ts = it.postedAt?.timestamp;
    const age = ts ? (now - ts) / 86400000 : 999;
    if (age > FRESH_DAYS) continue;
    const text = String(it.content ?? it.text ?? "").trim();
    if (!text) continue;
    out.push({ text: text.slice(0, 600), age_days: Math.round(age), is_repost: Boolean(it.repost) });
  }
  return out;
}

/**
 * Generate + persist the bucket hook for one accepted CarterCo lead.
 * Best-effort: any failure (Apify/Haiku) leaves personalized_hook null so the
 * render falls back to the static Bucket-6 website line. CarterCo-only.
 */
export async function generateBucketHook(
  admin: AdminClient,
  leadId: string,
): Promise<{ ok: true; hook: string; bucket: string } | { ok: false; reason: string }> {
  const { data: pipe } = await admin
    .from("outreach_pipeline")
    .select("sendpilot_lead_id, contact_email, workspace_id, linkedin_url")
    .eq("sendpilot_lead_id", leadId)
    .maybeSingle();
  if (!pipe) return { ok: false, reason: "pipeline row not found" };
  if (pipe.workspace_id !== CARTERCO_WORKSPACE_ID) return { ok: false, reason: "not CarterCo workspace" };

  const { data: lead } = await admin
    .from("outreach_leads")
    .select("first_name, last_name, title, company, linkedin_url")
    .eq("contact_email", pipe.contact_email ?? "")
    .maybeSingle();
  if (!lead) return { ok: false, reason: "lead not found" };

  const linkedinUrl = (lead.linkedin_url || pipe.linkedin_url || "").trim();
  if (!linkedinUrl) return { ok: false, reason: "no linkedin_url" };

  let posts: Post[] = [];
  try {
    posts = await fetchPosts(linkedinUrl);
  } catch (e) {
    // Non-blocking: fall through to the role floor (Bucket 3) with no posts.
    console.warn("bucket-hook: apify posts fetch failed, using role floor:", (e as Error).message);
  }

  const name = `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim();
  const lang = detectTargetLang(posts);
  const out = await draftHook(buildUser(name, lead.title ?? "(unknown)", lead.company ?? "(unknown)", posts, lang));

  const finalErr = validateHook(out);
  if (finalErr) return { ok: false, reason: `hook failed validation: ${finalErr}` };

  await admin.from("outreach_pipeline").update({
    personalized_hook: out.hook.trim(),
    hook_bucket: String(out.bucket),
    hook_trace: (out.reasoning ?? "").slice(0, 500),
    hook_lang: lang,
    hook_generated_at: new Date().toISOString(),
  }).eq("sendpilot_lead_id", leadId);

  return { ok: true, hook: out.hook.trim(), bucket: String(out.bucket) };
}
