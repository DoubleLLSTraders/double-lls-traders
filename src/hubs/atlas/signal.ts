import { atr, ema, latestIndicators } from "./indicators";
import type { AtlasBar } from "./instruments";
import { detectPatterns, type AtlasPattern } from "./patterns";
import {
  ATLAS_STRATEGIES,
  latestStrategySignal,
  strategyTradeParams,
  type AtlasStrategyId,
} from "./strategies";

export type AtlasBias = "buy" | "sell" | "neutral";

export interface ConfluenceFactor {
  id: string;
  label: string;
  side: "buy" | "sell" | "neutral";
  weight: number;
  hit: boolean;
}

export interface AtlasSignal {
  bias: AtlasBias;
  buyProbability: number;
  sellProbability: number;
  neutralProbability: number;
  confidence: number;
  riskScore: number;
  expectedRR: number;
  expectedHoldBars: number;
  explanation: string;
  patterns: AtlasPattern[];
  stopDistance: number;
  targetDistance: number;
  /** How many weighted factors agree with the bias (0–100). */
  confluence: number;
  factors: ConfluenceFactor[];
  /** True only when the Apex gate would allow a trade. */
  tradeable: boolean;
  /** EMA stack + price vs EMA50 agree with bias — hard rule for entries. */
  stackAligned: boolean;
  strategyName: string;
  /** Plain-English power read for the desk. */
  powerLabel: string;
  /** Gate agreement score (0–9). */
  gateScore: number;
}

function structureBias(bars: AtlasBar[]): "buy" | "sell" | "neutral" {
  if (bars.length < 30) return "neutral";
  const slice = bars.slice(-30);
  const mid = Math.floor(slice.length / 2);
  const first = slice.slice(0, mid);
  const second = slice.slice(mid);
  const hi1 = Math.max(...first.map((b) => b.high));
  const lo1 = Math.min(...first.map((b) => b.low));
  const hi2 = Math.max(...second.map((b) => b.high));
  const lo2 = Math.min(...second.map((b) => b.low));
  if (hi2 > hi1 && lo2 > lo1) return "buy";
  if (hi2 < hi1 && lo2 < lo1) return "sell";
  return "neutral";
}

function momentumBurst(closes: number[]): "buy" | "sell" | "neutral" {
  if (closes.length < 8) return "neutral";
  const recent = closes.slice(-5);
  const prior = closes.slice(-8, -5);
  const rMove = recent[recent.length - 1] - recent[0];
  const pMove = prior[prior.length - 1] - prior[0];
  if (rMove > 0 && rMove > Math.abs(pMove) * 0.55) return "buy";
  if (rMove < 0 && Math.abs(rMove) > Math.abs(pMove) * 0.55) return "sell";
  return "neutral";
}

/** Last N closes: directional pressure (not a crystal ball). */
function closePressure(
  closes: number[],
  n: number,
): "buy" | "sell" | "neutral" {
  if (closes.length < n + 1) return "neutral";
  let up = 0;
  let down = 0;
  for (let i = closes.length - n; i < closes.length; i += 1) {
    if (closes[i] > closes[i - 1]) up += 1;
    else if (closes[i] < closes[i - 1]) down += 1;
  }
  if (up >= n - 1) return "buy";
  if (down >= n - 1) return "sell";
  return "neutral";
}

/**
 * Late chase / exhaustion — e.g. SELL after a vertical dump far under EMA20.
 * Real desk waits for a pullback or a fresh controlled move, not the blow-off bar.
 */
function lateChase(
  bars: AtlasBar[],
  bias: "buy" | "sell",
  ema20: number,
  atrNow: number,
  rsi14: number,
): boolean {
  if (!(atrNow > 0) || bars.length < 8) return false;
  const closes = bars.map((b) => b.close);
  const i = closes.length - 1;
  const close = closes[i];
  const look = Math.min(5, i);
  const move = close - closes[i - look];
  const moveAtr = Math.abs(move) / atrNow;
  const extFromEma = Math.abs(close - ema20) / atrNow;

  // Already ran hard in the trade direction → chasing.
  if (bias === "sell" && move < 0 && moveAtr >= 1.35) return true;
  if (bias === "buy" && move > 0 && moveAtr >= 1.35) return true;

  // Price stretched far from EMA20 — wait for tag / pullback.
  if (bias === "sell" && close < ema20 && extFromEma >= 1.55) return true;
  if (bias === "buy" && close > ema20 && extFromEma >= 1.55) return true;

  // RSI already extreme in the chase direction.
  if (bias === "sell" && rsi14 <= 28 && moveAtr >= 0.85) return true;
  if (bias === "buy" && rsi14 >= 72 && moveAtr >= 0.85) return true;

  // Last 3 candles all same color and large — exhaustion cascade.
  if (bars.length >= 3) {
    const last3 = bars.slice(-3);
    const allBear = last3.every((b) => b.close < b.open);
    const allBull = last3.every((b) => b.close > b.open);
    const span =
      Math.max(...last3.map((b) => b.high)) -
      Math.min(...last3.map((b) => b.low));
    if (span / atrNow >= 1.8) {
      if (bias === "sell" && allBear) return true;
      if (bias === "buy" && allBull) return true;
    }
  }
  return false;
}

/**
 * Entry timing: don't fire into the opposite candle.
 * SELL needs bearish close or rejection; BUY needs bullish close or reclaim.
 */
function entryTimingOk(
  bars: AtlasBar[],
  bias: "buy" | "sell",
  ema20: number,
  atrNow: number,
): boolean {
  if (bars.length < 3 || !(atrNow > 0)) return false;
  const cur = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const curBull = cur.close > cur.open;
  const curBear = cur.close < cur.open;
  const prevBull = prev.close > prev.open;
  const prevBear = prev.close < prev.open;
  const body = Math.abs(cur.close - cur.open);

  // Hard block: large candle fighting the trade.
  if (bias === "sell" && curBull && body >= atrNow * 0.35) return false;
  if (bias === "buy" && curBear && body >= atrNow * 0.35) return false;

  if (bias === "sell") {
    const tagged =
      cur.high >= ema20 - atrNow * 0.15 && cur.close <= ema20 + atrNow * 0.05;
    return prevBear || curBear || tagged;
  }
  const tagged =
    cur.low <= ema20 + atrNow * 0.15 && cur.close >= ema20 - atrNow * 0.05;
  return prevBull || curBull || tagged;
}

/**
 * Live analyzer — confluence desk + selected strategy hard gate.
 * Sparse, profit-first entries. Strong filter — not a guarantee of profit.
 */
export function buildAtlasSignal(
  bars: AtlasBar[],
  spread: number,
  strategyId: AtlasStrategyId = "apex",
): AtlasSignal | null {
  const ind = latestIndicators(bars);
  if (!ind || bars.length < 80) return null;
  const last = bars[bars.length - 1];
  const closes = bars.map((b) => b.close);
  const patterns = detectPatterns(bars);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const i = bars.length - 1;
  const atrLine = atr(bars, 14);
  const atrNow = Math.max(atrLine[i] || ind.atr14, spread * 2, last.close * 0.0005);
  const stratSig = latestStrategySignal(strategyId, bars);
  const stratMeta =
    ATLAS_STRATEGIES.find((s) => s.id === strategyId) ?? ATLAS_STRATEGIES[0];
  const params = strategyTradeParams(strategyId);

  // ATR regime: expanding vs 20-bar mean favors trend entries.
  let atrMean = 0;
  let atrN = 0;
  for (let j = Math.max(0, i - 19); j <= i; j += 1) {
    if (Number.isFinite(atrLine[j])) {
      atrMean += atrLine[j];
      atrN += 1;
    }
  }
  atrMean = atrN ? atrMean / atrN : atrNow;
  const volExpanding = atrNow >= atrMean * 1.05;
  const volQuiet = atrNow < atrMean * 0.85;

  const factors: ConfluenceFactor[] = [];

  const trendSide: "buy" | "sell" =
    ind.ema20 > ind.ema50 ? "buy" : "sell";
  const priceVsE50: "buy" | "sell" =
    last.close >= ind.ema50 ? "buy" : "sell";
  const e50Slope =
    Number.isFinite(e50[i]) && Number.isFinite(e50[i - 5])
      ? e50[i] - e50[i - 5]
      : 0;
  const e50Side: "buy" | "sell" = e50Slope >= 0 ? "buy" : "sell";
  const stackBull =
    ind.ema20 > ind.ema50 && last.close > ind.ema50 && e50Slope >= 0;
  const stackBear =
    ind.ema20 < ind.ema50 && last.close < ind.ema50 && e50Slope <= 0;

  factors.push({
    id: "ema-stack",
    label: `EMA20 ${trendSide === "buy" ? ">" : "<"} EMA50`,
    side: trendSide,
    weight: 22,
    hit: true,
  });
  factors.push({
    id: "price-ema50",
    label: `Price ${priceVsE50 === "buy" ? "above" : "below"} EMA50`,
    side: priceVsE50,
    weight: 18,
    hit: true,
  });
  factors.push({
    id: "ema50-slope",
    label: `EMA50 slope ${e50Slope >= 0 ? "up" : "down"}`,
    side: e50Side,
    weight: 14,
    hit: Math.abs(e50Slope) > atrNow * 0.08,
  });

  if (ind.sma200 != null) {
    const side: "buy" | "sell" = last.close > ind.sma200 ? "buy" : "sell";
    const distAtr = Math.abs(last.close - ind.sma200) / atrNow;
    factors.push({
      id: "sma200",
      label: `Price ${side === "buy" ? "above" : "below"} SMA200`,
      side,
      weight: 14,
      hit: true,
    });
    // Strong separation from SMA200 = cleaner trend.
    if (distAtr >= 0.8) {
      factors.push({
        id: "sma200-sep",
        label: `Trend distance ${distAtr.toFixed(1)}ATR`,
        side,
        weight: 8,
        hit: true,
      });
    }
  }

  const macdSide: "buy" | "sell" = ind.macdHist >= 0 ? "buy" : "sell";
  factors.push({
    id: "macd",
    label: `MACD hist ${ind.macdHist >= 0 ? "+" : ""}${ind.macdHist.toFixed(4)}`,
    side: macdSide,
    weight: 12,
    hit: true,
  });

  let rsiSide: "buy" | "sell" | "neutral" = "neutral";
  // Symmetric mid-band both ways (was sell-leaning 38–58 vs buy 42–62).
  if (trendSide === "buy" && ind.rsi14 >= 40 && ind.rsi14 <= 60) rsiSide = "buy";
  else if (trendSide === "sell" && ind.rsi14 >= 40 && ind.rsi14 <= 60)
    rsiSide = "sell";
  else if (ind.rsi14 <= 30) rsiSide = "buy";
  else if (ind.rsi14 >= 70) rsiSide = "sell";
  factors.push({
    id: "rsi-zone",
    label: `RSI ${ind.rsi14.toFixed(1)} zone`,
    side: rsiSide,
    weight: 12,
    hit: rsiSide !== "neutral",
  });

  const adxStrong = ind.adx14 >= 18;
  const adxHot = ind.adx14 >= 26;
  // ADX only votes with trend when truly trending — stops quiet tape cloning EMA side.
  const adxSide: "buy" | "sell" | "neutral" = adxStrong ? trendSide : "neutral";
  factors.push({
    id: "adx",
    label: `ADX ${ind.adx14.toFixed(1)} ${adxHot ? "hot" : adxStrong ? "trending" : "quiet"}`,
    side: adxSide,
    weight: 14,
    hit: adxStrong,
  });

  factors.push({
    id: "vol-regime",
    label: volExpanding
      ? "Volatility expanding"
      : volQuiet
        ? "Volatility quiet"
        : "Volatility normal",
    side: volExpanding && adxStrong ? trendSide : "neutral",
    weight: 10,
    hit: volExpanding && adxStrong,
  });

  const struct = structureBias(bars);
  factors.push({
    id: "structure",
    label:
      struct === "buy"
        ? "HH/HL structure"
        : struct === "sell"
          ? "LH/LL structure"
          : "Range structure",
    side: struct,
    weight: 14,
    hit: struct !== "neutral",
  });

  const burst = momentumBurst(closes);
  factors.push({
    id: "burst",
    label:
      burst === "neutral" ? "No momentum burst" : `${burst.toUpperCase()} burst`,
    side: burst,
    weight: 10,
    hit: burst !== "neutral",
  });

  const pressure = closePressure(closes, 4);
  factors.push({
    id: "pressure",
    label:
      pressure === "neutral"
        ? "Mixed closes"
        : `${pressure.toUpperCase()} pressure`,
    side: pressure,
    weight: 10,
    hit: pressure !== "neutral",
  });

  const slope =
    Number.isFinite(e20[i]) && Number.isFinite(e20[i - 5])
      ? e20[i] - e20[i - 5]
      : 0;
  const slopeSide: "buy" | "sell" = slope >= 0 ? "buy" : "sell";
  factors.push({
    id: "ema-slope",
    label: `EMA20 slope ${slope >= 0 ? "up" : "down"}`,
    side: slopeSide,
    weight: 10,
    hit: Math.abs(slope) > atrNow * 0.12,
  });

  // Candle body strength (real body vs ATR).
  const body = Math.abs(last.close - last.open);
  const bodySide: "buy" | "sell" =
    last.close >= last.open ? "buy" : "sell";
  if (body >= atrNow * 0.45) {
    factors.push({
      id: "body",
      label: `Strong ${bodySide} body`,
      side: bodySide,
      weight: 8,
      hit: true,
    });
  }

  const topPattern = patterns[0] ?? null;
  if (topPattern && topPattern.direction !== "neutral") {
    factors.push({
      id: "pattern",
      label: topPattern.name,
      side: topPattern.direction === "bull" ? "buy" : "sell",
      weight: 12,
      hit: topPattern.confidence >= 55,
    });
  }

  const impulse =
    i > 0 ? (closes[i] - closes[i - 1]) / atrNow : 0;
  if (Math.abs(impulse) >= 0.3) {
    factors.push({
      id: "impulse",
      label: `Bar impulse ${impulse >= 0 ? "+" : ""}${impulse.toFixed(2)}ATR`,
      side: impulse >= 0 ? "buy" : "sell",
      weight: 8,
      hit: true,
    });
  }

  // Research drivers: what pushes tape up or down right now.
  const e50Dist = (last.close - ind.ema50) / atrNow;
  if (Math.abs(e50Dist) >= 0.35) {
    factors.push({
      id: "ema50-magnet",
      label:
        e50Dist > 0
          ? `Stretch +${e50Dist.toFixed(1)}ATR above EMA50`
          : `Stretch ${e50Dist.toFixed(1)}ATR below EMA50`,
      side: e50Dist > 0 ? "buy" : "sell",
      weight: 9,
      hit: true,
    });
  }

  let up6 = 0;
  let dn6 = 0;
  for (let j = closes.length - 6; j < closes.length; j += 1) {
    if (j <= 0) continue;
    if (closes[j] > closes[j - 1]) up6 += 1;
    else if (closes[j] < closes[j - 1]) dn6 += 1;
  }
  if (up6 >= 5 || dn6 >= 5) {
    factors.push({
      id: "drive-6",
      label: up6 >= 5 ? "6-bar upside drive" : "6-bar downside drive",
      side: up6 >= 5 ? "buy" : "sell",
      weight: 11,
      hit: true,
    });
  }

  const rangeNow = Math.max(last.high - last.low, 1e-12);
  const closeLoc = (last.close - last.low) / rangeNow;
  if (closeLoc >= 0.75 || closeLoc <= 0.25) {
    factors.push({
      id: "close-location",
      label:
        closeLoc >= 0.75
          ? "Close near highs (buyers)"
          : "Close near lows (sellers)",
      side: closeLoc >= 0.75 ? "buy" : "sell",
      weight: 9,
      hit: true,
    });
  }

  let buyScore = 0;
  let sellScore = 0;
  let weightTotal = 0;
  for (const f of factors) {
    weightTotal += f.weight;
    if (!f.hit || f.side === "neutral") continue;
    if (f.side === "buy") buyScore += f.weight;
    else sellScore += f.weight;
  }

  const buyProbability = weightTotal
    ? (buyScore / weightTotal) * 100
    : 33;
  const sellProbability = weightTotal
    ? (sellScore / weightTotal) * 100
    : 33;
  const neutralProbability = Math.max(
    0,
    100 - buyProbability - sellProbability,
  );

  const leadGap = Math.abs(buyProbability - sellProbability);
  const rawBias: AtlasBias =
    buyProbability >= sellProbability + 5 && buyProbability >= 42
      ? "buy"
      : sellProbability >= buyProbability + 5 && sellProbability >= 42
        ? "sell"
        : "neutral";

  const agreeing = factors.filter(
    (f) => f.hit && f.side === rawBias && rawBias !== "neutral",
  );
  const agreeingWeight = agreeing.reduce((s, f) => s + f.weight, 0);
  const confluence =
    rawBias === "neutral"
      ? Math.max(buyProbability, sellProbability)
      : Math.min(99, (agreeingWeight / Math.max(weightTotal, 1)) * 100);

  const structureOk =
    rawBias !== "neutral" && struct === rawBias;
  const macdOk = rawBias !== "neutral" && macdSide === rawBias;
  const pressureOk =
    rawBias !== "neutral" &&
    (pressure === rawBias || pressure === "neutral");
  const slopeOk = rawBias !== "neutral" && slopeSide === rawBias;
  const strategyOk =
    (stratSig === 1 && rawBias === "buy") ||
    (stratSig === -1 && rawBias === "sell");
  const trendOk = rawBias !== "neutral" && trendSide === rawBias;
  const stackOk =
    (rawBias === "buy" && stackBull) || (rawBias === "sell" && stackBear);
  // Never buy a bounce in a downtrend (or sell a dip in an uptrend).
  const againstStack =
    (rawBias === "buy" && !stackBull) || (rawBias === "sell" && !stackBear);
  const rsiAgainst =
    (rawBias === "buy" && ind.rsi14 >= 68) ||
    (rawBias === "sell" && ind.rsi14 <= 32);
  const chasing =
    rawBias !== "neutral" &&
    lateChase(bars, rawBias, ind.ema20, atrNow, ind.rsi14);
  const timingOk =
    rawBias === "neutral" ||
    entryTimingOk(bars, rawBias, ind.ema20, atrNow);

  let gateScore = 0;
  if (strategyOk) gateScore += 2;
  if (trendOk) gateScore += 2;
  if (stackOk) gateScore += 2;
  if (structureOk) gateScore += 1;
  if (macdOk) gateScore += 1;
  if (pressureOk) gateScore += 1;
  if (slopeOk || e50Side === rawBias) gateScore += 1;
  if (adxStrong) gateScore += 1;
  if (!volQuiet) gateScore += 1;
  if (rsiSide === rawBias) gateScore += 1;
  if (!chasing) gateScore += 1;
  if (timingOk) gateScore += 1;

  // Soft READY: very strong confluence can fire without waiting one strategy candle.
  const softReady =
    rawBias !== "neutral" &&
    !againstStack &&
    !rsiAgainst &&
    !chasing &&
    timingOk &&
    stackOk &&
    trendOk &&
    adxStrong &&
    (pressure === rawBias || pressure === "neutral") &&
    confluence >= 70 &&
    leadGap >= 6 &&
    gateScore >= 7 &&
    (structureOk || macdOk || strategyOk);

  // Real-market desk: stack + trend + timing + no late chase.
  const tradeable =
    softReady ||
    (rawBias !== "neutral" &&
      !againstStack &&
      !rsiAgainst &&
      !chasing &&
      timingOk &&
      stackOk &&
      trendOk &&
      adxStrong &&
      pressure === rawBias &&
      confluence >= 55 &&
      leadGap >= 8 &&
      gateScore >= 8 &&
      (strategyId === "pulse"
        ? strategyOk && (structureOk || macdOk) && confluence >= 58
        : strategyOk && confluence >= 55));

  const displayBias = againstStack || chasing || !timingOk
    ? "neutral"
    : tradeable || (confluence >= 50 && stackOk)
      ? rawBias
      : confluence < 40
        ? "neutral"
        : rawBias;

  const stackAligned =
    displayBias === "neutral"
      ? false
      : (displayBias === "buy" && stackBull) ||
        (displayBias === "sell" && stackBear);

  const confidence = Math.min(
    97,
    Math.max(
      18,
      confluence * 0.5 +
        leadGap * 0.28 +
        gateScore * 3.2 +
        (adxStrong ? 6 : 0) +
        (adxHot ? 5 : 0) +
        (strategyOk ? 10 : 0) +
        (stackOk ? 12 : 0) +
        (structureOk ? 6 : 0) +
        (topPattern && topPattern.direction !== "neutral" ? 2 : 0) -
        (displayBias === "neutral" ? 14 : 0) -
        (againstStack ? 20 : 0) -
        (chasing ? 22 : 0) -
        (volQuiet ? 8 : 0),
    ),
  );

  const tradeableStrict =
    tradeable &&
    stackAligned &&
    !chasing &&
    timingOk &&
    (softReady ? confidence >= 55 : confidence >= 58);

  const rrMultiple =
    adxHot && confluence >= 65 ? Math.max(params.rMultiple, 1.8) : params.rMultiple;
  const stopMult = params.atrMult;
  const stopDistance = atrNow * stopMult;
  const targetDistance = stopDistance * rrMultiple;
  const expectedRR = rrMultiple;

  const riskScore = Math.min(
    100,
    Math.round(
      12 +
        (spread / atrNow) * 30 +
        (adxStrong ? 0 : 12) +
        (volQuiet ? 10 : 0) +
        (displayBias === "neutral" ? 14 : 0) +
        (100 - confidence) * 0.22 +
        (tradeableStrict ? 0 : 10) +
        (chasing ? 18 : 0),
    ),
  );

  const powerLabel =
    tradeableStrict && confluence >= 70 && confidence >= 72
      ? "High power"
      : tradeableStrict
        ? "Ready"
        : softReady
          ? "Ready"
          : gateScore >= 6 && confluence >= 52
            ? "Almost"
            : confluence >= 42
              ? "Building"
              : "Waiting";

  const factorLine = factors
    .filter((f) => f.hit && f.side === displayBias)
    .slice(0, 5)
    .map((f) => f.label)
    .join(" · ");

  const blocked = [
    againstStack ? "against EMA stack — no counter-trend" : null,
    chasing ? "late chase — wait pullback (not after a dump/rally)" : null,
    !timingOk ? "bad candle timing — wait agreeing bar" : null,
    pressure !== rawBias && rawBias !== "neutral" && !softReady
      ? "close pressure fights entry"
      : null,
    !stackOk ? "need EMA20/50 + price stack" : null,
    !trendOk ? "trend soft" : null,
    !adxStrong ? "ADX weak" : null,
    !strategyOk && !softReady ? "need strategy candle" : null,
    rsiAgainst ? "RSI extreme against entry" : null,
    gateScore < 7 ? `only ${gateScore} factors` : null,
    confluence < 55 && !softReady ? "confluence soft" : null,
    confidence < 55 ? `confidence ${confidence.toFixed(0)}` : null,
    volQuiet ? "vol quiet" : null,
  ].filter(Boolean);

  const explanation = tradeableStrict
    ? `${stratMeta.name.toUpperCase()} ${displayBias.toUpperCase()} · ${powerLabel} · timed entry · stack OK · confluence ${confluence.toFixed(0)}% · conf ${confidence.toFixed(0)} · ${factorLine}. Target ${rrMultiple.toFixed(1)}R.`
    : chasing
      ? `${stratMeta.name} HOLD · ${rawBias.toUpperCase()} looks extended — analyzer wants a pullback/tag, not chasing the dump.`
      : !timingOk && (rawBias === "buy" || rawBias === "sell")
        ? `${stratMeta.name} HOLD · candle timing fights ${rawBias.toUpperCase()} — waiting for agreeing bar.`
      : againstStack
      ? `${stratMeta.name} BLOCKED · ${rawBias.toUpperCase()} lean fights EMA stack (EMA20 ${trendSide === "buy" ? ">" : "<"} EMA50). Real-market rule: no counter-trend entries.`
      : displayBias === "neutral"
        ? `${stratMeta.name} HOLD · tape mixed (buy ${buyProbability.toFixed(0)}% / sell ${sellProbability.toFixed(0)}%).`
        : softReady
          ? `${stratMeta.name} ${displayBias.toUpperCase()} · soft READY · conf ${confidence.toFixed(0)} · confluence ${confluence.toFixed(0)}% (strategy candle optional).`
          : `${stratMeta.name} ${powerLabel} ${displayBias.toUpperCase()} · conf ${confidence.toFixed(0)} · ${blocked.join(", ") || "warming"}.`;

  return {
    bias: displayBias,
    buyProbability,
    sellProbability,
    neutralProbability,
    confidence,
    riskScore,
    expectedRR,
    expectedHoldBars: adxHot ? 8 : 5,
    explanation,
    patterns,
    stopDistance,
    targetDistance,
    confluence,
    factors,
    tradeable: tradeableStrict || softReady,
    stackAligned,
    strategyName: stratMeta.name,
    powerLabel: tradeableStrict || softReady ? (confluence >= 70 ? "Ready" : powerLabel) : powerLabel,
    gateScore,
  };
}
