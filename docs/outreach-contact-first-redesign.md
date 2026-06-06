# /outreach — contact-first cockpit redesign

Design doc from an office-hours session, 2026-06-05. Supersedes the direction of
the Flow tab as the headline artifact.

## The real problem (not what we started building)

We spent a session polishing a "Flow" decision-tree (aggregate counts at each
stage). But the actual pain Louis named is different:

> "I can't see the thread or history of each contact, or their pending/upcoming
> tasks — I have no idea what messages they'll each receive and when. And the
> tabs feel weird and frankenstein."

Triggered specifically by the **AI-driven clients — Tresyv and OdaGroup** (AI-written
first DMs, A/B arms, automated follow-up sequences), where the machine acts on
Louis's behalf and he's lost sight of what it's doing to each contact. The core
fear: **contacts being followed up wrong, or quietly forgotten.**

**Premise we got wrong:** the Flow tree is an aggregate map; it can't show a
contact's thread or what's coming next — the exact thing that's missing. The
real missing primitive is a **per-contact timeline: past messages + projected
upcoming sends, with dates.** Several of the 10 tabs exist only because that
primitive was never built.

## Decision: contact-first cockpit (Approach B)

Make the **per-contact timeline the spine of /outreach**, and collapse the 10
frankenstein tabs into ~4.

### The missing primitive — contact timeline

Open any contact and see one screen:

- **Header:** name, company, title, current status, which sequence + step,
  ICP scores.
- **Thread (past):** every message merged in chronological order — sent
  (`rendered_message` / `personalized_hook` / `outreach_emails`) and received
  (`outreach_replies`) — each tagged with channel (LinkedIn DM / email),
  timestamp, and origin (AI hook bucket, A/B arm, manual).
- **Upcoming (future) — the new bit:** projected next sends with real dates.
  Walk the contact's sequence forward from their current step using each step's
  `waitHours` + `sequence_parked_until`: "Next: *kalender* on Tue 10 Jun —
  <template preview>", then subsequent steps projected out. Mark conditional
  steps ("if no reply"). 
- **The forgotten/wrong guard falls out for free:** a contact that's `sent` but
  has no sequence, no upcoming step, and no terminal outcome = **"no next step —
  may be forgotten."** That single derived flag is the confidence Louis asked
  for, surfaced per contact instead of hoped-for in aggregate.

All buildable from existing data — no new pipeline. The forward projection is
the only new logic (read `outreach_sequences.steps[].waitHours` + the contact's
`sequence_step` / `sequence_parked_until`).

### New information architecture: 10 tabs → 4

| New tab | Folds in today's | Why |
|---|---|---|
| **Gør nu** (act) | I dag, Opgaver, Indbakke, Svar, Signaler | Everything needing Louis's action = one prioritized queue. These 5 all answer "what do I do next?" |
| **Kontakter** (contacts) | Alle, Sendt, ICP-afvist | The spine. One list of contacts; each opens the timeline. Sendt / ICP-afvist become filters, not tabs. |
| **Performance** | Flow, the funnel, A/B scoreboard | The numbers + the flow map demoted to a sub-view. Also the seed of a client-facing overview later. |
| **Læring** | Læring | Unchanged (ICP tuning). |

The frankenstein feeling comes from action-surfaces (I dag / Opgaver / Indbakke /
Svar / Signaler) having accreted as separate tabs when they're one job. Merging
them is most of the cleanup.

### Play axis — a second scoping dimension (added 2026-06-06)

`/outreach` now runs several outbound **plays** concurrently within a workspace
(video-loop, hiring-signal, …) — orthogonal to workspace. The axis is live
(`outreach_pipeline.play`, `outreach_plays` registry; see
`docs/hiring-signal-play.md` §9). It folds into this IA as a **filter, not new
tabs** — a play selector parallel to the workspace dropdown, scoping Gør nu /
Kontakter / Performance, with the timeline tagging each contact's play. That's
**Phase 3** of the multi-play build (Phases 1 + 2a — schema + intake→pipeline
bridge — are already live).

## Phasing (ship value fast, don't disappear for 2 weeks)

1. **Phase 1 — contact timeline primitive.** Build the timeline panel (thread +
   projected upcoming + forgotten-guard), openable from the existing lists. This
   is the wedge: it alone kills "I can't see the thread or what's coming," and
   it's the atom the rest is built on. Shippable in ~half a day of CC time.
2. **Phase 2 — IA collapse.** Introduce **Kontakter** (contact list → timeline)
   and merge the action tabs into **Gør nu**. Retire Alle/Sendt/ICP-afvist as
   tabs (become filters/states).
3. **Phase 3 — Performance.** Move Flow + funnel + A/B scoreboard under one
   Performance tab; trim the Flow tree to a supporting map, not the headline.

Each phase is independently shippable and live.

## Open questions

- Does the timeline need to span channels beyond LinkedIn + email (SMS/call
  notes exist on the pipeline row)? Probably yes — fold `call_outcome` /
  `last_email_*` in.
- "Upcoming" projection accuracy: branches/conditions make it a best-effort
  forecast, not a guarantee. Label it as projected.
- Is Performance eventually client-facing (Tresyv/OdaGroup log in and see their
  own results), or operator-only for now? Deferred — start operator-only.

## The assignment (do this before we build)

Open the **OdaGroup** or **Tresyv** board, pick **one** contact you're actually
unsure about right now, and write down the 3 questions you'd want answered the
instant you open them (e.g. "what was the last thing said?", "what's the AI
sending next and when?", "is anything overdue?"). Those 3 questions are the spec
for the timeline panel — Phase 1 is done when that contact's screen answers all
three at a glance.
