import { MIN_STAKE_PER_CONTRACT } from "./types";
import type {
  BacktestOptions,
  BacktestReport,
  Round,
  StopReason,
  Strategy,
} from "./types";

/** Money is compared and accumulated in cents to avoid float drift. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function defaultOptions(): BacktestOptions {
  return {
    payoutMultiplier: 9.4,
    startingBalance: 100,
    baseStake: 1,
    stakeMode: "split",
    martingale: null,
    risk: {
      maxStakePerRound: 50,
      dailyLossLimit: Number.POSITIVE_INFINITY,
      maxConsecutiveLosses: Number.POSITIVE_INFINITY,
      maxRounds: Number.POSITIVE_INFINITY,
    },
    warmup: 100,
  };
}

/**
 * Replays a strategy over a digit series.
 *
 * Every round buys DIGITMATCH on each selected digit for the same upcoming
 * tick. Exactly one digit can win, so a basket of n digits wins n/10 of the
 * time on fair data — but expected loss stays proportional to turnover, which
 * is the whole point of reporting `edgePerTurnover` alongside profit.
 */
export function runBacktest(
  digits: number[],
  strategy: Strategy,
  options: BacktestOptions,
): BacktestReport {
  const history: Round[] = [];
  let balance = options.startingBalance;
  let peakBalance = balance;
  let maxDrawdown = 0;
  let turnover = 0;
  let wins = 0;
  let consecutiveLosses = 0;
  let longestLossStreak = 0;
  let largestStakePlaced = 0;
  let currentStake = options.baseStake;
  let stopReason: StopReason = "completed";

  for (let index = options.warmup; index < digits.length; index += 1) {
    if (history.length >= options.risk.maxRounds) {
      stopReason = "maxRounds";
      break;
    }
    if (options.startingBalance - balance >= options.risk.dailyLossLimit) {
      stopReason = "dailyLossLimit";
      break;
    }
    if (consecutiveLosses >= options.risk.maxConsecutiveLosses) {
      stopReason = "maxConsecutiveLosses";
      break;
    }

    const selection = [
      ...new Set(strategy.select({ history: digits.slice(0, index), consecutiveLosses, balance })),
    ];
    if (selection.length === 0) continue;

    const stakePerContract = round2(
      options.stakeMode === "split" ? currentStake / selection.length : currentStake,
    );
    const totalStake = round2(stakePerContract * selection.length);

    // Deriv rejects contracts under its minimum, so a basket that slices the
    // stake too thinly is not a trade you could actually place.
    if (stakePerContract < MIN_STAKE_PER_CONTRACT) {
      stopReason = "stakeBelowMinimum";
      break;
    }
    if (totalStake > options.risk.maxStakePerRound) {
      stopReason = "stakeAboveCap";
      break;
    }
    if (totalStake > balance) {
      stopReason = "ruin";
      break;
    }

    const winningDigit = digits[index];
    const won = selection.includes(winningDigit);
    const payout = won ? round2(stakePerContract * options.payoutMultiplier) : 0;
    const profit = round2(payout - totalStake);

    balance = round2(balance + profit);
    turnover = round2(turnover + totalStake);
    largestStakePlaced = Math.max(largestStakePlaced, totalStake);

    if (won) {
      wins += 1;
      consecutiveLosses = 0;
      currentStake = options.baseStake;
    } else {
      consecutiveLosses += 1;
      longestLossStreak = Math.max(longestLossStreak, consecutiveLosses);
      if (options.martingale) {
        currentStake =
          consecutiveLosses >= options.martingale.resetAfterLosses
            ? options.baseStake
            : round2(currentStake * options.martingale.factor);
      }
    }

    peakBalance = Math.max(peakBalance, balance);
    maxDrawdown = Math.max(maxDrawdown, round2(peakBalance - balance));

    history.push({
      index,
      digits: selection,
      winningDigit,
      stakePerContract,
      totalStake,
      payout,
      profit,
      balance,
      won,
    });

    if (balance < MIN_STAKE_PER_CONTRACT) {
      stopReason = "ruin";
      break;
    }
  }

  const rounds = history.length;
  return {
    strategy: strategy.name,
    stakeMode: options.stakeMode,
    rounds,
    wins,
    winRate: rounds === 0 ? 0 : wins / rounds,
    turnover,
    netProfit: round2(balance - options.startingBalance),
    edgePerTurnover: turnover === 0 ? 0 : (balance - options.startingBalance) / turnover,
    finalBalance: balance,
    peakBalance,
    maxDrawdown,
    longestLossStreak,
    largestStakePlaced,
    stopReason,
    history,
  };
}
