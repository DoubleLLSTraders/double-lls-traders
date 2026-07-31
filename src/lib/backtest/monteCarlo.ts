import { runBacktest } from "./engine";
import { fairDigits } from "./strategies";
import type { BacktestOptions, Strategy } from "./types";

export interface MonteCarloResult {
  strategy: string;
  runs: number;
  ticksPerRun: number;
  /** Share of runs that ended broke or unable to place the next stake. */
  ruinRate: number;
  /** Share of runs that finished in profit — high here does not mean good. */
  profitableRate: number;
  meanFinalBalance: number;
  medianFinalBalance: number;
  p5FinalBalance: number;
  p95FinalBalance: number;
  meanEdgePerTurnover: number;
  worstDrawdown: number;
  longestLossStreak: number;
}

function quantile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * Replays a strategy across many independent fair digit series.
 *
 * A single backtest says almost nothing about a martingale: most sessions end
 * green because the blow-up is rare and enormous. Only the distribution across
 * many runs shows the real shape, which is why ruin rate is reported next to
 * the headline "profitable" percentage.
 */
export function monteCarlo(
  strategy: Strategy,
  options: BacktestOptions,
  runs = 1000,
  ticksPerRun = 5000,
  seed = 1,
): MonteCarloResult {
  const finalBalances: number[] = [];
  let ruined = 0;
  let profitable = 0;
  let edgeTotal = 0;
  let edgeSamples = 0;
  let worstDrawdown = 0;
  let longestLossStreak = 0;

  for (let run = 0; run < runs; run += 1) {
    const report = runBacktest(fairDigits(ticksPerRun, seed + run), strategy, options);

    finalBalances.push(report.finalBalance);
    if (report.stopReason === "ruin" || report.stopReason === "stakeBelowMinimum") ruined += 1;
    if (report.netProfit > 0) profitable += 1;
    if (report.turnover > 0) {
      edgeTotal += report.edgePerTurnover;
      edgeSamples += 1;
    }
    worstDrawdown = Math.max(worstDrawdown, report.maxDrawdown);
    longestLossStreak = Math.max(longestLossStreak, report.longestLossStreak);
  }

  const sorted = [...finalBalances].sort((a, b) => a - b);
  return {
    strategy: strategy.name,
    runs,
    ticksPerRun,
    ruinRate: ruined / runs,
    profitableRate: profitable / runs,
    meanFinalBalance: finalBalances.reduce((total, value) => total + value, 0) / runs,
    medianFinalBalance: quantile(sorted, 0.5),
    p5FinalBalance: quantile(sorted, 0.05),
    p95FinalBalance: quantile(sorted, 0.95),
    meanEdgePerTurnover: edgeSamples === 0 ? 0 : edgeTotal / edgeSamples,
    worstDrawdown,
    longestLossStreak,
  };
}
