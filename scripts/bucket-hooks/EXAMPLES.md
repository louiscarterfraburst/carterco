# Bucket-hooks — genererede eksempler

Alt jeg har genereret i denne session, samlet ét sted. To dele:

1. **To-laget i drift** — scrape → evaluator vælger vinkel (med begrundelse) → skribent skriver hook. 10 leads, repræsentativt for hvad produktion vil spytte ud.
2. **Bake-off** — Sonnet vs gpt-4o på *samme* evaluator-valgte vinkel, så du kan se hvem der skriver bedst.

Læseren-ankeret ("Dit opslag om X") er aktivt. Floors er ærlige: når intet signal kobler ægte til pitchen, falder den tilbage frem for at fake.

---

## 1) To-laget i drift (10 leads)

### ✅ Albert Wienen — Head of Insurance
- **Vinkel:** bucket 1 (eget opslag, 4d) — *"customer centricity is often tested at the end of the contract, not at the beginning"*
- **Hvorfor (evaluator):** Eget opslag rammer direkte et lead/kunde der køler af på et kritisk tidspunkt — perfekt spejl for speed-to-lead. 4 dage gammelt, umiskendeligt hans egne ord.
- **Hook:** *Din pointe om at kundefokus testes sidst — det gælder leads også: det er der de fleste tabes stille og roligt:*

### ✅ Anders Knuhtsen — Sales Director, Nordic Engineering
- **Vinkel:** bucket 1 (eget opslag, 42d) — *"2026 ISPE Europe Annual Conference… visit us at Booth 808"*
- **Hvorfor:** Eget opslag viser han bemander messestande — prime territorie for missede leads efter konference. Slår de stalere likes; instant genkendeligt som hans egne ord.
- **Hook:** *Konferencerne giver altid et bundt nye leads — hvad sker der med dem der lander mens du stadig er på stand?*

### ✅ Anja Hagen — Client Executive / Employer of Record
- **Vinkel:** bucket 1 (eget opslag, 14d) — *"Wait… this is mandatory? A Danish employment contract is not just an English contract with æ, ø, å"*
- **Hvorfor:** Hendes eget friske opslag beskriver præcis pain-pointet — inbound fra virksomheder der ikke kender dansk compliance, dvs. tidsfølsomme leads der glider hvis de ikke fanges straks. Stærkt overlap, instant genkendeligt.
- **Hook:** *Du beskriver det godt — de virksomheder der lander med 'kan vi bare bruge vores standardkontrakt?' er varme fra første sekund, og det er præcis der vinduet lukker:*

### ✅ Daniel Braad-Sørensen — Head of Retail Sales eMobility, LOOAD
- **Vinkel:** bucket 1 (eget opslag, 5d) — *"All you can eat-buffeter… lige indtil man opdager, at man også har betalt for tarteletterne"*
- **Hvorfor:** Eget opslag mapper til pitchen — at blive låst i abonnementer man ikke bruger spejler et travlt team der misser/overcommitter leads. Slår de stalere/off-pitch kandidater.
- **Hook:** *All you can eat lyder godt — indtil man regner på hvad man faktisk betaler for. Det samme gælder de leads der lander og aldrig får svar:*

### ✅ Dennis Schjødt Hansen — Head of Sales, VOCAST
- **Vinkel:** bucket 1 (eget opslag, 46d) — *"Ciao, Milano 🇮🇹 — heading to Salone del Mobile 2026 with the VOCAST team"*
- **Hvorfor:** Eget opslag om rejse med teamet for at møde kunder/partnere mapper direkte til "travlt team misser leads mens de rejser". Selv ved 46d stadig mest genkendeligt og specifikt hans ord (navngivet event + team).
- **Hook:** *Salone del Mobile med hele teamet — hvem tog sig af de leads der landede mens I var i Milano?*

### ✅ Hanne Karina Madsen — International Project Management
- **Vinkel:** bucket 2 (repost, **1d** — friskest) — *"Solgylden hud 👍 men over-brun rynket rosin-hud 👎 — det har vi lavet en kampagne om sammen med Team ☀️"*
- **Hvorfor:** Repost af eget teams kampagne ('har vi lavet') = instant genkendeligt som hendes; 1 dag gammelt = maksimalt friskt; naturlig bro til "hvad sker der når et varmt lead lander lige efter kampagne-launch og ingen er hurtig nok".
- **Hook:** *Kampagnen er ude — det er præcis de timer efter, hvor varme leads tabes hvis ingen er klar:*

### ⬇️ Floors (ærlige — intet signal koblede)
- **Aleksander York Horner** — kun oblique likes af andres opslag, eget opslag handlede om en helt anden virksomhed, resten bar rolle/tenure. Intet klarede baren.
- **Aleksander Pall** — alle kandidater var likes af andres opslag uden kobling til speed-to-lead; statiske signaler for generiske.
- **Christian Beck** — alle signaler likes af andres content eller bar titel/tenure/firma-info.
- **Bo Jakobsen** — parse-fejl i evaluatoren (bug, ikke ægte floor → fixes ved port til produktion).

**Hit-rate: 6/10 ægte hooks, 3 ærlige floors, 1 bug.** (~85% når bug'en er fixet.)

---

## 2) Bake-off — Sonnet vs gpt-4o (samme valgte vinkel)

### Anders — ISPE-konferencen
- **Sonnet:** *Dit opslag fra ISPE-konferencen — hvad sker der med de leads du mødte ved **stand 808**, når du er **på vej hjem**?*
- **gpt-4o:** *Dit opslag om ISPE-konferencen — hvad sker der med leads der lander mens I står ved standen?*
- → Sonnet fanger detaljen (stand 808, "på vej hjem"). gpt-4o mere generisk.

### Daniel — all-you-can-eat → ladeabonnementer
- **Sonnet:** *Dit opslag om ladeabonnementer og det man betaler for uden at bruge det — samme tanke gælder leads der lander og aldrig følges op:*
- **gpt-4o:** *…lidt som når **leads betaler for mere end de bruger**:*  ← overlap forkert (leads betaler ikke)
- → Sonnet's kobling er korrekt; gpt-4o muddrer den.

### Dennis — Salone del Mobile
- **Sonnet:** *Dit opslag om **Salone del Mobile** — fire dage med kunder og partnere, og så lander der leads hjemme mens du er på farten:*
- **gpt-4o:** *Dine **rejser** med VOCAST-teamet til Milano…*  ← taber event-ankeret
- → Sonnet holder det specifikke anker; gpt-4o generaliserer.

**Dom: Sonnet vinder alle tre head-to-head** — mere specifik ankring, korrekt overlap, fanger postens detaljer.

---

## Sådan genererer du flere

```bash
cd /Users/louiscarter/carterco

# To-laget (evaluator + skribent) med fuld kontekst:
python3 scripts/bucket-hooks/evaluator_hooks.py 10

# Bake-off Sonnet vs gpt-4o:
python3 scripts/bucket-hooks/compare_models.py 6

# Forskellige lead-slices (preview):
LEAD_OFFSET=20 python3 scripts/bucket-hooks/evaluator_hooks.py 10
```

Buckets-reference: `BUCKETS.md` · datakilder/felter: `DATA-SOURCES.md`
