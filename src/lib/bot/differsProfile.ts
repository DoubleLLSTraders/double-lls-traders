import type { BotSettings } from "./types";

export interface DiffersFastRiskCaps {
  dailyLossLimit: number;
  dailyProfitTarget: number;
  maxConsecutiveLosses: number;
  maxTradesPerDay: number;
  maxStake: number;
}

/**
 * Differs fast profile — open within seconds once cold barrier + gap pass.
 * Keeps: stop after 1 loss, take-profit bank, skip digit that just lost.
 */
export const DIFFERS_FAST_PROFILE_VERSION = 4;

/** Gate/timing only — stake and money limits stay on the Bot form. */
export const DIFFERS_FAST_GATES = {
  armSeconds: 0,
  martingale: false,
  minSample: 500,
  minEdgePercent: 0,
  skipLowConfidence: false,
  requireFullConfirm: false,
  requireMultiWindow: false,
  requireWindowsEv: false,
  requireTiming: true,
  requireUneven: false,
  minColdGap: 4,
  maxMomentumGap: 3,
  pauseIfBelowBreakEvenAfter: 0,
  pauseIfExpectancyNegativeAfter: 0,
  maxDrawdownPercent: 0,
  maxTradesPerHour: 60,
  cooldownTicks: 0,
  parallelExecution: true,
} satisfies Partial<BotSettings>;

/**
 * Live Differs accuracy tier — targets ~91%+ win rate on R_75 (break-even ~91.2%).
 * Slightly slower entries (cold gap 5, 750-tick sample) for a clearer cold barrier.
 */
export const LIVE_DIFFERS_QUALITY_GATES = {
  ...DIFFERS_FAST_GATES,
  minSample: 750,
  minColdGap: 5,
  maxTradesPerHour: 30,
} satisfies Partial<BotSettings>;

/** Break-even win rate on R_75 Differs at typical payout (~1.0965×). */
const TYPICAL_DIFF_PAYOUT = 1.0965;
export const DIFFERS_R75_BREAK_EVEN_WIN_PCT = Number(
  ((1 / TYPICAL_DIFF_PAYOUT) * 100).toFixed(1),
);

export function isDiffersLiveQuality(settings: BotSettings): boolean {
  return (
    settings.side === "DIGITDIFF" &&
    settings.minColdGap === LIVE_DIFFERS_QUALITY_GATES.minColdGap &&
    settings.minSample >= LIVE_DIFFERS_QUALITY_GATES.minSample
  );
}

/** @deprecated use DIFFERS_FAST_GATES — stake is no longer part of the profile */
export const DIFFERS_FAST_ENTRY = DIFFERS_FAST_GATES;

export const DIFFERS_FAST_MODE = {
  side: "DIGITDIFF",
  autoSide: false,
  autoFollow: true,
  sidePreference: "differs",
  duration: 1,
} satisfies Partial<BotSettings>;

/** Bank ~10 wins at typical Differs payout then stop the run. */
export const DIFFERS_FAST_TAKE_PROFIT = 1.9;

/** Stop the run after a single loss — one −1.75 must not become a streak. */
export const DIFFERS_FAST_MAX_CONSECUTIVE_LOSSES = 1;

/** Default feed symbol for this profile (full Differs payout tier). */
export const DIFFERS_FAST_SYMBOL = "R_75";

export function createDiffersFastBotSettings(risk: DiffersFastRiskCaps): BotSettings {
  const stake = Math.max(0.35, Math.min(1.75, risk.maxStake));
  return {
    prediction: 0,
    martingaleMultiplier: 2,
    maxMartingaleSteps: 3,
    contracts: 1,
    stake,
    riskPercent: 0,
    maxExposurePercent: 2,
    takeProfit: DIFFERS_FAST_TAKE_PROFIT,
    stopLoss: risk.dailyLossLimit,
    maxRuns: 20,
    running: false,
    dailyLossLimit: risk.dailyLossLimit,
    dailyProfitTarget: risk.dailyProfitTarget,
    maxConsecutiveLosses: DIFFERS_FAST_MAX_CONSECUTIVE_LOSSES,
    maxTradesPerDay: risk.maxTradesPerDay,
    maxStake: Math.max(risk.maxStake, stake),
    ...DIFFERS_FAST_MODE,
    ...DIFFERS_FAST_GATES,
  };
}

/** Sync gate/timing profile; keeps stake, caps, and take-profit from the form. */
export function applyDiffersFastProfile(current: BotSettings): BotSettings {
  return {
    ...current,
    ...DIFFERS_FAST_MODE,
    ...DIFFERS_FAST_GATES,
    maxConsecutiveLosses: DIFFERS_FAST_MAX_CONSECUTIVE_LOSSES,
    maxStake: Math.max(current.maxStake, current.stake),
    running: false,
  };
}

export function isDiffersFastProfile(settings: BotSettings): boolean {
  return (
    settings.side === "DIGITDIFF" &&
    settings.autoSide === false &&
    settings.autoFollow === true &&
    settings.martingale === false &&
    settings.cooldownTicks === 0 &&
    settings.minColdGap === 4 &&
    settings.requireTiming === true &&
    settings.requireMultiWindow === false &&
    settings.maxConsecutiveLosses === DIFFERS_FAST_MAX_CONSECUTIVE_LOSSES
  );
}
