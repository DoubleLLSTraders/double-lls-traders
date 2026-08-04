import { isAnalyzerGood } from "../analysis/analyzerGate";
import { resolveAnalyzerPace } from "../analysis/analyzerPace";
import type { MarketSignal } from "../analysis/signal";
import { profitRate } from "./performance";
import type { BotSettings } from "./types";

export interface OverUnderRiskCaps {
  dailyLossLimit: number;
  dailyProfitTarget: number;
  maxConsecutiveLosses: number;
  maxTradesPerDay: number;
  maxStake: number;
}

/**
 * Over/Under Blitz desk (v3) — edge vs fair + payout EV on live tape.
 * Analyzer picks Over/Under + barrier from market-form math (not raw hit-rate).
 */
export const OVER_UNDER_PROFILE_VERSION = 28;

/** Gate/timing only — stake and money limits stay on the Bot form. */
export const OVER_UNDER_GATES = {
  armSeconds: 0,
  martingale: false,
  /** Deep enough to filter fakes; light enough to trade inside 1m. */
  minSample: 48,
  minEdgePercent: 1,
  skipLowConfidence: true,
  requireFullConfirm: false,
  requireMultiWindow: false,
  requireWindowsEv: true,
  requireTiming: true,
  requireUneven: false,
  minColdGap: 1,
  /** Winning outcome must be on the last tick (or one back). */
  maxMomentumGap: 1,
  pauseIfBelowBreakEvenAfter: 0,
  pauseIfExpectancyNegativeAfter: 0,
  maxDrawdownPercent: 0,
  /** Shield mode: Over 0 / Under 9 — fewer, stricter Trade nows. */
  maxTradesPerHour: 120,
  cooldownTicks: 2,
  parallelExecution: true,
  analyzerPace: "overunder-firm",
} satisfies Partial<BotSettings>;

export const OVER_UNDER_MODE = {
  side: "DIGITOVER",
  autoSide: true,
  autoFollow: true,
  sidePreference: "edge",
  duration: 1,
} satisfies Partial<BotSettings>;

/** @deprecated — auto TP is one barrier win; kept for older call sites. */
export const OVER_UNDER_TAKE_PROFIT = 0.35;
export const OVER_UNDER_MAX_CONSECUTIVE_LOSSES = 3;
export const OVER_UNDER_SYMBOL = "1HZ75V";

/** Blitz-tradable barriers (analyzer set). */
export const OU_OVER_BARRIERS = [0, 1, 2, 3] as const;
export const OU_UNDER_BARRIERS = [6, 7, 8, 9] as const;

/**
 * Timed bulk session presets.
 * Quick = TP stops; 1h/4h/8h/custom = full wall-clock (TP ignored as stop).
 */
export const OU_BULK_SESSION_PRESETS = [
  { id: "quick", label: "Quick", hours: 0, runs: 0 },
  { id: "1h", label: "1 hour", hours: 1, runs: 36 },
  { id: "4h", label: "4 hours", hours: 4, runs: 144 },
  { id: "8h", label: "8 hours", hours: 8, runs: 288 },
  { id: "custom", label: "Custom", hours: -1, runs: 0 },
] as const;

export type OuBulkSessionId = (typeof OU_BULK_SESSION_PRESETS)[number]["id"];

export function sessionHoursFromParts(hours: number, minutes: number): number {
  const h = Math.max(0, Math.floor(hours));
  const m = Math.min(59, Math.max(0, Math.floor(minutes)));
  return h + m / 60;
}

export function sessionPartsFromHours(totalHours: number): {
  hours: number;
  minutes: number;
} {
  if (!Number.isFinite(totalHours) || totalHours <= 0) {
    return { hours: 0, minutes: 0 };
  }
  const totalMins = Math.round(totalHours * 60);
  const hours = Math.floor(totalMins / 60);
  const minutes = totalMins % 60;
  return { hours, minutes };
}

export function formatSessionDuration(totalHours: number): string {
  const { hours, minutes } = sessionPartsFromHours(totalHours);
  if (hours <= 0 && minutes <= 0) return "—";
  if (hours <= 0) return `${minutes}m`;
  if (minutes <= 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

export function ouBulkPresetForRuns(
  maxRuns: number,
  manual?: boolean,
  sessionHours?: number,
): OuBulkSessionId {
  const hours = sessionHours ?? 0;
  if (hours <= 0) {
    if (!manual || maxRuns <= 1) return "quick";
    return "quick";
  }
  // Exact presets only — anything else (e.g. 30m, 2h) is Custom.
  if (Math.abs(hours - 1) < 1e-9) return "1h";
  if (Math.abs(hours - 4) < 1e-9) return "4h";
  if (Math.abs(hours - 8) < 1e-9) return "8h";
  return "custom";
}

export function createOverUnderBotSettings(
  risk: OverUnderRiskCaps,
): BotSettings {
  // Default to Deriv minimum — never force the Differs “optimal” 1.75.
  const stake = 0.35;
  const barrier = 1;
  const oneWin = Number((stake * profitRate("DIGITOVER", barrier)).toFixed(2));
  return {
    prediction: barrier,
    martingaleMultiplier: 2,
    maxMartingaleSteps: 3,
    contracts: 1,
    stake,
    riskPercent: 0,
    maxExposurePercent: 2,
    takeProfit: Math.max(0.01, oneWin),
    takeProfitManual: false,
    stopLoss: Math.max(stake * 2, 0.7),
    maxRuns: 1,
    maxRunsManual: false,
    sessionHours: 0,
    running: false,
    dailyLossLimit: risk.dailyLossLimit,
    dailyProfitTarget: Math.max(0.01, oneWin),
    maxConsecutiveLosses: OVER_UNDER_MAX_CONSECUTIVE_LOSSES,
    maxTradesPerDay: Math.max(risk.maxTradesPerDay, 300),
    maxStake: Math.max(risk.maxStake, stake),
    ...OVER_UNDER_MODE,
    ...OVER_UNDER_GATES,
  };
}

function clampOuBarrier(
  side: "DIGITOVER" | "DIGITUNDER",
  prediction: number,
): number {
  const set =
    side === "DIGITUNDER" ? OU_UNDER_BARRIERS : OU_OVER_BARRIERS;
  if ((set as readonly number[]).includes(prediction)) return prediction;
  return side === "DIGITUNDER" ? 8 : 1;
}

export function applyOverUnderProfile(current: BotSettings): BotSettings {
  const pace = resolveAnalyzerPace("overunder-firm");
  const side =
    current.side === "DIGITUNDER" || current.side === "DIGITOVER"
      ? current.side
      : OVER_UNDER_MODE.side;
  const sessionHours = current.sessionHours ?? 0;
  const timed = sessionHours > 0;
  return {
    ...current,
    ...OVER_UNDER_MODE,
    ...OVER_UNDER_GATES,
    side,
    prediction: clampOuBarrier(side, current.prediction),
    analyzerPace: "overunder-firm",
    cooldownTicks: pace.cooldownTicks,
    maxConsecutiveLosses: OVER_UNDER_MAX_CONSECUTIVE_LOSSES,
    // Timed Custom/1h/4h/8h: keep unlimited runs (0). Never coerce 0 → 1.
    sessionHours,
    maxRuns: timed ? 0 : Math.max(1, current.maxRuns || 1),
    maxRunsManual: timed ? true : current.maxRunsManual === true,
    takeProfitManual: timed ? true : current.takeProfitManual === true,
    takeProfit: current.takeProfit,
    stopLoss: current.stopLoss,
    maxStake: Math.max(current.maxStake, current.stake),
    maxTradesPerDay: Math.max(current.maxTradesPerDay, 300),
    running: false,
  };
}

export function isOverUnderProfile(settings: BotSettings): boolean {
  const pace = resolveAnalyzerPace(settings.analyzerPace);
  return (
    (settings.side === "DIGITOVER" || settings.side === "DIGITUNDER") &&
    settings.autoFollow === true &&
    settings.martingale === false &&
    settings.analyzerPace === "overunder-firm" &&
    settings.cooldownTicks === pace.cooldownTicks &&
    settings.maxMomentumGap === OVER_UNDER_GATES.maxMomentumGap &&
    settings.minSample <= OVER_UNDER_GATES.minSample + 20 &&
    settings.requireTiming === true &&
    settings.skipLowConfidence === true &&
    settings.maxConsecutiveLosses === OVER_UNDER_MAX_CONSECUTIVE_LOSSES
  );
}

export function isOverUnderDeskTradeReady(
  signal: MarketSignal,
  settings: Pick<BotSettings, "minColdGap" | "minSample" | "side" | "maxMomentumGap">,
): boolean {
  return isAnalyzerGood(signal, settings);
}
