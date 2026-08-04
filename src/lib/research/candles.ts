import type { DerivClient } from "../deriv/client";

export interface Bar {
  epoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface CandleResponse {
  msg_type: string;
  candles?: Array<{
    epoch: number;
    open: number | string;
    high: number | string;
    low: number | string;
    close: number | string;
  }>;
}

/**
 * A real market to research: an instrument whose price comes from actual
 * buyers and sellers, not a random generator.
 *
 * `spread` is the round-trip dealing cost in price units — the single most
 * important number in any honest backtest, because a strategy that only
 * works before costs does not work.
 */
export interface Instrument {
  symbol: string;
  name: string;
  spread: number;
}

/** Deriv's real-asset symbols. Spreads are conservative typical values. */
export const REAL_INSTRUMENTS: Instrument[] = [
  { symbol: "frxEURUSD", name: "EUR/USD", spread: 0.00012 },
  { symbol: "frxGBPUSD", name: "GBP/USD", spread: 0.00016 },
  { symbol: "frxUSDJPY", name: "USD/JPY", spread: 0.016 },
  { symbol: "frxAUDUSD", name: "AUD/USD", spread: 0.00014 },
  { symbol: "frxXAUUSD", name: "Gold/USD", spread: 0.35 },
  { symbol: "cryBTCUSD", name: "BTC/USD", spread: 22 },
  { symbol: "cryETHUSD", name: "ETH/USD", spread: 1.6 },
];

/** Bar sizes in seconds that Deriv serves as candles. */
export const GRANULARITIES = {
  m15: 900,
  h1: 3600,
  h4: 14400,
} as const;

function toBars(res: CandleResponse): Bar[] {
  return (res.candles ?? [])
    .map((candle) => ({
      epoch: candle.epoch,
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
    }))
    .filter(
      (bar) =>
        Number.isFinite(bar.open) &&
        Number.isFinite(bar.high) &&
        Number.isFinite(bar.low) &&
        Number.isFinite(bar.close),
    );
}

async function fetchPage(
  client: DerivClient,
  symbol: string,
  granularity: number,
  count: number,
  end: number | "latest",
): Promise<Bar[]> {
  return toBars(
    await client.send<CandleResponse>({
      ticks_history: symbol,
      adjust_start_time: 1,
      style: "candles",
      granularity,
      count,
      end,
    }),
  );
}

/**
 * Deep candle history. Deriv answers a single request with far fewer bars
 * than asked for, so this walks backwards page by page — without the depth
 * a backtest ends up with a dozen out-of-sample trades, which proves
 * nothing either way.
 */
export async function fetchCandles(
  client: DerivClient,
  symbol: string,
  granularity: number,
  target = 5000,
  options?: { pageGapMs?: number; maxPages?: number },
): Promise<Bar[]> {
  const gap = options?.pageGapMs ?? 1000;
  const maxPages = options?.maxPages ?? 12;
  const byEpoch = new Map<number, Bar>();
  let end: number | "latest" = "latest";

  for (let page = 0; page < maxPages; page += 1) {
    const bars = await fetchPage(client, symbol, granularity, 1000, end);
    if (bars.length === 0) break;
    const before = byEpoch.size;
    for (const bar of bars) byEpoch.set(bar.epoch, bar);
    if (byEpoch.size === before) break;
    if (byEpoch.size >= target) break;
    end = bars[0].epoch - 1;
    await new Promise((resolve) => setTimeout(resolve, gap));
  }

  return [...byEpoch.values()]
    .sort((a, b) => a.epoch - b.epoch)
    .slice(-target);
}

/** Average true range — the volatility unit stops and targets are sized in. */
export function atrSeries(bars: Bar[], period: number): number[] {
  const out = new Array<number>(bars.length).fill(Number.NaN);
  if (bars.length < period + 1) return out;
  const trueRanges: number[] = [Number.NaN];
  for (let i = 1; i < bars.length; i += 1) {
    const prevClose = bars[i - 1].close;
    trueRanges.push(
      Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - prevClose),
        Math.abs(bars[i].low - prevClose),
      ),
    );
  }
  let sum = 0;
  for (let i = 1; i <= period; i += 1) sum += trueRanges[i];
  out[period] = sum / period;
  for (let i = period + 1; i < bars.length; i += 1) {
    // Wilder smoothing.
    out[i] = (out[i - 1] * (period - 1) + trueRanges[i]) / period;
  }
  return out;
}
