# Product marketing context — Carter & Co

> Auto-loaded by the `/copywriting` skill before any copy work.
> Read this end-to-end before suggesting a single word change.
> Update this file whenever a copy decision is made that future-you would otherwise relitigate.

---

## 1. What we sell

**Carter & Co is a fractional GTM engineer.** Louis (founder, sole operator) builds *and runs* the revenue infrastructure for a small number of B2B clients at a time. Each engagement is 3-6 months. The client keeps the running system afterward.

The work breaks into three areas that show up on `carterco.dk` as 3 equal sections. Each client takes 1, 2, or all 3 — picked to what they actually need, not as a package menu.

### Three delivery areas (the sections on the homepage)

**Outbound** — finding prospects who don't know you and making them respond.
LinkedIn-beskeder personliggjort per modtager (built with AI, sent at scale, each one feels written-by-hand). Email-outreach. Meta-/Google-annoncer rettet mod folk der ligner dine bedste kunder. Reactivation flows for cold leads in your DB.
- Anchor case: **Tresyv** (cold LinkedIn at scale, 30%+ accept rate)
- AI-drafted DM style: **OdaGroup** (Niels at Oda ApS, Jarvis on top of Veeva/IQVIA/Salesforce, anchor proof = Novo Nordisk EU + Asia)

**Hastighed** (speed-to-lead) — when a lead lands, get them on the phone before they cool.
Form → screen → call within 5 min. SMS-bro if no answer. Push-notification to whoever's online. ICP-scoring on each lead. The MIT study (21× more qualified inside 5 min) is the headline external proof.
- Anchor case: **Murph** (87× faster lead response than industry average of 47 hours)

**Opfølgning** (post-meeting / nurture + close) — after first contact, keep momentum to deal close.
Pipeline that follows the day (not the week). Outcome marked same-day. Nurture flows for "ikke klar nu" leads. Reactivation flows for lost deals. Storkunde-fraled-detection (customer who quietly stops ordering). Attribution from lead source → won deal. AI-generated talepunkter before each call.
- Anchor case: **Burst** (4× conversion on same budget over 3 months)
- Full-system example: **Cleanstep** (~17M DKK DK rengørings-engros, DanDomain integration, full custom build — scoping in flight, NOT on the site yet)

### What's behind the demos

Real infrastructure, not slideware. ~25 Supabase edge functions across the 4 client workspaces (CarterCo, Tresyv, Haugefrom, OdaGroup). Real product surfaces: ICP scoring, reply-intent classifier, alt-contact search, phone-scout, push-notify, attribution, churn detection. The 5-6 mockups in each homepage section visualize work that actually runs.

### Engagement model + billing

- 3-6 months, fractional.
- **Billed hours + thin infra base.** Never retainer, never subscription, never fixed-fee, even when a client anchors a monthly budget.
- Cleanstep deal is the model: "Cleanstep betaler for det leverede — ikke for tidsforbruget. Hvis arbejdet tager længere end vurderet, er det mit problem. Bliver det hurtigere, er det min fortjeneste."
- Hourly rate: 1.000 DKK/time. Cleanstep scope: 45 hours = 45.000 DKK over 3 months, 3 rater.
- Drift (Vercel + Supabase + LLM API + Resend mail) inkluderet i engagementet.

---

## 2. Who buys — the buyer reading the homepage

**Founders and sales leaders at 5-50 person Danish B2B companies.** SaaS, agencies, professional services, niche manufacturers. Selling B2B contracts in the 50K–500K DKK range. Probably 1-5 sælgere on the team. CRM is HubSpot, Pipedrive, or "we use a spreadsheet."

### Their actual pain (in their words)

The phrases they use, the things that wake them up at night:

- "Leads kommer ind, men vi ringer dem først 2 dage senere"
- "Vores sælger har 150 leads i sin indbakke han aldrig nåede"
- "Vi sender 300 cold mails om måneden, får 0,5% reply rate"
- "Vi outsourced outbound til et bureau, men de svar vi får er for kolde til vi gider bruge tid"
- "Annoncerne kører, men jeg ved ikke hvilke leads der faktisk blev til kunder"
- "Vi mistede en 200K-kunde sidste år — sælgeren glemte at følge op efter mødet"
- "Vores største kunde holdt op med at bestille for 3 måneder siden, vi opdagede det for sent"
- "Jeg vil have lavet outbound der ikke føles som spam"

### Their objections

Things they're skeptical about, things they need addressed:

- "Endnu et system" fatigue. They don't want a new tool to learn.
- "Hvad ejer jeg bagefter?" — terrified of vendor lock-in or losing data when the consultant leaves.
- "Kan I komme i gang nu?" — they want it running, not a 6-month transformation project.
- "Hvad koster det egentligt?" — wants honest hourly billing, not "starting at" tier pricing.
- "Vi har ikke en stor stack — kan det stadig virke?" — yes. The system layers on what they have.
- "Hvordan er det forskelligt fra et marketing-bureau?" — bureaus recommend and hand off. Louis builds it AND runs it.

### Who they're comparing against

- Marketing/sales bureaus (Adversus, generic outbound shops)
- RevOps freelancers / consultants
- SaaS tools (HubSpot, Apollo, Outreach.io, Reply.io)
- "Skal vi hire en ny SDR?" — an internal SDR hire is the competitor for budget

The differentiator: **bureaus and consultants leave; SaaS tools require you to operate them; SDRs are full-time hires. Louis builds the system, runs it for 3-6 months, you keep it.**

### What "this person gets it" looks like

They book the lead-quiz CTA when they read a sub-point that names their exact problem in their own language. Specificity wins. Vague positioning ("we help B2B companies grow") gets bounced. Concrete process ("Lead lander → sælgeren har det på skærmen samme sekund. Ét tryk og du ringer op.") gets the quiz click.

---

## 3. Who Louis is

The operator. Not the brand. Not "vi." Specifically:

- **Builds and runs systems.** Hands-on from day 1. Writes the code, sets up the infrastructure, monitors the runs, debugs when something breaks. Not a consultant who recommends and leaves.
- **Direct line, no intermediaries.** No account manager. No juniors learning on your project. Calls go straight to him.
- **Fractional — small number of clients at a time.** Each gets real attention. The math is honest: a small operator who runs a few client systems well, not an agency with 50 logos and 3-person teams stretched thin.
- **Background in revenue ops.** Founded Burst Creators (the 4× anchor case), worked across B2B and B2C marketing/sales infrastructure.

### How to write Louis on the page

- First person singular: **jeg**, **jeg bygger**, **mit system**, **mine kunder**.
- Never "vi." There is no "vi."
- Never "solo" / "én mand" / "bare mig." That framing makes him sound under-resourced. The differentiator is "direct access to the builder + no juniors," NOT "I'm alone."
- Appears exactly once per page: in the founder card with photo + signature + mailto. Otherwise the system is the protagonist.

---

## 4. Voice rules

These are not preferences. They're guardrails. Future copy that violates them gets rewritten.

### Voice

- **Dansk first.** All visitor-facing copy in da_DK. Operator UI can switch to en_US.
- **Operator-jeg, never brand-vi.** "Jeg bygger" not "Vi tilbyder."
- **Buyer-perspective in sub-points.** The visitor is the BUYER (founder/sales leader hiring Louis), not the prospect being contacted. "Mails til beslutningstagerens indbakke" = the buyer's prospect's inbox, not the visitor's inbox. Don't write "skrevet til DIG, ikke til DIN titel" — visitor reads "what? I'm not getting these messages."

### Words and phrases

- **Use the customer's vocabulary.** "Lead-konvertering", "responstid", "outreach-volumen", "pipeline" beat "Salgsinfrastruktur" in body copy. Display headlines can be aspirational; body copy is operational.
- **No AI vocabulary.** No "comprehensive", "robust", "seamless", "intricate", "vibrant", "leverage", "unlock", "empower", "transformative", "innovative", "streamline", "optimize".
- **Accepted Danish B2B loanwords (keep these):** lead, ICP, CRM, push (notification), AI, B2B, SaaS, CRO, COO, outbound (in eyebrows / sales talk), pipeline.
- **Translate Anglicisms in copy:**
  - "outcome" → "resultat"
  - "attribution" → "sporing"
  - "nurture flows" → "plejeflows"
  - "stack" (in non-tech-stack contexts) → "værktøjer", "opsætning"
  - "alert" → "alarm" or "advarsel" or rephrase ("Storkunde falder fra" not "Fraled-alert")
  - "brief" → "oplæg", "noter", or context-specific ("Talepunkter før opkald" not "Pre-meeting brief")
  - "scout" → "opsporing" or "fundet"
  - "intent" → "type", "kategori", "intention"
- **No em-dashes in body copy.** Use periods or semicolons. Reserved exception: the founder letter uses em-dashes as a letter device.
- **Curly quotes, not straight.** Ellipsis character `…` not `...`.

### CTAs

- Every CTA leads to a conversation: lead-quiz → Calendly, mailto, phone.
- **Forbidden:** "Sign up", "Start free trial", "Create account", "Get started" (when paired with signup-like intent), "Submit", any tier picker.
- **Allowed:** "Tag lead-quizzen", "Book et opkald", "Skriv direkte til Louis", "Se hvordan det virker".

---

## 5. Forbidden patterns

Never ship these. Cumulative — they pile up to make the site read SaaS / agency / generic:

| Forbidden | Why |
|---|---|
| `/pricing`, `/features`, `/changelog`, `/integrations` pages | Don't exist in a fractional service. |
| "Solo / én mand / bare mig" | Sounds under-resourced. Use "direct line to the builder" framing. |
| Pricing tiers (Starter / Pro / Enterprise) | Service, not SaaS. |
| "Trusted by 10,000+ teams" / vanity scale | Fractional means small. Named portfolio beats anonymized scale. |
| Anonymized case studies ("a Series B SaaS client") | Every metric ties to a named client logo. If you can't name it, drop it. |
| Login button in marketing nav | `/outreach` exists but never surfaces on the public site. |
| AI-generated illustrations | Editorial / craftsman's notebook aesthetic. |
| Generic SaaS feature grid (3-column icon + title + description) | The most recognizable AI-template layout. |
| Purple/violet gradients | The most recognizable AI-template color scheme. |
| Lottie/Rive decoration | Motion only when it explains the mechanism. |
| Happy talk / welcome paragraphs | "Welcome to Carter & Co" dies. Users scan, they don't read introductions. |
| Meta-talk about page structure | "Tre dele · samme værksted" killed for this reason. The 3 numbered sections show it; we don't say it. |

---

## 6. Copy principles (the iteration-night gold)

Lessons learned by writing badly, then rewriting. Each one cost an hour at some point. Don't relitigate.

### 6.1 Headline + sub-points must not repeat the same claim

If the title says "Give them a reason to respond," sub-points should be channels/mechanisms, not three different ways of saying "we make it personal."

**Bad (rejected during iteration):**
> Give dem en grund til at svare.
> - Henvendelser der føles personlige og velovervejede, ikke spam ← repeats title claim
> - LinkedIn-beskeder skrevet til dig, ikke til din titel ← repeats title claim
> - Mails direkte til indbakken, uden om receptionen
> - Annoncer rettet mod dine bedste kunder, ikke alle der ligner

**Good (shipped):**
> Give dem en grund til at svare.
> - Personlige LinkedIn-beskeder, automatiseret per modtager
> - Mails direkte til beslutningstagerens indbakke
> - Annoncer til folk der ligner jeres bedste kunder
> - Genaktivering af kolde leads I allerede har samlet

The title carries the qualitative claim ("they want to respond"). The sub-points carry the channels (LinkedIn, mail, ads, reactivation). No overlap.

### 6.2 "Ikke X" pattern only works when X is an instant cliché

`Y, ikke X` requires the reader to recognize X as a known-bad thing immediately. If they have to think about what X means, the contrast fails.

**Works:**
> Annoncer til folk der ligner jeres bedste kunder, ikke bredt
("ikke bredt" = the broad-targeting cliché everyone knows is wasteful)

**Doesn't work:**
> Personlige LinkedIn-beskeder, ikke skabeloner
("ikke skabeloner" requires the reader to think about what skabeloner means in this context AND whether their current outreach IS skabeloner — too many cognitive steps)

**Rule:** Default to positive statements ("X is Y"). Only use the `Y, ikke X` form when X is a one-word universal-bad ("spam", "bredt", "skabeloner" if context is super-clear).

### 6.3 Lead with experience or quality, not mechanism

Buyer doesn't care that you record a personal video per recipient. Buyer cares that the message feels considered.

**Bad:**
> Henvendelser der ikke føles kolde — research, video, en grund til at læse

**Good:**
> Personlige LinkedIn-beskeder, automatiseret per modtager

The first one is the operator describing the tool. The second is the buyer's outcome (it gets done at scale, but feels personal).

### 6.4 Buyer reads as buyer, not as prospect

The homepage visitor IS the buyer (founder hiring Louis). "Dig" in sub-points means the buyer, not the buyer's prospects. Confusion kills the line.

**Bad:** "LinkedIn-beskeder skrevet til dig, ikke til din titel" (buyer reads: "what? I'm not getting these messages")

**Good:** "Personlige LinkedIn-beskeder, automatiseret per modtager" (buyer reads: "yes, we'll send personal DMs to OUR prospects at scale")

### 6.5 If deleting 30% improves it, keep deleting

The page is heavy by default. Cuts are easier wins than additions. Specifically:

- Body paragraphs that restate sub-points → cut the body, keep the sub-points
- Sub-points that double a row-2 mockup → cut the sub-point, the mockup carries it
- Subheads that just announce page structure ("Tre dele · samme værksted") → cut entirely
- Welcome paragraphs / introductions → cut entirely
- Section connective beats that recap → cut entirely

### 6.6 Every metric ties to a named client logo

If a number can't be attributed to a named case (Tresyv, Murph, Burst, etc.), it doesn't go on the page. External claims (MIT 21×) carry inline citations to the linked PDF. No anonymized proof, ever.

### 6.7 Timing claims must match reality, not approximate it

When describing time-sensitive mechanics, name the actual time scale, not a looser one. Looser-than-reality undersells what's built.

**Bad (rejected during iteration):**
> Hvert opkald får et resultat samme dag, pipelinen lyver ikke
("samme dag" is loose. The reality: salesperson taps the outcome chip on the phone *right after* the call ends. Not "later in the day.")

**Good:**
> Sælgeren markerer resultatet lige efter opkaldet, pipelinen lyver ikke

Same principle for the push-til-mobil claim — say "med det samme" (or similar) when the reality is instant, not "samme dag" or "inden for X minutter."

The buyer cares about urgency. If we say "samme dag" when we mean "med det samme," we sound like every other slow CRM vendor. Precision is the differentiator.

### 6.8 Outbound goes metric-less by design

Owner-confirmed: accept-rate is an activity metric, not an outcome metric. The ICP (founders, sales leaders) doesn't care about LinkedIn accept rates. Let the mockup do the proof (LinkedIn DM card + SendSpark thumbnail + Meta ad card) instead of leading with a stat that lands soft.

Speed-to-lead carries MIT 21×. Post-meeting carries Burst 4×. Outbound section's strength is in showing the work, not in claiming a number.

---

## 7. Client mapping (anchor + supporting cases)

Each homepage section has one anchor case + optional supporting circles. Map below is the current source of truth.

| Section | Anchor case | Anchor metric | Supporting clients |
|---|---|---|---|
| 01 · Outbound | Tresyv | "Kører den i dag" (no flashy number) | TBD — placeholder circles removed until real names exist |
| 02 · Hastighed | Murph | 87× faster than industry (3 min vs 47 hours) | TBD |
| 03 · Opfølgning | Burst | 4× lead-konvertering på samme budget | TBD |

### Other clients (not on the site yet — flag if asked to add)

- **Cleanstep** — DK rengørings-engros, ~17M DKK 2024. Full-system buyer scoping in flight 2026-05-15. **Do NOT mention on the site until the deal closes.** Memory entry: `project_cleanstep_deal.md`.
- **OdaGroup** — Niels @ Oda ApS, Jarvis on Veeva/IQVIA/Salesforce, anchor proof Novo Nordisk EU + Asia. AI-drafted DM client.
- **Haugefrom** — separate workspace, SendSpark video.

---

## 8. Proof points & numbers (what stands behind every claim)

### Internal data (CarterCo / client metrics)

| Number | Source | Where it can appear |
|---|---|---|
| 4× lead-konvertering | Burst, 3 months, same budget | Post-meeting / Opfølgning section, Burst anchor line |
| 87× hurtigere lead response | Murph vs industry avg of 47 hours | Hastighed section, Murph anchor line |
| ~38.6% accept rate (CarterCo) | 15-day cold LinkedIn data | NOT on the site (owner-rejected — accept rate is activity, not outcome) |
| ~30.9% accept rate (Tresyv) | 15-day cold LinkedIn data | NOT on the site (same reason) |

### External (cited)

| Number | Source | Citation form |
|---|---|---|
| 21× mere kvalificeret | MIT response-time study | Inline link to PDF: `https://25649.fs1.hubspotusercontent-na2.net/hub/25649/file-13535879-pdf/docs/mit_study.pdf` |
| "Branchen tager 47 timer" | Industry baseline for lead response | Implicit, paired with Murph's 3-min anchor |

### Numbers that should NEVER appear

- Anything in the form "Trusted by N+ teams" — vanity scale (forbidden)
- Accept rates on Outbound (owner call — buyer doesn't care)
- Random impressive-sounding statistics with no source (forbidden under "If you can't link it, don't claim it")

---

## 9. Decision log

Choices that came up during iteration. Don't relitigate without strong new info.

| Date | Decision | Rationale | What was rejected |
|---|---|---|---|
| 2026-05-15 | 3 equal-weight sections (Outbound/Hastighed/Opfølgning) | Each client takes 1-3; the work is real across all three | 2-machine (demand + conversion); 4-machine (find/call/nurture/close separate); role-based ("Fractional Head of Revenue"); outcome-based (lead with buyer outcomes) |
| 2026-05-15 | Each section is "del" not "maskine"/"system" | "Maskine"/"system" reads SaaS-shaped. "Del" reads as parts of an infrastructure being assembled | "Maskiner", "systemer", "moduler", "tilgange" |
| 2026-05-16 | Killed "Tre dele. Ét billede." connective beat | Meta-talk about page structure, not buyer value. Cases section above + anchor circles in each section already tell the "different clients = different paths" story | Keep as cards-only; rewrite with different headline |
| 2026-05-16 | Killed "Tre dele · samme værksted" subhead | Same meta-talk reason. Numbered 01/02/03 sections show it without saying it | Keep with different wording |
| 2026-05-16 | Section eyebrows in Danish (OUTBOUND / HASTIGHED / OPFØLGNING) | "Outbound" is accepted Danish loanword. "Speed-to-lead" and "post-meeting" were imported B2B jargon on a Danish-first site | SVARTID (too narrow for the speed concept); EFTER MØDET (too literal); keeping English (lost the Danish-first thread) |
| 2026-05-16 | Outbound goes metric-less | Accept rate is activity, not outcome. Buyer doesn't care | Use Tresyv 30.9%; use CarterCo 38.6%; use a combined or different metric |
| 2026-05-16 | Supporting client circles removed (until real names) | Codex flag: TBD placeholders add visual proof-weight without proof | Keep TBD circles as silhouette placeholders; remove entirely (chosen) |
| 2026-05-16 | Wire-down-the-left spine killed | Was a 4-stage funnel spine. Doesn't fit 3 equal areas (they're a practice, not a sequence) | Redesign as 3-section spine |

---

## 10. Site structure (current, post-restructure)

Order matters. Each section has a job. If a section can't name its job in one sentence, it shouldn't ship.

| # | Section | Job | Notes |
|---|---|---|---|
| 1 | Hero (ember) | Promise + brand signal | "Salgsinfrastruktur til ambitiøse B2B teams" + subtitle naming the 3 dele |
| 2 | Logo strip (sand) | "I have real clients" | Currently marquee; DESIGN.md says replace with printed contact sheet |
| 3 | Cases section (sand) | "Three named results, different industries" | "Forskellige brancher · Samme retning." with Tresyv / Murph / Burst cards |
| 4 | Journey H2 + 3 machine sections (ember, with internal radial backdrops + EmberSpark dividers) | The 3 delivery areas in depth | Each: eyebrow + h3 + body (optional) + 4-6 sub-points + proof + anchor + 4 row-2 mockups |
| 5 | Sand bridge | Rhythm fix between journey-ember and stack-ember | Thin printer's rule on sand. No copy. |
| 6 | Stack section (ember) | "You keep your stack" — anti-objection | Currently full section; DESIGN.md says shrink to one row of connected logos |
| 7 | Founder card (sand) | "This is who's actually doing it" | Photo + Polaroid + signed letter. Mention "fractional GTM-ingeniør i 3-6 måneder" |
| 8 | Lead-quiz CTA section (ember) | The ask | One primary CTA, no competition |

---

## 11. How to make decisions when iterating copy

When asked to "make this better":

1. **Read this whole file first.** Especially section 6 (copy principles) and section 9 (decision log).
2. **Identify the role of the line.** Is it title (qualitative claim) or sub-point (channel/mechanism)? Different roles need different copy patterns.
3. **Check for redundancy with the title and other sub-points.** If three lines say "personal", cut two.
4. **Check buyer-perspective.** "Dig" should refer to the visitor/buyer, not their prospects.
5. **Prefer positive statements.** "Ikke X" only when X is a one-word cliché.
6. **Cut before adding.** If deleting 30% improves it, keep deleting.
7. **Specificity over poetry.** "Hente dem ind hvor de allerede er" said nothing. "Give dem en grund til at svare" says something. Always name the concrete action or outcome.
8. **Tie back to a real proof point.** If you can't link it to a named client or external citation, don't put it on the page.

When in doubt, leave the existing copy alone and tell the user the line is fine.

---

## 12. Files to cross-reference

- `DESIGN.md` (project root) — design system, visual rules, decisions log
- `clients/odagroup/agent-brief.md` — Niels' voice DNA + 4 strategies + pain banks (great voice-of-customer reference)
- `clients/cleanstep/tilbud.md` — what a real Carter & Co engagement looks like on paper (DanDomain integration, AI upsell-mails, lead-pulje, attribution dashboard, etc.)
- `BACKLOG.md` — outreach pipeline learnings (Tresyv 2-link template kills video thumbnail, etc.)
- `docs/site-restructure-three-machines.md` — the original plan doc for the 3-section restructure
- `src/app/page.tsx` — the actual site

---

*Last updated: 2026-05-16. Update this file when a copy decision happens that future-you would otherwise relitigate.*
