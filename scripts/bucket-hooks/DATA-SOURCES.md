# Data sources — what we actually pull per bucket

Every field below is from a live probe of the real Apify actors (2026-06-02), not
guesses. Cookieless, ~1 cent/profile each. Maps to the buckets in `BUCKETS.md`.

---

## Bucket 1 — Self-authored content

**Actor: `harvestapi~linkedin-profile-posts`** · input `{ targetUrls:[url], maxPosts, includeReposts:true }`

Per post item:
| field | what |
|---|---|
| `content` | the post text they wrote |
| `postedAt.timestamp` / `.date` / `.postedAgoText` | when (we filter ≤90 days) |
| `repost` | object if it's a repost (→ feeds Bucket 2 "shared") |
| `author` | who (the prospect, or the company for reposts) |
| `postImages` / `postVideo` | media attached |
| `reactions` / `engagement` | likes/comments counts |
| `linkedinUrl` / `shareLinkedinUrl` | link to the post |

> Articles / speaking / webinars: LinkedIn has no clean structured field for these.
> They show up **inside posts** (people announce "excited to speak at X" / publish an
> article as a post). For pinned articles/talks, the profile scraper's `featured`
> and `publications` fields (see Bucket 5 area) are the place to look — **not yet
> wired in.**

---

## Bucket 2 — Engaged content (what they liked / commented / shared)

Three sources combine into "everything they engaged with":

**a) Shared / reposted** — free from the posts actor above (`repost` present).

**b) Liked — Actor: `harvestapi~linkedin-profile-reactions`** · input `{ profiles:[url], maxItems }`
| field | what |
|---|---|
| `action` | "Thomas Koed likes this" (also: celebrates / supports / loves / insightful) |
| `post.content` | full text of the post they reacted to |
| `post.linkedinUrl` / `post.author` | the post + who wrote it |
| `createdAtTimestamp` | when they reacted |

**c) Commented — Actor: `harvestapi~linkedin-profile-comments`** · input `{ profiles:[url], maxItems }`
| field | what |
|---|---|
| `commentary` | **their own comment text** (self-authored opinion — high signal) |
| `commentaryAttributes` | @-mentions etc. in the comment |
| `post.content` / `post.author` | the post they commented on + who wrote it |
| `createdAtTimestamp` | when |
| `engagement` | likes on their comment |

> A comment they wrote is nearly Bucket-1 quality: it's their own words and reveals
> what they care about + their voice. Likes show what resonates with them.

---

## Bucket 3 — Self-identified traits  &  Bucket 5 — Background

**Actor: `harvestapi~linkedin-profile-scraper`** · input `{ queries:[url], profileScraperMode:"Profile details no email ($4 per 1k)" }`
ONE call returns everything for both buckets:

Bucket 3 (self-written):
| field | what |
|---|---|
| `headline` | the line under their name |
| `about` | their "About me" section (often long, rich) |
| `currentPosition[].description` | how they describe their current role |

Bucket 5 (background) + extras:
| field | what |
|---|---|
| `experience[]` | every role: `position`, `companyName`, `duration`, `description` → tenure + **trajectory** |
| `certifications[]` | `title`, `issuedBy`, `issuedAt` |
| `honorsAndAwards[]` | awards |
| `receivedRecommendations[]` | recommendations written about them |
| `skills[]` / `topSkills` | skills (+ where used) |
| `education[]` | schools, degrees |
| `languages[]` | spoken languages (Bucket 4 junk — skip) |
| `volunteering[]` | professional volunteering / mentorship |
| `projects[]`, `publications[]`, `patents[]`, `courses[]` | **publications/projects can hold articles + talks (B1)** |
| `featured[]` | pinned content (their best post/article/talk — B1) |
| `organizations[]`, `causes[]` | boards, causes |
| `openToWork`, `hiring` | flags (job-search = drop; hiring = a B6-ish signal) |
| `connectionsCount`, `followerCount`, `influencer`, `premium` | scale/status |

---

## Bucket 4 — Junk drawer  →  SKIPPED

Personal interests, charity, languages, schools. Becc: junk/creepy. Not pulled.

---

## Bucket 6 — Company level

**Firecrawl** (`/v1/scrape`, markdown) on the prospect's company `website`:
| page | what |
|---|---|
| `/` (homepage) | company website language / positioning |
| `/careers` (or `/jobs`) | **hiring** signal (roles they're filling) |
| `/news` (or `/blog`) | company posts / blog / recent announcements |

> Firecrawl **cannot** scrape LinkedIn (returns "we do not support this site"), so
> all LinkedIn buckets go through Apify; Firecrawl is company-site only.
> Funding / M&A / external press (B6 #5–10) need a news-search source — **not yet
> wired.** Hiring can also come from the existing `track-job-postings` edge fn.

---

## Currently wired vs available

| Bucket | Wired now | Available but not wired yet |
|---|---|---|
| 1 | posts | `featured` / `publications` (pinned articles/talks) |
| 2 | reposts (shared) + reactions (partial) | full **comments** (their own words) + full **likes** |
| 3 | headline, about, role desc | — |
| 5 | trajectory, certs, awards, recommendations | skills/education/volunteering/boards |
| 6 | site + careers + news (Firecrawl) **+ Brave web search** (ext funding/M&A/press) | deep-read of top result page (Firecrawl) |
| 7 | **press/web mention of the person** (Brave web search) | deep-read; dated-result extraction |

---

## Web research (Brave Search) — emulating a human googling

Two searches per lead, run alongside the LinkedIn scrape (`BRAVE_SEARCH_API_KEY`):

| Query | → candidates | Fields used |
|---|---|---|
| `"{first} {last}" "{cleanCompany}"` | B7 press/web mention of the person | `web.results[].{title,url,description}` |
| `"{cleanCompany}"` (`freshness=py`) | B6 external company news (funding/launch/hiring/M&A) | same |

- `cleanCompany` = company with legal suffix stripped (`A/S`, `ApS`, `Inc`, `Ltd`…),
  EXACT-quoted to kill generic-word/namesake noise.
- `skipHost()` drops the prospect's own LinkedIn/site (already B1–B6), data brokers
  (ZoomInfo, RocketReach, Tracxn, prospeo, Apollo…) and dictionaries.
- Snippet-only (title + description); the evaluator scores them like any candidate
  and rejects namesakes. Best-effort — `[]` on any failure or missing key.
