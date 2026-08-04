/**
 * Deep market sweep — one honest read across every 1-second volatility index.
 *
 * The live analyzer only sees the market it sits on, so "No edge" there says
 * nothing about the other 1s boards. The sweep pulls a deep tape (2,000 ticks)
 * for all five 1s indices (slow R_* left out), scores Over/Under barriers on
 * each, and judges every one against its payout break-even with a lower bound
 * corrected for the search.
 *
 * The verdict is binding in both directions: if a barrier proves, the bot can
 * jump straight to it; while nothing proves, the sweep names the closest
 * candidate and exactly how far short it falls, so "No edge" is a measured
 * statement about the whole board rather than a shrug.
 */
import type { DerivClient } from "../deriv/client";
import { lastDigit, type HistoryResponse } from "../deriv/types";
import { breakEvenDigitPercent } from "../bot/performance";
import { judgeEvidence, type EvidenceVerdict } from "./evidence";
import { outcomeWon, type OverUnderSide } from "./overUnder";

export const SWEEP_MARKETS = [
  { symbol: "1HZ10V", name: "Volatility 10 (1s)" },
  { symbol: "1HZ25V", name: "Volatility 25 (1s)" },
  { symbol: "1HZ50V", name: "Volatility 50 (1s)" },
  { symbol: "1HZ75V", name: "Volatility 75 (1s)" },
  { symbol: "1HZ100V", name: "Volatility 100 (1s)" },
] as const;

/** Deep tape per market. At p≈0.7 this puts the standard error near ±1pp. */
export const SWEEP_TICKS = 2000;

/** Barriers × 1s markets — analyzer leaves slow R_* indices alone. */
export const SWEEP_COMPARISONS = SWEEP_MARKETS.length * 4;

/** Gap between history requests so a full pass never trips the rate limit. */
const SWEEP_REQUEST_GAP_MS = 400;

/** Shield elite board only — thin Over 0 / Under 9 are not trade targets. */
const SWEEP_BARRIERS: Array<{ side: OverUnderSide; barrier: number }> = [
  { side: "DIGITOVER", barrier: 1 },
  { side: "DIGITOVER", barrier: 2 },
  { side: "DIGITUNDER", barrier: 7 },
  { side: "DIGITUNDER", barrier: 8 },
];

export interface MarketSweepEntry {
  symbol: string;
  name: string;
  side: OverUnderSide;
  barrier: number;
  verdict: EvidenceVerdict;
  /** Lower bound minus break-even, pp. Positive = proven edge. */
  headroom: number;
}

export interface MarketSweep {
  /** Best barrier per market, best market first. */
  entries: MarketSweepEntry[];
  /** Strongest proven barrier on the whole board, if any. */
  proven: MarketSweepEntry | null;
  /** Best candidate when nothing is proven. */
  closest: MarketSweepEntry | null;
  scannedAt: number;
  ticksPerMarket: number;
  /** Markets that answered — the rest failed to fetch this pass. */
  scannedMarkets: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchSweepDigits(
  client: DerivClient,
  symbol: string,
): Promise<number[]> {
  const message: HistoryResponse = await client.send<HistoryResponse>({
    ticks_history: symbol,
    adjust_start_time: 1,
    count: SWEEP_TICKS,
    end: "latest",
    style: "ticks",
  });
  const prices = message.history?.prices ?? [];
  const pipSize = message.pip_size ?? 2;
  return prices.map((quote) => lastDigit(quote, pipSize));
}

function bestBarrierFor(
  symbol: string,
  name: string,
  digits: number[],
): MarketSweepEntry {
  let best: MarketSweepEntry | null = null;
  for (const { side, barrier } of SWEEP_BARRIERS) {
    let wins = 0;
    for (const d of digits) if (outcomeWon(side, barrier, d)) wins += 1;
    const verdict = judgeEvidence({
      wins,
      n: digits.length,
      breakEvenPercent: breakEvenDigitPercent(side, undefined, barrier),
      comparisons: SWEEP_COMPARISONS,
    });
    const entry: MarketSweepEntry = {
      symbol,
      name,
      side,
      barrier,
      verdict,
      headroom: verdict.lowerPercent - verdict.needPercent,
    };
    if (!best || entry.headroom > best.headroom) best = entry;
  }
  return best as MarketSweepEntry;
}

/**
 * One full pass over the board. Sequential with spacing — a burst of ten
 * history calls is what got the scanner rate-limited before.
 */
export async function runMarketSweep(
  client: DerivClient,
  isCancelled: () => boolean = () => false,
): Promise<MarketSweep | null> {
  const entries: MarketSweepEntry[] = [];

  for (const market of SWEEP_MARKETS) {
    if (isCancelled()) return null;
    try {
      const digits = await fetchSweepDigits(client, market.symbol);
      if (digits.length >= SWEEP_TICKS / 2) {
        entries.push(bestBarrierFor(market.symbol, market.name, digits));
      }
    } catch {
      // Skip this market this pass — the next sweep retries it.
    }
    await sleep(SWEEP_REQUEST_GAP_MS);
  }

  if (isCancelled()) return null;
  entries.sort((a, b) => b.headroom - a.headroom);
  const top = entries[0] ?? null;

  return {
    entries,
    proven: top && top.verdict.ok ? top : null,
    closest: top && !top.verdict.ok ? top : null,
    scannedAt: Date.now(),
    ticksPerMarket: SWEEP_TICKS,
    scannedMarkets: entries.length,
  };
}
