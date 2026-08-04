import type { AtlasBar } from "./instruments";

export function ema(values: number[], period: number): number[] {
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

export function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function atr(bars: AtlasBar[], period = 14): number[] {
  const out = new Array<number>(bars.length).fill(Number.NaN);
  if (bars.length < period + 1) return out;
  const tr: number[] = [Number.NaN];
  for (let i = 1; i < bars.length; i += 1) {
    const prev = bars[i - 1].close;
    tr.push(
      Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - prev),
        Math.abs(bars[i].low - prev),
      ),
    );
  }
  let sum = 0;
  for (let i = 1; i <= period; i += 1) sum += tr[i];
  out[period] = sum / period;
  for (let i = period + 1; i < bars.length; i += 1) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return out;
}

export function rsi(closes: number[], period = 14): number[] {
  const out = new Array<number>(closes.length).fill(Number.NaN);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i += 1) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): { macd: number[]; signal: number[]; hist: number[] } {
  const fastLine = ema(closes, fast);
  const slowLine = ema(closes, slow);
  const macdLine = closes.map((_, i) =>
    Number.isFinite(fastLine[i]) && Number.isFinite(slowLine[i])
      ? fastLine[i] - slowLine[i]
      : Number.NaN,
  );
  const signalLine = ema(
    macdLine.map((v) => (Number.isFinite(v) ? v : 0)),
    signal,
  );
  const hist = macdLine.map((v, i) =>
    Number.isFinite(v) && Number.isFinite(signalLine[i]) ? v - signalLine[i] : Number.NaN,
  );
  return { macd: macdLine, signal: signalLine, hist };
}

export function bollinger(
  closes: number[],
  period = 20,
  mult = 2,
): { mid: number[]; upper: number[]; lower: number[] } {
  const mid = sma(closes, period);
  const upper = new Array<number>(closes.length).fill(Number.NaN);
  const lower = new Array<number>(closes.length).fill(Number.NaN);
  for (let i = period - 1; i < closes.length; i += 1) {
    const mean = mid[i];
    if (!Number.isFinite(mean)) continue;
    let acc = 0;
    for (let j = i - period + 1; j <= i; j += 1) acc += (closes[j] - mean) ** 2;
    const sd = Math.sqrt(acc / period);
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { mid, upper, lower };
}

export function adx(bars: AtlasBar[], period = 14): number[] {
  const out = new Array<number>(bars.length).fill(Number.NaN);
  if (bars.length < period * 2) return out;
  const plusDM: number[] = [0];
  const minusDM: number[] = [0];
  const tr: number[] = [0];
  for (let i = 1; i < bars.length; i += 1) {
    const up = bars[i].high - bars[i - 1].high;
    const down = bars[i - 1].low - bars[i].low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    const prev = bars[i - 1].close;
    tr.push(
      Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - prev),
        Math.abs(bars[i].low - prev),
      ),
    );
  }
  let atrSmooth = 0;
  let plusSmooth = 0;
  let minusSmooth = 0;
  for (let i = 1; i <= period; i += 1) {
    atrSmooth += tr[i];
    plusSmooth += plusDM[i];
    minusSmooth += minusDM[i];
  }
  const dx: number[] = new Array(bars.length).fill(Number.NaN);
  for (let i = period; i < bars.length; i += 1) {
    if (i > period) {
      atrSmooth = atrSmooth - atrSmooth / period + tr[i];
      plusSmooth = plusSmooth - plusSmooth / period + plusDM[i];
      minusSmooth = minusSmooth - minusSmooth / period + minusDM[i];
    }
    const plusDI = atrSmooth === 0 ? 0 : (100 * plusSmooth) / atrSmooth;
    const minusDI = atrSmooth === 0 ? 0 : (100 * minusSmooth) / atrSmooth;
    const sum = plusDI + minusDI;
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / sum;
  }
  let adxVal = 0;
  let count = 0;
  for (let i = period; i < period * 2 && i < bars.length; i += 1) {
    if (Number.isFinite(dx[i])) {
      adxVal += dx[i];
      count += 1;
    }
  }
  if (count === 0) return out;
  adxVal /= count;
  out[period * 2 - 1] = adxVal;
  for (let i = period * 2; i < bars.length; i += 1) {
    adxVal = (adxVal * (period - 1) + dx[i]) / period;
    out[i] = adxVal;
  }
  return out;
}

export interface AtlasIndicators {
  ema20: number;
  ema50: number;
  sma200: number | null;
  rsi14: number;
  macdHist: number;
  atr14: number;
  bbUpper: number;
  bbLower: number;
  adx14: number;
}

export function latestIndicators(bars: AtlasBar[]): AtlasIndicators | null {
  if (bars.length < 60) return null;
  const closes = bars.map((b) => b.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const s200 = sma(closes, 200);
  const r = rsi(closes, 14);
  const m = macd(closes);
  const a = atr(bars, 14);
  const bb = bollinger(closes, 20, 2);
  const ad = adx(bars, 14);
  const i = bars.length - 1;
  if (!Number.isFinite(e20[i]) || !Number.isFinite(r[i])) return null;
  return {
    ema20: e20[i],
    ema50: e50[i],
    sma200: Number.isFinite(s200[i]) ? s200[i] : null,
    rsi14: r[i],
    macdHist: m.hist[i] ?? 0,
    atr14: a[i] ?? 0,
    bbUpper: bb.upper[i] ?? closes[i],
    bbLower: bb.lower[i] ?? closes[i],
    adx14: ad[i] ?? 0,
  };
}
