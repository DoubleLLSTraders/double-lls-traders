import { atrSeries, type Bar } from "./candles";

/** −1 short, 0 flat, +1 long. Must be computed from past bars only. */
export type Signal = -1 | 0 | 1;

export interface BacktestConfig {
  /** Stop distance = atrMult × ATR at the signal bar. */
  atrMult: number;
  /** Target distance = rMultiple × stop distance. */
  rMultiple: number;
  /** Round-trip dealing cost in price units. */
  spread: number;
  atrPeriod: number;
  /** Give up on a trade that has gone nowhere after this many bars. */
  maxHoldBars: number;
}

export interface BacktestResult {
  trades: number;
  wins: number;
  winRate: number;
  /** Average net result per trade, measured in units of risk (R). */
  expectancyR: number;
  totalR: number;
  profitFactor: number;
  maxDrawdownR: number;
  /** Average round-trip cost per trade in R — how big a hurdle costs are. */
  costR: number;
}

const EMPTY: BacktestResult = {
  trades: 0,
  wins: 0,
  winRate: 0,
  expectancyR: 0,
  totalR: 0,
  profitFactor: 0,
  maxDrawdownR: 0,
  costR: 0,
};

/**
 * Bar-by-bar simulator, deliberately pessimistic:
 *  - a signal on bar i is only acted on at bar i+1's open (no peeking),
 *  - both stop and target inside one bar counts as the stop,
 *  - the full round-trip spread is charged on every trade.
 */
export function runBacktest(
  bars: Bar[],
  signals: Signal[],
  config: BacktestConfig,
): BacktestResult {
  const atr = atrSeries(bars, config.atrPeriod);
  const results: number[] = [];
  const costs: number[] = [];
  let i = config.atrPeriod + 1;

  while (i < bars.length - 1) {
    const signal = signals[i] ?? 0;
    const risk = atr[i] * config.atrMult;
    if (signal === 0 || !Number.isFinite(risk) || risk <= 0) {
      i += 1;
      continue;
    }

    const long = signal === 1;
    const entryBar = bars[i + 1];
    const entry = long
      ? entryBar.open + config.spread / 2
      : entryBar.open - config.spread / 2;
    const stop = long ? entry - risk : entry + risk;
    const target = long
      ? entry + risk * config.rMultiple
      : entry - risk * config.rMultiple;

    let grossR: number | null = null;
    let exitIndex = i + 1;
    const lastBar = Math.min(bars.length - 1, i + 1 + config.maxHoldBars);
    for (let j = i + 1; j <= lastBar; j += 1) {
      const bar = bars[j];
      const stopHit = long ? bar.low <= stop : bar.high >= stop;
      const targetHit = long ? bar.high >= target : bar.low <= target;
      if (stopHit) {
        grossR = -1;
        exitIndex = j;
        break;
      }
      if (targetHit) {
        grossR = config.rMultiple;
        exitIndex = j;
        break;
      }
    }
    if (grossR === null) {
      // Timed out — mark to market at the last close we were allowed to hold.
      const exit = bars[lastBar].close;
      grossR = ((long ? exit - entry : entry - exit) / risk);
      exitIndex = lastBar;
    }

    const costR = config.spread / risk;
    results.push(grossR - costR);
    costs.push(costR);
    // No overlapping positions: resume scanning after the exit bar.
    i = exitIndex + 1;
  }

  if (results.length === 0) return EMPTY;

  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const r of results) {
    if (r > 0) {
      wins += 1;
      grossProfit += r;
    } else {
      grossLoss += -r;
    }
    equity += r;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const totalR = results.reduce((sum, r) => sum + r, 0);
  return {
    trades: results.length,
    wins,
    winRate: (wins / results.length) * 100,
    expectancyR: totalR / results.length,
    totalR,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit,
    maxDrawdownR: maxDrawdown,
    costR: costs.reduce((sum, c) => sum + c, 0) / costs.length,
  };
}
