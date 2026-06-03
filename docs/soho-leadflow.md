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

Soho `/leads` workspace_id: **`7f13f551-9514-4a5a-b1bf-98eb95c1a469`**
(owner info@soho.dk; louis@carterco.dk kept as operator member; 6 receptionist members TBD).

Soho Meta identifiers (from Leads Center): `business_id=1902356403310858`,
ad account `asset_id=146975948684005`. Existing pipeline stages in Meta:
Intake → Mødelokaler → Kontor → Qualified.

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

Needs from Soho: **Telavox API token** + per-receptionist extension/identity
mapping (which `/leads` member = which Telavox extension).

> TODO: confirm exact Telavox API endpoint + auth from their account/API docs
> before building. Do not assume the shape.

Flow: click dial → POST to Telavox (from = agent extension, to = lead phone) →
on call result, write a `lead_conversation_events` row (channel `phone`,
`source='telavox'`, `metadata` = {duration, answered, telavox_call_id},
`sender` = agent) and set `performed_by`.

---

## 5. Contact noted

Uses existing `public.lead_conversation_events` (`supabase/lead_conversation_events.sql`):
- channel `phone` (auto from Telavox) or `note` (manual), `direction`,
  `body`, `sender`.
- Surfaced as a per-lead timeline in the panel.
- Every event records **who** logged it → feeds the overview.
- Idempotent on `(source, source_id)` — use `telavox` + `telavox_call_id` so
  call records don't double-insert.

---

## 6. Agent overview (6 receptionists)

Add **`performed_by`** (member email) to call/outcome actions on `leads`, and it
already exists as `sender` on conversation events. Dashboard, per receptionist:
- leads assigned / handled
- calls made today, **answer rate** (from Telavox records)
- viewings booked, rooms rented
- **speed-to-first-call** (created_at → first call) — the core SLA

With Telavox-API these populate from real call data, not self-report.

---

## 7. SMS cadence (proposal-promised: confirmations, reminders, no-show)

Inbound, consented leads — transactional, not cold. Each touch triggers off
existing fields. (Note: this widens carterco's documented SMS rule — keep it
one-way; booking link goes to a page, not an SMS reply thread.)

| When | Trigger | Purpose |
|---|---|---|
| T+0 | new lead row | confirm receipt + expectation + self-serve link |
| after no-answer | `call_status='no_answer'`, by `retry_count` | re-engage, attempt-count variants |
| on booking | `meeting_at` set | confirmation |
| −24h / −2h | before `meeting_at` | reminder (cut no-shows) |
| no-show | `meeting_at` passed, no outcome | rebook link |

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

1. **Plumbing:** Soho workspace + members (6 receptionists) + push subscriptions;
   generalize `meta-leadgen-relay` → `lead-intake` with per-workspace token;
   attribution migration (§3 columns) + `performed_by`.
2. **Landing page + snippet:** form wired to `lead-intake`, param capture correct
   from the first lead.
3. **Telavox:** API click-to-call + call-record → conversation_events + agent attribution.
4. **Reception panel:** dial button, contact timeline, positive-never-booked queue,
   agent overview.
5. **SMS cadence.**
6. **Attribution + CAPI:** spend join (needs Meta access), CAPI on booked/customer,
   cohort report.

---

## 10. Open items / access needed

- **Telavox API token** + receptionist→extension mapping.
- **Meta read access** for spend (MCP reauth as Soho-access identity, or daily
  export) — for the cost side of attribution. *Not* needed for ingestion.
- **CAPI dataset** on Soho's ad account (`asset_id=146975948684005`).
- **Landing-page owner** confirmed (us / Soho) — either way they get the snippet + contract.
- **Sender domain** for SMS/email + SPF/DKIM/DMARC (proposal item).
- Run Meta instant form **in parallel** during cutover so no leads drop mid-switch.
