/**
 * Pre-trade scanner — picks the steadiest profitable market + strategy fit.
 * Prefers positive expectancy (even small / “cents”) over loud confluence alone.
 */
import { accountCredentials, getAccountKind } from "../../lib/accountMode";
import { config } from "../../lib/config";
import { DerivClient } from "../../lib/deriv/client";
import { resolveAccount } from "../../lib/deriv/rest";
import { atr, latestIndicators } from "./indicators";
import { ATLAS_INSTRUMENTS, type AtlasBar } from "./instruments";
import {
  getAtlasSession,
  sessionAllowsAutoLock,
  sessionFitBonus,
} from "./sessions";
import { buildAtlasSignal, type AtlasBias } from "./signal";
import {
  ATLAS_STRATEGIES,
  runAtlasBacktest,
  strategySignals,
  strategyTradeParams,
  type AtlasStrategyId,
} from "./strategies";

export interface AtlasMarketRank {
  symbol: string;
  name: string;
  assetClass: string;
  bias: AtlasBias;
  tradeable: boolean;
  confluence: number;
  confidence: number;
  gateScore: number;
  expectedRR: number;
  riskScore: number;
  score: number;
  powerLabel: string;
  explanation: string;
  strategyId: AtlasStrategyId;
  strategyName: string;
  /** Recent-window expectancy in R (can be small and still good). */
  expectancyR: number;
  winRate: number;
  sampleTrades: number;
  fitLabel: string;
  /** Session research tag for this pick. */
  sessionLabel?: string;
}

export interface AtlasScanResult {
  ranks: AtlasMarketRank[];
  best: AtlasMarketRank | null;
  scannedAt: number;
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

/** Strategies the analyzer may auto-select to fit the tape.
 * Pullback / Pulse / Apex only — trend crosses were chasing and going red first tick.
 */
const SCAN_STRATEGIES: AtlasStrategyId[] = [
  "pullback",
  "pulse",
  "apex",
  "meanReversion",
];

type TapeRegime = {
  trending: boolean;
  hotTrend: boolean;
  quiet: boolean;
  choppy: boolean;
  /** Soft whip — prefer mean-reversion / careful pullback, not hard skip. */
  mildChop: boolean;
  adx: number;
  atrNow: number;
  atrRatio: number;
  /** Direction flips in last ~24 bars — high = whip / not steady. */
  flips: number;
};

function toBars(res: CandleResponse): AtlasBar[] {
  return (res.candles ?? [])
    .map((c) => ({
      epoch: c.epoch,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
    }))
    .filter(
      (b) =>
        Number.isFinite(b.open) &&
        Number.isFinite(b.high) &&
        Number.isFinite(b.low) &&
        Number.isFinite(b.close),
    );
}

function countDirectionFlips(bars: AtlasBar[], lookback = 24): number {
  if (bars.length < 4) return 0;
  const start = Math.max(1, bars.length - lookback);
  let flips = 0;
  let prev = 0;
  for (let i = start; i < bars.length; i += 1) {
    const d = bars[i].close - bars[i].open;
    const sign = d > 0 ? 1 : d < 0 ? -1 : 0;
    if (sign !== 0 && prev !== 0 && sign !== prev) flips += 1;
    if (sign !== 0) prev = sign;
  }
  return flips;
}

function detectRegime(bars: AtlasBar[], assetClass?: string): TapeRegime {
  const ind = latestIndicators(bars);
  const a = atr(bars, 14);
  const i = bars.length - 1;
  const atrNow = Number.isFinite(a[i]) ? a[i] : ind?.atr14 ?? 0;
  let sum = 0;
  let n = 0;
  for (let j = Math.max(0, i - 19); j <= i; j += 1) {
    if (Number.isFinite(a[j])) {
      sum += a[j];
      n += 1;
    }
  }
  const atrMean = n ? sum / n : atrNow;
  const atrRatio = atrMean > 0 ? atrNow / atrMean : 1;
  const adx = ind?.adx14 ?? 0;
  const flips = countDirectionFlips(bars, 24);
  const crypto = assetClass === "crypto";
  const trending = adx >= (crypto ? 24 : 18);
  const hotTrend =
    adx >= (crypto ? 32 : 26) &&
    atrRatio >= 1.08 &&
    flips <= (crypto ? 7 : 10);
  const quiet = atrRatio < 0.85 || adx < 14;
  // Crypto whip is loud. FX: only hard-chop on real whip — was marking everything skip.
  const choppy = crypto
    ? flips >= 8 ||
      adx < 24 ||
      atrRatio >= 1.45 ||
      (adx < 28 && flips >= 6)
    : flips >= 13 ||
      (adx < 16 && flips >= 11) ||
      (adx < 14 && atrRatio >= 1.15);
  const mildChop =
    !crypto &&
    !choppy &&
    (flips >= 10 || (adx < 20 && atrRatio >= 0.95 && atrRatio <= 1.25));
  return {
    trending,
    hotTrend,
    quiet,
    choppy,
    mildChop,
    adx,
    atrNow,
    atrRatio,
    flips,
  };
}

/** How well this strategy matches the current regime. */
function strategyFit(
  sid: AtlasStrategyId,
  regime: TapeRegime,
): { bonus: number; label: string } {
  // Hard chop only — don't skip the whole desk.
  if (regime.choppy) {
    if (sid === "meanReversion")
      return { bonus: 55, label: "range tool in chop" };
    if (sid === "pullback")
      return { bonus: -40, label: "soft in hard chop" };
    if (sid === "pulse" || sid === "apex")
      return { bonus: -80, label: "soft in hard chop" };
    return { bonus: -200, label: "unsteady chop — skip" };
  }
  if (regime.mildChop) {
    if (sid === "meanReversion")
      return { bonus: 90, label: "fits mild chop / range" };
    if (sid === "pullback")
      return { bonus: 35, label: "ok careful pullback" };
    if (sid === "pulse" || sid === "apex")
      return { bonus: 20, label: "ok careful" };
    return { bonus: -30, label: "soft fit · mild chop" };
  }
  if (regime.hotTrend) {
    if (sid === "trend" || sid === "pulse" || sid === "apex")
      return { bonus: 140, label: "steady hot trend" };
    if (sid === "pullback" || sid === "breakout")
      return { bonus: 70, label: "ok in trend" };
    if (sid === "meanReversion")
      return { bonus: -120, label: "fade vs hot trend" };
  }
  if (regime.trending) {
    if (sid === "pulse" || sid === "apex" || sid === "pullback")
      return { bonus: 110, label: "steady trend" };
    if (sid === "trend") return { bonus: 95, label: "steady trend" };
    if (sid === "meanReversion")
      return { bonus: -50, label: "weak fit · ranging tool" };
  }
  if (regime.quiet) {
    if (sid === "meanReversion")
      return { bonus: 100, label: "fits quiet / range" };
    if (sid === "pullback") return { bonus: 25, label: "ok in range" };
    if (sid === "breakout" || sid === "trend")
      return { bonus: -160, label: "trend tool in quiet" };
    if (sid === "pulse" || sid === "apex")
      return { bonus: -40, label: "soft fit · quiet" };
  }
  return { bonus: 0, label: "neutral fit" };
}

/**
 * Steady-profit score: positive expectancy + clean tape beat loud confluence.
 */
function scoreSteadySetup(args: {
  tradeable: boolean;
  bias: AtlasBias;
  confluence: number;
  confidence: number;
  gateScore: number;
  riskScore: number;
  expectedRR: number;
  expectancyR: number;
  winRate: number;
  sampleTrades: number;
  profitFactor: number;
  maxDrawdownR: number;
  fitBonus: number;
  atrNow: number;
  spread: number;
  choppy: boolean;
  flips: number;
  adx: number;
}): number {
  const {
    tradeable,
    bias,
    confluence,
    confidence,
    gateScore,
    riskScore,
    expectedRR,
    expectancyR,
    winRate,
    sampleTrades,
    profitFactor,
    maxDrawdownR,
    fitBonus,
    atrNow,
    spread,
    choppy,
    flips,
    adx,
  } = args;

  if (bias === "neutral") {
    return confluence * 0.25 + confidence * 0.1 - riskScore * 0.5 + fitBonus * 0.15;
  }

  let score = 0;

  if (choppy) score -= 420;
  if (flips >= 12) score -= 160;
  else if (flips >= 10) score -= 80;
  if (adx < 18) score -= 90;
  else if (adx >= 26) score += 80;
  else if (adx >= 22) score += 40;

  if (tradeable && confidence >= 58 && !choppy) score += 520;
  else if (tradeable && !choppy) score += 160;
  else if (tradeable && choppy) score -= 220;

  if (confidence >= 72) score += 140;
  else if (confidence >= 60) score += 70;
  else if (confidence < 55) score -= 100;

  if (expectancyR > 0.08) score += 360 + expectancyR * 400;
  else if (expectancyR > 0.03) score += 200 + expectancyR * 320;
  else if (expectancyR > 0.01) score += 60;
  else score += expectancyR * 280 - 120;

  if (sampleTrades >= 5 && winRate >= 55) score += (winRate - 50) * 7;
  else if (sampleTrades >= 5 && winRate < 50) score -= (55 - winRate) * 6;

  if (profitFactor >= 1.15) score += Math.min(profitFactor, 3) * 55;
  else if (profitFactor > 0 && profitFactor < 1) score -= 50;

  if (sampleTrades >= 8) score += 45;
  else if (sampleTrades < 3) score -= 55;

  score += confluence * 1.15 + confidence * 1.4 + gateScore * 14;
  if (expectedRR >= 1.35 && expectedRR <= 1.75) score += 50;
  else if (expectedRR > 2.1) score -= 25;

  score -= riskScore * 1.6;
  score -= maxDrawdownR * 48;
  score += fitBonus;

  const edgeVsCost = atrNow / Math.max(spread, 1e-12);
  if (edgeVsCost >= 12) score += 70;
  else if (edgeVsCost >= 8) score += 35;
  else if (edgeVsCost < 4) score -= 140;

  return score;
}

function isSteadyFit(label: string): boolean {
  return (
    /steady|fits trend|fits hot|fits quiet|ok in trend|ok in range|ok careful|fits mild|range tool/i.test(
      label,
    ) && !/unsteady chop — skip|crypto noise/i.test(label)
  );
}

function isQualityMarket(r: AtlasMarketRank): boolean {
  if (!r.tradeable || r.bias === "neutral") return false;
  if (/crypto noise|unsteady chop — skip/i.test(r.fitLabel)) return false;
  if (!isSteadyFit(r.fitLabel)) return false;
  if (r.confidence < 55 || r.confluence < 52) return false;
  // Prefer positive expectancy — skip negative edge names.
  if (r.expectancyR < 0.01) return false;
  if (r.sampleTrades >= 5 && r.winRate < 52) return false;
  if (!sessionAllowsAutoLock(r.symbol, r.assetClass)) return false;
  if (r.assetClass === "crypto") {
    return (
      r.confidence >= 68 &&
      r.confluence >= 62 &&
      r.expectancyR >= 0.05 &&
      (r.sampleTrades < 4 || r.winRate >= 56)
    );
  }
  // During prime FX, require a bit more stability.
  const sess = getAtlasSession();
  if (sess.inPrimeFx && r.sampleTrades >= 5 && r.winRate < 54) return false;
  return r.sampleTrades < 4 || r.winRate >= 50;
}

function pickBestSetup(
  ranks: AtlasMarketRank[],
  preferReady = true,
): AtlasMarketRank | null {
  if (!ranks.length) return null;

  const steady = ranks.filter(
    (r) =>
      r.bias !== "neutral" &&
      isSteadyFit(r.fitLabel) &&
      !/crypto noise|unsteady chop — skip/i.test(r.fitLabel),
  );

  const fxMetal = steady.filter(
    (r) => r.assetClass === "forex" || r.assetClass === "metal",
  );
  const crypto = steady.filter((r) => r.assetClass === "crypto");

  const rankQuality = (pool: AtlasMarketRank[]) => {
    const elite = pool
      .filter(isQualityMarket)
      .filter((r) => r.confidence >= 58 && r.expectancyR >= 0.02)
      .sort((a, b) => {
        // Win rate + expectancy beat raw score when both are READY.
        const aEdge =
          a.score +
          a.expectancyR * 200 +
          (a.winRate || 0) * 3 +
          (a.symbol === "frxEURUSD" && getAtlasSession().inPrimeFx ? 80 : 0);
        const bEdge =
          b.score +
          b.expectancyR * 200 +
          (b.winRate || 0) * 3 +
          (b.symbol === "frxEURUSD" && getAtlasSession().inPrimeFx ? 80 : 0);
        return bEdge - aEdge;
      });
    if (elite.length) {
      const buys = elite.filter((r) => r.bias === "buy");
      const sells = elite.filter((r) => r.bias === "sell");
      if (buys.length && sells.length) {
        const buy = buys[0];
        const sell = sells[0];
        const buyEdge =
          buy.expectancyR * 160 +
          buy.confidence * 2.2 +
          buy.score +
          buy.winRate * 2;
        const sellEdge =
          sell.expectancyR * 160 +
          sell.confidence * 2.2 +
          sell.score +
          sell.winRate * 2;
        return buyEdge >= sellEdge ? buy : sell;
      }
      return elite[0];
    }
    const ready = pool
      .filter(isQualityMarket)
      .sort((a, b) => b.score - a.score);
    return ready[0] ?? null;
  };

  const fxPick = rankQuality(fxMetal);
  if (fxPick) return fxPick;

  // During researched peak FX hours — never fall back to crypto.
  if (getAtlasSession().inPrimeFx) {
    const warmingFx = fxMetal
      .filter(
        (r) =>
          r.bias !== "neutral" &&
          r.confidence >= 48 &&
          r.confluence >= 45,
      )
      .sort((a, b) => b.score - a.score);
    if (warmingFx.length) return warmingFx[0];
    const anyFx = ranks
      .filter(
        (r) =>
          (r.assetClass === "forex" || r.assetClass === "metal") &&
          r.bias !== "neutral",
      )
      .sort((a, b) => b.score - a.score);
    return anyFx[0] ?? null;
  }

  const cryptoPick = rankQuality(crypto);
  if (cryptoPick) return cryptoPick;

  // Keep moving: best FX lean even if Almost — bot switches market+strategy.
  const warming = fxMetal
    .filter(
      (r) =>
        r.bias !== "neutral" &&
        r.confidence >= 48 &&
        r.confluence >= 45 &&
        !/crypto noise/i.test(r.fitLabel),
    )
    .sort((a, b) => b.score - a.score);
  if (warming.length) return warming[0];

  if (preferReady) {
    const anyFx = ranks
      .filter(
        (r) =>
          (r.assetClass === "forex" || r.assetClass === "metal") &&
          r.bias !== "neutral" &&
          !/crypto noise/i.test(r.fitLabel),
      )
      .sort((a, b) => b.score - a.score);
    return anyFx[0] ?? null;
  }

  return ranks.sort((a, b) => b.score - a.score)[0] ?? null;
}

async function withScanClient<T>(fn: (client: DerivClient) => Promise<T>): Promise<T> {
  const kind = getAccountKind();
  const creds = accountCredentials(kind);
  const token = creds.token || config.token;
  if (!config.appId || !token) {
    throw new Error("Deriv credentials missing — configure .env");
  }
  const account = await resolveAccount(
    { appId: config.appId, restUrl: config.restUrl, token },
    kind === "real" ? "real" : "demo",
    creds.accountId || undefined,
  );
  const client = new DerivClient({
    appId: config.appId,
    restUrl: config.restUrl,
    token,
    accountId: account.accountId,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const t = window.setTimeout(
        () => reject(new Error("Scan connect timeout")),
        20_000,
      );
      const off = client.onStateChange((state) => {
        if (state === "ready") {
          window.clearTimeout(t);
          off();
          resolve();
        }
        if (state === "error" || state === "closed") {
          window.clearTimeout(t);
          off();
          reject(new Error("Scan connection failed"));
        }
      });
      client.connect();
    });
    return await fn(client);
  } finally {
    client.disconnect();
  }
}

async function fetchHistory(
  client: DerivClient,
  symbol: string,
  granularity: number,
  count: number,
): Promise<AtlasBar[]> {
  const res = await client.send<CandleResponse>({
    ticks_history: symbol,
    adjust_start_time: 1,
    style: "candles",
    granularity,
    count,
    end: "latest",
  });
  return toBars(res);
}

function evaluateSymbolStrategies(
  inst: (typeof ATLAS_INSTRUMENTS)[number],
  bars: AtlasBar[],
  strategies: AtlasStrategyId[],
): AtlasMarketRank {
  const regime = detectRegime(bars, inst.assetClass);
  let best: AtlasMarketRank | null = null;

  // Crypto: only allow selective strategies — no naked trend chase.
  const allowed =
    inst.assetClass === "crypto"
      ? strategies.filter((s) => s === "pullback" || s === "apex" || s === "pulse")
      : strategies;

  for (const sid of allowed.length ? allowed : strategies) {
    const meta = ATLAS_STRATEGIES.find((s) => s.id === sid) ?? ATLAS_STRATEGIES[0];
    const signal = buildAtlasSignal(bars, inst.spread, sid);
    const fit = strategyFit(sid, regime);
    const params = strategyTradeParams(sid);
    const bt =
      bars.length >= 80
        ? runAtlasBacktest(
            bars,
            strategySignals(sid, bars),
            inst.spread,
            params.atrMult,
            params.rMultiple,
          )
        : null;

    const expectancyR = bt?.expectancyR ?? 0;
    const winRate = bt?.winRate ?? 0;
    const sampleTrades = bt?.trades ?? 0;
    const profitFactor = bt?.profitFactor ?? 0;
    const maxDrawdownR = bt?.maxDrawdownR ?? 0;

    const skipChop =
      (regime.choppy && /unsteady chop — skip/i.test(fit.label)) ||
      (inst.assetClass === "crypto" &&
        (regime.flips >= 8 || regime.adx < 26 || expectancyR < 0.04));
    const cryptoOk =
      inst.assetClass !== "crypto" ||
      (!skipChop &&
        !!signal?.tradeable &&
        (signal?.confidence ?? 0) >= 68 &&
        expectancyR >= 0.05);
    const sessFit = sessionFitBonus(inst.symbol, inst.assetClass);
    const sessionOk = sessionAllowsAutoLock(inst.symbol, inst.assetClass);
    const row: AtlasMarketRank = !signal
      ? {
          symbol: inst.symbol,
          name: inst.name,
          assetClass: inst.assetClass,
          bias: "neutral",
          tradeable: false,
          confluence: 0,
          confidence: 0,
          gateScore: 0,
          expectedRR: 0,
          riskScore: 100,
          score: -1000 + fit.bonus + sessFit.bonus,
          powerLabel: "Waiting",
          explanation: "Not enough bars",
          strategyId: sid,
          strategyName: meta.name,
          expectancyR,
          winRate,
          sampleTrades,
          fitLabel: fit.label,
          sessionLabel: sessFit.label,
        }
      : {
          symbol: inst.symbol,
          name: inst.name,
          assetClass: inst.assetClass,
          bias: signal.bias,
          tradeable:
            signal.tradeable && !skipChop && cryptoOk && sessionOk,
          confluence: signal.confluence,
          confidence: signal.confidence,
          gateScore: signal.gateScore,
          expectedRR: signal.expectedRR,
          riskScore: signal.riskScore,
          score: (() => {
            let s = scoreSteadySetup({
              tradeable:
                signal.tradeable && !skipChop && cryptoOk && sessionOk,
              bias: signal.bias,
              confluence: signal.confluence,
              confidence: signal.confidence,
              gateScore: signal.gateScore,
              riskScore: signal.riskScore,
              expectedRR: signal.expectedRR,
              expectancyR,
              winRate,
              sampleTrades,
              profitFactor,
              maxDrawdownR,
              fitBonus: fit.bonus,
              atrNow: regime.atrNow || signal.stopDistance,
              spread: inst.spread,
              choppy: regime.choppy,
              flips: regime.flips,
              adx: regime.adx,
            });
            s += sessFit.bonus;
            // Win-rate / expectancy research weight — stable edges first.
            if (sampleTrades >= 5 && winRate >= 55) s += (winRate - 50) * 8;
            if (expectancyR >= 0.05) s += 100;
            else if (expectancyR < 0) s -= 160;
            if (inst.assetClass === "crypto") {
              s -= 380;
              if (regime.choppy || regime.flips >= 7) s -= 280;
              if (regime.adx < 28) s -= 180;
              if (expectancyR < 0.05) s -= 160;
            } else if (
              inst.assetClass === "forex" ||
              inst.assetClass === "metal"
            ) {
              if (regime.trending && !regime.choppy) s += 120;
              if (expectancyR > 0.03 && signal.tradeable) s += 90;
            }
            if (!sessionOk) s -= 250;
            return s;
          })(),
          powerLabel:
            !sessionOk
              ? "Off-session"
              : skipChop || !cryptoOk
                ? inst.assetClass === "crypto"
                  ? "Crypto skip"
                  : "Unsteady"
                : signal.powerLabel,
          explanation:
            !sessionOk
              ? `${signal.explanation} · skipped — wrong session (${sessFit.label})`
              : skipChop || !cryptoOk
                ? `${signal.explanation} · skipped — ${
                    inst.assetClass === "crypto"
                      ? "crypto tape not elite enough"
                      : `tape not steady (${fit.label})`
                  }`
                : `${signal.explanation} · session ${sessFit.label}`,
          strategyId: sid,
          strategyName: meta.name,
          expectancyR,
          winRate,
          sampleTrades,
          fitLabel:
            inst.assetClass === "crypto" && (skipChop || !cryptoOk)
              ? "crypto noise — skip"
              : fit.label,
          sessionLabel: sessFit.label,
        };

    if (!best || row.score > best.score) best = row;
  }

  return best!;
}

/** Re-rank from cached bars every second (no network) — keeps the desk live. */
export function rankAtlasBarCache(
  barCache: Map<string, AtlasBar[]>,
  strategyId: AtlasStrategyId,
  preferReady = true,
): AtlasScanResult {
  const strategies = Array.from(
    new Set<AtlasStrategyId>([strategyId, ...SCAN_STRATEGIES]),
  );
  const ranks: AtlasMarketRank[] = [];
  for (const inst of ATLAS_INSTRUMENTS) {
    const bars = barCache.get(inst.symbol);
    if (!bars || bars.length < 80) continue;
    ranks.push(evaluateSymbolStrategies(inst, bars, strategies));
  }
  ranks.sort((a, b) => b.score - a.score);
  return {
    ranks,
    best: pickBestSetup(ranks, preferReady),
    scannedAt: Date.now(),
  };
}

/**
 * Rank every Atlas market across strategies; pick steadiest profit + fit.
 * Also returns a bar cache for continuous 1s re-ranking while the bot runs.
 */
export async function findBestAtlasMarket(args: {
  granularitySec: number;
  strategyId: AtlasStrategyId;
  preferReady?: boolean;
  barCount?: number;
  gapMs?: number;
}): Promise<AtlasScanResult & { barCache: Map<string, AtlasBar[]> }> {
  const {
    granularitySec,
    strategyId,
    preferReady = true,
    barCount = 240,
    gapMs = 140,
  } = args;

  const strategies = Array.from(
    new Set<AtlasStrategyId>([strategyId, ...SCAN_STRATEGIES]),
  );
  const barCache = new Map<string, AtlasBar[]>();

  const ranks = await withScanClient(async (client) => {
    const out: AtlasMarketRank[] = [];
    for (const inst of ATLAS_INSTRUMENTS) {
      try {
        const bars = await fetchHistory(
          client,
          inst.symbol,
          granularitySec,
          barCount,
        );
        barCache.set(inst.symbol, bars);
        out.push(evaluateSymbolStrategies(inst, bars, strategies));
      } catch {
        out.push({
          symbol: inst.symbol,
          name: inst.name,
          assetClass: inst.assetClass,
          bias: "neutral",
          tradeable: false,
          confluence: 0,
          confidence: 0,
          gateScore: 0,
          expectedRR: 0,
          riskScore: 100,
          score: -2000,
          powerLabel: "Error",
          explanation: "Scan failed for this market",
          strategyId,
          strategyName:
            ATLAS_STRATEGIES.find((s) => s.id === strategyId)?.name ?? strategyId,
          expectancyR: 0,
          winRate: 0,
          sampleTrades: 0,
          fitLabel: "scan error",
        });
      }
      await new Promise((r) => setTimeout(r, gapMs));
    }
    return out;
  });

  ranks.sort((a, b) => b.score - a.score);
  const best = pickBestSetup(ranks, preferReady);

  return { ranks, best, scannedAt: Date.now(), barCache };
}
