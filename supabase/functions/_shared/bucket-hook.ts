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
`You write the single opening LINE of a cold LinkedIn DM for Carter & Co. The DM carries a short personalized video. Sender: Louis, a Danish operator.

WHAT CARTER & CO DOES — the line MUST connect to this:
Louis builds and runs the system that catches inbound leads and acts before they go cold: instant response, calling/messaging leads while they're hot, follow-up that doesn't slip, so meetings don't get missed and pipeline doesn't wither. The pain he removes: leads cooling off, slow or missing response, follow-up falling through.

YOUR JOB: from the real signals below, pick the single best one and write ONE line that (a) reacts to it as a peer AND (b) bridges naturally into why Louis is reaching out — the speed / cooling-leads / follow-up problem. CONNECTION IS REQUIRED: if you could delete the line and the message still made sense, it FAILS. A decorative compliment that does not connect is wrong.

THE VOICE:
- LinkedIn, not email. A little lighter, warmer, shorter, more conversational than a cold email. A light question is fine. No "Dear", no formality, no pitch structure.
- Peer or looking-UP, NEVER a judge. Credit their experience and defer to it. Put the problem as something THEY already know, not something you are teaching them.
- BANNED (grading from above — reads as condescending): "imponerende", "respekt for", "sjældent man ser", "stærkt", "flot", "godt gjort", "godt observeret", "dygtig". You are not their examiner.
- Do NOT lecture or explain their job back to them.
- VARY THE MOVE. Do NOT begin most lines with "du ved bedre end..." or any single phrase — across many leads it screams template. Rotate: (a) a light question, (b) "det har du nok mærket...", (c) just state the bridge plainly, (d) only occasionally "du ved bedre end...".
- KEEP IT SHORT. Often one clause about them + the bridge. Max ~20 words.

EXAMPLES (each uses a DIFFERENT move):
  auto-finance, plain bridge: "18 år i bilfinansiering, og opfølgningen er stadig der hvor de varme leads tabes:"
  eMobility, question: "Du kender ladebranchen — hvad sker der med de leads der lander mens sælgeren kører hjem fra Sønderborg?"
  EOR, det-har-du-nok-mærket: "EOR sælges på timing — det har du nok mærket på hvad et langsomt svar koster:"

STRICT SIGNAL BAR:
- Use a real concrete particular: a post, a specific build/achievement, a real career move, something they wrote about themselves. NEVER their bare job title.
- If nothing here is worth a CONNECTED line, return {"hook":""} (empty). We will try the next source. Never fake it.

FORMAT: one tight line, ends in a colon (:) leading into the video. Danish for Danish prospects; their language only if they clearly write in another. No Danglish, no invented numbers.

Output ONLY JSON: {"hook":"...", "lang":"da|en", "reasoning":"one short sentence"}`;

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

// ---- per-bucket signal blocks (null = nothing here) ----
function b1(posts: Post[]): string | null {
  const own = posts.filter((p) => !p.is_repost);
  return own.length ? own.slice(0, 4).map((p) => `- [POST, ${p.age_days}d] ${p.text}`).join("\n") : null;
}
function b2(posts: Post[], reactions: unknown[]): string | null {
  const out: string[] = [];
  for (const p of posts) if (p.is_repost) out.push(`- [SHARED/REPOST, ${p.age_days}d] ${p.text}`);
  for (const r of (reactions as Array<Record<string, unknown>>).slice(0, 6)) {
    const t = String((r.content ?? r.text ?? "") || "");
    if (t) out.push(`- [engaged with] ${t.slice(0, 220)}`);
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

  // 1 — self-authored posts (also yields shared/reposts for step 2)
  const posts = await scrapePosts(url);
  tried.push("1");
  let blk = b1(posts);
  let r = blk ? await writeLine(lead, blk) : null;
  if (r) { await persist(r.hook, "1", r.lang, "self-authored post"); return { ok: true, hook: r.hook, bucket: "1" }; }

  // 2 — engaged (reposts already in hand; + reactions lazily)
  tried.push("2");
  const reactions = await scrapeReactions(url);
  blk = b2(posts, reactions);
  r = blk ? await writeLine(lead, blk) : null;
  if (r) { await persist(r.hook, "2", r.lang, "engaged content"); return { ok: true, hook: r.hook, bucket: "2" }; }

  // 3 + 5 — one profile scrape covers both
  const profile = await scrapeProfile(url);
  tried.push("3");
  blk = b3(profile);
  r = blk ? await writeLine(lead, blk) : null;
  if (r) { await persist(r.hook, "3", r.lang, "self-written profile"); return { ok: true, hook: r.hook, bucket: "3" }; }
  tried.push("5");
  blk = b5(profile);
  r = blk ? await writeLine(lead, blk) : null;
  if (r) { await persist(r.hook, "5", r.lang, "background"); return { ok: true, hook: r.hook, bucket: "5" }; }

  // 6 — company (deep: site + careers + news)
  tried.push("6");
  blk = await b6((lead.website || "").trim());
  r = blk ? await writeLine(lead, blk) : null;
  if (r) { await persist(r.hook, "6", r.lang, "company signal"); return { ok: true, hook: r.hook, bucket: "6" }; }

  // floor — honest line, no fake personalization. State persisted so a later
  // touch can resume (re-scrape may surface a fresh post / new company event).
  await persist(null, "floor", "da", "no connected signal across buckets 1/2/3/5/6");
  return { ok: true, hook: FLOOR, bucket: "floor" };
}
