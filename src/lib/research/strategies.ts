import type { Bar } from "./candles";
import type { Signal } from "./backtest";

export interface StrategyRun {
  /** Human label including the parameters used. */
  label: string;
  params: Record<string, number>;
  signals: Signal[];
}

export interface Strategy {
  name: string;
  /** Every parameter combination worth testing. */
  runs(bars: Bar[]): StrategyRun[];
}

function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i];
  out[period - 1] = seed / period;
  for (let i = period; i < values.length; i += 1) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function stdev(values: number[], period: number, means: number[]): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  for (let i = period - 1; i < values.length; i += 1) {
    const mean = means[i];
    if (!Number.isFinite(mean)) continue;
    let acc = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      acc += (values[j] - mean) ** 2;
    }
    out[i] = Math.sqrt(acc / period);
  }
  return out;
}

/**
 * Trend continuation: trade in the direction of the faster average once it
 * is on the trend side of the slower one. The classic hypothesis that price
 * moves persist — the one thing a random generator can never show.
 */
export const trendStrategy: Strategy = {
  name: "EMA trend",
  runs(bars) {
    const closes = bars.map((bar) => bar.close);
    const out: StrategyRun[] = [];
    for (const fast of [12, 20, 34]) {
      for (const slow of [50, 100, 200]) {
        if (fast >= slow) continue;
        const fastLine = ema(closes, fast);
        const slowLine = ema(closes, slow);
        const signals: Signal[] = bars.map((_, i) => {
          const f = fastLine[i];
          const s = slowLine[i];
          const prevF = fastLine[i - 1];
          const prevS = slowLine[i - 1];
          if (
            !Number.isFinite(f) ||
            !Number.isFinite(s) ||
            !Number.isFinite(prevF) ||
            !Number.isFinite(prevS)
          ) {
            return 0;
          }
          // Only the crossing bar signals, so one trade per swing.
          if (prevF <= prevS && f > s) return 1;
          if (prevF >= prevS && f < s) return -1;
          return 0;
        });
        out.push({
          label: `EMA ${fast}/${slow}`,
          params: { fast, slow },
          signals,
        });
      }
    }
    return out;
  },
};

/**
 * Breakout: a close beyond the highest high / lowest low of the last N bars.
 * Tests whether ranges expanding in one direction keep going.
 */
export const breakoutStrategy: Strategy = {
  name: "Donchian breakout",
  runs(bars) {
    const out: StrategyRun[] = [];
    for (const lookback of [20, 40, 55]) {
      const signals: Signal[] = bars.map((bar, i) => {
        if (i < lookback) return 0;
        let highest = -Infinity;
        let lowest = Infinity;
        for (let j = i - lookback; j < i; j += 1) {
          highest = Math.max(highest, bars[j].high);
          lowest = Math.min(lowest, bars[j].low);
        }
        if (bar.close > highest) return 1;
        if (bar.close < lowest) return -1;
        return 0;
      });
      out.push({
        label: `Donchian ${lookback}`,
        params: { lookback },
        signals,
      });
    }
    return out;
  },
};

/**
 * Mean reversion: price stretched far from its own average snaps back.
 * The opposite hypothesis to trend — one of them may fit a given market.
 */
export const reversionStrategy: Strategy = {
  name: "Mean reversion",
  runs(bars) {
    const closes = bars.map((bar) => bar.close);
    const out: StrategyRun[] = [];
    for (const period of [20, 50]) {
      const means = sma(closes, period);
      const deviations = stdev(closes, period, means);
      for (const threshold of [1.5, 2, 2.5]) {
        const signals: Signal[] = bars.map((bar, i) => {
          const mean = means[i];
          const sd = deviations[i];
          if (!Number.isFinite(mean) || !Number.isFinite(sd) || sd <= 0) {
            return 0;
          }
          const z = (bar.close - mean) / sd;
          if (z <= -threshold) return 1;
          if (z >= threshold) return -1;
          return 0;
        });
        out.push({
          label: `Reversion ${period} @ ${threshold}σ`,
          params: { period, threshold },
          signals,
        });
      }
    }
    return out;
  },
};

export const STRATEGIES: Strategy[] = [
  trendStrategy,
  breakoutStrategy,
  reversionStrategy,
];
