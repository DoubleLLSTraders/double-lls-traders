/**
 * Compares Matches strategies over real tick history and over a fair random
 * control series.
 *
 *   npm run backtest -- --symbol R_100 --payout 9.4
 */
import { readFile } from "node:fs/promises";
import { runBacktest, defaultOptions } from "../src/lib/backtest/engine";
import { monteCarlo } from "../src/lib/backtest/monteCarlo";
import {
  afterStreak,
  coldestBasket,
  fairDigits,
  fixedBasket,
  hottestBasket,
  longestGapBasket,
  randomBasket,
} from "../src/lib/backtest/strategies";
import type { BacktestOptions, StakeMode, Strategy } from "../src/lib/backtest/types";

function arg(flag: string, fallback: string): string {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function money(value: number): string {
  return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

async function loadDigits(symbol: string): Promise<{ digits: number[]; source: string }> {
  try {
    const raw = await readFile(`data/${symbol}.json`, "utf8");
    const parsed = JSON.parse(raw) as { digits: number[] };
    return { digits: parsed.digits, source: `data/${symbol}.json` };
  } catch {
    console.log(`No data/${symbol}.json found — using a fair random series instead.`);
    console.log("Run `npm run fetch-ticks` first to test against real Deriv ticks.\n");
    return { digits: fairDigits(50_000), source: "synthetic fair random" };
  }
}

function reportRow(name: string, values: (string | number)[]): string {
  return [name.padEnd(20), ...values.map((value) => String(value).padStart(12))].join("");
}

async function main() {
  const symbol = arg("--symbol", "R_100");
  const payoutMultiplier = Number(arg("--payout", "9.4"));
  const { digits, source } = await loadDigits(symbol);

  // Large balance so early ruin does not truncate the sample and invent
  // fake edges. Small-account survival is measured separately below.
  const edgeOptions: BacktestOptions = {
    ...defaultOptions(),
    payoutMultiplier,
    startingBalance: 100_000,
    baseStake: 2,
    risk: {
      maxStakePerRound: 10_000,
      dailyLossLimit: Number.POSITIVE_INFINITY,
      maxConsecutiveLosses: Number.POSITIVE_INFINITY,
      maxRounds: Number.POSITIVE_INFINITY,
    },
  };

  console.log(`Source: ${source} (${digits.length} ticks)`);
  console.log(`Matches payout multiplier: ${payoutMultiplier}x  (fair would be 10x)`);
  console.log(`Theoretical edge per dollar staked: ${percent(payoutMultiplier / 10 - 1)}`);
  console.log("Any strategy that cannot beat -6% edge on fair data has no signal.\n");

  const strategies: Strategy[] = [
    fixedBasket([0, 1, 2, 3, 4]),
    randomBasket(5),
    hottestBasket(5),
    coldestBasket(5),
    longestGapBasket(5),
    fixedBasket([5]),
    hottestBasket(1),
    coldestBasket(1),
    afterStreak(2),
  ];

  for (const stakeMode of ["split", "perContract"] as StakeMode[]) {
    console.log(`\n=== Stake mode: ${stakeMode} (flat stake, $100k bankroll) ===`);
    console.log(
      reportRow("strategy", ["rounds", "win rate", "turnover", "net P&L", "edge/turn", "maxDD"]),
    );

    for (const strategy of strategies) {
      const report = runBacktest(digits, strategy, { ...edgeOptions, stakeMode });
      console.log(
        reportRow(strategy.name, [
          report.rounds,
          percent(report.winRate),
          money(report.turnover),
          money(report.netProfit),
          percent(report.edgePerTurnover),
          money(report.maxDrawdown),
        ]),
      );
    }
  }

  console.log("\n\n=== Martingale, 1000 sessions × 2000 rounds, $100 account ===");
  console.log("Basket of 5 digits, stake split, base stake $1.75 (Deriv min × 5).\n");
  console.log(
    reportRow("config", [
      "ruin rate",
      "in profit",
      "median end",
      "5th pct",
      "worst DD",
      "max streak",
    ]),
  );

  const smallAccount: BacktestOptions = {
    ...edgeOptions,
    startingBalance: 100,
    baseStake: 1.75,
    risk: { ...edgeOptions.risk, maxStakePerRound: 1000 },
  };

  const martingaleConfigs = [
    { label: "flat stake", martingale: null },
    { label: "x2 after loss", martingale: { factor: 2, resetAfterLosses: 99 } },
    { label: "x2 reset at 5", martingale: { factor: 2, resetAfterLosses: 5 } },
    { label: "x1.5 after loss", martingale: { factor: 1.5, resetAfterLosses: 99 } },
  ];

  for (const { label, martingale } of martingaleConfigs) {
    const result = monteCarlo(
      fixedBasket([0, 1, 2, 3, 4]),
      { ...smallAccount, stakeMode: "split", martingale },
      1000,
      2200,
    );
    console.log(
      reportRow(label, [
        percent(result.ruinRate),
        percent(result.profitableRate),
        money(result.medianFinalBalance),
        money(result.p5FinalBalance),
        money(result.worstDrawdown),
        result.longestLossStreak,
      ]),
    );
  }
}

main().catch((error: Error) => {
  console.error(error);
  process.exit(1);
});
