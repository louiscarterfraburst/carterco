# Site restructure — three machines, not one funnel

> **Status:** Plan agreed in principle 2026-05-15. Awaiting 3 inputs before implementation. See bottom of doc.

## The problem

The current `carterco.dk` is built as a single linear lead-funnel: lead lander → ring hurtigt → plej → luk. That's the speed-to-lead story.

The four pillars (Finde / Ringe / Pleje / Lukke) look like four equal steps, but they all describe what happens **after** the lead is in hand. Outbound — finding cold prospects, qualifying them, getting them to engage — is collapsed into a single bullet under "Finde" and disappears.

That's wrong-weighted, because Louis actually runs **three distinct machines** for clients:

| Machine | What it does | Where it lives in the codebase |
|---|---|---|
| **Outbound** | Find + reach cold prospects via LinkedIn/email/ads. Qualify before they're a lead. | `outreach_pipeline` (297 rows), SendPilot, Tresyv, `/outreach` app |
| **Speed-to-lead** | When a lead lands (form/quiz), call within 5 min. Hot-to-booked. | MIT citation, Murph 87×, lead quiz, `/speed-to-lead` route |
| **Post-meeting / pipeline** | After the first meeting: nurture flows, outcome tracking, reactivation, pipeline that moves with the day. | "Pleje" + "Lukke" pillars, Attio sync, won/lost outcomes |

Each client uses 1, 2, or all 3. Murph = speed-to-lead. Tresyv = outbound. Burst = primarily post-meeting/conversion. The site sells them as one funnel — but they're sold as separate (or combined) systems.

## The fix

Replace the 4-stage Journey section with **3 equal-weight machine sections**, each with its own mockup, case, and metric. Cut the "Det her er forskellen" section (a linear before/after that no longer fits). Shrink the Stack section to a single row.

## Page outline (target)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ EMBER   Hero — løftet                                                    │
│         "Salgsinfrastruktur til ambitiøse B2B teams"                     │
│         Tre maskiner. Du vælger 1, 2 eller alle 3.                       │
├──────────────────────────────────────────────────────────────────────────┤
│ SAND    Logo strip (light, kun 9 logoer, ingen marquee)                  │
├──────────────────────────────────────────────────────────────────────────┤
│ SAND    Section 01 · OUTBOUND                            [MASKINE 1/3]   │
│         Hente dem ind, hvor de allerede er.                              │
├──────────────────────────────────────────────────────────────────────────┤
│ EMBER   Section 02 · SPEED-TO-LEAD                       [MASKINE 2/3]   │
│         Få dem på telefonen før de glemmer dig.                          │
├──────────────────────────────────────────────────────────────────────────┤
│ SAND    Section 03 · POST-MEETING                        [MASKINE 3/3]   │
│         Føre dem hjem uden at miste én.                                  │
├──────────────────────────────────────────────────────────────────────────┤
│ EMBER   Stack-row (1 linje, "forbinder, ikke erstatter")                 │
├──────────────────────────────────────────────────────────────────────────┤
│ SAND    Founder-kort (Louis, polaroid, signatur)                         │
├──────────────────────────────────────────────────────────────────────────┤
│ EMBER   CTA / lead-quiz                                                  │
└──────────────────────────────────────────────────────────────────────────┘
```

Section rhythm respects DESIGN.md (sand → ember alternation).

## Section 01 · OUTBOUND (sand)

```
  01 · OUTBOUND

  Hente dem ind, hvor de allerede
  er. ── LinkedIn. Email. Annoncer.

  Personlige DMs i skala. Video-      ┌────────────────────────────┐
  optagelser af deres egen website.   │  [LinkedIn DM]             │
  Email-outreach uden om gate-        │  ┌──────┐ Sara El-Khouri   │
  keepere. Annoncer bygget på den     │  │ SE   │ Adm.dir, Tagværk │
  profil du allerede sælger til.      │  └──────┘                  │
                                      │  "Hej Sara — så at I lige  │
  ┌────────────────────────────────┐  │   har vundet udbuddet på…" │
  │ XX%                            │  │  ▷ video.carterco.dk/...   │
  │ accept rate på cold LinkedIn   │  └────────────────────────────┘
  │ (15-dages data, da_DK B2B)     │
  └────────────────────────────────┘  ┌────────────────────────────┐
                                      │  [SendSpark thumbnail]     │
  Tresyv kører den i dag · logo →     │  ▷ "Hej Maria, jeg kiggede │
                                      │     lige på dinesen.com…"  │
                                      └────────────────────────────┘
```

**Mockup:** LinkedIn-DM-kort (exists in codebase) + SendSpark video-thumbnail. Stack of 2-3 in a soft perspective fan. Case-anchor: Tresyv logo bottom.

## Section 02 · SPEED-TO-LEAD (ember)

```
  02 · SPEED-TO-LEAD

         ┌──────────────────────────┐   Få dem på telefonen før de
         │  [form lander]           │   glemmer dig.
         │  → ring inden 5 min      │
         │  → svar ikke? SMS-bridge │   Når et lead lander på din side
         │  → booket eller no-show? │   eller sender en form, ringer
         │  → flow tager over       │   sælgeren inden for 5 minutter.
         └──────────────────────────┘   Hvis ingen tager: SMS, email
                                        og reaktivering tager over.
         ┌──────────────────────────┐
         │ 21× mere kvalificeret    │   Sælgeren får leadet på skærmen
         │ når sælgeren svarer      │   samme sekund. Ét tryk = opkald.
         │ inden 5 min              │   Ingen CRM at åbne.
         │ iflg. MIT-studiet →      │
         └──────────────────────────┘

         Murph rammer 87× hurtigere end branchen · logo →
```

**Mockup:** Existing looping phone-scene (page.tsx 1697-1900) + SMS-bridge chips + outcome-pill. Case-anchor: Murph logo.

## Section 03 · POST-MEETING (sand)

```
  03 · POST-MEETING

  Holde dem varme. Lukke              ┌────────────────────────────┐
  aftalen.                            │  [Pipeline]                │
                                      │  Ny  │Kontakt│Booket│Vundt │
  Møder glipper. Aftaler              │  ──  │──     │──    │──    │
  forsvinder. Leads der               │  •MS │ •JK   │•TL   │•AB   │
  stod stille for to uger             │  •LP │ •MK   │      │      │
  siden bliver fanget. Vundne         │      │       │  ▶   │      │
  aftaler hopper til lukket           │       (deal hopper: Booket→Vundt)
  samme dag — pipelinen følger        └────────────────────────────┘
  med dagen, ikke ugen.
                                      ┌────────────────────────────┐
  ┌────────────────────────────────┐  │  [Nurture flow nodes]      │
  │ 4×                             │  │  ●→●→●→ booked? ──┐        │
  │ lead-konvertering              │  │  ↓ no             ↓        │
  │ samme målgruppe, samme budget  │  │  reaktiverings-flow         │
  └────────────────────────────────┘  └────────────────────────────┘

  Burst → 4× på samme budget · logo →
```

**Mockup:** Existing pipeline-kanban (page.tsx 221-244) + flow nodes. Case-anchor: Burst logo.

## Stack-row (ember, ONE line, not a section)

```
  Forbinder, ikke erstatter.

   HubSpot   Pipedrive   Twilio   Calendly   Gmail   Notion   Slack
      [Outbound]    [Speed-to-lead]    [Post-meeting]
```

Logos in a single row, each tagged with the machine it powers. Replaces the current scattered tile chaos (DESIGN.md flagged this as an open gap).

## Before / after summary

| Before | After |
|---|---|
| 4-step linear funnel | 3 equal-weight machines |
| Outbound is one bullet | Outbound is a full section |
| Speed-to-lead is implied | Speed-to-lead is named |
| "Det her er forskellen" repeats journey | Deleted |
| Stack is a full sand section | Stack is one ember row |
| Founder appears late | Founder preserved (can move up later) |

## Open questions (need answers before implementation)

1. **Three-machine frame correct?** Or should it be two (outbound + post-engagement), or four (outbound + speed-to-lead + nurture + close as separate)?
2. **Outbound accept-rate number:** Placeholder was "32%". Real number Louis will stand behind? BACKLOG.md notes CarterCo 38.6% / Tresyv 30.9%.
3. **Case-to-machine mapping confirmed?**
   - Tresyv → Outbound?
   - Murph → Speed-to-lead?
   - Burst → Post-meeting?
   - Or does one case anchor two machines?

## Files this will touch

- `src/app/page.tsx` — major restructure (delete forskellen, replace journey with 3 machines, shrink stack)
- `src/app/page.tsx` — possibly extract section components if it makes the diff readable
- `DESIGN.md` — update implementation gaps to mark this restructure as the dominant open work; mark forskellen-pillar-labels as superseded (the section is being deleted)
- Likely no new components needed — all 3 mockups already exist in the codebase

## Branch / shipping plan

1. Feature branch off main: `site/three-machines`
2. Implement on branch, verify on localhost + Vercel preview
3. Screenshot at 1023/1280/1440 viewports
4. Merge to main → carterco.dk auto-deploys

## Reference

- Companion design system: `DESIGN.md` (positioning, color, typography, voice — already on main)
- Live site pre-restructure: https://carterco.dk
- Plan agreed in conversation 2026-05-15 (Louis + Claude)
