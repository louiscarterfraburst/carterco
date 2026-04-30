// Lead-loss calculator. Pure functions, no side effects.
// All multipliers are defensible:
// - Speed factor anchored on the MIT speed-to-lead study (already cited on the page).
// - Ideal close rate from public B2B benchmarks (~25% of qualified leads → customer).
// - Channel-loss heuristic at 5% per missing canonical channel (conservative).

export type ResponseTime = "lt5m" | "5to30m" | "30mto1h" | "gt1h";

export type Channel =
  | "linkedin"
  | "cold-email"
  | "meta"
  | "google"
  | "referral"
  | "seo"
  | "other";

export type QuizInputs = {
  monthlyLeads: number; // count per month
  dealValue: number; // kr per closed customer
  closeRate: number; // 0..1, e.g. 0.15 = 15%
  responseTime: ResponseTime;
  channels: Channel[];
};

export type QuizResult = {
  totalLoss: number;
  speedLoss: number;
  closeRateLoss: number;
  channelLoss: number;
  missingChannels: Channel[];
  presentValuableChannels: Channel[];
  tav: number; // total addressable monthly value at ideal close + instant response
  actualMonthlyValue: number;
};

// Channels that, in B2B context, drive meaningful pipeline. Missing one of these is
// a real revenue gap; missing referrals/SEO is treated as neutral (those happen
// passively and aren't a "system gap").
const VALUABLE_CHANNELS: readonly Channel[] = [
  "linkedin",
  "cold-email",
  "meta",
  "google",
];

const SPEED_FACTOR: Record<ResponseTime, number> = {
  lt5m: 1.0,
  "5to30m": 0.4,
  "30mto1h": 0.15,
  gt1h: 0.05,
};

const IDEAL_CLOSE_RATE = 0.25;
const CHANNEL_LOSS_PER_MISSING = 0.05;

export function computeLoss(i: QuizInputs): QuizResult {
  const speed = SPEED_FACTOR[i.responseTime];
  const leads = Math.max(0, i.monthlyLeads);
  const dealValue = Math.max(0, i.dealValue);
  const closeRate = Math.min(1, Math.max(0, i.closeRate));

  const tav = leads * dealValue * IDEAL_CLOSE_RATE;
  const actualMonthlyValue = leads * dealValue * closeRate * speed;

  // 1. Speed loss — value lost because slow response demotes lead quality.
  const speedLoss = leads * dealValue * closeRate * (1 - speed);

  // 2. Close-rate gap — value lost because their close rate is below benchmark
  //    (only counted on leads that aren't already lost to speed).
  const closeRateLoss =
    leads * dealValue * Math.max(0, IDEAL_CLOSE_RATE - closeRate) * speed;

  // 3. Missing-channel loss — leads they're not getting because a valuable
  //    channel isn't running. Conservative 5% per missing canonical channel.
  const missingChannels = VALUABLE_CHANNELS.filter(
    (c) => !i.channels.includes(c),
  );
  const presentValuableChannels = VALUABLE_CHANNELS.filter((c) =>
    i.channels.includes(c),
  );
  const channelLoss =
    leads *
    dealValue *
    closeRate *
    (missingChannels.length * CHANNEL_LOSS_PER_MISSING);

  const totalLoss = speedLoss + closeRateLoss + channelLoss;

  return {
    totalLoss,
    speedLoss,
    closeRateLoss,
    channelLoss,
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

export const CHANNEL_LABELS: Record<Channel, string> = {
  linkedin: "LinkedIn outreach",
  "cold-email": "Cold email",
  meta: "Meta-annoncer",
  google: "Google Ads",
  referral: "Referencer",
  seo: "SEO",
  other: "Andet",
};

export const ALL_CHANNELS: readonly Channel[] = [
  "linkedin",
  "cold-email",
  "meta",
  "google",
  "referral",
  "seo",
  "other",
];

export function formatKr(amount: number): string {
  // Danish convention: thousands separated by ".", no decimal for round amounts.
  const rounded = Math.round(amount);
  return rounded.toLocaleString("da-DK") + " kr";
}
