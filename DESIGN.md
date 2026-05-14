# Design System — Carter & Co

> Read before making any visual or UI decision on `carterco.dk`. Updates to fonts, color, spacing, layout patterns, or copy framing all pass through here.

---

## Positioning (read first)

**Carter & Co is a fractional GTM engineer. Not a SaaS.**

- **GTM engineer** — Louis builds and operates the revenue pipeline (find → call → nurture → close) end-to-end. Technical sales operator, not a consultant who recommends and leaves.
- **Fractional** — a small number of clients at a time. Direct access to the builder for the full engagement. No account manager in between, no juniors learning on the project.
- **Not a SaaS** — the deliverable is a running system the client owns and operates on their own stack. No seats, no login at carterco.dk, no subscription tier, no product trial.
- **Differentiation comes from substance** — hands-on from day 1 to handover, no juniors, direct line to the builder. Never from "solo / én mand / bare mig" copy framing. The site reading agency-shaped is fine; it shouldn't read SaaS-shaped.

**The system is the protagonist.** Louis is the operator behind it. Every page should make a visitor think "this person builds the thing I see working in front of me," not "this person is a one-man show."

---

## What this means visually

| The site reads like... | Not like... |
|---|---|
| A craftsman's notebook open on a workshop bench | A SaaS product landing page |
| Live system panels (LinkedIn DM, SMS thread, pipeline, flow nodes) embedded as the proof | A `/features` grid describing capabilities |
| A named portfolio (Tresyv, Murph, Burst, Mavico…) with metrics tied to real logos | "Trusted by 10,000+ teams" with anonymized case studies |
| A direct line to the builder (`louis@carterco.dk`, Calendly, lead quiz) | A signup flow, free trial, or tier picker |
| An editorial sequence of warm paper and ember dark sections | A `/pricing` page with Starter / Pro / Enterprise |

---

## Required patterns

1. **Every CTA leads to a conversation.** Lead-quiz → Calendly, mailto, phone. Never "Sign up", never "Start free trial", never a tier picker.
2. **Every metric ties to a named client logo.** No anonymized proof. If a number can't be attributed, it isn't on the page.
3. **External claims carry citations.** MIT response-time study → linked PDF. Industry stats → source. If you can't link it, don't claim it.
4. **System mockups are live and inline.** Show the LinkedIn DM card, the SMS bridge, the pipeline columns, the flow nodes — actual representations of the operator's tools. Don't describe the mechanism, show it.
5. **Editorial section rhythm: sand → ember → sand → ember.** Light paper sections alternate with deep dark sections. Establishes pacing and prevents the page reading as flat.
6. **Louis appears exactly once per top-level page.** In the founder card, with the photo + signature + mailto. Never as a recurring face.
7. **Real Danish.** Site is bilingual-ready but ships da_DK first. No translated-from-English marketing voice.

---

## Forbidden patterns (do not ship)

- `/pricing`, `/features`, `/changelog`, `/integrations` pages — none of these exist in a fractional service.
- "Solo / én mand / bare mig" copy framing.
- "Start free trial", "Sign up", "Create account" CTAs at the marketing surface.
- Pricing tiers (Starter / Pro / Enterprise).
- "Trusted by 10,000+ teams" or any vanity scale claim.
- Anonymized case studies ("a Series B SaaS client increased…").
- Login button in the marketing nav. (The app login at `/outreach` exists but never surfaces on the marketing home.)
- Purple/violet gradients, default Tailwind shadow, bubble border-radius on every element.
- AI-generated illustrations.
- Lottie/Rive animations as decoration. (Motion exists, but only when it explains the mechanism — see Motion section below.)

---

## Product Context

- **What:** Marketing site for Carter & Co at `carterco.dk` + the operator UI at `/outreach` and `/leads`. This document governs the marketing surface and the visual language that bleeds into the operator UI.
- **Who it's for:** Founders and sales leaders at 5–50 person Danish B2B companies (SaaS, agencies, professional services) losing leads inside their own funnel.
- **Industry:** Revenue infrastructure / GTM engineering. Adjacent: RevOps tools, sales enablement, lead-routing services.
- **Project type:** Editorial marketing site with embedded operator-UI mockups, plus a working operator app.

---

## Aesthetic Direction

- **Direction:** Editorial / Sand-and-flame.
- **Decoration level:** Intentional. Paper grain overlays, ghost numerals, EmberSpark dividers, hand-drawn annotations. Decoration that signals craft, never that fills space.
- **Mood:** A craftsman's notebook open on a workshop bench. Warm paper, ember light, hand-tooled type, the smell of coffee and printer toner. Serious work in a warm room.
- **Reference points:** Stripe Press, Linear's older marketing pages (before the rebrand), Basecamp's writing-first pages, *The MIT Press* annual review aesthetic. Never: generic SaaS unicorn pages.

---

## Typography

### Loaded fonts

Web fonts load via `next/font/google` in `src/app/layout.tsx`. System fonts are declared in the CSS stack with no load step. **Do not declare a web font in CSS that isn't loaded in `layout.tsx`.**

| Role | Font | Source | Notes |
|---|---|---|---|
| Display / hero | **Georgia** | System | Italic carries the brand voice. Classical newspaper-masthead proportions with strong baseline stroke contrast that holds up at hero size. No web-font load. Fallback to Times New Roman, then generic serif. |
| Body / UI | **Manrope** | next/font/google | Variable weight. Humanist sans. Body, labels, buttons. |
| Operator signature | **Homemade Apple** | next/font/google | Reserved for Louis's printed signature in the hero and the founder card. Never headlines. |
| Marginalia / handwritten | **Caveat** | next/font/google | Small annotations only ("det er mig der svarer"). Never body copy, never headlines. |
| Code / tabular | **Geist Mono** | next/font/google | Pipeline IDs, code blocks, monospaced microcopy in operator UI. |

**Geist Sans is removed.** It was loaded but unused on the marketing surface.

**Why Georgia, not a modern Google font?** A direct A/B was run on 2026-05-14 with Fraunces (weight 600, WONK 1, SOFT 50) versus Georgia. Georgia won on this brand because (1) its baseline stroke contrast carries the flame gradient at 137px hero size without going thin, (2) its italic curl feels classical-editorial rather than contemporary-editorial which matches "craftsman's notebook" better than "Stripe Press essay," and (3) the page is service-marketing in da_DK, not a typeface showcase — the "I gave up on typography" connotation Georgia carries in design discourse does not apply when the choice is deliberate and the rest of the system has taste.

### Scale

| Token | Size | Use |
|---|---|---|
| `display-xl` | `clamp(5rem, 9.5vw, 9rem)` | Hero word ("Salgsinfrastruktur") — once per page |
| `display-lg` | `clamp(3.5rem, 7vw, 7rem)` | Section headlines on hero-weight sections |
| `display-md` | `clamp(2.5rem, 5.25vw, 5rem)` | Hero descriptor, founder headline |
| `display-sm` | `2.75rem` | In-section h2 / journey stage titles |
| `h3` | `2rem` | Stage titles, founder card subheads |
| `body-lg` | `1.25rem` | Hero body, founder letter |
| `body` | `1rem` | Default body |
| `body-sm` | `0.9375rem` | Captions, metric labels |
| `eyebrow` | `0.625rem` / `tracking-[0.3em]` / uppercase / bold | Section eyebrows, footer microcopy |

### Display italic rule (important)

The flame-gradient Fraunces italic is **brand signature material, not decoration.** Reserve it for **exactly two positions per top-level page**:

1. The hero word.
2. The founder card headline ("Det er mig der bygger").

All other section accents use solid italic Fraunces in `var(--clay)` or `var(--cream)/55` opacity. The gradient italic loses meaning if it appears five times on one page.

---

## Color

### Tokens (in `src/app/globals.css:3-13` — extend with these)

```css
:root {
  /* Surfaces */
  --sand:        #f6efe4;   /* paper base, light sections */
  --cream:       #fff8ea;   /* carrier surface for mockups on dark sections */
  --ember:       #0f0d0a;   /* primary dark surface */
  --ember-deep:  #0a0907;   /* deeper dark surface — for stack/founder dividers */

  /* Ink */
  --ink:         #29261f;   /* primary text on sand */
  --muted:       #6c6254;   /* secondary text on sand */

  /* Accent: flame system */
  --flame-50:    #ffb86b;
  --flame-500:   #ff6b2c;   /* the orange — primary accent on dark */
  --flame-700:   #c93c0a;
  --flame-grad:  linear-gradient(180deg, var(--flame-50), var(--flame-500), var(--flame-700));

  /* Semantic */
  --clay:        #b97041;   /* secondary accent, italic accent on sand */
  --forest:      #19463a;   /* "won / closed / secured" — primary CTA on sand */
}
```

### Semantic meaning

| Color | Meaning | Examples |
|---|---|---|
| Forest | Won / closed / secured / "we got the contract" | Won-deal pill, primary CTA on sand sections, success states |
| Flame | In motion / hot lead / urgency / "the system is acting now" | Hero accents, primary CTA on dark sections, "Booket" pipeline column, traveler dots |
| Clay | Aged / archival / quieter accent on paper | Italic in-section accents, footer eyebrows, secondary buttons on sand |
| Sand / Cream | Neutral / at rest / paper carrier | Light sections, mockup surfaces |
| Ember | Operator's screen / focus mode / "where the work happens" | Dark sections, system mockup backdrops |

### Forbidden colors

- No purple/violet anywhere.
- No pure black (`#000`). Use `--ember-deep` (`#0a0907`).
- No pure white (`#ffffff`). Use `--cream` (`#fff8ea`).
- No introduced blue. The system has no blue — adding one breaks coherence.

### Untokenized hex sweep (debt)

`src/app/page.tsx` currently has ~30 bare hex literals duplicating the values above. Replace with CSS variables. ~30 min cleanup, prevents drift.

---

## Spacing

- **Base unit:** 4px.
- **Density:** Comfortable. Marketing sections breathe; operator UI tightens up.
- **Scale:** `2xs(2) xs(4) sm(8) md(16) lg(24) xl(32) 2xl(48) 3xl(64) 4xl(96) 5xl(128)`.
- **Section vertical padding:** `py-28` (light) / `py-32` (dark) at sm, `py-36` (light) / `py-44` (dark) at lg.
- **Max content width:** `1400px` (hero, integration scatter), `1080px` (founder, editorial body), `680px` (centered hero copy max).

---

## Layout

- **Approach:** Editorial section-by-section. Each section is a poster with its own composition. The page is not a uniform grid.
- **Section alternation:** Sand → Ember → Sand → Ember → Sand → Ember → Sand. The rhythm is the structure.
- **Section dividers:** Never default `<hr>`. Use:
  - `EmberSpark` (thin flame line with gradient glow) between dark sections.
  - Paper-grain overlay (multiply blend) on sand sections — never on ember.
- **Grid:** When a grid is used (founder card, journey stages), it's 12-col at `lg` with hand-tuned col-spans. No uniform 3-col or 4-col grids.
- **Border radius:** `sm:4px` (inputs, chips) / `md:12px` (cards, mockup panels) / `lg:24px` (large surfaces) / `full:9999px` (CTAs only). Never one universal radius on everything.

---

## Motion

- **Approach:** Expressive **only when it explains the mechanism.** Decorative motion is forbidden.
- **The system is a working machine. Motion shows it working.**

| Motion | Job | Where |
|---|---|---|
| `pipeline-glide` | Show a deal moving column → column. Explains pipeline progression. | Journey stage 04 mockup |
| `lead-glide-y` | Show a lead being nurtured through flow nodes. | Journey stage 03 mockup |
| `notification-drop` / `phone-screen-*` | Show the speed-to-lead flow on a phone. | Journey stage 02 mockup |
| `cal-scan` | Show the agent scanning calendar slots. | SMS bridge mockup |
| `wire-travel` | Show signal traveling along an integration wire. | Stack section dividers |
| `hero-reveal` | One-time entry stagger on page load. | Hero only |
| `marquee` | **Deprecated.** Replace logo marquee with a printed contact sheet (see Layout patterns below). |

**Easing:** `cubic-bezier(0.2, 0.8, 0.2, 1)` for entrances. `cubic-bezier(0.55, 0, 0.45, 1)` for sweeps. Linear for marquees if any survive.

**Reduced-motion:** Every animation must have a `@media (prefers-reduced-motion: no-preference)` guard. Already done — keep it that way.

---

## Page-level patterns

### CTA discipline

- **Primary CTA on dark sections:** Flame pill (`bg-[var(--flame-500)]`), text `--ember`. Hero, journey close.
- **Primary CTA on sand sections:** Forest pill (`bg-[var(--forest)]`), text `--cream`. Founder card, "Det her er forskellen" section.
- **Secondary CTA:** Mailto link, eyebrow style, no pill.
- **Maximum one primary CTA per section.** Quiz button is the only ask. Never compete with itself.

### Logo proof

- **Replace the scrolling marquee with a printed contact sheet.** 9 logos in a 3×3, hand-numbered caption ("Nogle af dem jeg har bygget for — 2023-2026"), thin printer's rule underneath. Matches the paper-grain and Polaroid in the founder card. The contact sheet owns "9 named clients" as a feature instead of hiding the count behind motion.

### Stack section

- **Replace the scattered tile chaos with a single neat row.** Recognizable tool logos (Hubspot/Pipedrive/Twilio/Calendly/Gmail/Slack/Notion) connected with thin lines through a central Carter & Co dot pulse. Caption: "Forbinder, ikke erstatter." The current scattered version fights the "you keep what you have" message.

### Founder card

- Photo on the right, letter on the left. **One** photo per page. The Polaroid framing and archival caption are correct.
- The handwritten "det er mig der svarer" arrow is approved — it's small, marginal, and serves the "direct access" claim.
- Body copy must mention the operator role explicitly. Current copy is close. Add one line about the engagement model: e.g. *"Jeg er din fractional GTM-ingeniør i 3-6 måneder. Du beholder systemet bagefter."* That clarifies "fractional" without leaning into "solo."

---

## Voice (copy rules)

- **Danish first.** All visitor-facing copy in da_DK. Operator UI can switch to en_US where conventions are stronger (e.g. Pipeline statuses).
- **Speak as the operator, not the brand.** First-person singular ("Jeg bygger systemet") is correct for the hero and founder card. Plural "vi" is forbidden — there is no "vi."
- **Use the customer's vocabulary.** "Lead-konvertering", "responstid", "outreach-volumen", "pipeline" beat "Salgsinfrastruktur" in body copy. Display headlines can be aspirational; body copy is operational.
- **No AI vocabulary.** No "comprehensive", "robust", "seamless", "intricate", "vibrant", "leverage", "unlock", "empower."
- **No em dashes in body copy.** Periods or semicolons. Reserved exception: the founder letter uses em dashes deliberately as a letter device.
- **Citations live inline.** "21× mere kvalificeret · iflg. MIT-studiet →" with the link. Not in a footer, not in a footnote.

---

## Accessibility floor

- **Color contrast:** All text ≥ AA. Ink on sand = 12.8:1. Cream on ember = 14.2:1. Muted on sand = 5.1:1 (AA Large only — use sparingly for body).
- **Focus rings:** Already implemented in `.focus-cream` / `.focus-orange`. Apply to every interactive element.
- **Motion:** `prefers-reduced-motion` respected on every animation. Already correct.
- **Keyboard:** Lead quiz fully keyboard-operable. Verify after every change.
- **Screen reader:** Decorative SVGs `aria-hidden`. Mockup elements have role/label where they convey state. Currently inconsistent — sweep needed.

---

## Implementation gaps (current → target)

| Gap | Severity | Status |
|---|---|---|
| Manrope not loaded | Critical | **Done** 2026-05-14 |
| Untokenized hex in `page.tsx` (~235 occurrences) | High | **Done** 2026-05-14 |
| Flame-italic gradient used 5+ times per page | Medium | **Done** 2026-05-14 — kept on hero word + founder headline only |
| Logo marquee instead of contact sheet | Medium | Open |
| Scattered integration tiles | Medium | Open |
| Geist Sans loaded but unused | Low | **Done** 2026-05-14 |
| Founder copy doesn't mention "fractional" | Low | **Done** 2026-05-14 |
| Decorative SVGs missing `aria-hidden` consistently | Low | **Done** 2026-05-14 |

---

## Decisions Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-05-14 | Initial DESIGN.md established | Page redesign on `homepage-redesign` branch surfaced the implicit system. Locking it in. |
| 2026-05-14 | Position as "fractional GTM engineer, not SaaS" | Customer-facing positioning. Prevents drift toward agency or SaaS tropes. |
| 2026-05-14 | Reserve flame-gradient italic to exactly 2 positions per page | Editorial discipline. Brand signature loses meaning if used everywhere. |
| 2026-05-14 | Forbid purple, pure black, pure white, introduced blue | Maintain palette coherence. |
| 2026-05-14 | Marquee → contact sheet for logo proof | Match aesthetic; differentiate from agency tropes. |
| 2026-05-14 | Display font: Georgia, not Fraunces | A/B compared on live hero. Georgia's baseline stroke contrast carries the flame gradient better at hero size. Italic curl reads classical-editorial. Deliberate choice, not a fallback. |
