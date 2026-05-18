// Lead-loss calculator. Pure functions, no side effects.
// Restructured 2026-05-18 from speed-to-lead-centric to holistic GTM: three
// loss categories now map 1:1 to the three machines on carterco.dk:
//   · hastighedLoss  → Hastighed machine (response time)
//   · outboundLoss   → Outbound machine (channels + personalization quality)
//   · opfølgningLoss → Opfølgning machine (close-rate gap + nurture quality)
// Each machine gets a dedicated input + its own defensible loss formula.

export type ResponseTime = "lt5m" | "5to30m" | "30mto1h" | "gt1h";

export type OutboundQuality =
  | "deep"      // research per recipient, references their work/role
  | "light"     // first-name + company merge fields
  | "templated" // mass template, identical to every recipient
  | "none";     // not doing outbound at all

export type FollowupQuality =
  | "automated" // every lead gets a cadence until they reply
  | "partial"   // some reminders, inconsistent
  | "manual"    // seller follows up when they have time
  | "none";     // no nurture for leads that don't buy now

export type SalesCycle =
  | "lt2w"     // <2 weeks
  | "2to8w"   // 2-8 weeks
  | "2to6mo"  // 2-6 months
  | "gt6mo";  // >6 months

export type LeadOriginMix =
  | "mostly-inbound"  // mostly they reach out to us
  | "mix"             // roughly half-half
  | "mostly-outbound"; // mostly we reach out to them

export type Channel =
  | "linkedin"
  | "cold-email"
  | "meta"
  | "google"
  | "referral"
  | "seo"
  | "other";

export type QuizInputs = {
  monthlyLeads: number;
  dealValue: number;
  closeRate: number; // 0..1
  responseTime: ResponseTime;
  channels: Channel[];
  outboundQuality: OutboundQuality;
  followupQuality: FollowupQuality;
  salesCycle: SalesCycle;
  leadOriginMix: LeadOriginMix;
};

export type QuizResult = {
  totalLoss: number;

  // Three machine-labeled losses
  hastighedLoss: number;
  outboundLoss: number;
  opfølgningLoss: number;

  missingChannels: Channel[];
  presentValuableChannels: Channel[];
  tav: number;
  actualMonthlyValue: number;
};

// Channels that drive meaningful B2B pipeline. Missing referrals / SEO is
// treated as neutral (they happen passively).
const VALUABLE_CHANNELS: readonly Channel[] = [
  "linkedin",
  "cold-email",
  "meta",
  "google",
];

// Response-time → captured share of lead value.
// The MIT study reports 21× qualification-rate advantage at <5 min vs >30 min,
// but qualification odds don't translate 1:1 to revenue capture — slow leads
// still close some of the time. Softened from a strict 21× drop (which made
// Hastighed dominate the breakdown 5:1 over the other two machines) to a
// more proportionate spread where speed still matters most but doesn't
// crowd out outbound + opfølgning losses.
const SPEED_FACTOR: Record<ResponseTime, number> = {
  lt5m: 1.0,
  "5to30m": 0.7,
  "30mto1h": 0.45,
  gt1h: 0.25,
};

// Outbound-quality → captured share of outbound channel value.
// Deep personalization captures the full potential of a channel; templated
// mass-DMs leave most response on the table. Industry pattern, conservative
// numbers below the often-cited "6× response rate" claim for deep personal.
const OUTBOUND_QUALITY_FACTOR: Record<OutboundQuality, number> = {
  deep: 1.0,
  light: 0.55,
  templated: 0.25,
  none: 0.0,
};

// Followup-quality → captured share of nurture-stage pipeline value.
// Manual followup loses leads to the void; automated cadence captures
// most of the deals that need 5+ touches before they buy.
const FOLLOWUP_QUALITY_FACTOR: Record<FollowupQuality, number> = {
  automated: 1.0,
  partial: 0.5,
  manual: 0.2,
  none: 0.0,
};

const IDEAL_CLOSE_RATE = 0.25;

// How much of the outbound loss is attributable to quality vs missing channels.
// Quality cap raised to 35% (mass-templated outreach loses a lot more than
// 20%); channel-leak raised to 8% per missing channel. Combined, an operator
// with templated outreach + 3 missing channels can hit ~57% outbound leak,
// which matches the order-of-magnitude reality of "you have one channel and
// it's mass-spam."
const OUTBOUND_QUALITY_WEIGHT = 0.35;
const CHANNEL_LOSS_PER_MISSING = 0.08;

// How much of the followup loss is attributable to nurture quality.
// Raised from 15% to 30% — manual followup loses more than the previous
// number implied. 80% of B2B deals require 5+ touches; manual nurture
// loses most of them, not just 15%.
const FOLLOWUP_QUALITY_WEIGHT = 0.30;

// Hastighed-loss multiplier by where leads originate.
// Inbound leads are perishable — they reached out NOW expecting NOW.
// Outbound leads, you control the timing — speed-to-respond matters less.
const HASTIGHED_BY_ORIGIN: Record<LeadOriginMix, number> = {
  "mostly-inbound": 1.2,
  mix: 1.0,
  "mostly-outbound": 0.7,
};

// Opfølgning-loss multiplier by sales-cycle length.
// Short cycles (<2w) → decision happens fast, less nurture matters.
// Long cycles (>6mo) → buyer drifts away, automated cadence is everything.
const OPFOLGNING_BY_CYCLE: Record<SalesCycle, number> = {
  lt2w: 0.7,
  "2to8w": 1.0,
  "2to6mo": 1.3,
  gt6mo: 1.5,
};

export function computeLoss(i: QuizInputs): QuizResult {
  const speed = SPEED_FACTOR[i.responseTime];
  const outboundCaptured = OUTBOUND_QUALITY_FACTOR[i.outboundQuality];
  const followupCaptured = FOLLOWUP_QUALITY_FACTOR[i.followupQuality];

  const leads = Math.max(0, i.monthlyLeads);
  const dealValue = Math.max(0, i.dealValue);
  const closeRate = Math.min(1, Math.max(0, i.closeRate));

  const tav = leads * dealValue * IDEAL_CLOSE_RATE;
  const actualMonthlyValue = leads * dealValue * closeRate * speed;

  // 1. HASTIGHED — value lost because slow response demotes lead quality.
  // Anchored on MIT 5-min response-time study. Multiplied by lead-origin
  // mix: inbound leads are perishable, outbound leads aren't.
  const originMultiplier = HASTIGHED_BY_ORIGIN[i.leadOriginMix];
  const hastighedLoss =
    leads * dealValue * closeRate * (1 - speed) * originMultiplier;

  // 2. OUTBOUND — two stacking factors:
  //    (a) Missing channels — leads they're not generating because a
  //        valuable channel isn't running.
  //    (b) Outbound quality — even on channels they DO run, templated
  //        mass-DMs leave response on the table vs personalized outreach.
  const missingChannels = VALUABLE_CHANNELS.filter(
    (c) => !i.channels.includes(c),
  );
  const presentValuableChannels = VALUABLE_CHANNELS.filter((c) =>
    i.channels.includes(c),
  );
  const channelLeak = missingChannels.length * CHANNEL_LOSS_PER_MISSING;
  const qualityLeak = (1 - outboundCaptured) * OUTBOUND_QUALITY_WEIGHT;
  const outboundLoss =
    leads * dealValue * closeRate * speed * (channelLeak + qualityLeak);

  // 3. OPFØLGNING — two stacking factors:
  //    (a) Close-rate gap vs B2B benchmark (25% of qualified leads → customer).
  //    (b) Followup-quality leak — manual nurture loses deals that need 5+
  //        touches; automated cadence captures them.
  const closeRateGap = Math.max(0, IDEAL_CLOSE_RATE - closeRate);
  const followupLeak = (1 - followupCaptured) * FOLLOWUP_QUALITY_WEIGHT;
  const cycleMultiplier = OPFOLGNING_BY_CYCLE[i.salesCycle];
  const opfølgningLoss =
    (leads * dealValue * closeRateGap * speed +
      leads * dealValue * closeRate * speed * followupLeak) *
    cycleMultiplier;

  const totalLoss = hastighedLoss + outboundLoss + opfølgningLoss;

  return {
    totalLoss,
    hastighedLoss,
    outboundLoss,
    opfølgningLoss,
    missingChannels: [...missingChannels],
    presentValuableChannels: [...presentValuableChannels],
    tav,
    actualMonthlyValue,
  };
}

export const RESPONSE_TIME_LABELS: Record<ResponseTime, string> = {
  lt5m: "Under 5 min",
  "5to30m": "5–30 min",
  "30mto1h": "30 min – 1 time",
  gt1h: "Over 1 time",
};

export const OUTBOUND_QUALITY_LABELS: Record<OutboundQuality, string> = {
  deep: "Dyb research per modtager",
  light: "Let personlig (navn, firma)",
  templated: "Mass-template, alle får det samme",
  none: "Vi laver ikke outbound",
};

export const FOLLOWUP_QUALITY_LABELS: Record<FollowupQuality, string> = {
  automated: "Fuldautomatisk pleje-flow — alle leads får cadence",
  partial: "Halvautomatisk — nogle påmindelser, inkonsistent",
  manual: "Manuelt — sælger følger op når der er tid",
  none: "Vi har ingen pleje af kolde leads",
};

export const SALES_CYCLE_LABELS: Record<SalesCycle, string> = {
  lt2w: "Under 2 uger",
  "2to8w": "2-8 uger",
  "2to6mo": "2-6 måneder",
  gt6mo: "Over 6 måneder",
};

export const LEAD_ORIGIN_LABELS: Record<LeadOriginMix, string> = {
  "mostly-inbound": "Mest dem der kontakter os",
  mix: "Cirka halv-halv",
  "mostly-outbound": "Mest os der kontakter dem",
};

export const CHANNEL_LABELS: Record<Channel, string> = {
  linkedin: "LinkedIn outreach",
  "cold-email": "Cold email",
  meta: "Meta-annoncer",
  google: "Google Ads",
  referral: "Referencer",
  seo: "SEO",
  other: "Andet",
};

// ─── English variants ─────────────────────────────────────────────
// Used by the /en marketing page. Same shape as the *_LABELS exports
// above; lead-quiz.tsx picks one or the other based on its `locale` prop.

export const RESPONSE_TIME_LABELS_EN: Record<ResponseTime, string> = {
  lt5m: "Under 5 min",
  "5to30m": "5–30 min",
  "30mto1h": "30 min – 1 hr",
  gt1h: "Over 1 hr",
};

export const OUTBOUND_QUALITY_LABELS_EN: Record<OutboundQuality, string> = {
  deep: "Deep research per recipient",
  light: "Lightly personal (name, company)",
  templated: "Mass template — everyone gets the same",
  none: "We don't do outbound",
};

export const FOLLOWUP_QUALITY_LABELS_EN: Record<FollowupQuality, string> = {
  automated: "Fully automated nurture flow — every lead gets cadence",
  partial: "Semi-automated — some reminders, inconsistent",
  manual: "Manual — sales follows up when there's time",
  none: "We don't nurture cold leads",
};

export const SALES_CYCLE_LABELS_EN: Record<SalesCycle, string> = {
  lt2w: "Under 2 weeks",
  "2to8w": "2-8 weeks",
  "2to6mo": "2-6 months",
  gt6mo: "Over 6 months",
};

export const LEAD_ORIGIN_LABELS_EN: Record<LeadOriginMix, string> = {
  "mostly-inbound": "Mostly people contacting us",
  mix: "Roughly half and half",
  "mostly-outbound": "Mostly us contacting them",
};

export const CHANNEL_LABELS_EN: Record<Channel, string> = {
  linkedin: "LinkedIn outreach",
  "cold-email": "Cold email",
  meta: "Meta ads",
  google: "Google Ads",
  referral: "Referrals",
  seo: "SEO",
  other: "Other",
};

export function formatKrEN(amount: number): string {
  const rounded = Math.round(amount);
  return "kr " + rounded.toLocaleString("en-US");
}

export function formatRangeEN(amount: number): string {
  if (amount < 1000) return formatKrEN(amount);
  const lowRaw = amount * 0.7;
  const highRaw = amount * 1.3;
  const step = amount >= 100_000 ? 5000 : 1000;
  const low = Math.floor(lowRaw / step) * step;
  const high = Math.ceil(highRaw / step) * step;
  return (
    "kr " +
    low.toLocaleString("en-US") +
    "–" +
    high.toLocaleString("en-US")
  );
}

export const ALL_CHANNELS: readonly Channel[] = [
  "linkedin",
  "cold-email",
  "meta",
  "google",
  "referral",
  "seo",
  "other",
];

export const OUTBOUND_QUALITY_OPTIONS: readonly OutboundQuality[] = [
  "deep",
  "light",
  "templated",
  "none",
];

export const FOLLOWUP_QUALITY_OPTIONS: readonly FollowupQuality[] = [
  "automated",
  "partial",
  "manual",
  "none",
];

export const SALES_CYCLE_OPTIONS: readonly SalesCycle[] = [
  "lt2w",
  "2to8w",
  "2to6mo",
  "gt6mo",
];

export const LEAD_ORIGIN_OPTIONS: readonly LeadOriginMix[] = [
  "mostly-inbound",
  "mix",
  "mostly-outbound",
];

export function formatKr(amount: number): string {
  const rounded = Math.round(amount);
  return rounded.toLocaleString("da-DK") + " kr";
}

// Display a loss as an honest range, not false-precise single number.
// The point-estimate is built on 4 rough estimates from the visitor (leads,
// deal value, close rate, response time), so claiming "63.847 kr" is wrong
// even if the math gives that exact figure. Conservative ±30% spread,
// rounded to clean step sizes so the bounds feel like real estimates.
//
// < 1.000 kr   → single number (no range — too small to meaningfully bound)
// < 100.000 kr → rounded to nearest 1.000
// ≥ 100.000 kr → rounded to nearest 5.000
export function formatRange(amount: number): string {
  if (amount < 1000) return formatKr(amount);
  const lowRaw = amount * 0.7;
  const highRaw = amount * 1.3;
  const step = amount >= 100_000 ? 5000 : 1000;
  const low = Math.floor(lowRaw / step) * step;
  const high = Math.ceil(highRaw / step) * step;
  return (
    low.toLocaleString("da-DK") +
    "–" +
    high.toLocaleString("da-DK") +
    " kr"
  );
}
