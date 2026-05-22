// Tresyv 3-arm A/B copy library. Templates are VERBATIM from Rasmus's
// May 21 2026 email ("Re: Fwd: 3 versioner vi kører" thread). Do not
// edit the body text without re-confirming with Rasmus — the experiment
// independent variable is the message exactly as written.
//
// Substitutions:
//   {firstName} → outreach_leads.first_name (greeting form, first token)
//   {website}   → outreach_leads.website (bare domain, lowercased)
//
// Sign-off ("De venligste hilsner / Rasmus") is omitted: SendPilot appends
// the sender's signature at send time. Adding it here would double-stamp.

export type FirstDmVariant = "v1_long" | "v2_short" | "v3_video";

export const TRESYV_V1_LONG = [
  "Hej {firstName}",
  "",
  "Tak for forbindelsen.",
  "",
  "Jeg har kigget kort på {website}, og jeg tror, der er nogle ret oplagte muligheder for at gøre brugerrejsen tydeligere og få mere ud af de besøgende, I allerede har.",
  "",
  "Min kollega Tue og jeg har arbejdet med UX, design og brugerpsykologi i over 25 år og hjælper dagligt stærke brands med websites, der er lettere at forstå, lettere at bruge og bedre til at konvertere.",
  "",
  "Hvis det er relevant, giver vi gerne en kort og uforpligtende gennemgang af jeres website. Bagefter får I 5-10 konkrete forbedringspunkter, som I kan bruge med det samme.",
  "",
  "Kunne det være relevant for jer?",
].join("\n");

export const TRESYV_V2_SHORT = [
  "Hej {firstName}",
  "",
  "Tak for forbindelsen.",
  "",
  "Jeg har kigget kort på {website}, og jeg tror, der er et par ret oplagte greb, som kan gøre websitet skarpere og få flere besøgende til at tage næste skridt.",
  "",
  "Skal jeg sende dig 2-3 konkrete ting, jeg især ville få kigget på?",
].join("\n");

// V3 (video) keeps using the existing sendspark-webhook DEFAULT_TEMPLATE —
// no copy change there. The arm assignment just decides which of the
// three paths a Tresyv accept takes.

// Per-arm follow-up copy (also verbatim from the same email thread). Used
// by the engagement engine when sending the second touch. Breakup message
// dropped per Rasmus's May 21 reply.
export const TRESYV_V1_FOLLOWUP = [
  "Hej {firstName}",
  "",
  "Jeg følger bare lige op.",
  "",
  "Jeg tror, der er et par oplagte steder, hvor jeres website kan blive tydeligere og konvertere bedre.",
  "",
  "Skal jeg sende et par konkrete bud?",
  "",
  "Hvis ikke, er det helt fair – så lukker jeg den bare herfra.",
].join("\n");

export const TRESYV_V2_FOLLOWUP = [
  "Hej {firstName}",
  "",
  "Jeg følger bare lige op.",
  "",
  "Skal jeg sende dig de 2-3 ting, jeg især ville kigge på for at gøre jeres website skarpere og få flere besøgende til at tage næste skridt?",
  "",
  "Hvis ikke, er det helt fair.",
].join("\n");

export const TRESYV_VIDEO_FOLLOWUP_WATCHED = [
  "Hej {firstName}",
  "",
  "Jeg håber, videoen gav mening.",
  "",
  "Skal vi tage en kort snak om, hvor vi ser de største muligheder for at gøre jeres website tydeligere og få flere besøgende til at tage næste skridt?",
  "",
  "Jeg sender gerne et par forslag til tider.",
].join("\n");

export const TRESYV_VIDEO_FOLLOWUP_PARTIAL = [
  "Hej {firstName}",
  "",
  "Jeg følger bare lige op på videoen fra forleden.",
  "",
  "Den korte version er, at vi tror, der er nogle konkrete greb, der kan gøre jeres website tydeligere og få flere besøgende til at tage næste skridt.",
  "",
  "Skal jeg sende et par forslag til tider, hvor vi kan tage en kort snak?",
].join("\n");

export const TRESYV_VIDEO_FOLLOWUP_NO_ACTIVITY = [
  "Hej {firstName}",
  "",
  "Jeg følger bare lige op.",
  "",
  "Jeg tror, der er nogle oplagte muligheder for at gøre jeres website tydeligere og få flere besøgende til at tage næste skridt.",
  "",
  "Skal jeg sende et par forslag til tider, hvor vi kan tage en kort snak?",
].join("\n");

// 33/33/33 random assignment. Math.random is fine here — no statistical
// rigor needed for a 3-way coin flip at this volume; what matters is that
// the assignment is independent per lead and locked at insert time.
export function assignFirstDmVariant(): FirstDmVariant {
  const r = Math.random();
  if (r < 1 / 3) return "v1_long";
  if (r < 2 / 3) return "v2_short";
  return "v3_video";
}

// Render V1 / V2 body text with {firstName} and {website} substitution.
// firstName: greeting form (first token only). website: bare domain, lowercased.
export function renderTresyvBody(
  template: string,
  firstName: string,
  website: string,
): string {
  return template
    .replaceAll("{firstName}", firstName || "der")
    .replaceAll("{website}", website || "jeres site");
}
