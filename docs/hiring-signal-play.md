# The hiring-signal foot-in-the-door play

> **Status:** Intake built + validated 2026-06-05 (`scripts/lead-enrichment/apify_hiring_intake.py`). Cadence designed, not yet wired. Video script pending (Louis to record).

## 1. The play in one line

A DK B2B company posts a sales/SDR role → we detect it the day it goes live → we
pull a sample of **their** ideal buyers → we open with *"here are 5 of your buyers
and the exact DMs I'd send them — before you put 600k+/yr into one seat."*

Outbound is the **foot in the door** (the most legible "yes" — they can hold the
list in their hand). Speed-to-lead and post-meeting are the **expansion** once
we're inside. See [[project_site_three_machines_plan]].

## 2. Why the hiring signal is the richest trigger we have

A sales job posting is five inputs in one public document:

| Input | Field from the intake |
|---|---|
| **Trigger** — timed, dated buying intent | `posted_date` (+ `--posted-limit`) |
| **Pain spec** — what they want done, in their words | `jd_text` |
| **ICP hint** — who they sell into | `jd_text` (target vertical) |
| **Budget anchor** — the price comp | `salary` when disclosed; role band otherwise |
| **Contact** — who to reach | `hiring_contact` (when exposed) or the employee scrape |

It's a self-declared "we need more pipeline," with budget approved, addressed to
exactly the buyer we want.

## 3. The intake (BUILT)

`scripts/lead-enrichment/apify_hiring_intake.py` — one harvestapi actor
(`linkedin-job-search`, same `APIFY_API_TOKEN`, ~$1/1k jobs), DK-defaulted.

```
intake → companies-out → apify_enrich_brands.py → their buyers → the sample
```

`company_linkedin_url` comes out already shaped for `apify_enrich_brands.py`, so
the Jina/`find_linkedin_companies` bridge is skipped. Bonus fields captured:
`domain` (feeds Firecrawl B6), `hiring_contact` (the poster, when LinkedIn
exposes them).

### Two filters do the real work — the actor's keyword search is junk

The actor barely applies the search term (querying "salgskonsulent" returns
chefs, juicers, a bricklayer). So **precision is entirely client-side**, two gates:

1. **Role gate** (`is_sales_role`) — keep only genuine B2B sales/SDR/BDR/biz-dev
   titles; drop engineers, ops, retail floor staff.
2. **ICP gate** (`is_icp_company`) — drop the giants (>1000 emp — Salesforce,
   Vattenfall, STARK; they *are* the outbound machine) and retail industries.
   Tunable via `--max-employees` / `--min-employees`.

### Operating mode — run DAILY, not weekly

`maxItems` is a *total* run cap (~40 pages), and the DK feed is large + diluted,
so a single weekly `--posted-limit week` pull only *samples* the week. Run it
**daily with `--posted-limit 24h`** — fresher signal, less dilution, and you
reach the buyer the day they post. Accumulate across the week.

```bash
set -a; source .env.local; set +a
python3 scripts/lead-enrichment/apify_hiring_intake.py \
  --out clients/carterco/data/hiring_intake_dk.csv \
  --companies-out clients/carterco/data/hiring_companies_dk.csv \
  --roles "SDR" "sælger" "salgskonsulent" "business development" "account executive" "kundeansvarlig" \
  --max-items 300 --posted-limit 24h
```

**Realistic yield:** ~5–15 clean DK ICP targets/week at current thresholds. A
trickle, but a *high-intent* trickle for a hands-on operation. Lever to widen:
add Nordic geos (Apollo covers SE/NO/FI) or loosen `--max-employees`.

## 4. Office-hours pressure-test (read before scaling)

Honest hard questions a YC partner would put to this play:

1. **"Before you spend 600k on a seat" can read as an insult.** You're telling
   someone who *just won headcount approval* that their plan is dumb. Reframe
   from threat → augmentation: *"You're hiring an SDR — here's a head start so
   they're booking in week 1 instead of month 3,"* or *"whether or not you fill
   it, here are 5 buyers I'd start with."* Don't fight their decision; ride it.
2. **The poster isn't always the buyer.** Half these are posted by TA/recruiters.
   Route to the sales leader / founder (`hiring_contact` → verify title; else
   employee scrape for the Head of Sales), not whoever clicked "post."
3. **Fresh-posted may be the wrong moment.** Day-1 they're committed to hiring.
   A role **still open at 3–4 weeks** = the hire is failing = more receptive.
   Worth A/B-ing recency: brand-new vs. aging-open.
4. **Volume is thin.** 5–15/week won't fill a business alone. This is one intake
   feeding the existing engine, not the whole engine. Treat it as the
   highest-intent lane, not the only one.

## 5. The cadence

**Type:** trigger-based (not cold). **Persona:** founder / CEO / Head of Sales /
Sales Manager at a DK B2B SMB (20–500 emp) who just posted a sales role.
**Channels:** LinkedIn DM (SendPilot, primary) · email (parallel, past
gatekeepers) · **SendSpark personalized video** (centerpiece). **No phone** —
that's the speed-to-lead machine for inbound, not an outbound channel here.
**Goal:** book a conversation. **Duration:** ~16 days, 6 touches.

| Day | Step | Channel | Action | Personalization |
|----|----|----|----|----|
| 0 | intake | — | Detect posting, pull their 5 buyers + draft a DM for each (the sample) | — |
| 1 | 1 | LinkedIn | Profile view + connection request, note references the JD. **No pitch.** | L4 (their exact role + vertical) |
| 1 | 1b | Email | Parallel opener (in case no LI accept): the sample teaser | L3 |
| on accept (else D3) | 2 | **SendSpark video DM** | 60–90s: walk *their* site, show the 5 buyers + the DMs you'd send. **The pitch.** | L4 |
| 4 | 3 | Email | If video viewed, no reply: the budget-math angle (head start, not "don't hire") | L3 |
| 7 | 4 | LinkedIn | New value — one extra buyer or a vertical insight; soft nudge | L3 |
| 11 | 5 | Email | Specific proof: a Tresyv/Bikenor-style outbound result, one line | L3 |
| 16 | 6 | LinkedIn | **Soft open-door** (NOT a breakup) — "leaving the list with you, here if timing shifts" | L2 |

> **Carter & Co rules applied** — no breakup touch ([[feedback_no_breakup_followups]]);
> no fabricated proof / performative signals ([[feedback_no_fabricated_proof]],
> [[feedback_no_performative_signals]]); service not SaaS, every CTA = a
> conversation ([[feedback_service_not_saas]]); differentiate on substance
> ([[feedback_carter_and_co_not_solo]]).

### This plugs into the engine that already exists

The advanced play is **not new send infra.** It's a new *intake* feeding the
existing `SendPilot → SendSpark → sequences.ts` loop (see `docs/outreach-playbook.md`):

- Step 1 connection request = SendPilot invite.
- Step 2 video = the existing `connection.accepted → SendSpark render → DM` path.
- Steps 3–6 = a new play-specific sequence in `sequences.ts`, driven by the same
  SendSpark engagement signals (`viewed`/`played`/`watched_end`/`cta_clicked`)
  that already branch `watched_followup_v1` / `unwatched_followup_v1`.

So: **new intake + one new sequence**, on top of a send machine that's live.

## 6. Should we use SendSpark? — YES, as the centerpiece (not a fallback)

The generic cadence playbook says "use video at step 5+ if email stalls." For
**this** play that's wrong. The video is the single best fit because:

- It can **show the sample** — screen-record walking their site, then "here are 5
  of your buyers, here's the DM I'd send each." That's unfalsifiable proof of the
  service, delivered *as* the service.
- It's already a named line on the outbound offer ("video-optagelser af deres
  egen website") and already wired (`connection.accepted → SendSpark`).
- At 5–15 prospects/week, per-render cost is trivial.

So SendSpark is **Step 2, the pitch** — fired on connection-accept — not a
step-5 rescue. Email/LinkedIn text steps exist to *earn the open* and *follow the
engagement signal*, with the video doing the persuading.

### Video script — structure for Louis to record (≤90s)

1. **Name + proof-of-research (0–10s)** — "Hej {firstName} — I saw {company}'s
   just opened the {role} role." (Quote the real JD detail. No performative
   fluff.)
2. **The turn (10–25s)** — not "don't hire," but: "So I did the first slice of
   that SDR's job for you." Pull up the screen.
3. **The sample (25–70s)** — show the 5 real buyers + the DM drafted for each.
   This is the whole pitch; let the artifact talk.
4. **Soft CTA (70–90s)** — "That's 5 of maybe 500. If it's useful, I'll walk you
   through the rest — 15 min this week?" Conversation, not demo.

(One reusable script; the *sample* on screen is what's personalized per prospect.)

## 7. A/B angles

| # | Test | Variant A | Variant B | Metric |
|---|---|---|---|---|
| 1 | Recency of trigger | posted ≤24h | role still open ≥3 wks | positive reply |
| 2 | Step-1 note frame | "head start for your new hire" | "5 buyers I'd start with" | accept rate |
| 3 | Video CTA | specific time ("Thu 15 min?") | open ("worth a look?") | meeting-booked |
| 4 | Email opener | budget-math (seat vs system) | the sample teaser | reply rate |

## 8. Metrics (trigger-based, expect above cold benchmarks)

| Metric | Target | Note |
|---|---|---|
| LinkedIn accept | ≥40% | baseline is 38.6% CarterCo / 30.9% Tresyv cold; trigger should beat it |
| Video view rate (of accepts) | ≥60% | SendSpark `viewed` signal |
| Positive reply | ≥7% | high-intent; should clear the 3–5% cold floor |
| Meeting booked | ≥5% | the only metric that matters |

## 9. Multi-play /outreach wiring (status)

The cockpit now models `play` as a second scoping axis, orthogonal to workspace
("concurrent plays" model; sequential hand-off deferred):

- **Phase 1 (DONE, live):** `outreach_pipeline.play` (default `video_loop`, all
  1097 existing leads backfilled) + `outreach_plays` registry seeded with
  `video_loop` + `hiring_signal`. Migration `20260606_outreach_play_axis.sql`.
- **Phase 2a — intake→pipeline bridge (DONE, verified):** `play` on
  `outreach_leads` + `outreach_record_invite` derives it onto the pipeline row,
  exactly alongside `workspace_id` (RPC tested end-to-end 2026-06-06). Bridge
  script `scripts/lead-enrichment/hiring_to_outreach_leads.py` seeds enriched
  hiring leads into `outreach_leads` tagged `hiring_signal` + emits the SendPilot
  CSV. Migration `20260606_play_on_leads.sql`. (Pre-seeds `outreach_leads`;
  `lead_inbox`→`outreach_leads` promote does NOT yet carry `play`.)
- **Phase 2b (TODO):** make sequence resolution play-aware and add
  `hiring_signal_v1` (cadence steps 3–6). Until then, hiring leads ride the
  existing video-loop sequences — fine as an interim (the video IS step 2).
- **Phase 3 (TODO):** play selector in the UI (parallel to the workspace
  dropdown), scoping Kontakter / Gør nu / Performance.

## 10. Next steps

- [ ] Louis records the SendSpark video (script §6) — one reusable take.
- [ ] Wire daily `24h` intake run (cron / `track-job-postings`-style schedule).
- [ ] Phase 2b: `hiring_signal_v1` sequence + play-aware engine.
- [ ] Phase 3: play selector UI.
- [ ] Decide contact routing: `hiring_contact` vs. Head-of-Sales scrape.
- [ ] First live batch on this week's clean targets; measure §8.
