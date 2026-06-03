# Incident audit — OdaGroup Danish follow-ups (2026-05-26)

**Workspace:** OdaGroup (`cdfd80d8-33bb-4b64-b778-0a2c5ab78cc6`)
**LinkedIn sender:** Niels (odagroup)
**Reported by:** Caroline Brix, 2026-05-26
**Scope:** 11 leads received a Danish follow-up DM (`unwatched_followup_v1.qualifier` step) that was never shown to Caroline for approval.

---

## Root cause

The follow-up step in the global `outreach_sequences.unwatched_followup_v1` row is configured as `auto_send` with a hardcoded Danish `template` field. The engagement engine (`outreach-engagement-tick`) renders that template verbatim and ships it via SendPilot without passing through the approval queue. Approval only gates the initial DM; downstream steps fire unattended.

Workspace `message_language` was set to `en`. That field is honored by `draft-first-message.ts` (initial DM) but ignored by `outreach-engagement-tick` (follow-ups), because the engine reads `action.template` straight off the sequence row.

---

## What went out — 13 messages total

### 2 initial English DMs — correct (matched approved content)

| Sent at (UTC) | Lead | Country | Company | Title | LinkedIn |
|---|---|---|---|---|---|
| 2026-05-26 07:07:46 | Tomohiro Hirose | JP | — | — | — |
| 2026-05-26 07:11:03 | Yasushi Koizumi | JP | — | — | — |

### 11 Danish follow-up nudges — unapproved, hardcoded template

Template that fired (with `{firstName}` substitution):

> Hej {firstName}
>
> Hurtigt spørgsmål: er du den rigtige hos jer at tale med om dette, eller skal jeg fange en anden? Sig også til hvis det ikke er relevant.

| Sent at (UTC) | Lead | Country | Company | Title | LinkedIn |
|---|---|---|---|---|---|
| 2026-05-23 09:15:05 | Kyohei Kinugasa | JP | Insmed Incorporated | Commercial Effectiveness / Digital Excellence Director | linkedin.com/in/kyohei-kinugasa-61881354 |
| 2026-05-23 09:25:05 | Antonio Martin MD PhD | CH | Sanofi | Global Head of Medical and Launch Excellence Business Operations | linkedin.com/in/antonio-martin-md-phd-6b170712 |
| 2026-05-24 12:35:09 | Akira Kawai | JP | MSD | Associate Director, Medical Operations & Realization, Medical Affairs | linkedin.com/in/akira-kawai-57489866 |
| 2026-05-24 12:40:07 | Kenichi Suzuki | JP | Sonova Group | Director, Head of National Sales, Commercial Excellence and Customer Service (Japan Leadership Team) | linkedin.com/in/kenichi-suzuki |
| 2026-05-24 12:40:09 | Jolana Schmiedl | CH | CSL | Medical Director, Global Medical Affairs Haematology | linkedin.com/in/jolana-schmiedl |
| 2026-05-24 12:40:12 | Carla Torán Barona | ES | Sobi | Medical Excellence Director | linkedin.com/in/carlatoranbarona |
| 2026-05-24 12:40:15 | Takashi Sahara | JP | Takeda | Director, Head of Strategic Operation, Commercial Excellence | linkedin.com/in/takashi-sahara-b5790843 |
| 2026-05-24 12:40:19 | Yoshiki Toda | JP | Takeda | Associate Director, Marketing Innovation & Excellence, Japan Oncology BU | linkedin.com/in/yoshiki-toda-a39baa185 |
| 2026-05-24 12:40:22 | Yukio Osawa | JP | Johnson & Johnson Vision | Associate Director, Japan Medical Affairs | linkedin.com/in/yukio-osawa-593120133 |
| 2026-05-24 12:40:24 | Aurélia Fauveau | CH | Merck Healthcare | Director Regulatory Affairs drug/device combination products and medical devices | linkedin.com/in/aureliafauveau |
| 2026-05-24 12:40:28 | João Medeiros | CH | Astellas Pharma | Director Program Management - Oncology Team Lead - Global Medical Affairs | linkedin.com/in/jmcmedeiros |

### Per-lead timeline

For each of the 11 leads above, the same pattern: connection invite → accepted → approved English initial DM rendered and sent → 72h later the Danish nudge auto-fired.

### Reply status (as of 2026-05-26 09:46 UTC)

`last_reply_at IS NULL` for all 11 leads. **No prospect has replied to either the English DM or the Danish nudge.** No conversation damage to undo via inbound thread.

---

## Other workspaces — checked, no cross-contamination

| Workspace | Danish "Hurtigt spørgsmål" nudges sent | Status |
|---|---|---|
| OdaGroup | 11 | **Incident** |
| CarterCo (Louis' own outreach) | 10 | Correct — all 10 went to DK-named recipients at DK companies (Benny Box, Eilersen Electric, Insights Danmark, OpinioSec, etc.) |
| Tresyv | 0 sent of this exact template (Tresyv runs its own arm-templates) | Out of scope |
| Haugefrom | 0 | Out of scope |

---

## Containment — done

| Action | Status | Notes |
|---|---|---|
| All 13 OdaGroup pipeline rows in `unwatched_followup_v1` / `watched_followup_v1` set to `sequence_completed_at = 2026-05-26 09:46 UTC`, `sequence_parked_until = 2099-01-01` | ✅ Done | Stops engagement-tick from considering them. Initial parking-only attempt was overwritten by tick because step 1 was active; completing the sequence is the durable stop. |
| Graceful-exit closer ("Hej, Jeg lukker den herfra…") — would have fired on 11 leads at T+120h from qualifier (i.e., 2026-05-28 / 2026-05-29) | ✅ Prevented | All 11 affected rows completed before the 120h mark elapsed. |
| 1 OdaGroup lead is `accepted_but_not_yet_enrolled` (no sequence_id yet); 95 leads have invites out, not yet accepted | ⚠️ Not yet stopped | New accepts will be enrolled in the global Danish sequence by the next engagement-tick run. Requires structural fix below before any new accept lands. |

---

## Structural fix — not yet shipped

The contract that must hold: **text shown next to an approve button is the only text that ever ships for that lead.** No `auto_send` action may render lead-facing text downstream without the approver having seen it.

Two ways to enforce, in increasing-correctness order:

1. **Convert every step in `unwatched_followup_v1` and `watched_followup_v1` from `auto_send` to `queue_approval`.** Caroline (and every other workspace operator) gets the qualifier / graceful-exit / nysgerrig / kalender drafts in her queue with rendered text next to Godkend. Nothing fires without her clicking. Tracked in feedback memory `feedback_approved_text_is_binding.md`.
2. **Or: surface the full sequence (all step previews per lead) inside the initial-DM approval card**, so one approve = whole chain approved with text visible.

Until (1) or (2) ships, additional containment for new OdaGroup accepts: insert per-workspace `outreach_sequences` rows for `unwatched_followup_v1` + `watched_followup_v1` with `workspace_id='cdfd80d8-…'` and `steps: []` — overrides global per resolver in `_shared/sequences.ts:104`.

---

## Customer-facing posture (recommended by Louis 2026-05-26)

No outbound apology to the 11 affected leads. Reasoning: a "beklager den forrige besked" follow-up would amplify the error in their inbox more than the original Danish line. Let the Danish nudges stand un-followed-up. Time will do the work.

Hours spent on root-cause and fix: not billed to OdaGroup.
