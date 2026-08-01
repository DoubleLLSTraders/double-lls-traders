import { analyzerAllowsEntry } from "../analysis/analyzerGate";
import type { MarketSignal } from "../analysis/signal";
import { confirmScore, isArmedSignal } from "../analysis/signal";
import { isLowPayoutSymbol, profitRate } from "./performance";
import type { BotSettings } from "./types";

export type GateResult = { ok: true } | { ok: false; reason: string };

export type DoubtResult = { doubtful: false } | { doubtful: true; reason: string };

/**
 * Strict quality check for the *next* trade after a run has already started.
 *
 * Take-profit and max-runs are profit targets, not permission to keep firing
 * into a soft setup. Any of these flags means bank what you have and stop —
 * even after a single win.
 *
 * `requireFullConfidence` (default true for follow-up trades) demands the
 * analyzer's high tier — all five confirms green + power floor. Anything less
 * is treated as doubt, including a setup that merely "looks ok" on cold gap.
 */
export function nextTradeDoubt(
  settings: BotSettings,
  signal: MarketSignal,
  extras?: {
    coolBarrierDigit?: number | null;
    symbol?: string;
    /** When true (follow-up trades), only a fully armed high-confidence setup is allowed. */
    requireFullConfidence?: boolean;
  },
): DoubtResult {
  if (extras?.symbol && isLowPayoutSymbol(extras.symbol)) {
    return { doubtful: true, reason: `Doubt · ${extras.symbol} is a low-payout index` };
  }
  if (signal.watching.sampleSize < settings.minSample) {
    return {
      doubtful: true,
      reason: `Doubt · sample ${signal.watching.sampleSize}/${settings.minSample}`,
    };
  }
  if (signal.confidence !== "high") {
    return {
      doubtful: true,
      reason: `Doubt · confidence ${signal.confidence} · need high for next trade`,
    };
  }
  if (!signal.barrierAligned) {
    return {
      doubtful: true,
      reason:
        signal.side === "DIGITMATCH"
          ? `Doubt · Matches ${signal.digit} is not the hot pick`
          : `Doubt · Differs ${signal.digit} is not the cold barrier`,
    };
  }
  if (!signal.timingOk) {
    return {
      doubtful: true,
      reason:
        signal.side === "DIGITMATCH"
          ? `Doubt · momentum gap ${signal.watching.signalGap ?? "—"} > ${settings.maxMomentumGap}`
          : `Doubt · cold gap ${signal.watching.signalGap ?? "—"} < ${settings.minColdGap}`,
    };
  }
  if (signal.side === "DIGITDIFF") {
    if (!signal.coldMarginOk) {
      return {
        doubtful: true,
        reason: `Doubt · cold barrier too close (${signal.watching.separation || "—"})`,
      };
    }
    if (!signal.separationOk) {
      return {
        doubtful: true,
        reason: `Doubt · cold lead unclear (${signal.watching.separation || "—"})`,
      };
    }
    if (
      extras?.coolBarrierDigit !== null &&
      extras?.coolBarrierDigit !== undefined &&
      signal.digit === extras.coolBarrierDigit
    ) {
      return {
        doubtful: true,
        reason: `Doubt · Differs ${signal.digit} already lost this run`,
      };
    }
  }
  if (!signal.evOk) {
    return {
      doubtful: true,
      reason:
        signal.side === "DIGITDIFF"
          ? `Doubt · EV closed · ${signal.watching.wilsonBound || `${signal.digitPercent.toFixed(1)}%`}`
          : `Doubt · EV closed (${signal.digitPercent.toFixed(1)}%)`,
    };
  }
  if (!signal.windowsAgree) {
    return {
      doubtful: true,
      reason: `Doubt · windows disagree (${signal.watching.windowVotes || "—"})`,
    };
  }
  if (!signal.windowsEvOk) {
    return {
      doubtful: true,
      reason: `Doubt · multi-window EV (${signal.watching.windowEv || "—"})`,
    };
  }

  const score = confirmScore(signal);
  const needFull = extras?.requireFullConfidence !== false;
  if (needFull && !isArmedSignal(signal)) {
    return {
      doubtful: true,
      reason: `Doubt · confirms ${score}/5 · power ${signal.power} · need armed high`,
    };
  }
  return { doubtful: false };
}

/** Shared entry filters for paper + live bots and the analyzer UI. */
export function evaluateEntry(
  settings: BotSettings,
  signal: MarketSignal,
  extras?: {
    tradesLastHour?: number;
    drawdownPercent?: number;
    /** Barrier of the previous order, if it is still the standing pick. */
    lastEntryDigit?: number | null;
    /** True once that barrier has actually printed since the order went on. */
    lastEntryDigitPrinted?: boolean;
    /** After a Differs loss, skip re-backing until cold pick changes. */
    coolBarrierDigit?: number | null;
    /** Live balance, for the exposure ceiling. */
    balance?: number | null;
    /** Skip cheap-payout indices (worse EV for free). */
    symbol?: string;
  },
): GateResult {
  // Checked before anything else: when the account is too small to place a
  // legal basket inside the ceiling, no signal is worth acting on.
  const cap = exposureCap(settings, extras?.balance ?? null);
  if (cap && !cap.affordable) {
    const legs = Math.max(1, settings.contracts);
    const floor = Number((MIN_STAKE * legs).toFixed(2));
    return {
      ok: false,
      reason: `Skip · balance too small for ${settings.maxExposurePercent}% cap (${cap.budget}) · min stake ${floor}`,
    };
  }
  if (extras?.symbol && isLowPayoutSymbol(extras.symbol)) {
    return {
      ok: false,
      reason: `Switching · ${extras.symbol} low payout · picking a better index…`,
    };
  }
  if (signal.watching.sampleSize < settings.minSample) {
    return {
      ok: false,
      reason: `Skip · sample ${signal.watching.sampleSize}/${settings.minSample}`,
    };
  }

  // Digits Good / Trade now — hard lock. Warming/Building cannot buy.
  const analyzer = analyzerAllowsEntry(signal, settings);
  if (!analyzer.ok) {
    return { ok: false, reason: analyzer.reason.replace(/^Analyzer ·/, "Skip ·") };
  }

  if (settings.skipLowConfidence && signal.confidence !== "high") {
    return {
      ok: false,
      reason: `Skip · confidence ${signal.confidence} · need high`,
    };
  }

  const score = confirmScore(signal);

  if (settings.requireFullConfirm) {
    // Master switch: every layer green + high armed. Individual toggles below
    // are skipped — this already implies them.
    if (!isArmedSignal(signal)) {
      return {
        ok: false,
        reason: `Skip · confirms ${score}/5 · ${signal.confidence} · power ${signal.power}`,
      };
    }
  } else {
    // Each toggle is the only thing standing between the signal and an order,
    // so they are checked here rather than after the master switch. Running
    // them in both branches made the switches look live while doing nothing.
    if (!signal.evOk) {
      return {
        ok: false,
        reason:
          signal.side === "DIGITDIFF"
            ? `Skip · EV closed · ${signal.watching.wilsonBound || `${signal.digitPercent.toFixed(1)}%`}`
            : `Skip · EV closed (${signal.digitPercent.toFixed(1)}%)`,
      };
    }
    if (!signal.barrierAligned) {
      return {
        ok: false,
        reason:
          signal.side === "DIGITMATCH"
            ? `Skip · Matches ${signal.digit} is not the hot pick (hot: ${signal.watching.hot})`
            : `Skip · Differs ${signal.digit} is not the cold barrier (cold: ${signal.watching.cold})`,
      };
    }
    if (signal.side === "DIGITDIFF") {
      if (
        extras?.coolBarrierDigit !== null &&
        extras?.coolBarrierDigit !== undefined &&
        signal.digit === extras.coolBarrierDigit
      ) {
        return {
          ok: false,
          reason: `Skip · Differs ${signal.digit} hit last loss · wait for new cold pick`,
        };
      }
      // Lead / margin / windows live in analyzerAllowsEntry — Digits Good
      // already proved them; do not re-block and desync the desk.
    }
    if (settings.requireMultiWindow && !signal.windowsAgree) {
      return {
        ok: false,
        reason: `Skip · windows disagree (${signal.watching.windowVotes || "—"})`,
      };
    }
    if (settings.requireWindowsEv && !signal.windowsEvOk) {
      return {
        ok: false,
        reason: `Skip · multi-window EV (${signal.watching.windowEv || "—"})`,
      };
    }
    if (settings.requireTiming && !signal.timingOk) {
      return {
        ok: false,
        reason:
          // signal.side, not settings.side: on auto the setting trails by a
          // render and would label the skip with the wrong contract type.
          signal.side === "DIGITMATCH"
            ? `Skip · momentum gap ${signal.watching.signalGap ?? "—"} > ${settings.maxMomentumGap}`
            : `Skip · cold gap ${signal.watching.signalGap ?? "—"} < ${settings.minColdGap}`,
      };
    }
    if (settings.requireUneven && !signal.structureOk) {
      return { ok: false, reason: "Skip · window still looks fair (χ²)" };
    }
  }
  // One barrier, one bet. The coldest digit in a 1000-tick window barely moves,
  // so without this the bot re-backs the same digit on almost every tick:
  // scripts/diagnose-gate.ts measured 97.7% of consecutive orders sharing a
  // barrier, with one run of 1355. Those are not separate bets — they all hinge
  // on the same digit staying away, so a single print takes the whole run down
  // at once. Waiting for the barrier to print resets the question before asking
  // it again, which is what makes each order independent.
  if (
    extras?.lastEntryDigit !== null &&
    extras?.lastEntryDigit !== undefined &&
    extras.lastEntryDigit === signal.digit &&
    extras.lastEntryDigitPrinted === false
  ) {
    return {
      ok: false,
      reason: `Wait · re-backing ${signal.digit} after last order · need digit to print first`,
    };
  }
  if (
    settings.maxTradesPerHour > 0 &&
    (extras?.tradesLastHour ?? 0) >= settings.maxTradesPerHour
  ) {
    return {
      ok: false,
      reason: `Skip · max ${settings.maxTradesPerHour} trades/hour`,
    };
  }
  if (
    settings.maxDrawdownPercent > 0 &&
    (extras?.drawdownPercent ?? 0) >= settings.maxDrawdownPercent
  ) {
    return {
      ok: false,
      reason: `Skip · drawdown ${extras?.drawdownPercent?.toFixed(1)}% ≥ ${settings.maxDrawdownPercent}%`,
    };
  }
  return { ok: true };
}

export interface RecoveryPlan {
  /** Stake per contract for the next attempt. */
  stake: number;
  /** Total risked across the basket at that stake. */
  exposure: number;
  /** False when maxStake is too low for a win to clear the deficit. */
  enough: boolean;
}

/**
 * Size the next martingale rung from the payout rather than a blind multiplier.
 *
 * A fixed 2x only recovers when a win roughly doubles the stake. Differs pays
 * about 9% of exposure, so clearing a loss needs roughly 11x the exposure, not
 * 2x — with a fixed multiplier the ladder loses ground on every rung.
 */
export function recoveryStake(
  deficit: number,
  side: "DIGITMATCH" | "DIGITDIFF",
  contracts: number,
  baseStake: number,
  maxStake: number,
): RecoveryPlan {
  const legs = Math.max(1, contracts);
  const rate = profitRate(side);
  const baseProfit = baseStake * legs * rate;
  const needExposure = (deficit + baseProfit) / rate;
  const wanted = Number((needExposure / legs).toFixed(2));
  const stake = Math.max(baseStake, Math.min(maxStake, wanted));
  return {
    stake,
    exposure: Number((stake * legs).toFixed(2)),
    enough: wanted <= maxStake,
  };
}

export interface RecoveryRequirements {
  /** Max stake per contract needed to clear one full basket loss. */
  maxStake: number;
  /** Daily loss cap that still leaves room for that recovery basket. */
  dailyLossLimit: number;
  /** Total risked by the recovery basket. */
  exposure: number;
}

/**
 * Smallest caps that make a one-rung recovery actually possible.
 *
 * Differs only returns ~9% of exposure, so winning back a loss needs roughly
 * 12x that loss on the table. Reporting the number lets the form fill itself
 * instead of telling the user recovery is impossible.
 */
export function recoveryRequirements(
  settings: Pick<
    BotSettings,
    "stake" | "contracts" | "side" | "dailyLossLimit" | "maxStake"
  >,
): RecoveryRequirements {
  const legs = Math.max(1, settings.contracts);
  const risked = settings.stake * legs;
  const rate = profitRate(settings.side);
  const needExposure = (risked + risked * rate) / rate;
  const maxStake = Math.max(
    settings.stake,
    Number((Math.ceil((needExposure / legs) * 100) / 100).toFixed(2)),
  );
  const exposure = Number((maxStake * legs).toFixed(2));
  return {
    maxStake,
    dailyLossLimit: Math.ceil(exposure + risked),
    exposure,
  };
}

export function stakeFromRisk(
  settings: BotSettings,
  balance: number | null,
  maxStake: number,
): number {
  if (settings.riskPercent <= 0 || balance === null || balance <= 0) {
    return Math.min(maxStake, Math.max(MIN_STAKE, settings.stake));
  }
  const sized = Number(((balance * settings.riskPercent) / 100).toFixed(2));
  return Math.min(maxStake, Math.max(MIN_STAKE, sized));
}

/** Smallest stake Deriv will accept on a digit contract. */
export const MIN_STAKE = 0.35;

export interface ExposureCap {
  /** Largest stake per contract the cap allows. */
  stake: number;
  /** Currency the cap allows on the table at once. */
  budget: number;
  /** False when even one minimum-stake basket breaches the cap. */
  affordable: boolean;
}

/**
 * Ceiling on a single basket, expressed against live balance.
 *
 * maxStake alone could not prevent a wipeout: it is a fixed number, so as the
 * balance falls it becomes a larger and larger share of the account, and the
 * martingale ladder climbs toward it after every loss. A 5.00 basket against a
 * 5.50 balance is a coin-flip on the whole account, and Differs loses that flip
 * 10% of the time. Sizing the ceiling from the balance instead means the worst
 * single trade is always a known fraction of what is left.
 */
export function exposureCap(
  settings: Pick<BotSettings, "maxExposurePercent" | "contracts">,
  balance: number | null,
): ExposureCap | null {
  const percent = settings.maxExposurePercent;
  // Settings saved before this field existed read back as undefined. Left
  // unguarded that yields a NaN budget, which compares false against the
  // minimum stake and silently blocks every trade behind a "NaN" message.
  if (!Number.isFinite(percent) || percent <= 0) return null;
  if (balance === null || !Number.isFinite(balance) || balance <= 0) return null;
  const legs = Math.max(1, settings.contracts);
  const budget = Number(((balance * percent) / 100).toFixed(2));
  const perLeg = Math.floor((budget / legs) * 100) / 100;
  return {
    stake: Number(Math.max(MIN_STAKE, perLeg).toFixed(2)),
    budget,
    affordable: perLeg >= MIN_STAKE,
  };
}

/** Applies the balance cap to a proposed stake. Never raises it. */
export function capStake(
  stake: number,
  settings: Pick<BotSettings, "maxExposurePercent" | "contracts">,
  balance: number | null,
): number {
  const cap = exposureCap(settings, balance);
  if (!cap || !cap.affordable) return stake;
  return Math.min(stake, cap.stake);
}
