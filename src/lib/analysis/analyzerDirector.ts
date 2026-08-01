/**
 * Analyzer director — Digits decides; the trade desk only follows.
 *
 * Stay on a market while a Differs cold is building. Only hop when the tape
 * is dead. When the gate clears, lock STEADY_TICKS then buyNow.
 */
import {
  analyzerAllowsEntry,
  type AnalyzerGateResult,
} from "./analyzerGate";
import type { MarketSignal } from "./signal";
import type { BotSettings } from "../bot/types";

/** 1 = Digits Trade now and desk buy on the same Good tick (no lag lock). */
export const STEADY_TICKS = 1;

/** How long a dead tape must sit before we rotate volatility. */
export const DEAD_MARKET_MS = 9000;

type DeskSettings = Pick<
  BotSettings,
  "minColdGap" | "minSample" | "side" | "maxMomentumGap"
>;

export interface AnalyzerHold {
  key: string;
  count: number;
  lastGap: number;
  digit: number;
  side: MarketSignal["side"];
}

export interface AnalyzerDirective {
  gate: AnalyzerGateResult;
  buyNow: boolean;
  hold: AnalyzerHold | null;
  label: string;
  detail: string;
  digit: number;
  side: MarketSignal["side"];
}

function holdKey(symbol: string, signal: MarketSignal): string {
  return `${symbol}|${signal.side}|${signal.digit}`;
}

/**
 * True while Digits should stay put — building / almost / good / locking.
 * Hopping away here is what made Good never appear.
 */
export function isPromisingSetup(
  signal: MarketSignal,
  settings: DeskSettings,
): boolean {
  if (analyzerAllowsEntry(signal, settings).ok) return true;
  if (signal.side !== "DIGITDIFF" && settings.side === "DIGITDIFF") return false;

  const gap = signal.watching.signalGap ?? 0;
  const n = signal.watching.sampleSize;
  if (n < 80) return true; // feed still catching up after a hop — stay
  if (n < Math.min(300, settings.minSample) && gap >= 2) return true;
  if (!signal.primaryBarrier || !signal.barrierAligned) return false;
  if (signal.digitPercent > 9.5) return false;
  // Building a cold absence — give it time to reach minColdGap.
  if (gap >= 3 && signal.digitPercent <= 9.5) return true;
  if (signal.evOk && gap >= Math.max(2, settings.minColdGap - 3)) return true;
  return false;
}

export function advanceAnalyzerDirector(
  prev: AnalyzerHold | null,
  symbol: string,
  signal: MarketSignal,
  settings: DeskSettings,
): AnalyzerDirective {
  const gate = analyzerAllowsEntry(signal, settings);
  const digit = signal.digit;
  const side = signal.side;
  const sideLabel = side === "DIGITMATCH" ? "Matches" : "Differs";

  if (!gate.ok) {
    return {
      gate,
      buyNow: false,
      hold: null,
      label: "Watch",
      detail: gate.reason.replace(/^Analyzer ·/, ""),
      digit,
      side,
    };
  }

  const key = holdKey(symbol, signal);
  const gap = signal.watching.signalGap ?? 0;

  if (!prev || prev.key !== key) {
    const hold: AnalyzerHold = { key, count: 1, lastGap: gap, digit, side };
    return {
      gate,
      buyNow: STEADY_TICKS <= 1,
      hold,
      label: STEADY_TICKS <= 1 ? "Trade now" : "Locking",
      detail:
        STEADY_TICKS <= 1
          ? `${gate.label} · desk follows now`
          : `${sideLabel} ${digit} · locking 1/${STEADY_TICKS} · gap ${gap}`,
      digit,
      side,
    };
  }

  // Barrier printed / gap collapsed — restart lock, stay on market.
  if (side === "DIGITDIFF" && gap + 1 < prev.lastGap) {
    const hold: AnalyzerHold = { key, count: 1, lastGap: gap, digit, side };
    return {
      gate,
      buyNow: false,
      hold,
      label: "Locking",
      detail: `${sideLabel} ${digit} · gap dipped · restart 1/${STEADY_TICKS}`,
      digit,
      side,
    };
  }

  const count = prev.count + 1;
  const hold: AnalyzerHold = {
    key,
    count,
    lastGap: Math.max(prev.lastGap, gap),
    digit,
    side,
  };
  const buyNow = count >= STEADY_TICKS;

  if (!buyNow) {
    return {
      gate,
      buyNow: false,
      hold,
      label: "Locking",
      detail: `${sideLabel} ${digit} · locking ${Math.min(count, STEADY_TICKS)}/${STEADY_TICKS} · gap ${gap}`,
      digit,
      side,
    };
  }

  return {
    gate,
    buyNow: true,
    hold,
    label: "Trade now",
    detail: `${gate.label} · steady · desk follows now`,
    digit,
    side,
  };
}

export function isAnalyzerCandidate(
  signal: MarketSignal,
  settings: DeskSettings,
): boolean {
  return analyzerAllowsEntry(signal, settings).ok;
}
