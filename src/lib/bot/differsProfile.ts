import type { BotSettings } from "./types";

export interface DiffersFastRiskCaps {
  dailyLossLimit: number;
  dailyProfitTarget: number;
  maxConsecutiveLosses: number;
  maxTradesPerDay: number;
  maxStake: number;
}

/**
 * Differs calibrated-confidence profile (v8).
 *
 * scripts/calibrate-elite.ts + scripts/probe-elite.ts on live R_75 showed the
 * previous v7 bar (Wilson 99%, margin 3pp, edge 0.8) armed **0 times** in 8k
 * ticks. Strongest bar that still fired: Wilson 90%, edge 0, cold gap ≥14,
 * lead ≥8, margin ≥1.5pp, unique EV, window agree — ~8 armed / ~25min wait.
 */
export const DIFFERS_FAST_PROFILE_VERSION = 8;

/** Gate/timing only — stake and money limits stay on the Bot form. */
export const DIFFERS_FAST_GATES = {
  armSeconds: 0,
  martingale: false,
  minSample: 1500,
  minEdgePercent: 0,
  skipLowConfidence: true,
  requireFullConfirm: true,
  requireMultiWindow: true,
  requireWindowsEv: true,
  requireTiming: true,
  requireUneven: true,
  minColdGap: 14,
  maxMomentumGap: 2,
  pauseIfBelowBreakEvenAfter: 0,
  pauseIfExpectancyNegativeAfter: 0,
  maxDrawdownPercent: 0,
  maxTradesPerHour: 4,
  cooldownTicks: 0,
  parallelExecution: true,
} satisfies Partial<BotSettings>;

export const LIVE_DIFFERS_QUALITY_GATES = {
  ...DIFFERS_FAST_GATES,
  minSample: 1500,
  minColdGap: 14,
  maxTradesPerHour: 3,
} satisfies Partial<BotSettings>;

const TYPICAL_DIFF_PAYOUT = 1.0965;
export const DIFFERS_R75_BREAK_EVEN_WIN_PCT = Number(
  ((1 / TYPICAL_DIFF_PAYOUT) * 100).toFixed(1),
);

export function isDiffersLiveQuality(settings: BotSettings): boolean {
  return (
    settings.side === "DIGITDIFF" &&
    settings.minColdGap === LIVE_DIFFERS_QUALITY_GATES.minColdGap &&
    settings.minSample >= LIVE_DIFFERS_QUALITY_GATES.minSample &&
    settings.requireFullConfirm === true
  );
}

/** @deprecated use DIFFERS_FAST_GATES */
export const DIFFERS_FAST_ENTRY = DIFFERS_FAST_GATES;

export const DIFFERS_FAST_MODE = {
  side: "DIGITDIFF",
  autoSide: false,
  autoFollow: true,
  sidePreference: "differs",
  duration: 1,
} satisfies Partial<BotSettings>;

export const DIFFERS_FAST_TAKE_PROFIT = 0.2;
export const DIFFERS_FAST_MAX_CONSECUTIVE_LOSSES = 1;
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
    maxRuns: 1,
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

export function applyDiffersFastProfile(current: BotSettings): BotSettings {
  return {
    ...current,
    ...DIFFERS_FAST_MODE,
    ...DIFFERS_FAST_GATES,
    maxConsecutiveLosses: DIFFERS_FAST_MAX_CONSECUTIVE_LOSSES,
    maxRuns: 1,
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
    settings.minColdGap === DIFFERS_FAST_GATES.minColdGap &&
    settings.requireFullConfirm === true &&
    settings.requireMultiWindow === true &&
    settings.requireTiming === true &&
    settings.maxConsecutiveLosses === DIFFERS_FAST_MAX_CONSECUTIVE_LOSSES
  );
}
