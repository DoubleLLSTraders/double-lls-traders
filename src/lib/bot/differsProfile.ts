import { isAnalyzerGood } from "../analysis/analyzerGate";
import type { MarketSignal } from "../analysis/signal";
import type { BotSettings } from "./types";

export interface DiffersFastRiskCaps {
  dailyLossLimit: number;
  dailyProfitTarget: number;
  maxConsecutiveLosses: number;
  maxTradesPerDay: number;
  maxStake: number;
}

/**
 * Differs desk profile (v13) — Digits Trade now = instant desk buy.
 *
 * Executor is a pure follower (no re-back / deep research). Stay while
 * building; hop only after a dead dwell.
 */
export const DIFFERS_FAST_PROFILE_VERSION = 13;

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
  minColdGap: 6,
  maxMomentumGap: 2,
  pauseIfBelowBreakEvenAfter: 0,
  pauseIfExpectancyNegativeAfter: 0,
  maxDrawdownPercent: 0,
  maxTradesPerHour: 20,
  cooldownTicks: 0,
  parallelExecution: true,
} satisfies Partial<BotSettings>;

export const LIVE_DIFFERS_QUALITY_GATES = {
  ...DIFFERS_FAST_GATES,
  maxTradesPerHour: 12,
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
    settings.requireTiming === true
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
    // Keep the Bot form's Number of runs / money limits — do not reset to 1.
    maxRuns: Math.max(1, current.maxRuns || 1),
    takeProfit: current.takeProfit,
    stopLoss: current.stopLoss,
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
    settings.requireTiming === true &&
    settings.maxConsecutiveLosses === DIFFERS_FAST_MAX_CONSECUTIVE_LOSSES
  );
}

/** Live Digits / Start: same Good gate the bot must obey. */
export function isDeskTradeReady(
  signal: MarketSignal,
  settings: Pick<BotSettings, "minColdGap" | "minSample" | "side" | "maxMomentumGap">,
): boolean {
  return isAnalyzerGood(signal, settings);
}
