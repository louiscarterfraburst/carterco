# Soho — meeting-room lead flow

Spec + build doc for the Soho engagement. Scope: **meeting-room slot bookings**
("Mødelokaler"), not office space. Goal of the system: turn FB-ad spend into
*rented meeting rooms*, with speed-to-lead reception calling, full contact
logging, and true ROAS attribution.

Locked decisions:
- **Telavox API click-to-call** for the dial button (not a bare `tel:` link).
- **Attribution target = room rented** (`outcome='customer'`), true ROAS.
  Viewing-booked tracked as the leading indicator.
- Lead source is a **landing-page form**, replacing Meta native instant forms.
  Builder of the page is TBD — design must not depend on who builds it.

Workspaces (two — event funnel kept separate):
- **Soho** (rooms) `7f13f551-9514-4a5a-b1bf-98eb95c1a469` — info@soho.dk (owner),
  louis@carterco.dk (operator), + Pernille (pm@), Victoria (vh@), Rosa (rlj@),
  Lee (lvl@).
- **Soho Events** `9d2a8cd2-ea01-4ab0-92c5-84e4256ccca7` — info@ (owner), louis@,
  Sahra (sahra@, event-only). Event ads (point 4) route here.
- A persistent **TEST lead** ("TEST – Realtime tjek") is kept in Soho on purpose.

Soho Meta identifiers (from Leads Center): `business_id=1902356403310858`,
ad account `asset_id=146975948684005`. Existing pipeline stages in Meta:
Intake → Mødelokaler → Kontor → Qualified.

Deploy model: feature branch → PR → **`main` (= production carterco.dk, auto-deploy)**.

---

## 0. Status (2026-06-03)

**Shipped to prod:**
- Two workspaces + 6 people with first names (`workspace_members.display_name`).
- `/leads` **workspace switcher** (multi-workspace users swap; per-workspace
  `workspace_id` filtering).
- **Ring-click logging** — clicking Ring writes a `phone` event
  (`/api/call-clicked`, `sender`=receptionist). Foundation for agent attribution.
- **Live activity** — `/leads` subscribes to `leads` + `lead_conversation_events`
  via Supabase Realtime (publication enabled on both); new leads, calls, notes
  appear with no refresh. Optimistic append for the actor.
- **Attributed notes** — `/api/note-added` + NoteComposer (⌘/Ctrl+Enter).
- **CallSummaryChip** — `📞 Rosa 14:32` row glance (anti-double-dial).
- **SMS gating** — `workspaces.sms_enabled` (CarterCo only); client panels are
  call-first (no AI-svar / "· SMS" / SMS chips leaking in).
- Push-notification banner compacted to a slim bar.

**Pending (build order §9):** lead-intake (landing page), Telavox dial wiring
(blocked on a calling seat), agent-overview dashboard, SMS cadence, attribution
+ CAPI, positive-never-booked queue.

---

## 1. Architecture

```
FB ad (campaign_id/ad_id in URL params, fbclid auto)
   │
   ▼
Landing page  ──(capture snippet: utm_*, fbclid, gclid, page_url)──┐
   │  form submit                                                  │
   ▼                                                               │
lead-intake edge fn  (per-workspace submit token)                  │
   │  insert into public.leads, workspace_id = Soho                │
   │  structured attribution columns (first-touch, immutable)      │
   ▼                                                               │
public.leads (Soho workspace)                                      │
   │  DB trigger → notify-new-lead → Web Push to reception phones  │
   ▼                                                               │
Reception panel (/leads, 6 receptionists)                          │
   │  dial → Telavox API click-to-call (call records flow back) ───┘
   ▼
outcome progression: interested → booked (meeting_at) → customer (room rented)
   │  CAPI event on booked + customer  ──────────────► Meta (optimize to rooms)
   ▼
Attribution report: leads × campaign_id × stage ÷ Meta spend
```

Nothing in the lead lifecycle (call_status / outcome / retry / meeting_at) is
new — those columns exist in `supabase/leads.sql`. The new work is: landing-page
intake, **structured** attribution, Telavox call integration, agent attribution,
and the SMS cadence.

---

## 2. Ingestion — landing-page intake (decoupled from page builder)

The landing page may be built by us (Vercel) or by Soho's web person. Either way
the contract is one page of spec, so the builder is never a bottleneck.

**Capture snippet** (we provide, ~15 lines JS): reads `utm_source/medium/
campaign/content/term`, `fbclid`, `gclid` from the URL, persists them in a
first-party cookie (so they survive multi-page navigation), and forwards them
with the form submit.

**`lead-intake` edge function** — generalize `meta-leadgen-relay`:
- Auth: per-workspace submit token (so Soho's form can only write to Soho's
  workspace; no cross-tenant spam).
- Resolve workspace from the token, **not** the hardcoded `carterco_workspace_id()`.
- Validate + dedupe (on email+phone within a short window, or a client-sent
  `dedupe_key`).
- Write structured attribution columns (below), not free-text notes.

On the FB ad side, set the destination URL params:
`?utm_campaign={{campaign.name}}&utm_content={{ad.name}}&campaign_id={{campaign.id}}&ad_id={{ad.id}}`
— Meta appends `fbclid` automatically.

---

## 3. Attribution model (true ROAS)

The question the system must answer: **"per krone of FB spend, how many meeting
rooms got rented, by which ad?"** Four links in the chain, each with a fix:

| Link | Break risk | Fix |
|---|---|---|
| ad → click | none | `campaign_id`/`ad_id` URL params + auto `fbclid` |
| click → form | params lost on nav | capture snippet (cookie-persisted) |
| form → lead | attribution overwritten | **first-touch, immutable** on lead at creation |
| rental → ad | usually skipped | **Meta spend joined by `campaign_id`** + CAPI on outcome |

Principles that make it actually dialled-in:
1. **Optimize on the real outcome.** Reward `outcome='customer'` (room rented),
   not form-fills. Form-fill optimization buys cheap junk leads.
2. **Cohort by lead-created-date, not conversion-date.** Rooms rent weeks after
   the click; conversion-date reporting produces garbage CPA. Report by the
   cohort the lead entered so CPL → cost-per-booking → cost-per-rental mature
   correctly.
3. **Spend has to get in.** Cost-per-rental needs Meta spend by `campaign_id`
   — this is the real reason for Meta read access (MCP reauth as the
   Soho-access identity, or a daily spend export). Without it: volume but no cost.

**Conversions API loop:** because we hold `fbclid` per lead, fire a CAPI event
server-side on `outcome='booked'` and `outcome='customer'` (dataset on Soho's ad
account). This is the single biggest lever on cost-per-rented-room — Meta learns
to find people who rent, not people who fill forms.

**Schema (new columns on `public.leads`):**
```
utm_source text, utm_medium text, utm_campaign text,
utm_content text, utm_term text,
fbclid text, gclid text,
meta_campaign_id text, meta_ad_id text, meta_form_id text,
landing_page_url text
```
First-touch: set once on insert, never updated. (Discrete columns beat a jsonb
blob here because we group/report by `meta_campaign_id`.)

---

## 4. Telavox — dial button (API click-to-call)

The dial button calls Telavox's API to originate the call from the receptionist's
own extension (agent's phone rings, then the lead). Chosen over a bare `tel:`
link because **call records flow back** — answered/not, duration, which agent —
which auto-populates both contact logging (§5) and the agent overview (§6) with
no manual entry.

**Telavox CAPI — verified 2026-06-03** (token in `.env.local` as `TELAVOX_API`):
- Base: `https://home.telavox.se/api/capi` (admin.telavox.com also works).
- Auth: `Authorization: Bearer <JWT>` (token type "Custom integration", per-user).
- **Dial:** `POST /v1/extensions/users/me/dial` body
  `{"phoneNumber":"0045…","autoAnswer":true}` — `00` intl prefix, NOT `+`.
- **Call history (poll):** `GET /v1/extensions/users/me/calls/history?callType=ALL`
  → answered/duration/etc. There are **no webhooks in CAPI**, so call logging is
  **poll-based**, not push.
- SMS also available: `POST /v1/extensions/users/me/sms`.
- `/me` = the token owner, so a per-receptionist token dials from that
  receptionist's phone and returns their calls → attribution is intrinsic. One
  shared token works if they share a device.

> BLOCKER: dial returns 400 "this user does not have access to this feature"
> unless the token belongs to a Telavox user with a real calling extension +
> CTI/click-to-call licence. Auth + read work regardless. Current token (Louis's
> Soho login) is a management seat without dial. Emailed Casper for a token from a
> calling seat. Both token types (Custom + CTI) hit the same wall → it's the seat.

Flow once unblocked: click dial → POST `…/me/dial` → poll `…/me/calls/history` →
reconcile real call records into `lead_conversation_events` (channel `phone`,
`source='telavox'`, `metadata`={duration, answered, telavox_call_id}, `sender`=agent).
The ring-click log (shipped) already records the intent; Telavox records enrich it.

---

## 5. Contact noted — SHIPPED

`public.lead_conversation_events`, surfaced as a live per-lead timeline:
- channel `phone` (ring-click via `/api/call-clicked`; Telavox records later) or
  `note` (manual via `/api/note-added` + NoteComposer). `sender` = the author's
  email; rendered as their first name via the workspace name map (fallback to
  local-part).
- **Realtime**: timeline + row chip update across all open panels with no refresh.
- Telavox call records (when unblocked) idempotent on `(source, source_id)` =
  `telavox` + `telavox_call_id`.

---

## 6. Agent overview (NOT yet built)

The data foundation exists: every call/note event carries `sender` (the actor's
email), so "who did what when" is already captured — no `performed_by` column
needed (earlier plan superseded; `sender` on events is the source of truth).

Still to build: a per-receptionist dashboard — calls made today, **answer rate**
(from Telavox records once unblocked), viewings booked, rooms rented,
**speed-to-first-call** (created_at → first call) — scoped per workspace.

---

## 7. Follow-up cadence — DESIGNED 2026-06-03 (via /sales-cadence)

Inbound, hot leads → goal = book a room viewing. **Calibrated for DK + a
low-stakes meeting-room enquiry: low-pressure, self-serve-first, and it NEVER
closes the lead.** Call-first; SMS + email follow-ups carry a booking link (never
a reply thread).

Tone rules: plain Danish, no hype, no manufactured urgency ("limited times!"),
no breakup. Lead with the booking link and let them act (autonomy > pursuit).

The model fix: `outcome` is terminal (set once — correct); the **no-answer
follow-up is attempt-aware**, keyed on `retry_count`. Today every no-answer fired
the same copy + delay — that's the flatness being fixed.

| Touch | Day | Call | If no answer → follow-up |
|---|---|---|---|
| 1 | 0 | call on enquiry (fast) | **Msg 1** "vi prøvede at fange dig" + book-link |
| 2 | 1–2 | call | **Msg 2** gentle nudge, other channel, + book-link |
| — | after | — | **Go quiet. NO close, NO breakup.** Lead stays open + eligible for §8 reactivation |

It's **operator-fired** — the receptionist decides per lead whether to send the
next touch. The ladder is a suggestion, not an autoblast.

Branches: answered+booked → confirmation + reminder (no-show defense);
answered+interested-not-booked → §8 positive-never-booked queue; only an explicit
**"ikke interesseret"** closes the lead — a non-responder is never closed.

Copy (DK, one-way, book-link not reply):
1. `Hej {{navn}}, vi prøvede at fange dig ang. mødelokale hos Soho. Book en tid her: {{link}} — eller ring til os på {{nummer}}.`
2. `Hej {{navn}}, her er linket til at booke mødelokale igen: {{link}}. Sig endelig til hvis du har spørgsmål 🙂`

**Channels (per Louis 2026-06-03):**
- **SMS → Telavox** (`POST /v1/extensions/users/me/sms`) or a Telavox deeplink —
  sent from **Soho's one number**, NOT the personal-phone `sms:` handoff. Both
  tie to the Telavox calling seat → **blocked on the same token as dial** (§4).
  (Deeplink for SMS is unconfirmed; the API endpoint is confirmed.)
- **Email → operator-fired draft** from the receptionist's own `*@soho.dk`
  mailbox (the "Skriv mail" handoff). **Not blocked by the sender domain** — that
  only gates *automated* server email (booking confirmations/reminders).

**Build status:**
- Buildable now: the **email-draft cadence** — Soho-correct templates
  (per-workspace booking link + signoff, not Louis/CarterCo), attempt-aware copy,
  optional AI-email draft. Needs **Soho's booking link** + a per-workspace
  branding field (booking_url/signoff on `workspaces` or member identity).
- Blocked on Telavox seat token: SMS (via Telavox), dial.
- Blocked on sender domain: automated confirmations/reminders.

---

## 8. "Positive but never booked" reactivation

Highest-ROI warm pool — they raised a hand and stalled. Distinct from the area-2
cold 6–8k reactivation.

```sql
outcome IN ('interested','callback','follow_up')
AND meeting_at IS NULL
AND outcome <> 'customer'
AND outcome_at < now() - interval '3 days'
AND (next_action_at IS NULL OR next_action_at < now())
```
Cadence (reuses `next_action_at` / `retry_count`): Day 3 SMS nudge with a concrete
available slot → Day 7 reception call flagged with *why* warm → Day 14 final SMS +
link, then dormant. Surface as its own panel queue ("interesseret, ikke booket").
Reactivated bookings must credit the original first-touch ad.

---

## 9. Build order

1. **Plumbing:** ✅ workspaces + members + names + switcher + realtime + ring-click
   logging + attributed notes + SMS gating. ⏳ still: generalize
   `meta-leadgen-relay` → `lead-intake` with per-workspace token; attribution
   columns (§3).
2. **Landing page + snippet:** ⏳ pending — needs the page to exist (owner TBD).
3. **Telavox:** ⏳ CAPI verified; dial wiring blocked on a calling-seat token.
4. **Reception panel:** ✅ dial button + contact timeline (live). ⏳ still:
   positive-never-booked queue, agent-overview dashboard.
5. **SMS cadence:** ⏳ pending (Soho's own one-way cadence; SMS gating already
   keeps CarterCo's handoff out of Soho).
6. **Attribution + CAPI:** ⏳ pending (needs Meta spend access).

---

## 10. Open items / access needed (blocked on Soho/Casper)

- **Telavox token from a calling-enabled seat** (current one can't dial — see §4
  blocker). Emailed Casper.
- **Leads CSV** (the 6–8k existing leads) — for area-2 reactivation.
- **Landing-page owner** confirmed (us / Soho) — either way they get the snippet +
  contract. Blocks lead-intake.
- **Meta read access** for spend (MCP reauth as Soho-access identity, or daily
  export) — cost side of attribution. *Not* needed for ingestion.
- **CAPI dataset** on Soho's ad account (`asset_id=146975948684005`).
- **Sender domain** for SMS/email + SPF/DKIM/DMARC (proposal item).
- Run Meta instant form **in parallel** during cutover so no leads drop mid-switch.
