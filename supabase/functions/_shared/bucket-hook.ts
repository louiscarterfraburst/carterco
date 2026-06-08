// Becc-bucket personalization for CarterCo's own outbound — scrape-everything-then-choose.
//
// On accept, gather EVERY signal source up front (no waterfall):
//   1 self-authored posts · 2 engaged · 3 self-written · 5 background  (LinkedIn/Apify)
//   6 company deep (site + careers + news, Firecrawl) + web news (Brave)
//   7 press / web mention of the person                                (Brave)
// then a single evaluator picks the global best angle across all of it (or floors).
// At CarterCo volume (tens/month, async render) deep-scraping every lead is pennies and
// beats the old waterfall, which could pick a locally-OK angle while a stronger unscraped
// one sat hidden. State (hook_buckets_tried) persists so a later touch re-scrapes fresh.
//
// Voice is locked: connected (delete the line and the message breaks), peer not
// judge, LinkedIn-light, varied. Sonnet writes the body (observation + bridge
// into the video; greeting and link are added downstream). CarterCo-only,
// best-effort (any scrape/model failure just cascades or floors).
//
// Ported from the validated scripts/bucket-hooks/waterfall_hooks.py.

import { CARTERCO_WORKSPACE_ID } from "./workspaces.ts";
import { humanize } from "./text.ts";

const MODEL = "claude-sonnet-4-6";
const FRESH_DAYS = 90;
const FLOOR = "Jeg var lige inde på jeres side og optog en kort video om én ting, jeg tror I mister lidt værdi på:";

// deno-lint-ignore no-explicit-any
type AdminClient = { from: (t: string) => any };
type Lead = { first_name?: string; last_name?: string; title?: string; company?: string; website?: string };

const SYS =
`You write the BODY of a cold LinkedIn DM for Carter & Co — everything between the greeting and the video link (BOTH added downstream, not by you). The DM carries a short personalized video. Sender: Louis, a Danish operator. The prospect is usually a Danish B2B sales / commercial leader.

THE CORE MOVE — A REAL PERSON WHO GOT CURIOUS.
This is NOT outreach. It is Louis seeing something genuinely interesting about THEM, becoming curious, and — because he was curious — recording a short video. The body must read like a thought, not an analysis. Method:
  a) From the signals below, take the most concrete, genuine thing about the prospect (a real post, comment, event — something Louis would actually notice and react to).
  b) React to it the way a human would: acknowledge it, say it made you curious. NOT "here's what it means for your leads."
  c) Move plainly into the video. The CONNECTION to leads/follow-up does NOT need to live in the line — the video carries it. The line only has to feel like a real, curious human.
CURIOSITY, NOT DIAGNOSIS. The prospect must NEVER feel diagnosed, analyzed, or sold to. You are not making a point; you noticed something and wondered about it.
IF THE BRIDGE FEELS FORCED, DON'T USE IT. Many posts have nothing to do with how leads are handled — that's fine. If connecting it to the pitch would be clever rather than obvious, DON'T. React genuinely, then go straight to "jeg testede jeres lead-flow og samlede et par tanker i en kort video." A plain reaction + plain video beats a weak analogy every time. Reserve the empty-hook floor only for: no real signal at all, bare title+tenure, or a signal you'd have to fabricate.

THE VIDEO IS THE PITCH — THE DM ONLY EARNS THE CLICK. Do NOT explain Carter & Co. Do NOT explain AI, automation, systems, or what Louis builds. Do NOT argue any of the points below. The video does all of that. The body's only job is (1) why Louis thought of THEM, and (2) that he recorded a short video.

WHAT THE VIDEO IS ABOUT (background for YOU only — NEVER state these in the body):
  - Inbound leads go cold fast; the first minutes after a lead lands decide whether it converts.
  - A system that responds to a new lead instantly, while it's hot — faster than a human would.
  - It catches the leads a busy team misses: after hours, weekends, while travelling, right after a conference or campaign.
  - Follow-up never slips — it nurtures every lead until they're ready.

THE VIDEO (fixed premise — your bridge builds on this).
The DM carries a short personalized video in which Louis has TESTED their lead-flow. React to the thing about THEM as a human FIRST, THEN bridge into the video: say, plainly, that you tested their lead-flow and put what you saw in a short video. Vary the phrasing so a batch doesn't read identically — test verb ("jeg testede jeres lead-flow" / "jeg prøvede jeres flow af") — AVOID audit-flavored framings like "jeg kørte jeres setup igennem" (examiner energy) — AND video verb ("samlede et par tanker i en kort video" / "optog en kort video om det jeg så" / "lavede en kort video om det") — but always keep the test claim.

KILL THE SALES TONE — this is the #1 failure mode. Write the way a Dane actually writes a DM: lavmælt, tør, beskeden. The bridge is "jeg testede jeres lead-flow og samlede et par tanker i en kort video" (or "...lavede en kort video med en hurtig gevinst" — Louis's own wording, fine). NOT "I found a gap / value you're missing / huge potential". Do NOT sell. Do NOT explain their own business back to them — banned shape: "[deres ting] betyder flere leads / flere der køler ned, og det er typisk dér det smutter." They already know what happens to their leads; name their topic + your curiosity and move straight to the bridge. Do NOT do the consultant reframe ("det gælder egentlig også den anden vej", "det samme gælder jo for jer", "den pointe gælder jo også henvendelser", flipping their insight back as a mirror) — that's a sales-trainer's pivot, not a peer's remark. Also BANNED: explaining their own world back to them ("den slags udgivelse trækker henvendelser", "når infrastrukturen skalerer, skalerer henvendelserne med", "flere henvendelser er kun godt hvis man når at følge op"), and any diagnosis-question in disguise ("hvad sker der når leadsne lander?", "hvor hurtigt bliver en henvendelse fanget hos jer?"). OBSERVATIONS, NOT ASSERTIONS — do not complete the thought for them. Reach for soft, curious phrasing instead: "det fik mig til at tænke på...", "jeg blev nysgerrig på...", "jeg kom til at tænke på...", "kan forestille mig...", "måske..." — name what you noticed + that it made you curious, then go to the video. Do NOT use inflated marketing words (momentum, potentiale, optimere, "vindue"); plain outcome words (miste, værdi, gevinst, nå dem i tide) are fine. Understatement over enthusiasm. If a line sounds like a pitch, it has FAILED.

So: body = [a genuine human reaction to their specific thing] → [a modest, curious bridge into the video]. One flowing thought. The reaction comes first and stands on its own; the bridge stays light and never explains anything back to them.

THE STRICT BAR — what counts as a real "truth about them".
Only a concrete particular qualifies: a real post or comment, a topic they wrote about, a specific thing they built or did, a real move in their career, a named certification, a specific line they wrote about themselves, a real company event (funding, hiring, new office, launch).
REJECT (return an empty hook so we cascade or floor):
  - bare title + tenure ("11 år som Sales Director", "6 år som CSO") — a role template with a number; it overlaps with nothing specific.
  - their job title used to guess their pain.
  - anything generic that is true of anyone in that role.
  - anything you'd have to stretch or fabricate to make interesting.
We would rather floor (a plain honest line) than send something fake-specific. Never invent a signal.

RECENCY MATTERS — huge difference between 1 day and 1 year. Each signal shows its age (e.g. [POST, 2d] = 2 days old). A fresh signal (days, up to ~2 weeks) is timely — you may anchor it in time naturally ("forleden", "i denne uge", "lige nu"). An older one (1-2 months) is NOT fresh — reference the TOPIC, never imply it just happened ("du var lige til..." about a 2-month-old event is wrong). Prefer the freshest signal when choosing. If everything is old, lean on their durable field/role/company rather than a stale moment.

THE VOICE.
- Peer, NEVER a judge. You are a younger operator who genuinely noticed something, not their examiner. Credit their experience, defer to it, put the problem as something THEY already know. Defer DOWN ("du kender det bedre end mig"), never up.
- BANNED grading words (they sound condescending / bedrevidende): imponerende, respekt for, sjældent man ser, stærkt, flot, godt gjort, godt observeret, dygtig, "du ved bedre end de fleste".
- Do NOT recite their facts back ("Så du byggede X", "I saw you did Y"). Reference, do not narrate.
- ANCHOR FOR THE READER (important). The prospect does NOT see the signal you saw — give a light, explicit anchor so they instantly recognise what you mean: "dit opslag om [emne]", "din kampagne for [X]", "din kommentar om [Y]". This is the difference from cold recitation: "Så du skrev X" is cold/grading; "dit opslag om X — ..." is a warm reference that orients them in one beat. ALWAYS name the thing clearly enough that the reader knows it is theirs; never an oblique allusion they would have to decode.
- WEB-SOURCED SIGNALS. The signal may come from googling them, not LinkedIn (a press piece, interview, podcast, talk, or company news like funding/hiring/a launch). Anchor it just as modestly: "jeg så I lige har [rejst kapital / åbnet kontor i X / lanceret Y]", "jeg faldt over din samtale i [medie/podcast] om [emne]", "jeg så jeres nyhed om [X]". Use it only when it's unmistakably about them — never reference a web find you're not sure is theirs.
- ECHO THEIR WORDS LIGHTLY. Where it's natural, reuse 2-3 words from their own world/content in your reaction — their language, not yours. But do NOT bend their phrase toward the cooling-leads problem if it doesn't go there naturally; a plain reaction + the video beats a forced word-twist.
- DANISH-MODEST (Jante), LOW CONFIDENCE. A Danish LinkedIn DM: understated, warm, tentative. You do NOT know how their business works — don't pretend to. Default to soft, curious framing ("jeg blev nysgerrig på", "kan forestille mig", "måske", "det fik mig til at tænke på") over any confident claim about their world. Warm and human, never cocky, never certain.
- VARY THE MOVE. No single phrase ("jeg gætter på", "du ved bedre end", "det er sjældent") may dominate. Rotate: a genuine question, "det har du nok mærket", "jeg tænker...", a plain modest-but-confident bridge, "mon ikke...".
- THE SHAPE: two beats. (1) a genuine human reaction to THEM (anchored so they recognise it — a real post/comment/event you noticed and got curious about), then (2) the bridge into the video (you tested their lead-flow and put what you saw in a short video). Beat 1 stands on its own and leads naturally into beat 2 — one thought, not two bolted-together halves.
- SHORT AND DRY. ~30-45 words. One anchored observation + one modest bridge. If you feel a third clause coming on to "explain" the consequence to them, CUT it — that's the lecture. Do NOT write the "Hej {name}" greeting and do NOT write the video link or any URL — both are added downstream. End on the bridge; a trailing colon (:) that leads into the video is good (the link follows on its own line).
- NO EM DASHES (—) OR EN DASHES (–). Hard rule, no exceptions. Louis never uses them. Use a comma, a period, or a colon instead. The ONLY colon allowed is the trailing one that leads into the video link; everywhere else, a dash you were tempted to write becomes a comma or a full stop. (Ordinary hyphens in compound words like "lead-flow" or "B2B-løsninger" are fine, those are hyphens, not dashes.)
- WRITE IT LIKE LOUIS TYPING IT BY HAND, NOT A COPY-PASTE. It must read like he wrote it himself. So: do NOT paste trademark or legal symbols (™, ®, ©, ℠), drop them ("Opal Renew", never "Opal Renew™"). Do NOT reproduce ALL-CAPS or stylized brand casing scraped from their post, write names in natural Title Case the way a person types them ("Interface Nordics", not "INTERFACE Nordics"; "Kubo", not "KUBO"). Keep only genuinely-standard short acronyms (B2B, EOR, GTM, OT) as they are.
- ONE LANGUAGE, DANISH BY DEFAULT. Write the ENTIRE body in a single language, and default to Danish — these are Danish B2B leaders at Danish companies. If the chosen signal is in another language (English, Dutch, German…), translate its MEANING into Danish; NEVER copy foreign-language phrases verbatim into a Danish sentence (no "eenvoudige vragen", no stray English mid-sentence, no Danglish). Only write the whole body in another language if the prospect clearly operates in that language day-to-day (rare).
- Never fabricate, never invent numbers or statistics.

EXAMPLES (a thought + a video, never a pitch; react FIRST, bridge light; each a different move + different test/video phrasing; NO em dashes, NO ™/®, NO ALL-CAPS brand styling anywhere):
  GOLD (Louis's register: reaction + curiosity, then STOPS, then the video; no diagnosis): "Din kommentar om stigende efterspørgsel på gasbehandlingsløsninger fik mig til at tænke på jer. Blev nysgerrig, så jeg testede jeres lead-flow og lavede en kort video om det:"
  milestone post (bridge simplified, no forced analogy; brand in natural casing): "Dit opslag fra Interface Nordics, fedt at se infrastrukturen vokse. Det gjorde mig nysgerrig på jeres setup, så jeg testede jeres lead-flow og samlede et par tanker i en kort video:"
  conference post (light, no lecture): "Dit opslag fra ISPE, ligner et par gode dage. Jeg blev nysgerrig og prøvede jeres opfølgning af bagefter, optog en kort video om det:"
  eMobility (curious, not diagnostic): "Du kender ladebranchen bedre end mig, jeg kom bare til at tænke på jer. Testede jeres lead-flow og lavede en kort video om det jeg så:"
  EOR / durable field (dry, modest): "EOR er jo timing, det ved du bedre end mig. Jeg blev nysgerrig, testede jeres flow og samlede det i en kort video:"

Output ONLY JSON: {"hook":"<the full DM body: human reaction + light bridge into the video, NO greeting, NO link>", "lang":"da|en", "reasoning":"name the signal you reacted to + why it felt genuine"}. An empty "hook" means there's no real, specific signal worth reacting to, cascade.`;

const EVAL_SYS =
`You are the ANGLE EVALUATOR for Carter & Co's cold LinkedIn outreach. You get a numbered list of candidate signals about ONE prospect (each tagged with bucket + age). Pick the SINGLE best angle to build a personalized opening line on — or decline (floor).

WHAT THE VIDEO IS ABOUT (background only — the chosen signal does NOT need to connect to this; the video carries the pitch, so pick the signal Louis would most genuinely be CURIOUS about, not the one with the tightest "sales overlap"):
- inbound leads go cold fast; the first minutes after a lead lands decide it
- a system that responds to a new lead instantly, while it's hot
- it catches the leads a busy team misses: after hours, weekends, travel, post-conference
- follow-up that never slips; nurtures every lead until ready

SCORE each candidate on:
1. GENUINENESS — is this a concrete, specific thing Louis would naturally notice and be curious about (a real post, comment, event)? The line does NOT need to connect to cooling leads — the video does that. Down-rank only the empty/forced (nothing real to react to).
2. FRESHNESS — newer is much better. 0-3 days = timely; ~2 weeks = recent; 1-2 months = stale. Prefer fresh; a stale signal loses to a fresh one.
3. READER-RECOGNIZABILITY — would the prospect INSTANTLY recognize it as theirs (their own post, their company, a named event) vs something oblique they'd strain to recall (a fleeting like of someone else's post, a generic role line)?
4. SPECIFICITY — a concrete particular, not bare title/tenure.

REJECT a candidate outright if: bare title + tenure ("X years as Sales Director"), generic-to-anyone, a like/repost of someone ELSE's post that isn't clearly the prospect's own view, or nothing real and specific to react to.

WEB SIGNALS (bucket 6 "company news (web…)" and bucket 7 "web/press about them") come from googling the person + company — press, interviews, podcasts, talks, funding/hiring/launch news. A clearly-about-THEM web hit is strong and recognizable (recent company news especially). But REJECT a web hit if: it could be a NAMESAKE (a different person with the same name — when in doubt, reject), it's a generic directory/aggregator/profile page, or it's a stale fact dressed as news. Only pick a web signal you'd bet is genuinely about this exact prospect/company.

Pick the ONE best overall (a fresh, recognizable, specific own-post Louis would genuinely react to usually beats a stale or oblique one). If NOTHING clears the bar, choose floor.

Output ONLY JSON: {"choice": <the [index] number, or "floor">, "why": "one line: the genuine thing to react to + why this beat the others (freshness / recognizability)"}`;

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
  // Now that B6 always runs, cap each page read so one slow site can't stall a render.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"] }),
      signal: ctrl.signal,
    });
    if (!res.ok) return "";
    const d = await res.json();
    return ((d.data || {}).markdown || "").slice(0, 1500);
  } catch { return ""; }
  finally { clearTimeout(timer); }
}

// What a human does: google the person + the company. Brave Search returns
// web results we feed as candidates (press, interviews, talks, funding/news/
// hiring) — the external signals LinkedIn + the company's own site never show.
// Best-effort like apify()/firecrawl(): [] on any failure or missing key.
type WebHit = { title: string; url: string; description: string };
async function webSearch(query: string, opts?: { count?: number; freshness?: string }): Promise<WebHit[]> {
  const key = Deno.env.get("BRAVE_SEARCH_API_KEY") ?? "";
  if (!key || !query.trim()) return [];
  try {
    const params = new URLSearchParams({ q: query, count: String(opts?.count ?? 5) });
    if (opts?.freshness) params.set("freshness", opts.freshness);
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: { "Accept": "application/json", "X-Subscription-Token": key },
    });
    if (!res.ok) return [];
    const body = await res.json();
    const web = ((body.web || {}).results || []) as Array<Record<string, unknown>>;
    return web.map((r) => ({
      title: String(r.title ?? ""), url: String(r.url ?? ""), description: String(r.description ?? ""),
    })).filter((h) => h.title || h.description);
  } catch { return []; }
}

// Hosts we never want as a "web signal": the prospect's own LinkedIn/site (already
// covered by B1-B6) and directory/aggregator pages (no real personalization).
const SKIP_HOSTS = ["linkedin.com", "facebook.com", "instagram.com", "twitter.com", "x.com",
  "youtube.com", "greens.dk", "bizz.dk", "proff.dk", "krak.dk", "wikipedia.org", "cvr.dk", "virk.dk",
  // data brokers / contact-scrapers / dictionaries — never real personalization
  "zoominfo.com", "rocketreach.co", "apollo.io", "tracxn.com", "lusha.com", "contactout.com",
  "signalhire.com", "leadiq.com", "theorg.com", "cambridge.org", "dictionary.com",
  "collinsdictionary.com", "merriam-webster.com", "glassdoor.com", "indeed.com", "prospeo.io"];
function skipHost(url: string, ownDomain?: string): boolean {
  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { return true; }
  if (!host) return true;
  if (ownDomain && (host === ownDomain || host.endsWith("." + ownDomain))) return true; // own site = B6
  return SKIP_HOSTS.some((h) => host === h || host.endsWith("." + h));
}
function domainOf(website?: string): string | undefined {
  if (!website) return undefined;
  try { return new URL(website.startsWith("http") ? website : "http://" + website).hostname.replace(/^www\./, ""); }
  catch { return undefined; }
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

const ageDays = (ts?: number): number => (ts ? Math.round((Date.now() - ts) / 86400000) : 999);

// ---- candidate builder (LAYER 0): flatten every scraped source into one list
// of angles, each tagged with bucket + age. The evaluator picks the best. ----
type Cand = { b: string; age: number | null; t: string };
// deno-lint-ignore no-explicit-any
function buildCandidates(posts: Post[], profile: any, reactions: unknown[], comments: unknown[], companyText?: string | null, personWeb: WebHit[] = [], companyWeb: WebHit[] = [], ownDomain?: string): Cand[] {
  const c: Cand[] = [];
  // B1 — self-authored posts, freshest first
  for (const p of posts.filter((p) => !p.is_repost).sort((a, b) => a.age_days - b.age_days).slice(0, 5)) {
    c.push({ b: "1", age: p.age_days, t: "own post: " + p.text.slice(0, 400) });
  }
  // B2 — their own comments (high signal: their words). Cap to the 4 freshest.
  const myComments = (comments as Array<Record<string, unknown>>)
    .map((cm) => ({
      mine: String(cm?.commentary ?? "").trim(),
      age: ageDays(cm.createdAtTimestamp as number),
      on: String(((cm.post as Record<string, unknown>) || {}).content ?? "").slice(0, 80),
    }))
    .filter((x) => x.mine && x.age <= FRESH_DAYS)
    .sort((a, b) => a.age - b.age).slice(0, 4);
  for (const x of myComments) {
    c.push({ b: "2", age: x.age, t: `their comment: "${x.mine.slice(0, 200)}"${x.on ? ` (under a post about: ${x.on})` : ""}` });
  }
  // B2 — likes (what resonates). Cap to the 4 freshest.
  const myLikes = (reactions as Array<Record<string, unknown>>)
    .map((r) => ({
      liked: String(((r.post as Record<string, unknown>) || {}).content ?? r.content ?? "").trim(),
      age: ageDays(r.createdAtTimestamp as number),
    }))
    .filter((x) => x.liked && x.age <= FRESH_DAYS)
    .sort((a, b) => a.age - b.age).slice(0, 4);
  for (const x of myLikes) c.push({ b: "2", age: x.age, t: "liked someone's post: " + x.liked.slice(0, 200) });
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
  // B6 — company site (always scraped now)
  if (companyText) c.push({ b: "6", age: null, t: "company site: " + companyText.slice(0, 500) });
  // B6 (web) — external company news (funding/hiring/launch/press) the own-site never shows. Cap 4.
  for (const h of companyWeb.filter((h) => !skipHost(h.url, ownDomain)).slice(0, 4)) {
    c.push({ b: "6", age: null, t: `company news (web, past yr): ${h.title} — ${h.description}`.slice(0, 400) });
  }
  // B7 — press / web mention OF THE PERSON (interview, podcast, talk, quote, article). Cap 4.
  for (const h of personWeb.filter((h) => !skipHost(h.url, ownDomain)).slice(0, 4)) {
    c.push({ b: "7", age: null, t: `web/press about them: ${h.title} — ${h.description}`.slice(0, 400) });
  }
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

// LAYER 2 — WRITER. Writes the full DM body (observation + bridge into the video)
// from the ONE chosen angle (locked voice). Still returned under `hook`.
async function writeBody(lead: Lead, angle: string): Promise<{ hook: string; lang: string } | null> {
  const user = `Prospect: ${lead.first_name ?? ""} ${lead.last_name ?? ""} — ${lead.title ?? ""} at ${lead.company ?? ""}.\n\nCandidate signals:\n${angle}`;
  const out = await anthropicJson(SYS, user);
  if (!out) return null;
  const hook = humanize(String(out.hook ?? "").trim());
  return hook ? { hook, lang: String(out.lang ?? "da") } : null;
}

const TRACE: Record<string, string> = {
  "1": "self-authored post", "2": "engaged content (comment/like/share)",
  "3": "self-written profile", "5": "background", "6": "company signal",
  "7": "press / web mention",
};

/**
 * Two-layer hook generation for one accepted CarterCo lead:
 *   scrape EVERYTHING up front (LinkedIn + B6 company site + person/company web)
 *   build the full candidate set (light per-bucket caps)
 *   LAYER 1 evaluator picks the single best angle across all of it (or floor)
 *   LAYER 2 writer writes the body from the chosen angle
 * Persists the body + the bucket + the evaluator's reasoning (hook_context).
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

  // SCRAPE EVERYTHING, THEN CHOOSE. No waterfall: gather every source up front and
  // let the evaluator pick the global best with full context. At CarterCo's volume
  // (tens/month, async render) the cost of always deep-scraping is pennies, and it
  // beats picking a locally-OK angle while a stronger unscraped one sits hidden.
  const ownDomain = domainOf(website);
  const first = (lead.first_name || "").trim();
  const last = (lead.last_name || "").trim();
  const company = (lead.company || "").trim();
  // Strip the legal suffix and EXACT-quote the company — bare generic-word names
  // ("VOCAST", "BusySunday") otherwise return dictionary/namesake junk.
  const cleanCo = company.replace(/\s+(a\/s|aps|ivs|p\/s|k\/s|inc|llc|ltd|gmbh)\.?$/i, "").trim();

  // LinkedIn (Apify) + company deep-scrape (Firecrawl) run in parallel — different hosts.
  const [posts, profile, reactions, comments, companyText] = await Promise.all([
    scrapePosts(url), scrapeProfile(url), scrapeReactions(url), scrapeComments(url),
    website ? b6(website) : Promise.resolve(null),
  ]);
  // Google the person + the company — sequential to respect Brave's ~1 req/s free tier.
  const personWeb = cleanCo ? await webSearch(`"${`${first} ${last}`.trim()}" "${cleanCo}"`, { count: 5 }) : [];
  const companyWeb = cleanCo ? await webSearch(`"${cleanCo}"`, { count: 6, freshness: "py" }) : [];

  const cands = buildCandidates(posts, profile, reactions, comments, companyText, personWeb, companyWeb, ownDomain);
  tried = [...new Set(cands.map((c) => c.b))];
  const ev = cands.length ? await evaluate(lead, cands) : { choice: "floor" as const, why: "no signals scraped" };

  // Honest floor — no real angle cleared the bar. State persists so a later touch
  // can resume (re-scrape may surface a fresh post / new company event).
  if (ev.choice === "floor" || typeof ev.choice !== "number" || ev.choice >= cands.length) {
    await persist(null, "floor", "da", `floor: ${ev.why}`);
    return { ok: true, hook: FLOOR, bucket: "floor" };
  }

  const chosen = cands[ev.choice];
  const ageTag = chosen.age !== null ? `${chosen.age}d` : "no date";
  const angle = `[CHOSEN ANGLE — bucket ${chosen.b}, ${ageTag}] ${chosen.t}\nWHY: ${ev.why}`;
  const r = await writeBody(lead, angle);
  if (!r) {
    await persist(null, "floor", "da", `writer failed after choosing bucket ${chosen.b}: ${ev.why}`);
    return { ok: true, hook: FLOOR, bucket: "floor" };
  }
  await persist(r.hook, chosen.b, r.lang, `${ageTag} · ${ev.why}`);
  return { ok: true, hook: r.hook, bucket: chosen.b };
}
