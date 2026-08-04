import { atr, ema, rsi, sma } from "./indicators";
import type { AtlasBar } from "./instruments";

export type AtlasStrategyId =
  | "pulse"
  | "apex"
  | "trend"
  | "pullback"
  | "breakout"
  | "meanReversion";

export interface AtlasStrategyMeta {
  id: AtlasStrategyId;
  name: string;
  description: string;
}

export const ATLAS_STRATEGIES: AtlasStrategyMeta[] = [
  {
    id: "pulse",
    name: "Deep Pulse",
    description:
      "Tight Deep Pulse: clean BUY & SELL only. Strict EMA stack + structure + mirrored RSI. Scanner picks high-confidence steady markets with positive expectancy.",
  },
  {
    id: "apex",
    name: "Apex Confluence",
    description:
      "Faster Apex: EMA trend + pullback/push + structure lean. Fires when enough factors agree (not every filter). More trades — still filtered, not guaranteed.",
  },
  {
    id: "trend",
    name: "Trend following",
    description:
      "EMA9/21 cross only with EMA50 + SMA200 agreement and expanding ATR. Stop 1.15×ATR · target 1.8R.",
  },
  {
    id: "pullback",
    name: "Pullback entry",
    description:
      "Buy/sell EMA20 tags in a clean trend with bounce confirmation candle and RSI mid-zone. Stop 1.15×ATR · target 1.7R.",
  },
  {
    id: "breakout",
    name: "Breakout confirmation",
    description:
      "Donchian-20 close break + range expansion + close near extreme. Avoids quiet fakeouts. Stop 1.25×ATR · target 1.8R.",
  },
  {
    id: "meanReversion",
    name: "Mean reversion",
    description:
      "Fade 2.2σ Bollinger extremes only when ATR is quiet and RSI is stretched, with reclaim candle. Stop 1.1×ATR · target 1.5R.",
  },
];

export type StrategySignal = -1 | 0 | 1;

export function strategyTradeParams(id: AtlasStrategyId): {
  atrMult: number;
  rMultiple: number;
} {
  switch (id) {
    case "pulse":
      return { atrMult: 1.25, rMultiple: 1.55 };
    case "apex":
      return { atrMult: 1.28, rMultiple: 1.6 };
    case "trend":
      return { atrMult: 1.3, rMultiple: 1.7 };
    case "pullback":
      return { atrMult: 1.25, rMultiple: 1.55 };
    case "breakout":
      return { atrMult: 1.35, rMultiple: 1.7 };
    case "meanReversion":
      return { atrMult: 1.2, rMultiple: 1.4 };
    default:
      return { atrMult: 1.3, rMultiple: 1.7 };
  }
}

function atrMeanAt(a: number[], i: number, look = 20): number {
  let sum = 0;
  let n = 0;
  for (let j = Math.max(0, i - look + 1); j <= i; j += 1) {
    if (Number.isFinite(a[j])) {
      sum += a[j];
      n += 1;
    }
  }
  return n ? sum / n : a[i];
}

function structAt(
  bars: AtlasBar[],
  i: number,
): "buy" | "sell" | "neutral" {
  if (i < 20) return "neutral";
  let hi1 = -Infinity;
  let lo1 = Infinity;
  let hi2 = -Infinity;
  let lo2 = Infinity;
  for (let j = i - 19; j <= i - 10; j += 1) {
    hi1 = Math.max(hi1, bars[j].high);
    lo1 = Math.min(lo1, bars[j].low);
  }
  for (let j = i - 9; j <= i; j += 1) {
    hi2 = Math.max(hi2, bars[j].high);
    lo2 = Math.min(lo2, bars[j].low);
  }
  if (hi2 > hi1 && lo2 > lo1) return "buy";
  if (hi2 < hi1 && lo2 < lo1) return "sell";
  return "neutral";
}

/** Suppress clustered signals — keep quality over quantity. */
function thinSignals(
  raw: StrategySignal[],
  cooldown = 4,
): StrategySignal[] {
  const out = raw.slice();
  let last = -999;
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] === 0) continue;
    if (i - last < cooldown) {
      out[i] = 0;
      continue;
    }
    last = i;
  }
  return out;
}

/** Deep Pulse: tight symmetric buy/sell — only clean pull / push / reclaim. */
function pulseSignals(bars: AtlasBar[]): StrategySignal[] {
  const n = bars.length;
  const out: StrategySignal[] = new Array(n).fill(0);
  if (n < 60) return out;
  const closes = bars.map((b) => b.close);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const e20 = ema(closes, 20);
  const e200 = ema(closes, 200);
  const r = rsi(closes, 14);
  const a = atr(bars, 14);

  for (let i = 55; i < n; i += 1) {
    if (
      ![e9[i], e21[i], e50[i], e20[i], r[i], a[i]].every(Number.isFinite)
    ) {
      continue;
    }
    const meanA = atrMeanAt(a, i);
    // Skip dead tape — need enough movement to bank after spread.
    if (a[i] < meanA * 0.9) continue;

    const st = structAt(bars, i);
    const above200 = !Number.isFinite(e200[i]) || closes[i] > e200[i];
    const below200 = !Number.isFinite(e200[i]) || closes[i] < e200[i];

    // Strict stack — no soft equality.
    const bullStack = e9[i] > e21[i] && e21[i] > e50[i] && closes[i] > e50[i];
    const bearStack = e9[i] < e21[i] && e21[i] < e50[i] && closes[i] < e50[i];

    const rsiPull = r[i] >= 42 && r[i] <= 58;
    const rsiPushBull = r[i] >= 48 && r[i] <= 64;
    const rsiPushBear = r[i] >= 36 && r[i] <= 52;
    const nearE20 =
      bars[i].low <= e20[i] * 1.003 && bars[i].high >= e20[i] * 0.997;

    const bodyUp = closes[i] > bars[i].open;
    const bodyDn = closes[i] < bars[i].open;
    const momUp =
      closes[i] > closes[i - 1] &&
      closes[i - 1] > closes[i - 2] &&
      closes[i] > e9[i];
    const momDn =
      closes[i] < closes[i - 1] &&
      closes[i - 1] < closes[i - 2] &&
      closes[i] < e9[i];
    // Reject single-bar spikes against the prior 4-bar drive.
    let priorUp = 0;
    let priorDn = 0;
    for (let k = i - 4; k < i; k += 1) {
      if (k <= 0) continue;
      if (closes[k] > closes[k - 1]) priorUp += 1;
      else if (closes[k] < closes[k - 1]) priorDn += 1;
    }
    const spikeBuy = bodyUp && priorDn >= 3;
    const spikeSell = bodyDn && priorUp >= 3;

    // 1) Pullback — structure must agree (no neutral).
    const bullPull =
      bullStack &&
      above200 &&
      st === "buy" &&
      nearE20 &&
      closes[i] >= e20[i] &&
      bodyUp &&
      !spikeBuy &&
      rsiPull &&
      a[i] >= meanA * 0.95;
    const bearPull =
      bearStack &&
      below200 &&
      st === "sell" &&
      nearE20 &&
      closes[i] <= e20[i] &&
      bodyDn &&
      !spikeSell &&
      rsiPull &&
      a[i] >= meanA * 0.95;

    // 2) Momentum push — needs expansion, no fade spike.
    const bullPush =
      bullStack &&
      above200 &&
      st === "buy" &&
      closes[i] > e20[i] &&
      momUp &&
      !spikeBuy &&
      rsiPushBull &&
      a[i] >= meanA * 1.02;
    const bearPush =
      bearStack &&
      below200 &&
      st === "sell" &&
      closes[i] < e20[i] &&
      momDn &&
      !spikeSell &&
      rsiPushBear &&
      a[i] >= meanA * 1.02;

    // 3) Structure reclaim — HH/HL or LH/LL only with strong body.
    const range = Math.max(bars[i].high - bars[i].low, 1e-12);
    const bodyPct = Math.abs(closes[i] - bars[i].open) / range;
    const bullReclaim =
      bullStack &&
      above200 &&
      st === "buy" &&
      closes[i] > e21[i] &&
      bodyUp &&
      bodyPct >= 0.45 &&
      r[i] >= 45 &&
      r[i] <= 62 &&
      a[i] >= meanA * 0.95;
    const bearReclaim =
      bearStack &&
      below200 &&
      st === "sell" &&
      closes[i] < e21[i] &&
      bodyDn &&
      bodyPct >= 0.45 &&
      r[i] >= 38 &&
      r[i] <= 55 &&
      a[i] >= meanA * 0.95;

    if (bullPull || bullPush || bullReclaim) out[i] = 1;
    else if (bearPull || bearPush || bearReclaim) out[i] = -1;
  }
  return thinSignals(out, 3);
}

/** Apex: faster pullback / trend continuation — still filtered, not every bar. */
function apexSignals(bars: AtlasBar[]): StrategySignal[] {
  const n = bars.length;
  const out: StrategySignal[] = new Array(n).fill(0);
  if (n < 60) return out;
  const closes = bars.map((b) => b.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, 200);
  const r = rsi(closes, 14);
  const a = atr(bars, 14);

  for (let i = 50; i < n; i += 1) {
    if (![e20[i], e50[i], r[i], a[i]].every(Number.isFinite)) continue;
    const meanA = atrMeanAt(a, i);
    if (a[i] < meanA * 0.85) continue; // skip dead quiet only

    const bullTrend = e20[i] > e50[i] && closes[i] > e50[i];
    const bearTrend = e20[i] < e50[i] && closes[i] < e50[i];
    const above200 = !Number.isFinite(e200[i]) || closes[i] > e200[i];
    const below200 = !Number.isFinite(e200[i]) || closes[i] < e200[i];
    const st = structAt(bars, i);

    const nearEma20 =
      bars[i].low <= e20[i] * 1.004 && bars[i].high >= e20[i] * 0.996;
    const bullBounce =
      bullTrend &&
      above200 &&
      (st === "buy" || st === "neutral") &&
      nearEma20 &&
      closes[i] >= e20[i] * 0.998 &&
      r[i] >= 35 &&
      r[i] <= 65;
    const bearBounce =
      bearTrend &&
      below200 &&
      (st === "sell" || st === "neutral") &&
      nearEma20 &&
      closes[i] <= e20[i] * 1.002 &&
      r[i] >= 35 &&
      r[i] <= 65;

    // Momentum push only when not already extended from EMA20.
    const ext = a[i] > 0 ? Math.abs(closes[i] - e20[i]) / a[i] : 99;
    const recent =
      a[i] > 0 ? Math.abs(closes[i] - closes[i - 4]) / a[i] : 99;
    const bullPush =
      bullTrend &&
      above200 &&
      ext <= 1.1 &&
      recent <= 1.2 &&
      closes[i] > closes[i - 1] &&
      closes[i] > e20[i] &&
      r[i] >= 45 &&
      r[i] <= 68 &&
      a[i] >= meanA * 0.9;
    const bearPush =
      bearTrend &&
      below200 &&
      ext <= 1.1 &&
      recent <= 1.2 &&
      closes[i] < closes[i - 1] &&
      closes[i] < e20[i] &&
      r[i] >= 32 &&
      r[i] <= 55 &&
      a[i] >= meanA * 0.9;

    // Prefer pullback tags over naked continuation.
    if (bullBounce || (bullPush && nearEma20)) out[i] = 1;
    else if (bearBounce || (bearPush && nearEma20)) out[i] = -1;
  }
  return thinSignals(out, 1);
}

function trendSignals(bars: AtlasBar[]): StrategySignal[] {
  const n = bars.length;
  const out: StrategySignal[] = new Array(n).fill(0);
  if (n < 60) return out;
  const closes = bars.map((b) => b.close);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const s200 = sma(closes, 200);
  const a = atr(bars, 14);

  for (let i = 55; i < n; i += 1) {
    if (
      ![e9[i], e21[i], e50[i], a[i]].every(Number.isFinite) ||
      !Number.isFinite(e9[i - 1]) ||
      !Number.isFinite(e21[i - 1])
    ) {
      continue;
    }
    const meanA = atrMeanAt(a, i);
    if (!(a[i] >= meanA * 0.98)) continue;

    // No late chase: skip if already ran hard into the cross.
    const run =
      a[i] > 0 ? Math.abs(closes[i] - closes[i - 4]) / a[i] : 99;
    if (run >= 1.4) continue;
    const ext50 =
      a[i] > 0 && Number.isFinite(e50[i])
        ? Math.abs(closes[i] - e50[i]) / a[i]
        : 0;
    if (ext50 >= 2.2) continue;

    const crossUp = e9[i - 1] <= e21[i - 1] && e9[i] > e21[i];
    const crossDn = e9[i - 1] >= e21[i - 1] && e9[i] < e21[i];
    const longOk =
      crossUp &&
      e9[i] > e50[i] &&
      (!Number.isFinite(s200[i]) || closes[i] > s200[i]);
    const shortOk =
      crossDn &&
      e9[i] < e50[i] &&
      (!Number.isFinite(s200[i]) || closes[i] < s200[i]);

    if (longOk) out[i] = 1;
    else if (shortOk) out[i] = -1;
  }
  return thinSignals(out, 4);
}

function pullbackSignals(bars: AtlasBar[]): StrategySignal[] {
  const n = bars.length;
  const out: StrategySignal[] = new Array(n).fill(0);
  if (n < 60) return out;
  const closes = bars.map((b) => b.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const r = rsi(closes, 14);
  const a = atr(bars, 14);

  for (let i = 55; i < n; i += 1) {
    if (![e20[i], e50[i], r[i], a[i]].every(Number.isFinite)) continue;
    const meanA = atrMeanAt(a, i);
    if (a[i] < meanA * 0.9) continue;

    const up = e20[i] > e50[i] && closes[i] > e50[i];
    const down = e20[i] < e50[i] && closes[i] < e50[i];
    const tag =
      bars[i].low <= e20[i] * 1.001 && bars[i].high >= e20[i] * 0.999;

    if (
      up &&
      tag &&
      closes[i] > e20[i] &&
      closes[i] > bars[i].open &&
      r[i] >= 40 &&
      r[i] <= 58
    ) {
      out[i] = 1;
    } else if (
      down &&
      tag &&
      closes[i] < e20[i] &&
      closes[i] < bars[i].open &&
      r[i] >= 42 &&
      r[i] <= 60
    ) {
      out[i] = -1;
    }
  }
  return thinSignals(out, 4);
}

function breakoutSignals(bars: AtlasBar[]): StrategySignal[] {
  const n = bars.length;
  const out: StrategySignal[] = new Array(n).fill(0);
  if (n < 40) return out;
  const closes = bars.map((b) => b.close);
  const a = atr(bars, 14);
  const lookback = 20;

  for (let i = lookback + 5; i < n; i += 1) {
    if (!Number.isFinite(a[i])) continue;
    const meanA = atrMeanAt(a, i);
    if (!(a[i] >= meanA * 1.05)) continue; // expansion required

    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - lookback; j < i; j += 1) {
      hi = Math.max(hi, bars[j].high);
      lo = Math.min(lo, bars[j].low);
    }
    const bar = bars[i];
    const rng = Math.max(bar.high - bar.low, 1e-9);
    const closePos = (bar.close - bar.low) / rng;

    // Close beyond channel AND finish near the breakout extreme.
    if (closes[i] > hi && closePos >= 0.65 && bar.close > bar.open) {
      out[i] = 1;
    } else if (
      closes[i] < lo &&
      closePos <= 0.35 &&
      bar.close < bar.open
    ) {
      out[i] = -1;
    }
  }
  return thinSignals(out, 5);
}

function meanReversionSignals(bars: AtlasBar[]): StrategySignal[] {
  const n = bars.length;
  const out: StrategySignal[] = new Array(n).fill(0);
  if (n < 40) return out;
  const closes = bars.map((b) => b.close);
  const a = atr(bars, 14);
  const r = rsi(closes, 14);

  for (let i = 25; i < n; i += 1) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(r[i])) continue;
    const meanA = atrMeanAt(a, i);
    // Mean reversion only in quiet / cooling tape.
    if (a[i] > meanA * 1.05) continue;

    let sum = 0;
    for (let j = i - 19; j <= i; j += 1) sum += closes[j];
    const mean = sum / 20;
    let varAcc = 0;
    for (let j = i - 19; j <= i; j += 1) varAcc += (closes[j] - mean) ** 2;
    const sd = Math.sqrt(varAcc / 20);
    if (!(sd > 0)) continue;

    const bar = bars[i];
    const lower = mean - 2.2 * sd;
    const upper = mean + 2.2 * sd;

    // Reclaim: dipped outside band then closed back inside with RSI stretch.
    if (
      bar.low < lower &&
      closes[i] > lower &&
      closes[i] > bar.open &&
      r[i] <= 32
    ) {
      out[i] = 1;
    } else if (
      bar.high > upper &&
      closes[i] < upper &&
      closes[i] < bar.open &&
      r[i] >= 68
    ) {
      out[i] = -1;
    }
  }
  return thinSignals(out, 4);
}

export function strategySignals(
  id: AtlasStrategyId,
  bars: AtlasBar[],
): StrategySignal[] {
  switch (id) {
    case "pulse":
      return pulseSignals(bars);
    case "apex":
      return apexSignals(bars);
    case "trend":
      return trendSignals(bars);
    case "pullback":
      return pullbackSignals(bars);
    case "breakout":
      return breakoutSignals(bars);
    case "meanReversion":
      return meanReversionSignals(bars);
    default:
      return pulseSignals(bars);
  }
}

/** Latest strategy signal on this bar or a recent bar (faster entries). */
export function latestStrategySignal(
  id: AtlasStrategyId,
  bars: AtlasBar[],
  lookback = 3,
): StrategySignal {
  const sigs = strategySignals(id, bars);
  for (let i = sigs.length - 1; i >= Math.max(0, sigs.length - lookback); i -= 1) {
    const s = sigs[i] ?? 0;
    if (s !== 0) return s as StrategySignal;
  }
  return 0;
}

export interface AtlasBacktestResult {
  trades: number;
  wins: number;
  winRate: number;
  profitFactor: number;
  expectancyR: number;
  totalR: number;
  maxDrawdownR: number;
  sharpeApprox: number;
}

export function runAtlasBacktest(
  bars: AtlasBar[],
  signals: StrategySignal[],
  spread: number,
  atrMult = 1.15,
  rMultiple = 1.7,
): AtlasBacktestResult {
  const atrLine = atr(bars, 14);
  const results: number[] = [];
  let i = 60;
  while (i < bars.length - 1) {
    const signal = signals[i] ?? 0;
    const risk = atrLine[i] * atrMult;
    if (signal === 0 || !(risk > 0)) {
      i += 1;
      continue;
    }
    const long = signal === 1;
    const entryBar = bars[i + 1];
    const entry = long ? entryBar.open + spread / 2 : entryBar.open - spread / 2;
    const stop = long ? entry - risk : entry + risk;
    const target = long ? entry + risk * rMultiple : entry - risk * rMultiple;
    let grossR: number | null = null;
    let exitIndex = i + 1;
    // Profit-first: shorter max hold so winners bank or cut sooner.
    const last = Math.min(bars.length - 1, i + 1 + 36);
    for (let j = i + 1; j <= last; j += 1) {
      const bar = bars[j];
      const stopHit = long ? bar.low <= stop : bar.high >= stop;
      const targetHit = long ? bar.high >= target : bar.low <= target;
      // Same-bar ambiguity: favor stop (conservative).
      if (stopHit && targetHit) {
        grossR = -1;
        exitIndex = j;
        break;
      }
      if (stopHit) {
        grossR = -1;
        exitIndex = j;
        break;
      }
      if (targetHit) {
        grossR = rMultiple;
        exitIndex = j;
        break;
      }
    }
    if (grossR === null) {
      const exit = bars[last].close;
      grossR = (long ? exit - entry : entry - exit) / risk;
      exitIndex = last;
    }
    results.push(grossR - spread / risk);
    i = exitIndex + 1;
  }
  if (results.length === 0) {
    return {
      trades: 0,
      wins: 0,
      winRate: 0,
      profitFactor: 0,
      expectancyR: 0,
      totalR: 0,
      maxDrawdownR: 0,
      sharpeApprox: 0,
    };
  }
  let wins = 0;
  let gp = 0;
  let gl = 0;
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const r of results) {
    if (r > 0) {
      wins += 1;
      gp += r;
    } else gl += -r;
    equity += r;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  const mean = results.reduce((a, b) => a + b, 0) / results.length;
  const variance =
    results.reduce((a, b) => a + (b - mean) ** 2, 0) / results.length;
  const std = Math.sqrt(variance);
  return {
    trades: results.length,
    wins,
    winRate: (wins / results.length) * 100,
    profitFactor: gl > 0 ? gp / gl : gp,
    expectancyR: mean,
    totalR: results.reduce((a, b) => a + b, 0),
    maxDrawdownR: maxDd,
    sharpeApprox: std > 0 ? mean / std : 0,
  };
}
