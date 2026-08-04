import type { AtlasBar } from "./instruments";

export interface AtlasPattern {
  name: string;
  direction: "bull" | "bear" | "neutral";
  confidence: number;
  /** Rough historical success rate placeholder from pattern literature, not a guarantee. */
  historicalHitRate: number;
}

function body(bar: AtlasBar): number {
  return Math.abs(bar.close - bar.open);
}

function range(bar: AtlasBar): number {
  return Math.max(bar.high - bar.low, 1e-12);
}

export function detectPatterns(bars: AtlasBar[]): AtlasPattern[] {
  if (bars.length < 3) return [];
  const a = bars[bars.length - 3];
  const b = bars[bars.length - 2];
  const c = bars[bars.length - 1];
  const found: AtlasPattern[] = [];

  const cBody = body(c);
  const cRange = range(c);
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;

  if (cBody / cRange < 0.1) {
    found.push({
      name: "Doji",
      direction: "neutral",
      confidence: 55,
      historicalHitRate: 48,
    });
  }
  if (lowerWick > cBody * 2 && upperWick < cBody * 0.5 && c.close > c.open) {
    found.push({
      name: "Hammer",
      direction: "bull",
      confidence: 62,
      historicalHitRate: 54,
    });
  }
  if (upperWick > cBody * 2 && lowerWick < cBody * 0.5 && c.close < c.open) {
    found.push({
      name: "Shooting Star",
      direction: "bear",
      confidence: 60,
      historicalHitRate: 52,
    });
  }
  if (b.close < b.open && c.close > c.open && c.open <= b.close && c.close >= b.open) {
    found.push({
      name: "Bullish Engulfing",
      direction: "bull",
      confidence: 68,
      historicalHitRate: 55,
    });
  }
  if (b.close > b.open && c.close < c.open && c.open >= b.close && c.close <= b.open) {
    found.push({
      name: "Bearish Engulfing",
      direction: "bear",
      confidence: 68,
      historicalHitRate: 55,
    });
  }
  if (
    a.close < a.open &&
    body(b) / range(b) < 0.3 &&
    c.close > c.open &&
    c.close > (a.open + a.close) / 2
  ) {
    found.push({
      name: "Morning Star",
      direction: "bull",
      confidence: 70,
      historicalHitRate: 56,
    });
  }
  if (
    a.close > a.open &&
    body(b) / range(b) < 0.3 &&
    c.close < c.open &&
    c.close < (a.open + a.close) / 2
  ) {
    found.push({
      name: "Evening Star",
      direction: "bear",
      confidence: 70,
      historicalHitRate: 56,
    });
  }
  return found.sort((x, y) => y.confidence - x.confidence);
}
