import type { ContractSide } from "../analysis/signal";
import type { BotSettings } from "./types";
import { MIN_STAKE } from "./gates";
import {
  applyDiffersFastProfile,
  DIFFERS_FAST_SYMBOL,
  DIFFERS_FAST_MAX_CONSECUTIVE_LOSSES,
  DIFFERS_FAST_GATES,
  DIFFERS_FAST_TAKE_PROFIT,
  DIFFERS_R75_BREAK_EVEN_WIN_PCT,
  LIVE_DIFFERS_QUALITY_GATES,
  isDiffersLiveQuality,
} from "./differsProfile";
import {
  effectiveDiffMultiple,
  isLowPayoutSymbol,
  MATCH_PAYOUT_MULTIPLIER,
  profitRate,
} from "./performance";

/** Best measured Differs stake on R_75 (payout rounding). scripts/check-beststake */
export const LIVE_OPTIMAL_STAKE = 1.75;

/** Demo/real: one armed trade then bank — deep gate refuses follow-ups. */
export const REAL_MAX_RUNS = 1;

/** One win at stake, then stop — pressing after a win is where streaks die. */
export const DEMO_TAKE_PROFIT_WINS = 1;

/** @deprecated demo now uses runsForTakeProfit — kept for scripts/docs */
export const DEMO_MAX_RUNS = 0;

const EXPOSURE_CAP_PERCENT = 2;

/** Side + barrier for payout-aware win / take-profit math. */
export interface ContractPayoutCtx {
  side?: ContractSide;
  barrier?: number;
}

function isOverUnderSide(side: ContractSide | undefined): boolean {
  return side === "DIGITOVER" || side === "DIGITUNDER";
}

export function payoutCtxFromSettings(
  settings: Pick<BotSettings, "side" | "prediction">,
): ContractPayoutCtx {
  return { side: settings.side, barrier: settings.prediction };
}

/**
 * Profit on one winning basket.
 * Differs uses the stake→cent-rounding curve; Over/Under / Matches use barrier payouts.
 */
export function liveWinPnl(
  stake: number,
  contracts: number,
  ctx: ContractPayoutCtx = {},
): number {
  const legs = Math.max(1, contracts);
  const exposure = stake * legs;
  if (isOverUnderSide(ctx.side)) {
    const rate = profitRate(ctx.side!, ctx.barrier ?? 1);
    return Number((exposure * rate).toFixed(2));
  }
  if (ctx.side === "DIGITMATCH") {
    return Number((exposure * (MATCH_PAYOUT_MULTIPLIER - 1)).toFixed(2));
  }
  return Number((exposure * (effectiveDiffMultiple(stake) - 1)).toFixed(2));
}

/** Session take-profit from stake and win count (actual payout profit — no MIN_STAKE floor). */
export function liveTakeProfit(
  stake: number,
  contracts: number,
  wins = DEMO_TAKE_PROFIT_WINS,
  ctx: ContractPayoutCtx = {},
): number {
  const bank = liveWinPnl(stake, contracts, ctx) * wins;
  // High-hit OU barriers (e.g. Under 9 ×1.09) profit ~0.03 on a 0.35 stake.
  // Flooring at MIN_STAKE (0.35) was inventing a fake TP and ~12 "auto" runs.
  if (bank <= 0) return Number(MIN_STAKE.toFixed(2));
  return Number(bank.toFixed(2));
}

export interface LiveStakePlan {
  stake: number;
  maxExposurePercent: number;
  note: string;
}

export function planLiveStake(
  balance: number | null,
  contracts: number,
  isVirtual = true,
): LiveStakePlan {
  const legs = Math.max(1, contracts);
  const minBasket = MIN_STAKE * legs;

  if (balance === null || balance <= 0) {
    return {
      stake: isVirtual ? LIVE_OPTIMAL_STAKE : MIN_STAKE,
      maxExposurePercent: isVirtual ? EXPOSURE_CAP_PERCENT : 0,
      note: "Waiting for balance · default stake until loaded",
    };
  }

  if (isVirtual && balance >= LIVE_OPTIMAL_STAKE) {
    return {
      stake: LIVE_OPTIMAL_STAKE,
      maxExposurePercent: EXPOSURE_CAP_PERCENT,
      note: `Demo · ${LIVE_OPTIMAL_STAKE.toFixed(2)} stake · 2% cap · take profit stop`,
    };
  }

  const budget = Number(((balance * EXPOSURE_CAP_PERCENT) / 100).toFixed(2));
  const perLegCap = Math.floor((budget / legs) * 100) / 100;

  if (perLegCap >= LIVE_OPTIMAL_STAKE) {
    return {
      stake: LIVE_OPTIMAL_STAKE,
      maxExposurePercent: EXPOSURE_CAP_PERCENT,
      note: `2% cap allows ${LIVE_OPTIMAL_STAKE.toFixed(2)} stake`,
    };
  }

  if (perLegCap >= MIN_STAKE) {
    return {
      stake: perLegCap,
      maxExposurePercent: EXPOSURE_CAP_PERCENT,
      note: `2% cap sizes stake to ${perLegCap.toFixed(2)}`,
    };
  }

  const stake =
    balance >= LIVE_OPTIMAL_STAKE
      ? LIVE_OPTIMAL_STAKE
      : balance >= minBasket
        ? MIN_STAKE
        : MIN_STAKE;

  return {
    stake,
    maxExposurePercent: 0,
    note: `Small balance ${balance.toFixed(2)} · stake ${stake.toFixed(2)} · cap off`,
  };
}

export function demoTakeProfit(
  stake: number,
  contracts: number,
  ctx: ContractPayoutCtx = {},
): number {
  const oneWin = liveTakeProfit(stake, contracts, DEMO_TAKE_PROFIT_WINS, ctx);
  // Over/Under / Matches: TP = one real win at this barrier payout.
  if (isOverUnderSide(ctx.side) || ctx.side === "DIGITMATCH") {
    return oneWin;
  }
  return Math.max(DIFFERS_FAST_TAKE_PROFIT, oneWin);
}

/** Wins needed at this stake/basket to reach the take-profit target. */
export function runsForTakeProfit(
  takeProfit: number,
  stake: number,
  contracts: number,
  ctx: ContractPayoutCtx = {},
): number {
  if (takeProfit <= 0) return 0;
  const winPnl = liveWinPnl(stake, contracts, ctx);
  if (winPnl <= 0) return 1;
  return Math.max(1, Math.ceil(takeProfit / winPnl));
}

export function expectedMaxRuns(
  settings: Pick<
    BotSettings,
    | "takeProfit"
    | "takeProfitManual"
    | "stake"
    | "contracts"
    | "side"
    | "prediction"
    | "maxRunsManual"
    | "maxRuns"
  >,
  stake: number,
  isVirtual: boolean,
): number {
  if (settings.maxRunsManual === true) {
    return Math.max(0, settings.maxRuns);
  }
  // Real live Differs stays one-and-done; OU/Matches may keep demo-style flow on virtual.
  if (!isVirtual && settings.side === "DIGITDIFF") return REAL_MAX_RUNS;
  if (!isVirtual && isOverUnderSide(settings.side)) {
    return Math.max(1, settings.maxRuns || REAL_MAX_RUNS);
  }
  const ctx = payoutCtxFromSettings(settings);
  const takeProfit =
    settings.takeProfitManual === true && settings.takeProfit > 0
      ? settings.takeProfit
      : demoTakeProfit(stake, settings.contracts, ctx);
  return runsForTakeProfit(takeProfit, stake, settings.contracts, ctx);
}

/**
 * Keep the Base stake from the bot form.
 * Demo and real live: never raise to 1.75, never balance-size away from
 * the typed amount. Only floor at Deriv minimum; widen exposure so the
 * stake stays allowed under the 2% helper cap.
 */
export function resolveLiveStake(
  settings: Pick<BotSettings, "stake" | "contracts" | "maxExposurePercent">,
  balance: number,
  _isVirtual: boolean,
): { stake: number; maxExposurePercent: number } {
  const legs = Math.max(1, settings.contracts);
  const stake = Number(Math.max(MIN_STAKE, settings.stake).toFixed(2));
  let maxExposurePercent = settings.maxExposurePercent;

  if (balance > 0) {
    const neededPercent = Number(((stake * legs) / balance * 100).toFixed(2));
    if (neededPercent > maxExposurePercent) {
      maxExposurePercent = neededPercent;
    }
  }

  return { stake, maxExposurePercent };
}

/** @deprecated use resolveLiveStake */
export function clampLiveStake(
  settings: BotSettings,
  balance: number,
  isVirtual: boolean,
): number {
  return resolveLiveStake(settings, balance, isVirtual).stake;
}

export function profitLimitsForStake(
  stake: number,
  contracts: number,
  isVirtual: boolean,
  takeProfitOverride?: number,
  ctx: ContractPayoutCtx = {},
  opts?: { preserveMaxRuns?: number },
): Pick<
  BotSettings,
  "takeProfit" | "stopLoss" | "dailyProfitTarget" | "dailyLossLimit" | "maxRuns"
> {
  const takeProfit =
    takeProfitOverride !== undefined && takeProfitOverride > 0
      ? takeProfitOverride
      : isVirtual
        ? demoTakeProfit(stake, contracts, ctx)
        : liveTakeProfit(stake, contracts, REAL_MAX_RUNS, ctx);
  const stopLoss = Number((stake * 2).toFixed(2));
  const dailyLossLimit = Math.max(stopLoss, Number((stake * 3).toFixed(2)), 5);
  const maxRuns =
    opts?.preserveMaxRuns !== undefined
      ? opts.preserveMaxRuns
      : !isVirtual && ctx.side === "DIGITDIFF"
        ? REAL_MAX_RUNS
        : runsForTakeProfit(takeProfit, stake, contracts, ctx);
  return {
    takeProfit,
    stopLoss,
    dailyLossLimit,
    dailyProfitTarget: takeProfit,
    maxRuns,
  };
}

/** Recompute TP / SL / runs from the current Over/Under (or Differs) payout. */
export function withContractMoneyLimits(
  settings: BotSettings,
  isVirtual: boolean,
): BotSettings {
  const timed = (settings.sessionHours ?? 0) > 0;
  const ctx = payoutCtxFromSettings(settings);
  const limits = profitLimitsForStake(
    settings.stake,
    settings.contracts,
    isVirtual,
    timed || settings.takeProfitManual === true
      ? settings.takeProfit
      : undefined,
    ctx,
    timed || settings.maxRunsManual === true
      ? { preserveMaxRuns: settings.maxRuns }
      : undefined,
  );
  return {
    ...settings,
    ...limits,
    // Timed hour: keep user's TP as comfort only; clock owns the stop.
    takeProfit:
      timed || settings.takeProfitManual === true
        ? settings.takeProfit
        : limits.takeProfit,
    takeProfitManual: timed ? true : settings.takeProfitManual,
    // Timed Custom / bulk clock: never shrink the form SL back to stake×2 —
    // that was ending 7m sessions in ~90s after a couple of thin-pay losses.
    stopLoss: timed
      ? Math.max(settings.stopLoss, limits.stopLoss, settings.stake * 4)
      : settings.stopLoss > 0
        ? Math.max(settings.stopLoss, limits.stopLoss)
        : limits.stopLoss,
    // Timed Custom / hour cards always unlimited runs — never keep a stale 1.
    maxRuns: timed
      ? 0
      : settings.maxRunsManual === true
        ? settings.maxRuns
        : limits.maxRuns,
    maxRunsManual: timed ? true : settings.maxRunsManual,
    sessionHours: settings.sessionHours ?? 0,
    dailyLossLimit: Math.max(
      settings.dailyLossLimit,
      limits.dailyLossLimit,
      timed ? settings.stake * 8 : 0,
    ),
    dailyProfitTarget: timed
      ? 0
      : settings.takeProfitManual === true
        ? Math.max(settings.dailyProfitTarget, settings.takeProfit)
        : limits.dailyProfitTarget,
  };
}

/** Patch caps / take-profit when balance or stake changes (respects manual stake on demo). */
export function liveSettingsForBalance(
  settings: BotSettings,
  balance: number | null,
  isVirtual = true,
  opts?: { lockStake?: boolean },
): Partial<BotSettings> | null {
  if (balance === null || balance <= 0) return null;
  const { stake, maxExposurePercent } = resolveLiveStake(
    settings,
    balance,
    isVirtual,
  );
  const ctx = payoutCtxFromSettings(settings);
  const limits = profitLimitsForStake(
    stake,
    settings.contracts,
    isVirtual,
    settings.takeProfitManual === true ? settings.takeProfit : undefined,
    ctx,
    settings.maxRunsManual === true
      ? { preserveMaxRuns: settings.maxRuns }
      : undefined,
  );
  const expectedRuns = expectedMaxRuns(
    {
      ...settings,
      takeProfit: limits.takeProfit,
      stake,
    },
    stake,
    isVirtual,
  );

  const stakeOk = Math.abs(settings.stake - stake) < 0.001;
  const exposureOk = settings.maxExposurePercent === maxExposurePercent;
  const runsOk = settings.maxRuns === expectedRuns;
  const tpOk =
    settings.takeProfitManual === true ||
    Math.abs(settings.takeProfit - limits.takeProfit) < 0.15;
  const slOk = Math.abs(settings.stopLoss - limits.stopLoss) < 0.15;

  if (stakeOk && exposureOk && runsOk && tpOk && slOk) return null;

  const patch: Partial<BotSettings> = {
    dailyLossLimit: Math.max(
      settings.dailyLossLimit,
      limits.dailyLossLimit,
    ),
  };

  if (settings.maxRunsManual !== true && settings.maxRuns !== expectedRuns) {
    patch.maxRuns = expectedRuns;
  }

  if (!opts?.lockStake) {
    patch.stake = stake;
    patch.maxStake = Math.max(settings.maxStake, stake);
  }
  // Always widen exposure so capStake cannot shrink the form stake.
  if (!exposureOk) {
    patch.maxExposurePercent = maxExposurePercent;
  }

  if (settings.takeProfitManual !== true) {
    patch.takeProfit = limits.takeProfit;
    patch.dailyProfitTarget = limits.dailyProfitTarget;
  }
  if (!slOk) {
    patch.stopLoss = limits.stopLoss;
  }

  return patch;
}

/** Demo or real live preset. Demo runs until take-profit; real uses capped runs. */
export function applyLiveTradingProfile(
  current: BotSettings,
  balance: number | null,
  isVirtual = true,
  opts?: { preserveStake?: boolean },
): BotSettings {
  const contracts = opts?.preserveStake
    ? Math.max(1, Math.floor(current.contracts))
    : 1;
  const plan = planLiveStake(balance, contracts, isVirtual);
  const resolved =
    opts?.preserveStake
      ? balance !== null
        ? resolveLiveStake({ ...current, contracts }, balance, isVirtual)
        : {
            stake: current.stake,
            maxExposurePercent: current.maxExposurePercent,
          }
      : balance !== null
        ? { stake: plan.stake, maxExposurePercent: plan.maxExposurePercent }
        : {
            stake: current.stake,
            maxExposurePercent: plan.maxExposurePercent,
          };
  const { stake, maxExposurePercent } = resolved;
  const ctx = payoutCtxFromSettings({ ...current, side: "DIGITDIFF" });
  const limits = profitLimitsForStake(stake, contracts, isVirtual, undefined, ctx);
  const gates = isVirtual ? DIFFERS_FAST_GATES : LIVE_DIFFERS_QUALITY_GATES;

  return {
    ...applyDiffersFastProfile(current),
    ...gates,
    contracts,
    stake,
    riskPercent: 0,
    maxExposurePercent,
    maxStake: Math.max(current.maxStake, stake, LIVE_OPTIMAL_STAKE),
    ...limits,
    takeProfitManual: false,
    maxRunsManual: false,
    maxConsecutiveLosses: DIFFERS_FAST_MAX_CONSECUTIVE_LOSSES,
    maxTradesPerDay: 60,
    running: false,
  };
}

export function isLiveTradingProfile(
  settings: BotSettings,
  balance: number | null,
  isVirtual = true,
): boolean {
  const { stake, maxExposurePercent } =
    balance === null
      ? { stake: settings.stake, maxExposurePercent: settings.maxExposurePercent }
      : resolveLiveStake(settings, balance, isVirtual);
  const ctx = payoutCtxFromSettings(settings);
  const expectedTp = isVirtual
    ? demoTakeProfit(stake, settings.contracts, ctx)
    : liveTakeProfit(stake, settings.contracts, REAL_MAX_RUNS, ctx);
  const expectedRuns = expectedMaxRuns(settings, stake, isVirtual);
  const gatesOk = isVirtual
    ? settings.minColdGap === DIFFERS_FAST_GATES.minColdGap &&
      settings.minSample === DIFFERS_FAST_GATES.minSample
    : isDiffersLiveQuality(settings);

  return (
    settings.side === "DIGITDIFF" &&
    settings.autoSide === false &&
    settings.autoFollow === true &&
    settings.duration === 1 &&
    settings.riskPercent === 0 &&
    settings.martingale === false &&
    gatesOk &&
    settings.maxConsecutiveLosses === DIFFERS_FAST_MAX_CONSECUTIVE_LOSSES &&
    settings.maxRuns === expectedRuns &&
    (settings.takeProfitManual === true ||
      Math.abs(settings.takeProfit - expectedTp) < 0.15) &&
    Math.abs(settings.stake - stake) < 0.02 &&
    settings.maxExposurePercent === maxExposurePercent
  );
}

export { DIFFERS_FAST_SYMBOL, DIFFERS_R75_BREAK_EVEN_WIN_PCT, isLowPayoutSymbol };
