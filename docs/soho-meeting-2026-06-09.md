# Soho meeting — game plan (2026-06-09)

**Room:** all marketing people present. **Goal:** turn FB spend from a traffic
cost into a measured pipeline that hunts *rented rooms*. Scope = **meeting rooms
(Mødelokaler) only** — not office space, not events.

---

## 1. OPEN WITH (the flex)

> "The hardest part is already done. I've built and **tested** the data
> connection — Meta's Conversions API is firing into your dataset right now,
> verified. So today isn't 'can we' — it's three changes on your side and we're
> live."

You walk in with a working, tested system. Everyone else is still talking ideas.

---

## 2. THE DIAGNOSIS (back it with their own Events Manager)

Pull up the dataset on screen if you can.

- Your meeting-room ads **optimize for "landing page views."** That's a *traffic*
  campaign — Meta gets paid to send people to a page and counts that they arrived.
- So the dataset only ever sees **PageView** (6.1/10 match quality). **No Lead
  event, no booking event — nothing measures whether a click became an enquiry,
  let alone a rented room.**
- The "100% lower cost per result / demo" banner is celebrating **cheap page
  views.** Pure vanity. It tells you nothing about cost-per-rented-room.

**The line:** *"Right now you pay Meta to deliver page views, and you measure
page views. That's why nothing improves."*

---

## 3. THE FIX (three moves, in order)

1. **Move the campaigns off "landing page views" → a Leads objective.**
   So Meta optimizes for real enquiries, not visits. *(Their call — biggest lever.)*
2. **Capture the lead** — instant form (robust cross-device; survives
   phone→laptop, weeks-later bookings).
3. **Feed the booking back via CAPI** *(done + tested)* — Meta's Conversion-Leads
   model learns to find leads that *rent*, even at low booking volume. Optimize on
   the lead for volume; the booking event biases toward renters.

> Wiring CAPI alone changes nothing until step 1 happens — Meta only optimizes
> for the event you point it at. The objective change is **step one, not polish.**

---

## 4. WHAT I NEED FROM YOU TODAY

**Decisions (in the room):**
- [ ] **Switch meeting-room campaigns to a Leads objective** (off landing-page-views).
- [ ] **Landing page / instant form** — confirm we go instant-form. (Removes the
      "who builds the page" blocker entirely.)
- [ ] **Dataset cleanup** — you have **~7 datasets**, near-duplicate names
      ("New web" = live; "New website" = empty; two "DELETE"; MAYA; Nomads).
      Which **one** do the room ads credit? Consolidate + kill the rest.

**Access (kick off today — has lead time):**
- [ ] **Meta ads read access** for me (View-performance on the SOHO ad account) —
      cost-per-rental needs spend by campaign. *(Already mid-setup.)*
- [ ] **Nexudus admin** to add a booking webhook (auto-marks "Booket" + triggers
      the CAPI booking event). + the **Nexudus booking link**.
- [ ] **Telavox token from a calling seat** (dial + SMS) — Casper's homework. The
      current seat can't dial. Put a date on it.

---

## 5. IF YOU ONLY GET 3 THINGS

1. **Agree to switch off landing-page-views → Leads objective.** (Nothing works without it.)
2. **Confirm the canonical dataset** (kill the other 6).
3. **Nexudus webhook admin access.** (Closes the loop, zero manual marking.)

---

## 6. NEW PITCH — coffee & snack upsell (heard from Pernille)

Raise it as *"I heard Pernille mention…"* so it lands as listening, not upselling.

> "Every booked room is an upsell moment you're handling by hand. The Nexudus
> booking webhook I'm already adding can auto-offer coffee + snacks the day before
> the meeting — one-tap order — and for the first time you'd see **attach-rate and
> revenue per booking.**"

- It's the first piece that **makes you money** vs. saves effort → cleanest ROI.
- Need from them: do they use **Nexudus Store/Products**? + current menu/prices
  (for a real ROI number).

---

## 7. GUARDRAILS

- Keep it on **meeting rooms** — don't let it drift to office space or events.
- Don't let "more creative / more campaigns" hijack it — the bottleneck is
  **measurement**, not ads.

---

## Cheat sheet (IDs)

| | |
|---|---|
| Live dataset | `2094557531307172` ("SOHO \| New web 27/3-26") |
| SOHO business | `1902356403310858` |
| SOHO ad account | `1902358339977331` |
| Dataset owner | Martin Juul (created Mar 27) |
| CAPI status | LIVE + tested (`META_CAPI_ACCESS_TOKEN_SOHO` in `.env.local`) |

Full spec: `docs/soho-leadflow.md` (§12 = CAPI status).
