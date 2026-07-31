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
import { effectiveDiffMultiple, isLowPayoutSymbol } from "./performance";

/** Best measured Differs stake on R_75 (payout rounding). scripts/check-beststake */
export const LIVE_OPTIMAL_STAKE = 1.75;

/** Demo: auto runs from take-profit bank. Real micro: fixed cap per Start. */
export const REAL_MAX_RUNS = 2;

/** ~10 wins at 1.75 on R_75 — demo take-profit bank. */
export const DEMO_TAKE_PROFIT_WINS = 10;

/** @deprecated demo now uses runsForTakeProfit — kept for scripts/docs */
export const DEMO_MAX_RUNS = 0;

const EXPOSURE_CAP_PERCENT = 2;

export function liveWinPnl(stake: number, contracts: number): number {
  const legs = Math.max(1, contracts);
  const exposure = stake * legs;
  return Number((exposure * (effectiveDiffMultiple(stake) - 1)).toFixed(2));
}

/** Session take-profit from stake and win count. */
export function liveTakeProfit(
  stake: number,
  contracts: number,
  wins = DEMO_TAKE_PROFIT_WINS,
): number {
  const bank = liveWinPnl(stake, contracts) * wins;
  return Math.max(MIN_STAKE, Number(bank.toFixed(2)));
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

export function demoTakeProfit(stake: number, contracts: number): number {
  return Math.max(
    DIFFERS_FAST_TAKE_PROFIT,
    liveTakeProfit(stake, contracts, DEMO_TAKE_PROFIT_WINS),
  );
}

/** Wins needed at this stake/basket to reach the take-profit target. */
export function runsForTakeProfit(
  takeProfit: number,
  stake: number,
  contracts: number,
): number {
  if (takeProfit <= 0) return 0;
  const winPnl = liveWinPnl(stake, contracts);
  if (winPnl <= 0) return 1;
  return Math.max(1, Math.ceil(takeProfit / winPnl));
}

export function expectedMaxRuns(
  settings: Pick<
    BotSettings,
    "takeProfit" | "takeProfitManual" | "stake" | "contracts"
  >,
  stake: number,
  isVirtual: boolean,
): number {
  if (!isVirtual) return REAL_MAX_RUNS;
  const takeProfit =
    settings.takeProfitManual === true && settings.takeProfit > 0
      ? settings.takeProfit
      : demoTakeProfit(stake, settings.contracts);
  return runsForTakeProfit(takeProfit, stake, settings.contracts);
}

/** Keep user stake when valid; widen demo cap instead of clamping manual stake down. */
export function resolveLiveStake(
  settings: Pick<BotSettings, "stake" | "contracts" | "maxExposurePercent">,
  balance: number,
  isVirtual: boolean,
): { stake: number; maxExposurePercent: number } {
  const legs = Math.max(1, settings.contracts);
  const plan = planLiveStake(balance, settings.contracts, isVirtual);

  // Micro real balance: stake is balance-sized, not free-form.
  if (!isVirtual && plan.maxExposurePercent === 0) {
    return { stake: plan.stake, maxExposurePercent: 0 };
  }

  let stake = Math.max(MIN_STAKE, settings.stake);
  let maxExposurePercent = settings.maxExposurePercent;

  if (balance > 0) {
    const neededPercent = Number(((stake * legs) / balance * 100).toFixed(2));
    if (isVirtual && neededPercent > maxExposurePercent) {
      maxExposurePercent = neededPercent;
    } else if (maxExposurePercent > 0) {
      const maxByCap =
        Math.floor(((balance * maxExposurePercent) / 100 / legs) * 100) / 100;
      if (maxByCap >= MIN_STAKE && stake > maxByCap) {
        stake = maxByCap;
      }
    }
  }

  return {
    stake: Number(stake.toFixed(2)),
    maxExposurePercent,
  };
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
): Pick<
  BotSettings,
  "takeProfit" | "stopLoss" | "dailyProfitTarget" | "dailyLossLimit" | "maxRuns"
> {
  const takeProfit =
    takeProfitOverride !== undefined && takeProfitOverride > 0
      ? takeProfitOverride
      : isVirtual
        ? demoTakeProfit(stake, contracts)
        : liveTakeProfit(stake, contracts, REAL_MAX_RUNS);
  const stopLoss = Number((stake * 2).toFixed(2));
  const dailyLossLimit = Math.max(stopLoss, Number((stake * 3).toFixed(2)), 5);
  const maxRuns = isVirtual
    ? runsForTakeProfit(takeProfit, stake, contracts)
    : REAL_MAX_RUNS;
  return {
    takeProfit,
    stopLoss,
    dailyLossLimit,
    dailyProfitTarget: takeProfit,
    maxRuns,
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
  const limits = profitLimitsForStake(
    stake,
    settings.contracts,
    isVirtual,
    settings.takeProfitManual === true ? settings.takeProfit : undefined,
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

  if (settings.maxRuns !== expectedRuns) {
    patch.maxRuns = expectedRuns;
  }

  if (!opts?.lockStake) {
    patch.stake = stake;
    patch.maxExposurePercent = maxExposurePercent;
    patch.maxStake = Math.max(settings.maxStake, stake);
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
  const limits = profitLimitsForStake(stake, contracts, isVirtual);
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
  const expectedTp = isVirtual
    ? demoTakeProfit(stake, settings.contracts)
    : liveTakeProfit(stake, settings.contracts, REAL_MAX_RUNS);
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
