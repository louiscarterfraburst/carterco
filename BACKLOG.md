# Outreach Backlog

Hypoteser at teste, bugs at fixe, observationer at validere. Nyeste øverst.

Format: dato + headline, hvad vi tror, hvad vi har af bevis, hvad vi vil teste/gøre, status.

---

## 2026-05-14 — Tresyv-template har 2 links, dræber video-thumbnail

**Hypotese:** Tresyv's `OUTREACH_MESSAGE_TEMPLATE` har "{website}" inline i teksten ("Jeg var lige inde på dinesen.com..."), som LinkedIn auto-linker. Kombineret med video-URL'en bliver det 2 links pr. besked, og LinkedIn dropper video-thumbnail når der er mere end ét URL.

**Bevis (15 dages data):**
- CarterCo (1 link, kun video): 38.6% accept rate, 56% reply rate, 33% referrals + 27% questions
- Tresyv (2 links: website + video): 30.9% accept rate, 31.8% reply rate, 71% declines

Samme sender-kvalitet, sammenlignelig volume. Stærk korrelation med antal links.

**Test:** Skift Tresyv-template til at nævne firma-NAVN i stedet for URL:
- Før: `"Jeg var lige inde på dinesen.com og optog en kort video..."`
- Efter: `"Jeg var lige inde på Dinesen og optog en kort video..."`

Bruger `{company}` (normalizeCompanyName) i stedet for `{website}` (normalizeWebsiteUrl). Fjerner auto-link, beholder personalisation.

**Action:** Opdater `OUTREACH_MESSAGE_TEMPLATE` i Tresyv's Supabase secrets, eller skift default i `sendspark-webhook/index.ts`. Send 50-100 næste Tresyv-leads med ny template. Sammenlign reply rate efter 1-2 uger.

**Status:** Open

---

## 2026-05-14 — outreach_pipeline tracker ikke om SendSpark brugte fallback-baggrund

**Hypotese:** SendSpark falder tilbage til workspace-default (carterco.dk eller tresyv.dk) når den ikke kan scrape prospect's website (Cloudflare-bot-block, timeout, osv.). Vi har ingen måde at vide det før beskeden sendes.

**Bevis:** Victor Lisberg (Revata Carbon, revatacarbon.com) renderede med CarterCo-branded landing som baggrund i stedet for hans website. Website var i DB før render, blev passet til SendSpark, men resultatet havde fallback.

**Action:** Tilføj `background_status` kolonne på outreach_pipeline. Når sendspark-webhook modtager render_ready, sammenlign `evt.originalBackgroundUrl` vs `evt.backgroundUrl` (hvis SendSpark eksponerer det) eller poll SendSpark's prospect API. Hvis fallback brugt → flag som `pending_manual_review` i stedet for `pending_approval`.

**Status:** Open

---

## 2026-05-14 — Lead-ingestion mangler quality gate for company/title

**Hypotese:** LinkedIn-scrapere dumper "Volunteer Work for X. Freelance for Y" som company-felt når en person har flere current roles. Vi ingester det rå.

**Bevis:** Charlotte Andersen (faktisk CMO på Otto Suenson) blev importeret med `company = "Volunteer Work for Save the Children Denmark and Dansk Handicap Forbund. Freelance for Stark Group"`. Webhook-pipelinen sendte hende videre uden flag. Kun 1 ramt i Tresyv's 1889 leads, men én kan være pinligt nok.

**Action:** I `build_master.py` eller `enrich_li.py`, tilføj quality gate:
- `company` indeholder "freelance" / "volunteer" / "self-employed" → flag til manual review
- `company` > 60 chars → flag (men IKKE auto-reject; ICARS-typer er ægte)
- Drop CSV-rækker der hits flag, eller mark `needs_review=true` så de ikke ryger ind i sendpilot-flowet

**Status:** Open

---

## 2026-05-14 — acceptance_responder.py læser website fra stale CSV

**Status:** Closed. Patchet til at læse fra Supabase direkte via REST. Se commit / `scripts/lead-enrichment/acceptance_responder.py`.

## 2026-05-14 — outreach-approve fejlede med null sendpilot_sender_id

**Status:** Closed. Workspace-wide fallback tilføjet, deployed som v30. Backfiller sender_id ved første kald.

## 2026-05-14 — sendspark-webhook ungoede sent-status efter manual render-kick

**Status:** Closed. `sent_at`-guard tilføjet, deployed som v36. Render af allerede-sendt lead opdaterer video-link men beholder status=sent.
