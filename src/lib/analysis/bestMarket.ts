import { summarise } from "./digits";
import { analyzerAllowsEntry } from "./analyzerGate";
import { deskOf, isOverUnderSide, type TradeDesk } from "./contractSide";
import {
  buildOverUnderSignal,
  OU_BLITZ_SHORT,
  pickBetterOverUnder,
} from "./overUnder";
import { firmSteadyCheck } from "./analyzerDirector";
import {
  buildMarketSignal,
  isArmedSignal,
  pickBetterSignal,
  setupEdgePoints,
  type MarketSignal,
} from "./signal";
import { isLowPayoutSymbol } from "../bot/performance";
import type { DerivClient } from "../deriv/client";
import { lastDigit, type HistoryResponse } from "../deriv/types";
import type { BotSettings } from "../bot/types";

/** Analyzer / Start hunt — 1-second volatility only (leave slow R_* alone). */
const SCAN_MARKETS = [
  { symbol: "1HZ100V", name: "Volatility 100 (1s) Index" },
  { symbol: "1HZ10V", name: "Volatility 10 (1s) Index" },
  { symbol: "1HZ25V", name: "Volatility 25 (1s) Index" },
  { symbol: "1HZ50V", name: "Volatility 50 (1s) Index" },
  { symbol: "1HZ75V", name: "Volatility 75 (1s) Index" },
] as const;

const SCAN_COUNT = 1200;
const WINDOW_SIZES = [500, 1000, 1500] as const;
/** Primary window for ranking — matches desk sample floor. */
const PRIMARY_WINDOW = 500;

export interface MarketScanResult {
  symbol: string;
  name: string;
  signal: MarketSignal;
  score: number;
}

/** 1-second indices print twice as fast as the standard ones. */
function isFastIndex(symbol: string): boolean {
  return symbol.startsWith("1HZ");
}

/**
 * The ranking is cost-based, not signal-based, and that is deliberate.
 *
 * scripts/find-edge.ts checked 400k ticks: digits are uniform (all p > 0.13),
 * the next digit is independent of the current one, and the step distribution
 * is flat (pooled p = 0.22). scripts/diagnose-gate.ts then replayed 32k gated
 * trades and the picked barrier came in at 90.2% [89.9-90.5] — a coin flip
 * against the 90% baseline, on every market. Ranking markets by how strong
 * their setup looks is therefore ranking noise, so the old confirm-score term
 * is gone; it made Start feel decisive while choosing at random.
 *
 * What does differ between markets is what a win pays and how fast losses
 * accumulate, so those are the only two terms:
 *  - payout tier is worth ~0.9 points of expected value per trade;
 *  - a 1-second index offers twice as many entries per minute as a standard
 *    one, and since every entry carries the same negative expectancy, the
 *    faster feed simply reaches the same loss sooner.
 * setupEdgePoints survives only as a deterministic tie-break so the scan
 * returns a stable answer instead of flapping between equals.
 */
function scoreSignal(
  signal: MarketSignal,
  symbol: string,
  sidePreference: BotSettings["sidePreference"],
): number {
  // Cheap payout tiers lose ~0.9pp per trade — keep them out of the top pick.
  if (isLowPayoutSymbol(symbol)) return -1;

  const payoutRank = 10000;
  // Prefer 1s indices — slow R_* are not in SCAN_MARKETS anymore.
  const paceRank = isFastIndex(symbol) ? 500 : 0;

  let setupRank = setupEdgePoints(signal) * 25;
  const prefersDiffers =
    sidePreference === "differs" || sidePreference === "winrate";

  if (prefersDiffers) {
    if (signal.side !== "DIGITDIFF") setupRank -= 5000;
    if (signal.timingOk) setupRank += 900;
    else setupRank -= 1200;
    if (signal.coldMarginOk) setupRank += 450;
    if (signal.barrierAligned) setupRank += 250;
    if (signal.primaryBarrier) setupRank += 350;
    if (signal.uniqueEvOk) setupRank += 400;
    setupRank += Math.min(600, (signal.watching.signalGap ?? 0) * 60);
  } else if (sidePreference === "matches") {
    if (signal.side !== "DIGITMATCH") setupRank -= 5000;
    if (signal.timingOk) setupRank += 900;
    else setupRank -= 1200;
  } else if (isOverUnderSide(signal.side)) {
    // Blitz hunt: payout EV + HIGH confidence beat raw hit-rate.
    if (signal.confidence === "high") setupRank += 2800;
    else if (signal.confidence === "medium") setupRank += 400;
    else setupRank -= 900;
    if (signal.evOk) setupRank += 1200;
    else setupRank -= 1600;
    if (signal.timingOk) setupRank += 900;
    else setupRank -= 1200;
    if (signal.coldMarginOk) setupRank += 450;
    if (signal.uniqueEvOk) setupRank += 500;
    if (signal.windowsEvOk) setupRank += 350;
    setupRank += Math.max(0, 600 - (signal.watching.signalGap ?? 9) * 80);
    setupRank += signal.power * 4;
  } else {
    setupRank += signal.timingOk ? 400 : -400;
  }

  setupRank += signal.power * 2;
  if (isArmedSignal(signal)) setupRank += 2000;

  return payoutRank + paceRank + setupRank;
}

async function fetchDigits(
  client: DerivClient,
  symbol: string,
): Promise<number[]> {
  // Deriv often caps a single ticks_history reply well below SCAN_COUNT —
  // page backwards until we have enough for the primary window.
  const prices: number[] = [];
  let pipSize = 2;
  let end: number | "latest" = "latest";
  const page = 1000;
  while (prices.length < SCAN_COUNT) {
    const message: HistoryResponse = await client.send<HistoryResponse>({
      ticks_history: symbol,
      adjust_start_time: 1,
      count: page,
      end,
      style: "ticks",
    });
    const times: number[] = message.history?.times ?? [];
    if (times.length === 0) break;
    pipSize = message.pip_size ?? pipSize;
    prices.unshift(...message.history.prices);
    const earliest: number = times[0]!;
    if (end !== "latest" && earliest >= end) break;
    end = earliest - 1;
  }
  return prices.map((quote) => lastDigit(quote, pipSize));
}

function signalForDigits(
  digits: number[],
  settings: Pick<
    BotSettings,
    | "prediction"
    | "minEdgePercent"
    | "maxMomentumGap"
    | "minColdGap"
    | "sidePreference"
    | "minSample"
    | "side"
  >,
  symbol: string,
  desk: TradeDesk = "digits",
): MarketSignal {
  const primary = Math.max(PRIMARY_WINDOW, settings.minSample ?? PRIMARY_WINDOW);
  const windowDigits = digits.slice(-primary);
  const stats = summarise(windowDigits);
  const windowStats = WINDOW_SIZES.map((size) => summarise(digits.slice(-size)));
  const options = {
    windowStats,
    windowSizes: [...WINDOW_SIZES],
    minEdgePercent: settings.minEdgePercent,
    maxMomentumGap: settings.maxMomentumGap,
    minColdGap: settings.minColdGap,
    minSampleForHigh: settings.minSample ?? PRIMARY_WINDOW,
    symbol,
  };
  if (desk === "overunder") {
    const over = buildOverUnderSignal(
      windowDigits,
      stats,
      "DIGITOVER",
      settings.prediction,
      options,
    );
    const under = buildOverUnderSignal(
      windowDigits,
      stats,
      "DIGITUNDER",
      settings.prediction,
      options,
    );
    return pickBetterOverUnder(over, under);
  }
  const match = buildMarketSignal(stats, "DIGITMATCH", settings.prediction, options);
  const diff = buildMarketSignal(stats, "DIGITDIFF", settings.prediction, options);
  return pickBetterSignal(match, diff, settings.sidePreference);
}

export interface FindBestMarketOptions {
  /** Markets to skip — used when the current index is stuck so we pick a fresh one. */
  excludeSymbols?: string[];
  /**
   * Prefer a setup whose cold/momentum gap already clears. When requireReady
   * is also set, a soft prefer is not enough — see requireReady.
   */
  preferReady?: boolean;
  /**
   * Hard filter: only return a market that is tradeable right now
   * (timing + barrier + cold margin for Differs). If none qualify, returns null
   * so the caller can stop instead of jumping onto a bad index.
   */
  requireReady?: boolean;
}

function isTradeReady(
  signal: MarketSignal,
  settings: Pick<
    BotSettings,
    "minColdGap" | "minSample" | "maxMomentumGap" | "sidePreference" | "side"
  >,
): boolean {
  if (isOverUnderSide(signal.side) || deskOf(settings.side) === "overunder") {
    return analyzerAllowsEntry(signal, {
      minColdGap: settings.minColdGap,
      minSample: settings.minSample,
      maxMomentumGap: settings.maxMomentumGap,
      side: signal.side,
    }).ok;
  }
  const prefersDiffers =
    settings.sidePreference === "differs" || settings.sidePreference === "winrate";
  const side = prefersDiffers
    ? ("DIGITDIFF" as const)
    : settings.sidePreference === "matches"
      ? ("DIGITMATCH" as const)
      : signal.side;
  return analyzerAllowsEntry(signal, {
    minColdGap: settings.minColdGap,
    minSample: settings.minSample,
    maxMomentumGap: settings.maxMomentumGap,
    side,
  }).ok;
}

/**
 * Score every listed volatility market and return the strongest analyzer setup.
 * Falls back to `fallbackSymbol` if the scan fails entirely — unless
 * `requireReady` is set, in which case a null means "nothing is tradeable".
 */
type ScanSettings = Pick<
  BotSettings,
  | "prediction"
  | "minEdgePercent"
  | "maxMomentumGap"
  | "minColdGap"
  | "sidePreference"
  | "minSample"
  | "side"
>;

export async function findBestMarket(
  client: DerivClient,
  settings: ScanSettings,
  fallbackSymbol: string,
  options: FindBestMarketOptions & { requireReady: true },
): Promise<MarketScanResult | null>;
export async function findBestMarket(
  client: DerivClient,
  settings: ScanSettings,
  fallbackSymbol: string,
  options?: FindBestMarketOptions,
): Promise<MarketScanResult>;
export async function findBestMarket(
  client: DerivClient,
  settings: ScanSettings,
  fallbackSymbol: string,
  options: FindBestMarketOptions = {},
): Promise<MarketScanResult | null> {
  const excluded = new Set(options.excludeSymbols ?? []);
  const desk = deskOf(settings.side);
  // Fetched together so Start is one round-trip of latency, not ten.
  const settled = await Promise.allSettled(
    SCAN_MARKETS.filter((market) => !excluded.has(market.symbol)).map(
      async (market): Promise<MarketScanResult> => {
        const digits = await fetchDigits(client, market.symbol);
        if (digits.length < PRIMARY_WINDOW) throw new Error("not enough history");
        const signal = signalForDigits(digits, settings, market.symbol, desk);
        return {
          symbol: market.symbol,
          name: market.name,
          signal,
          score: scoreSignal(signal, market.symbol, settings.sidePreference),
        };
      },
    ),
  );

  const ranked: MarketScanResult[] = settled
    .filter(
      (result): result is PromiseFulfilledResult<MarketScanResult> =>
        result.status === "fulfilled",
    )
    .map((result) => result.value);

  if (ranked.length === 0) {
    if (options.requireReady) return null;
    return {
      symbol: fallbackSymbol,
      name: SCAN_MARKETS.find((m) => m.symbol === fallbackSymbol)?.name ?? fallbackSymbol,
      signal: {
        side: "DIGITDIFF",
        digit: settings.prediction,
        label: "—",
        reason: "Scan unavailable · keeping current market",
        confidence: "low",
        power: 0,
        windowsAgree: false,
        digitPercent: 10,
        evOk: false,
        windowsEvOk: false,
        timingOk: false,
        structureOk: false,
        separationOk: false,
        barrierAligned: false,
        windowFair: true,
        coldMarginOk: false,
        primaryBarrier: false,
        uniqueEvOk: false,
        watching: {
          lastDigit: null,
          streak: "—",
          hot: "—",
          cold: "—",
          evenOdd: "—",
          sampleSize: 0,
          signalGap: null,
          windowVotes: "—",
          windowEv: "—",
          separation: "—",
          wilsonBound: "—",
        },
      },
      score: -Infinity,
    };
  }

  ranked.sort((a, b) => b.score - a.score);

  if (options.requireReady) {
    const ready = ranked.find(
      (entry) =>
        !isLowPayoutSymbol(entry.symbol) &&
        isTradeReady(entry.signal, settings),
    );
    return ready ?? null;
  }

  if (options.preferReady) {
    const ready = ranked.find(
      (entry) =>
        !isLowPayoutSymbol(entry.symbol) &&
        isTradeReady(entry.signal, settings),
    );
    if (ready) return ready;
  }
  const preferred = ranked.find((entry) => !isLowPayoutSymbol(entry.symbol));
  return preferred ?? ranked[0];
}

/** Fast 1s indices preferred — Blitz only needs ~36–80 ticks. */
const OU_BLITZ_SCAN_MARKETS = SCAN_MARKETS.filter(
  (m) => !isLowPayoutSymbol(m.symbol),
);
const OU_BLITZ_HISTORY = 120;

async function fetchBlitzDigits(
  client: DerivClient,
  symbol: string,
): Promise<number[]> {
  const message: HistoryResponse = await client.send<HistoryResponse>({
    ticks_history: symbol,
    adjust_start_time: 1,
    count: OU_BLITZ_HISTORY,
    end: "latest",
    style: "ticks",
  });
  const prices = message.history?.prices ?? [];
  const pipSize = message.pip_size ?? 2;
  return prices.map((quote) => lastDigit(quote, pipSize));
}

function ouBlitzSignalForDigits(
  digits: number[],
  settings: ScanSettings,
  symbol: string,
): MarketSignal {
  const windowDigits = digits.slice(-Math.max(OU_BLITZ_SHORT, settings.minSample ?? OU_BLITZ_SHORT));
  const stats = summarise(windowDigits);
  const options = {
    minEdgePercent: settings.minEdgePercent,
    maxMomentumGap: settings.maxMomentumGap,
    minColdGap: settings.minColdGap,
    minSampleForHigh: settings.minSample ?? OU_BLITZ_SHORT,
    symbol,
  };
  const over = buildOverUnderSignal(
    windowDigits,
    stats,
    "DIGITOVER",
    settings.prediction,
    options,
  );
  const under = buildOverUnderSignal(
    windowDigits,
    stats,
    "DIGITUNDER",
    settings.prediction,
    options,
  );
  return pickBetterOverUnder(over, under);
}

/**
 * Parallel short-history scan across volatilities for Over/Under Blitz.
 * Prefer HIGH / firmSteady markets; otherwise the strongest EV score.
 */
export async function findBestOverUnderBlitz(
  client: DerivClient,
  settings: ScanSettings,
  fallbackSymbol: string,
  options: FindBestMarketOptions = {},
): Promise<MarketScanResult> {
  const excluded = new Set(options.excludeSymbols ?? []);
  const settled = await Promise.allSettled(
    OU_BLITZ_SCAN_MARKETS.filter((market) => !excluded.has(market.symbol)).map(
      async (market): Promise<MarketScanResult> => {
        const digits = await fetchBlitzDigits(client, market.symbol);
        if (digits.length < OU_BLITZ_SHORT) {
          throw new Error("not enough history");
        }
        const signal = ouBlitzSignalForDigits(digits, settings, market.symbol);
        return {
          symbol: market.symbol,
          name: market.name,
          signal,
          score: scoreSignal(signal, market.symbol, "edge"),
        };
      },
    ),
  );

  const ranked: MarketScanResult[] = settled
    .filter(
      (result): result is PromiseFulfilledResult<MarketScanResult> =>
        result.status === "fulfilled",
    )
    .map((result) => result.value)
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    return {
      symbol: fallbackSymbol,
      name:
        SCAN_MARKETS.find((m) => m.symbol === fallbackSymbol)?.name ??
        fallbackSymbol,
      signal: {
        side: "DIGITOVER",
        digit: settings.prediction,
        label: "—",
        reason: "Blitz scan unavailable · keep current",
        confidence: "low",
        power: 0,
        windowsAgree: false,
        digitPercent: 10,
        evOk: false,
        windowsEvOk: false,
        timingOk: false,
        structureOk: false,
        separationOk: false,
        barrierAligned: false,
        windowFair: true,
        coldMarginOk: false,
        primaryBarrier: false,
        uniqueEvOk: false,
        watching: {
          lastDigit: null,
          streak: "—",
          hot: "—",
          cold: "—",
          evenOdd: "—",
          sampleSize: 0,
          signalGap: null,
          windowVotes: "—",
          windowEv: "—",
          separation: "—",
          wilsonBound: "—",
        },
      },
      score: -Infinity,
    };
  }

  const desk = {
    minColdGap: settings.minColdGap,
    minSample: settings.minSample,
    maxMomentumGap: settings.maxMomentumGap,
    side: settings.side,
  };

  const firmReady = ranked.find(
    (entry) =>
      !isLowPayoutSymbol(entry.symbol) &&
      firmSteadyCheck(entry.signal, {
        ...desk,
        side: entry.signal.side,
      }).ok,
  );
  if (firmReady) return firmReady;

  if (options.preferReady || options.requireReady) {
    const ready = ranked.find(
      (entry) =>
        !isLowPayoutSymbol(entry.symbol) &&
        isTradeReady(entry.signal, settings),
    );
    if (ready) return ready;
    if (options.requireReady) {
      return ranked.find((e) => !isLowPayoutSymbol(e.symbol)) ?? ranked[0]!;
    }
  }

  return ranked.find((e) => !isLowPayoutSymbol(e.symbol)) ?? ranked[0]!;
}
