// Sequential Becc-bucket personalization waterfall (CarterCo's own outbound).
//
// On accept, cascade through buckets best-first and STOP at the first one with a
// genuinely connected line:
//   1 self-authored posts -> 2 engaged -> 3 self-written -> 5 background
//   -> 6 company (deep: site + careers + news) -> floor (honest line).
// Only scrape what isn't already scraped (cheapest/highest first; deeper sources
// fetched lazily). State (hook_buckets_tried) persists so a floored lead can
// continue deeper on a later touch.
//
// Voice is locked: connected (delete the line and the message breaks), peer not
// judge, LinkedIn-light, varied. Sonnet writes the line. CarterCo-only,
// best-effort (any scrape/model failure just cascades or floors).
//
// Ported from the validated scripts/bucket-hooks/waterfall_hooks.py.

import { CARTERCO_WORKSPACE_ID } from "./workspaces.ts";

const MODEL = "claude-sonnet-4-6";
const FRESH_DAYS = 90;
const FLOOR = "Jeg var lige inde på jeres side og optog en kort video om én ting, jeg tror I mister lidt værdi på:";

// deno-lint-ignore no-explicit-any
type AdminClient = { from: (t: string) => any };
type Lead = { first_name?: string; last_name?: string; title?: string; company?: string; website?: string };

const SYS =
`You write the single opening LINE of a cold LinkedIn DM for Carter & Co. The DM carries a short personalized video. Sender: Louis, a Danish operator. The prospect is usually a Danish B2B sales / commercial leader.

THE CORE MECHANIC — CONNECT VIA OVERLAP.
The hook lives where a true thing about THEM meets a true thing about the PITCH. Method:
  a) From the signals below, take what is genuinely true about the prospect (their world, what they do, what they wrote/built).
  b) Below is what is true about Carter & Co's pitch.
  c) Find the strongest OVERLAP between (a) and (b), and write the line ON that overlap.
The overlap IS the connection — that is why the line passes the DELETE TEST: remove it and the link to the pitch is gone. A line that does not sit on an overlap is decorative and FAILS.
FLOOR ONLY AS A LAST RESORT. If you have a real, specific signal that plausibly connects to one of the pitch truths, WRITE the line — do NOT be precious about whether the overlap is "perfect." Reserve the empty-hook floor for: no real signal at all, bare title+tenure, or a connection that would have to be fabricated (a pun on nothing, a genuine stretch). A real signal that decently connects BEATS a floor; only a forced/fake overlap loses to a floor. When you have something concrete and it plausibly ties to the pitch, write it.

WHAT'S TRUE ABOUT THE PITCH (the overlap must hit one of these):
  - Inbound leads go cold fast; the first minutes after a lead lands decide whether it converts.
  - Carter & Co's system responds / calls / messages a new lead instantly, while it's hot — faster than a human would.
  - It catches the leads a busy team misses: after hours, weekends, while travelling, right after a conference or campaign.
  - Follow-up never slips — it nurtures every lead until they're ready, so none are forgotten.
  - Result: fewer missed meetings, pipeline that doesn't wither.
  - Louis builds and runs it himself — hands-on, no juniors.

So: line = [their specific truth] × [one pitch truth], expressed as one connected thought leading into the video.

THE STRICT BAR — what counts as a real "truth about them".
Only a concrete particular qualifies: a real post or comment, a topic they wrote about, a specific thing they built or did, a real move in their career, a named certification, a specific line they wrote about themselves, a real company event (funding, hiring, new office, launch).
REJECT (return an empty hook so we cascade or floor):
  - bare title + tenure ("11 år som Sales Director", "6 år som CSO") — a role template with a number; it overlaps with nothing specific.
  - their job title used to guess their pain.
  - anything generic that is true of anyone in that role.
  - anything that fails the delete test.
We would rather floor (a plain honest line) than send something fake-specific. Never invent a signal.

RECENCY MATTERS — huge difference between 1 day and 1 year. Each signal shows its age (e.g. [POST, 2d] = 2 days old). A fresh signal (days, up to ~2 weeks) is timely — you may anchor it in time naturally ("forleden", "i denne uge", "lige nu"). An older one (1-2 months) is NOT fresh — reference the TOPIC, never imply it just happened ("du var lige til..." about a 2-month-old event is wrong). Prefer the freshest signal when choosing. If everything is old, lean on their durable field/role/company rather than a stale moment.

THE VOICE.
- Peer, NEVER a judge. You are a younger operator who genuinely noticed something, not their examiner. Credit their experience, defer to it, put the problem as something THEY already know. Defer DOWN ("du kender det bedre end mig"), never up.
- BANNED grading words (they sound condescending / bedrevidende): imponerende, respekt for, sjældent man ser, stærkt, flot, godt gjort, godt observeret, dygtig, "du ved bedre end de fleste".
- Do NOT recite their facts back ("Så du byggede X", "I saw you did Y"). Reference, do not narrate.
- ANCHOR FOR THE READER (important). The prospect does NOT see the signal you saw — give a light, explicit anchor so they instantly recognise what you mean: "dit opslag om [emne]", "din kampagne for [X]", "din kommentar om [Y]". This is the difference from cold recitation: "Så du skrev X" is cold/grading; "dit opslag om X — ..." is a warm reference that orients them in one beat. ALWAYS name the thing clearly enough that the reader knows it is theirs; never an oblique allusion they would have to decode.
- HOOK BY WORD-TWIST. Where you can, take 2-3 words from their own world/content and twist them into the cooling-leads problem (reorganize their phrase), instead of explaining. Their words, bent toward the pitch.
- DANISH-MODEST (Jante) but WITH SPINE. A Danish LinkedIn DM: understated, warm, a genuine light question is fine. Too confident reads as cocky — but do not over-hedge into wishy-washy. The target is QUIET CONFIDENCE IN THE OBSERVATION, HUMBLE IN TONE. Not every line a "jeg gætter på" guess; some may state the bridge with a little backbone while staying modest.
- VARY THE MOVE. No single phrase ("jeg gætter på", "du ved bedre end", "det er sjældent") may dominate. Rotate: a genuine question, "det har du nok mærket", "jeg tænker...", a plain modest-but-confident bridge, "mon ikke...".
- LinkedIn-light: warmer and shorter than a cold email. ~15-20 words, one clause about them + the bridge. End in a colon (:) that leads into the video.
- Language-matched: Danish for Danish prospects; their language only if they clearly post in another (e.g. Spanish). No Danglish.
- Never fabricate, never invent numbers or statistics.

EXAMPLES (each sits on an OVERLAP; each a different move; modest with spine):
  auto-finance × leads-cool: "18 år i bilfinansiering, og opfølgningen er stadig der hvor de varme leads tabes:"
  eMobility × after-hours: "Du kender ladebranchen — hvad sker der med de leads der lander efter fyraften?"
  EOR × timing: "EOR kører på timing — det har du nok mærket på hvad et langsomt svar koster:"
  their comment on networking × waiting-leads: "Din kommentar om netværk ramte noget — samme logik gælder de varme leads der lander og venter på svar:"

Output ONLY JSON: {"hook":"...", "lang":"da|en", "reasoning":"name the prospect-truth x pitch-truth overlap you used"}. An empty "hook" means nothing here overlaps the pitch — cascade.`;

const EVAL_SYS =
`You are the ANGLE EVALUATOR for Carter & Co's cold LinkedIn outreach. You get a numbered list of candidate signals about ONE prospect (each tagged with bucket + age). Pick the SINGLE best angle to build a personalized opening line on — or decline (floor).

WHAT CARTER & CO PITCHES (the line will connect to one of these):
- inbound leads go cold fast; the first minutes after a lead lands decide it
- a system that responds/calls/messages a new lead instantly, while it's hot
- it catches the leads a busy team misses: after hours, weekends, travel, post-conference
- follow-up that never slips; nurtures every lead until ready
- fewer missed meetings, pipeline that doesn't wither

SCORE each candidate on:
1. OVERLAP — how strongly can you connect THIS signal to the pitch (cooling leads / speed / follow-up)? Could you write a line where deleting it breaks the message? Strong overlap > weak.
2. FRESHNESS — newer is much better. 0-3 days = timely; ~2 weeks = recent; 1-2 months = stale. Prefer fresh; a stale signal loses to a fresh one.
3. READER-RECOGNIZABILITY — would the prospect INSTANTLY recognize it as theirs (their own post, their company, a named event) vs something oblique they'd strain to recall (a fleeting like of someone else's post, a generic role line)?
4. SPECIFICITY — a concrete particular, not bare title/tenure.

REJECT a candidate outright if: bare title + tenure ("X years as Sales Director"), generic-to-anyone, a like/repost of someone ELSE's post that isn't clearly the prospect's own view, or no real overlap with the pitch.

Pick the ONE best overall (a fresh, recognizable, strongly-overlapping own-post usually beats a stale or oblique one). If NOTHING clears the bar, choose floor.

Output ONLY JSON: {"choice": <the [index] number, or "floor">, "why": "one line: the overlap + why this beat the others (freshness / recognizability)"}`;

async function apify(actor: string, body: unknown): Promise<unknown[]> {
  const token = Deno.env.get("APIFY_API_TOKEN") ?? "";
  if (!token) return [];
  try {
    const res = await fetch(`https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${token}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!res.ok) return [];
    const arr = await res.json();
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

async function firecrawl(url: string): Promise<string> {
  const key = Deno.env.get("FIRECRAWL_API") ?? "";
  if (!key || !url) return "";
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"] }),
    });
    if (!res.ok) return "";
    const d = await res.json();
    return ((d.data || {}).markdown || "").slice(0, 1500);
  } catch { return ""; }
}

// ---- scrapes ----
type Post = { text: string; age_days: number; is_repost: boolean };
async function scrapePosts(url: string): Promise<Post[]> {
  const arr = await apify("harvestapi~linkedin-profile-posts", { targetUrls: [url], maxPosts: 6, includeReposts: true });
  const now = Date.now();
  const out: Post[] = [];
  for (const it of arr as Array<Record<string, unknown>>) {
    if (!it || typeof it !== "object") continue;
    // deno-lint-ignore no-explicit-any
    const ts = (it as any).postedAt?.timestamp;
    const age = ts ? (now - (ts as number)) / 86400000 : 999;
    if (age > FRESH_DAYS) continue;
    const text = String(it.content ?? it.text ?? "").trim();
    if (text) out.push({ text: text.slice(0, 600), age_days: Math.round(age), is_repost: Boolean(it.repost) });
  }
  return out;
}

// deno-lint-ignore no-explicit-any
async function scrapeProfile(url: string): Promise<any> {
  const arr = await apify("harvestapi~linkedin-profile-scraper", { queries: [url], profileScraperMode: "Profile details no email ($4 per 1k)" });
  return arr[0] ?? null;
}

async function scrapeReactions(url: string): Promise<unknown[]> {
  return await apify("harvestapi~linkedin-profile-reactions", { profiles: [url], maxItems: 8 });
}
async function scrapeComments(url: string): Promise<unknown[]> {
  return await apify("harvestapi~linkedin-profile-comments", { profiles: [url], maxItems: 8 });
}

// Becc: company-level (B6) is low efficacy EXCEPT for business owners/founders —
// their company IS their ego, so it hooks as hard as self-authored. Bump B6 up
// the order for them.
function isOwner(title?: string): boolean {
  const t = (title || "").toLowerCase();
  return ["founder", "co-founder", "owner", "ejer", "indehaver", "stifter",
    "medstifter", "grundlægger", "partner", "selvstændig", "self-employed"].some((w) => t.includes(w));
}

const ageDays = (ts?: number): number => (ts ? Math.round((Date.now() - ts) / 86400000) : 999);

// ---- candidate builder (LAYER 0): flatten every scraped source into one list
// of angles, each tagged with bucket + age. The evaluator picks the best. ----
type Cand = { b: string; age: number | null; t: string };
// deno-lint-ignore no-explicit-any
function buildCandidates(posts: Post[], profile: any, reactions: unknown[], comments: unknown[], companyText?: string | null): Cand[] {
  const c: Cand[] = [];
  // B1 — self-authored posts, freshest first
  for (const p of posts.filter((p) => !p.is_repost).sort((a, b) => a.age_days - b.age_days).slice(0, 5)) {
    c.push({ b: "1", age: p.age_days, t: "own post: " + p.text.slice(0, 400) });
  }
  // B2 — their own comments (high signal: their words)
  for (const cm of comments as Array<Record<string, unknown>>) {
    const mine = String(cm?.commentary ?? "").trim();
    if (!mine) continue;
    const age = ageDays(cm.createdAtTimestamp as number);
    if (age > FRESH_DAYS) continue;
    const on = String(((cm.post as Record<string, unknown>) || {}).content ?? "").slice(0, 80);
    c.push({ b: "2", age, t: `their comment: "${mine.slice(0, 200)}"${on ? ` (under a post about: ${on})` : ""}` });
  }
  // B2 — likes (what resonates)
  for (const r of reactions as Array<Record<string, unknown>>) {
    const liked = String(((r.post as Record<string, unknown>) || {}).content ?? r.content ?? "").trim();
    if (!liked) continue;
    const age = ageDays(r.createdAtTimestamp as number);
    if (age > FRESH_DAYS) continue;
    c.push({ b: "2", age, t: "liked someone's post: " + liked.slice(0, 200) });
  }
  // B2 — reposts
  for (const p of posts) if (p.is_repost) c.push({ b: "2", age: p.age_days, t: "shared/reposted: " + p.text.slice(0, 200) });
  // B3 — self-written profile
  if (profile) {
    if (profile.headline) c.push({ b: "3", age: null, t: "their headline: " + String(profile.headline).slice(0, 200) });
    if (profile.about) c.push({ b: "3", age: null, t: "their About: " + String(profile.about).slice(0, 400) });
    const cur = (profile.currentPosition || [])[0];
    if (cur?.description) c.push({ b: "3", age: null, t: "their role description: " + String(cur.description).slice(0, 300) });
    // B5 — background / trajectory
    const exp = profile.experience || [];
    if (exp.length) c.push({ b: "5", age: null, t: "career: " + exp.slice(0, 5).map((e: Record<string, unknown>) => `${e.position ?? "?"} @ ${e.companyName ?? "?"} (${e.duration ?? "?"})`).join("  |  ") });
    const certs = (profile.certifications || []).slice(0, 6).map((x: Record<string, unknown>) => x.title).filter(Boolean);
    if (certs.length) c.push({ b: "5", age: null, t: "certifications: " + certs.join(", ") });
    const awards = (profile.honorsAndAwards || []).slice(0, 4).map((a: Record<string, unknown>) => a.title).filter(Boolean);
    if (awards.length) c.push({ b: "5", age: null, t: "awards: " + awards.join(", ") });
  }
  // B6 — company (only when scraped: owners up front, others on floor-escalation)
  if (companyText) c.push({ b: "6", age: null, t: "company site: " + companyText.slice(0, 500) });
  return c;
}

async function b6(website: string): Promise<string | null> {
  if (!website) return null;
  const base = website.replace(/\/+$/, "");
  // deep: homepage + careers (hiring) + news/blog (company events)
  const pages = await Promise.all([firecrawl(base), firecrawl(base + "/careers"), firecrawl(base + "/news")]);
  const labels = ["site", "careers/hiring", "news"];
  const parts = pages.map((md, i) => md.trim() ? `== ${labels[i]} ==\n${md}` : "").filter(Boolean);
  return parts.length ? parts.join("\n\n") : null;
}

// Strip unpaired UTF-16 surrogates. Scraped LinkedIn text is full of emoji
// (surrogate pairs); our .slice() caps can cut a pair in half, leaving a lone
// surrogate that makes Anthropic reject the body with HTTP 400 ("no low
// surrogate in string"). Removing the orphan halves keeps valid emoji intact.
function clean(s: string): string {
  return s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")   // high surrogate not followed by low
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, ""); // low surrogate not preceded by high
}

// Shared Sonnet JSON call. Returns the parsed object, or null on any failure.
// maxTokens defaults to 400 (enough for a hook); the evaluator passes more so a
// long "why" can't truncate the JSON mid-string. Both fields are surrogate-
// cleaned so a sliced emoji can't produce an invalid request body.
// deno-lint-ignore no-explicit-any
async function anthropicJson(system: string, user: string, maxTokens = 400, temperature = 1): Promise<any | null> {
  const key = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (!key) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, temperature, system: clean(system), messages: [{ role: "user", content: clean(user) }] }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const txt = ((body.content ?? []) as Array<{ type: string; text?: string }>).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
    const slice = txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1);
    try { return JSON.parse(slice); }
    catch {
      // Salvage a truncated/over-long response: pull the first key fields by regex
      // so a malformed tail can't sink an otherwise-good choice.
      const choice = slice.match(/"choice"\s*:\s*("?\w+"?)/)?.[1]?.replace(/"/g, "");
      const why = slice.match(/"why"\s*:\s*"([^"]*)/)?.[1];
      const hook = slice.match(/"hook"\s*:\s*"([^"]*)/)?.[1];
      if (choice !== undefined || hook !== undefined) return { choice, why, hook };
      return null;
    }
  } catch { return null; }
}

// LAYER 1 — EVALUATOR. Scores every candidate on overlap × freshness ×
// reader-recognizability × specificity and picks the single best, or floor.
// Retries once on a parse failure before falling back. A parse failure must
// NEVER silently floor a real self-authored post — so on unparseable output we
// deterministically pick the freshest bucket-1 own-post (if any) and let the
// writer decide overlap; only floor when there is no own-post to fall back to.
async function evaluate(lead: Lead, cands: Cand[]): Promise<{ choice: number | "floor"; why: string }> {
  const listing = cands.map((c, i) => `[${i}] (bucket ${c.b}, ${c.age !== null ? "age " + c.age + "d" : "no date"}) ${c.t}`).join("\n");
  const user = `Prospect: ${lead.first_name ?? ""} ${lead.last_name ?? ""} — ${lead.title ?? ""} at ${lead.company ?? ""}.\n\nCandidates:\n${listing}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await anthropicJson(EVAL_SYS, user, 800, 0); // temp 0: deterministic scoring, reliable JSON
    if (out && out.choice !== undefined) {
      const ch = out.choice;
      const choice = (typeof ch === "number") ? ch
        : (typeof ch === "string" && /^\d+$/.test(ch)) ? parseInt(ch, 10) : "floor";
      return { choice: choice as number | "floor", why: String(out.why ?? "") };
    }
  }
  // Unparseable/errored both times — fall back to the freshest own-post rather than floor.
  let best = -1, bestAge = Infinity;
  cands.forEach((c, i) => {
    if (c.b === "1" && (c.age ?? 999) < bestAge) { best = i; bestAge = c.age ?? 999; }
  });
  if (best >= 0) return { choice: best, why: "evaluator unparseable — fell back to freshest own-post" };
  return { choice: "floor", why: "evaluator parse-fail" };
}

// LAYER 2 — WRITER. Writes the hook from the ONE chosen angle (locked voice).
async function writeLine(lead: Lead, angle: string): Promise<{ hook: string; lang: string } | null> {
  const user = `Prospect: ${lead.first_name ?? ""} ${lead.last_name ?? ""} — ${lead.title ?? ""} at ${lead.company ?? ""}.\n\nCandidate signals:\n${angle}`;
  const out = await anthropicJson(SYS, user);
  if (!out) return null;
  const hook = String(out.hook ?? "").trim();
  return hook ? { hook, lang: String(out.lang ?? "da") } : null;
}

const TRACE: Record<string, string> = {
  "1": "self-authored post", "2": "engaged content (comment/like/share)",
  "3": "self-written profile", "5": "background", "6": "company signal",
};

/**
 * Two-layer hook generation for one accepted CarterCo lead:
 *   scrape cheap LinkedIn sources -> build all candidate angles
 *   LAYER 1 evaluator picks the single best angle (or floor)
 *   (floor on cheap sources -> escalate to company B6, re-evaluate)
 *   LAYER 2 writer writes the line from the chosen angle
 * Persists the hook + the bucket + the evaluator's reasoning (hook_context).
 * CarterCo-only, best-effort (any scrape/model failure floors honestly).
 */
export async function generateBucketHook(
  admin: AdminClient,
  leadId: string,
): Promise<{ ok: true; hook: string; bucket: string } | { ok: false; reason: string }> {
  const { data: pipe } = await admin
    .from("outreach_pipeline")
    .select("sendpilot_lead_id, contact_email, workspace_id, linkedin_url, hook_buckets_tried")
    .eq("sendpilot_lead_id", leadId).maybeSingle();
  if (!pipe) return { ok: false, reason: "pipeline row not found" };
  if (pipe.workspace_id !== CARTERCO_WORKSPACE_ID) return { ok: false, reason: "not CarterCo workspace" };

  const { data: lead } = await admin
    .from("outreach_leads")
    .select("first_name, last_name, title, company, linkedin_url, website")
    .eq("contact_email", pipe.contact_email ?? "").maybeSingle();
  if (!lead) return { ok: false, reason: "lead not found" };
  const url = (lead.linkedin_url || pipe.linkedin_url || "").trim();
  if (!url) return { ok: false, reason: "no linkedin_url" };
  const website = (lead.website || "").trim();

  let tried: string[] = [];
  const persist = async (hook: string | null, bucket: string, lang: string, context: string) => {
    await admin.from("outreach_pipeline").update({
      personalized_hook: hook, hook_bucket: bucket, hook_context: context.slice(0, 500),
      hook_trace: (TRACE[bucket] ?? bucket).slice(0, 500), hook_lang: lang,
      hook_buckets_tried: tried.join(","), hook_generated_at: new Date().toISOString(),
    }).eq("sendpilot_lead_id", leadId);
  };

  // Scrape the cheap LinkedIn sources once, in parallel.
  const [posts, profile, reactions, comments] = await Promise.all([
    scrapePosts(url), scrapeProfile(url), scrapeReactions(url), scrapeComments(url),
  ]);

  // Becc: owners/founders — company IS their ego, so B6 hooks as hard as a post.
  // Scrape it up front for them so the evaluator can weigh it from round one.
  const owner = isOwner(lead.title);
  const companyUpFront = owner && website ? await b6(website) : null;

  let cands = buildCandidates(posts, profile, reactions, comments, companyUpFront);
  tried = [...new Set(cands.map((c) => c.b))];
  let ev = cands.length ? await evaluate(lead, cands) : { choice: "floor" as const, why: "no signals scraped" };

  // Floored on cheap sources -> escalate to company B6 and re-evaluate (non-owners).
  if (ev.choice === "floor" && !owner && website) {
    const companyText = await b6(website);
    if (companyText) {
      cands = buildCandidates(posts, profile, reactions, comments, companyText);
      tried = [...new Set(cands.map((c) => c.b))];
      ev = await evaluate(lead, cands);
    }
  }

  // Honest floor — no real angle cleared the bar. State persists so a later touch
  // can resume (re-scrape may surface a fresh post / new company event).
  if (ev.choice === "floor" || typeof ev.choice !== "number" || ev.choice >= cands.length) {
    await persist(null, "floor", "da", `floor: ${ev.why}`);
    return { ok: true, hook: FLOOR, bucket: "floor" };
  }

  const chosen = cands[ev.choice];
  const ageTag = chosen.age !== null ? `${chosen.age}d` : "no date";
  const angle = `[CHOSEN ANGLE — bucket ${chosen.b}, ${ageTag}] ${chosen.t}\nWHY: ${ev.why}`;
  const r = await writeLine(lead, angle);
  if (!r) {
    await persist(null, "floor", "da", `writer failed after choosing bucket ${chosen.b}: ${ev.why}`);
    return { ok: true, hook: FLOOR, bucket: "floor" };
  }
  await persist(r.hook, chosen.b, r.lang, `${ageTag} · ${ev.why}`);
  return { ok: true, hook: r.hook, bucket: chosen.b };
}
