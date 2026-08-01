/**
 * Analyzer director — Digits decides; the trade desk only follows.
 *
 * Trade now is only armed after the same market+digit stays Good for
 * STEADY_TICKS and STEADY_MS. Fleeting 1–2s flashes stay on Locking and
 * must never reach the executor.
 */
import {
  analyzerAllowsEntry,
  type AnalyzerGateResult,
} from "./analyzerGate";
import type { MarketSignal } from "./signal";
import type { BotSettings } from "../bot/types";

/** Continuous Good ticks on the same digit before Trade now. */
export const STEADY_TICKS = 5;

/** Wall-clock hold so a burst of ticks cannot fake a lock. */
export const STEADY_MS = 4500;

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
  sinceMs: number;
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
 * True while Digits should stay put — building / almost / locking / Trade now.
 */
export function isPromisingSetup(
  signal: MarketSignal,
  settings: DeskSettings,
): boolean {
  if (analyzerAllowsEntry(signal, settings).ok) return true;
  if (signal.side !== "DIGITDIFF" && settings.side === "DIGITDIFF") return false;

  const gap = signal.watching.signalGap ?? 0;
  const n = signal.watching.sampleSize;
  if (n < 80) return true;
  if (n < Math.min(300, settings.minSample) && gap >= 2) return true;
  if (!signal.primaryBarrier || !signal.barrierAligned) return false;
  if (signal.digitPercent > 9.5) return false;
  if (gap >= 3 && signal.digitPercent <= 9.5) return true;
  if (signal.evOk && gap >= Math.max(2, settings.minColdGap - 3)) return true;
  return false;
}

export function advanceAnalyzerDirector(
  prev: AnalyzerHold | null,
  symbol: string,
  signal: MarketSignal,
  settings: DeskSettings,
  nowMs: number = Date.now(),
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

  // Need a little air under the gap so a print one tick later is less likely.
  const firmGap =
    side === "DIGITDIFF" ? settings.minColdGap + 1 : settings.minColdGap;
  if (side === "DIGITDIFF" && gap < firmGap) {
    return {
      gate: {
        ok: false,
        reason: `Analyzer · gap ${gap}/${firmGap} · need steady air`,
      },
      buyNow: false,
      hold: null,
      label: "Almost",
      detail: `${sideLabel} ${digit} · gap ${gap}/${firmGap} · holding for steady air`,
      digit,
      side,
    };
  }

  if (!prev || prev.key !== key) {
    const hold: AnalyzerHold = {
      key,
      count: 1,
      lastGap: gap,
      digit,
      side,
      sinceMs: nowMs,
    };
    return {
      gate,
      buyNow: false,
      hold,
      label: "Locking",
      detail: `${sideLabel} ${digit} · locking 1/${STEADY_TICKS} · ${Math.round(STEADY_MS / 1000)}s · gap ${gap}`,
      digit,
      side,
    };
  }

  // Gap collapsed while locking — fake entry; restart (do not buy).
  if (side === "DIGITDIFF" && gap + 1 < prev.lastGap) {
    const hold: AnalyzerHold = {
      key,
      count: 1,
      lastGap: gap,
      digit,
      side,
      sinceMs: nowMs,
    };
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
  const heldMs = nowMs - prev.sinceMs;
  const hold: AnalyzerHold = {
    key,
    count,
    lastGap: Math.max(prev.lastGap, gap),
    digit,
    side,
    sinceMs: prev.sinceMs,
  };
  const buyNow = count >= STEADY_TICKS && heldMs >= STEADY_MS;

  if (!buyNow) {
    const tickPart = Math.min(count, STEADY_TICKS);
    const secPart = Math.min(STEADY_MS, heldMs);
    return {
      gate,
      buyNow: false,
      hold,
      label: "Locking",
      detail: `${sideLabel} ${digit} · locking ${tickPart}/${STEADY_TICKS} · ${Math.round(secPart / 100) / 10}s/${Math.round(STEADY_MS / 1000)}s · gap ${gap}`,
      digit,
      side,
    };
  }

  const pct = signal.digitPercent.toFixed(1);
  return {
    gate,
    buyNow: true,
    hold,
    label: "Trade now",
    detail: `ENTRY ${sideLabel} ${digit} · gap ${gap}/${settings.minColdGap} · cold ${pct}% · power ${signal.power} · held ${STEADY_TICKS} ticks`,
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
