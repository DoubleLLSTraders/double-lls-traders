/**
 * Sanity checks for the simulation engine against properties we can compute
 * by hand. Failures here mean the backtester itself is lying.
 */
import { runBacktest, defaultOptions } from "../src/lib/backtest/engine";
import { fairDigits, fixedBasket } from "../src/lib/backtest/strategies";
import type { BacktestOptions } from "../src/lib/backtest/types";

let failures = 0;

function check(label: string, ok: boolean, detail: string) {
  console.log(`${ok ? "OK  " : "FAIL"} ${label} — ${detail}`);
  if (!ok) failures += 1;
}

const digits = fairDigits(50_000, 42);
const basket = fixedBasket([0, 1, 2, 3, 4]);

const fairOptions: BacktestOptions = {
  ...defaultOptions(),
  payoutMultiplier: 10,
  startingBalance: 10_000,
  baseStake: 10,
  stakeMode: "split",
  warmup: 0,
  risk: {
    maxStakePerRound: 10_000,
    dailyLossLimit: Number.POSITIVE_INFINITY,
    maxConsecutiveLosses: Number.POSITIVE_INFINITY,
    maxRounds: Number.POSITIVE_INFINITY,
  },
};

const fair = runBacktest(digits, basket, fairOptions);
check(
  "fair payout, edge near zero",
  Math.abs(fair.edgePerTurnover) < 0.02,
  `edge = ${(fair.edgePerTurnover * 100).toFixed(3)}%`,
);
check(
  "5-digit basket wins ~50%",
  Math.abs(fair.winRate - 0.5) < 0.02,
  `win rate = ${(fair.winRate * 100).toFixed(2)}%`,
);

const house = runBacktest(digits, basket, { ...fairOptions, payoutMultiplier: 9.4 });
check(
  "9.4x payout, edge near -6%",
  Math.abs(house.edgePerTurnover + 0.06) < 0.02,
  `edge = ${(house.edgePerTurnover * 100).toFixed(3)}%`,
);

// Cap both modes to the same number of rounds so early ruin in the heavier
// mode cannot masquerade as a different edge.
const matchedRounds: BacktestOptions = {
  ...fairOptions,
  payoutMultiplier: 9.4,
  startingBalance: 1_000_000,
  risk: { ...fairOptions.risk, maxRounds: 10_000 },
};
const split = runBacktest(digits, basket, { ...matchedRounds, stakeMode: "split" });
const perContract = runBacktest(digits, basket, { ...matchedRounds, stakeMode: "perContract" });
check(
  "split and perContract share the same edge",
  Math.abs(split.edgePerTurnover - perContract.edgePerTurnover) < 0.005,
  `split ${(split.edgePerTurnover * 100).toFixed(3)}% vs perContract ${(perContract.edgePerTurnover * 100).toFixed(3)}%`,
);
check(
  "perContract turns over ~5× more than split",
  Math.abs(perContract.turnover / split.turnover - 5) < 0.05,
  `ratio = ${(perContract.turnover / split.turnover).toFixed(3)}`,
);
check(
  "perContract loses ~5× more dollars than split",
  Math.abs(perContract.netProfit / split.netProfit - 5) < 0.3,
  `ratio = ${(perContract.netProfit / split.netProfit).toFixed(3)}`,
);

const single = runBacktest(digits, fixedBasket([7]), {
  ...fairOptions,
  stakeMode: "perContract",
  payoutMultiplier: 9.4,
});
check(
  "single Matches wins ~10%",
  Math.abs(single.winRate - 0.1) < 0.015,
  `win rate = ${(single.winRate * 100).toFixed(2)}%`,
);

const martingale = runBacktest(digits, basket, {
  ...fairOptions,
  payoutMultiplier: 9.4,
  stakeMode: "split",
  baseStake: 2,
  startingBalance: 100,
  martingale: { factor: 2, resetAfterLosses: 99 },
});
check(
  "unbounded martingale eventually ruins a small account",
  martingale.stopReason === "ruin" || martingale.stopReason === "stakeAboveCap",
  `stop = ${martingale.stopReason}, final = $${martingale.finalBalance.toFixed(2)}, max stake = $${martingale.largestStakePlaced.toFixed(2)}`,
);

console.log("");
if (failures === 0) {
  console.log("All engine checks passed.");
} else {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
