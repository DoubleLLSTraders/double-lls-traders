import { isAnalyzerGood } from "../analysis/analyzerGate";
import { resolveAnalyzerPace } from "../analysis/analyzerPace";
import type { MarketSignal } from "../analysis/signal";
import type { BotSettings } from "./types";

export interface MatchesFirmRiskCaps {
  dailyLossLimit: number;
  dailyProfitTarget: number;
  maxConsecutiveLosses: number;
  maxTradesPerDay: number;
  maxStake: number;
}

/**
 * Matches firm desk profile (v2) — hunt best hot, short firm prove, same-tick buy.
 *
 * Differs stays the default Start pack. This is switchable via Matches mode.
 */
export const MATCHES_FIRM_PROFILE_VERSION = 2;

/** Gate/timing only — stake and money limits stay on the Bot form. */
export const MATCHES_FIRM_GATES = {
  armSeconds: 0,
  martingale: false,
  minSample: 500,
  minEdgePercent: 0,
  skipLowConfidence: true,
  requireFullConfirm: false,
  requireMultiWindow: false,
  requireWindowsEv: false,
  requireTiming: true,
  requireUneven: false,
  minColdGap: 6,
  /** Hot must stay recent — 2 ticks allows firm without freezing forever. */
  maxMomentumGap: 2,
  pauseIfBelowBreakEvenAfter: 0,
  pauseIfExpectancyNegativeAfter: 0,
  maxDrawdownPercent: 0,
  maxTradesPerHour: 12,
  cooldownTicks: 10,
  parallelExecution: true,
  analyzerPace: "matches-firm",
} satisfies Partial<BotSettings>;

export const MATCHES_FIRM_MODE = {
  side: "DIGITMATCH",
  autoSide: false,
  autoFollow: true,
  sidePreference: "matches",
  duration: 1,
} satisfies Partial<BotSettings>;

export const MATCHES_FIRM_TAKE_PROFIT = 0.2;
/** Stop the run after this many losses in a row. */
export const MATCHES_FIRM_MAX_CONSECUTIVE_LOSSES = 2;
export const MATCHES_FIRM_SYMBOL = "1HZ75V";

export function createMatchesFirmBotSettings(
  risk: MatchesFirmRiskCaps,
): BotSettings {
  const stake = Math.max(0.35, Math.min(1.75, risk.maxStake));
  return {
    prediction: 0,
    martingaleMultiplier: 2,
    maxMartingaleSteps: 3,
    contracts: 1,
    stake,
    riskPercent: 0,
    maxExposurePercent: 2,
    takeProfit: MATCHES_FIRM_TAKE_PROFIT,
    stopLoss: risk.dailyLossLimit,
    maxRuns: 1,
    running: false,
    dailyLossLimit: risk.dailyLossLimit,
    dailyProfitTarget: risk.dailyProfitTarget,
    maxConsecutiveLosses: MATCHES_FIRM_MAX_CONSECUTIVE_LOSSES,
    maxTradesPerDay: risk.maxTradesPerDay,
    maxStake: Math.max(risk.maxStake, stake),
    ...MATCHES_FIRM_MODE,
    ...MATCHES_FIRM_GATES,
  };
}

export function applyMatchesFirmProfile(current: BotSettings): BotSettings {
  const pace = resolveAnalyzerPace("matches-firm");
  return {
    ...current,
    ...MATCHES_FIRM_MODE,
    ...MATCHES_FIRM_GATES,
    analyzerPace: "matches-firm",
    cooldownTicks: pace.cooldownTicks,
    maxConsecutiveLosses: MATCHES_FIRM_MAX_CONSECUTIVE_LOSSES,
    maxRuns: Math.max(1, current.maxRuns || 1),
    takeProfit: current.takeProfit,
    stopLoss: current.stopLoss,
    maxStake: Math.max(current.maxStake, current.stake),
    running: false,
  };
}

export function isMatchesFirmProfile(settings: BotSettings): boolean {
  const pace = resolveAnalyzerPace(settings.analyzerPace);
  return (
    settings.side === "DIGITMATCH" &&
    settings.autoSide === false &&
    settings.autoFollow === true &&
    settings.martingale === false &&
    settings.analyzerPace === "matches-firm" &&
    settings.cooldownTicks === pace.cooldownTicks &&
    settings.maxMomentumGap === MATCHES_FIRM_GATES.maxMomentumGap &&
    settings.minSample >= MATCHES_FIRM_GATES.minSample &&
    settings.requireTiming === true &&
    settings.skipLowConfidence === true &&
    settings.maxConsecutiveLosses === MATCHES_FIRM_MAX_CONSECUTIVE_LOSSES
  );
}

/** Live Digits / Start: same Good gate the bot must obey. */
export function isMatchesDeskTradeReady(
  signal: MarketSignal,
  settings: Pick<BotSettings, "minColdGap" | "minSample" | "side" | "maxMomentumGap">,
): boolean {
  return isAnalyzerGood(signal, settings);
}
