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

THE VOICE.
- Peer, NEVER a judge. You are a younger operator who genuinely noticed something, not their examiner. Credit their experience, defer to it, put the problem as something THEY already know. Defer DOWN ("du kender det bedre end mig"), never up.
- BANNED grading words (they sound condescending / bedrevidende): imponerende, respekt for, sjældent man ser, stærkt, flot, godt gjort, godt observeret, dygtig, "du ved bedre end de fleste".
- Do NOT recite their facts back ("Så du byggede X", "I saw you did Y"). Reference, do not narrate.
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

// ---- per-bucket signal blocks (null = nothing here) ----
function b1(posts: Post[]): string | null {
  const own = posts.filter((p) => !p.is_repost);
  return own.length ? own.slice(0, 4).map((p) => `- [POST, ${p.age_days}d] ${p.text}`).join("\n") : null;
}
function b2(posts: Post[], reactions: unknown[], comments: unknown[]): string | null {
  const out: string[] = [];
  for (const p of posts) if (p.is_repost) out.push(`- [SHARED/REPOST, ${p.age_days}d] ${p.text}`);
  // Comments = their OWN words (high signal — nearly B1 quality).
  for (const c of (comments as Array<Record<string, unknown>>).slice(0, 5)) {
    const mine = String(c.commentary ?? "").trim();
    const on = String(((c.post as Record<string, unknown>) || {}).content ?? "").slice(0, 120);
    if (mine) out.push(`- [THEIR COMMENT] "${mine.slice(0, 220)}"${on ? `  (on a post about: ${on})` : ""}`);
  }
  // Likes = what resonates with them.
  for (const r of (reactions as Array<Record<string, unknown>>).slice(0, 5)) {
    const liked = String(((r.post as Record<string, unknown>) || {}).content ?? r.content ?? "").trim();
    if (liked) out.push(`- [LIKED] ${liked.slice(0, 200)}`);
  }
  return out.length ? out.join("\n") : null;
}
// deno-lint-ignore no-explicit-any
function b3(p: any): string | null {
  if (!p) return null;
  const out: string[] = [];
  if (p.headline) out.push(`- headline: ${p.headline}`);
  if (p.about) out.push(`- about (excerpt): ${String(p.about).slice(0, 600)}`);
  const cur = (p.currentPosition || [])[0];
  if (cur?.description) out.push(`- role description: ${String(cur.description).slice(0, 300)}`);
  return out.length ? out.join("\n") : null;
}
// deno-lint-ignore no-explicit-any
function b5(p: any): string | null {
  if (!p) return null;
  const out: string[] = [];
  const exp = p.experience || [];
  if (exp.length) out.push("- trajectory: " + exp.slice(0, 5).map((e: Record<string, unknown>) => `${e.position ?? "?"} @ ${e.companyName ?? "?"} (${e.duration ?? "?"})`).join("  |  "));
  const certs = (p.certifications || []).slice(0, 6).map((c: Record<string, unknown>) => c.title).filter(Boolean);
  if (certs.length) out.push("- certifications: " + certs.join(", "));
  const awards = (p.honorsAndAwards || []).slice(0, 4).map((a: Record<string, unknown>) => a.title).filter(Boolean);
  if (awards.length) out.push("- awards: " + awards.join(", "));
  const recs = p.receivedRecommendations || [];
  if (recs[0] && typeof recs[0] === "object") {
    const t = recs[0].text || recs[0].description || "";
    if (t) out.push(`- a recommendation about them: ${String(t).slice(0, 300)}`);
  }
  return out.length ? out.join("\n") : null;
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

async function writeLine(lead: Lead, signals: string): Promise<{ hook: string; lang: string } | null> {
  const key = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (!key) return null;
  const user = `Prospect: ${lead.first_name ?? ""} ${lead.last_name ?? ""} — ${lead.title ?? ""} at ${lead.company ?? ""}.\n\nCandidate signals:\n${signals}`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 400, system: SYS, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const txt = ((body.content ?? []) as Array<{ type: string; text?: string }>).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
    const out = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
    const hook = String(out.hook ?? "").trim();
    return hook ? { hook, lang: String(out.lang ?? "da") } : null;
  } catch { return null; }
}

/**
 * Sequential waterfall for one accepted CarterCo lead. Stops at the first bucket
 * with a connected line; persists the line + which buckets were tried. CarterCo-
 * only, best-effort (any failure cascades / floors).
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

  const tried: string[] = [];
  const persist = async (hook: string | null, bucket: string, lang: string, trace: string) => {
    await admin.from("outreach_pipeline").update({
      personalized_hook: hook, hook_bucket: bucket, hook_trace: trace.slice(0, 500),
      hook_lang: lang, hook_buckets_tried: tried.join(","), hook_generated_at: new Date().toISOString(),
    }).eq("sendpilot_lead_id", leadId);
  };

  // Lazy scrape cache — each source fetched at most once.
  // deno-lint-ignore no-explicit-any
  const c: { posts?: Post[]; profile?: any; reactions?: unknown[]; comments?: unknown[] } = {};
  const posts = async () => (c.posts ??= await scrapePosts(url));
  const profile = async () => (c.profile ??= await scrapeProfile(url));

  const TRACE: Record<string, string> = {
    "1": "self-authored post", "2": "engaged content (comment/like/share)",
    "3": "self-written profile", "5": "background", "6": "company signal",
  };
  async function block(bucket: string): Promise<string | null> {
    switch (bucket) {
      case "1": return b1(await posts());
      case "2": {
        const [p, re, co] = [await posts(), (c.reactions ??= await scrapeReactions(url)), (c.comments ??= await scrapeComments(url))];
        return b2(p, re, co);
      }
      case "3": return b3(await profile());
      case "5": return b5(await profile());
      case "6": return await b6((lead.website || "").trim());
      default: return null;
    }
  }

  // Becc: owners/founders get company (B6) bumped up — their company is their ego.
  const order = isOwner(lead.title) ? ["1", "2", "6", "3", "5"] : ["1", "2", "3", "5", "6"];
  for (const bucket of order) {
    tried.push(bucket);
    const blk = await block(bucket);
    const r = blk ? await writeLine(lead, blk) : null;
    if (r) { await persist(r.hook, bucket, r.lang, TRACE[bucket] ?? bucket); return { ok: true, hook: r.hook, bucket }; }
  }

  // floor — honest line, no fake personalization. State (hook_buckets_tried)
  // persisted so a later touch can resume (re-scrape may surface a fresh post /
  // new company event).
  await persist(null, "floor", "da", `no connected overlap across buckets ${order.join("/")}`);
  return { ok: true, hook: FLOOR, bucket: "floor" };
}
