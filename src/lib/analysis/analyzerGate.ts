import type { MarketSignal } from "./signal";
import type { BotSettings } from "../bot/types";

export type AnalyzerGateResult =
  | { ok: true; label: string }
  | { ok: false; reason: string };

type DeskSettings = Pick<
  BotSettings,
  "minColdGap" | "minSample" | "side" | "maxMomentumGap"
>;

/**
 * Single source of truth for Digits “Good / Trade now” and bot buys.
 * Warming / Building / Almost must never reach an order.
 */
export function analyzerAllowsEntry(
  signal: MarketSignal,
  settings: DeskSettings,
): AnalyzerGateResult {
  const minGap = settings.minColdGap;
  const minSample = settings.minSample;
  const gap = signal.watching.signalGap;

  if (settings.side === "DIGITDIFF" && signal.side !== "DIGITDIFF") {
    return { ok: false, reason: "Analyzer · waiting Differs (not Matches)" };
  }
  if (settings.side === "DIGITMATCH" && signal.side !== "DIGITMATCH") {
    return { ok: false, reason: "Analyzer · waiting Matches" };
  }
  if (signal.watching.sampleSize < minSample) {
    return {
      ok: false,
      reason: `Analyzer · sample ${signal.watching.sampleSize}/${minSample}`,
    };
  }
  if (!signal.barrierAligned || !signal.primaryBarrier) {
    return {
      ok: false,
      reason: `Analyzer · ${signal.digit} is not the #1 ${signal.side === "DIGITDIFF" ? "cold" : "hot"}`,
    };
  }
  if (!signal.evOk) {
    return {
      ok: false,
      reason: `Analyzer · EV closed · ${signal.watching.wilsonBound || `${signal.digitPercent.toFixed(1)}%`}`,
    };
  }
  if (!signal.timingOk) {
    return {
      ok: false,
      reason:
        signal.side === "DIGITDIFF"
          ? `Analyzer · gap ${gap ?? "—"}/${minGap} · Building`
          : `Analyzer · momentum gap weak`,
    };
  }
  if (signal.side === "DIGITDIFF") {
    if (gap === null || gap < minGap) {
      return {
        ok: false,
        reason: `Analyzer · gap ${gap ?? "—"}/${minGap} · not Good yet`,
      };
    }
    if (!signal.coldMarginOk || !signal.separationOk) {
      return {
        ok: false,
        reason: `Analyzer · cold lead thin (${signal.watching.separation || "—"})`,
      };
    }
    if (!signal.structureOk) {
      return { ok: false, reason: "Analyzer · structure not clear · no entry" };
    }
    if (signal.digitPercent > 9.5) {
      return {
        ok: false,
        reason: `Analyzer · cold ${signal.digitPercent.toFixed(1)}% > 9.5%`,
      };
    }
  }

  const sideLabel = signal.side === "DIGITMATCH" ? "Matches" : "Differs";
  return {
    ok: true,
    label: `${sideLabel} ${signal.digit} · gap ${gap ?? "—"} · ${signal.digitPercent.toFixed(1)}%`,
  };
}

/** Digits mood “good” and Start live-good use the same check. */
export function isAnalyzerGood(
  signal: MarketSignal,
  settings: DeskSettings,
): boolean {
  return analyzerAllowsEntry(signal, settings).ok;
}

/**
 * Recompute cold/hot gap from the live tick tape so a stale signal cannot buy
 * after the barrier just printed (Digits already shows Warming).
 */
export function liveDigitGap(
  digits: readonly number[],
  digit: number,
): number {
  let gap = 0;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    if (digits[i] === digit) break;
    gap += 1;
  }
  return gap;
}

export function liveTapeAllowsEntry(
  signal: MarketSignal,
  settings: DeskSettings,
  recentDigits: readonly number[],
): AnalyzerGateResult {
  const base = analyzerAllowsEntry(signal, settings);
  if (!base.ok) return base;

  if (signal.side === "DIGITDIFF") {
    const gap = liveDigitGap(recentDigits, signal.digit);
    if (gap < settings.minColdGap) {
      return {
        ok: false,
        reason: `Analyzer · live gap ${gap}/${settings.minColdGap} · Warming (tape)`,
      };
    }
  } else {
    const gap = liveDigitGap(recentDigits, signal.digit);
    if (gap > settings.maxMomentumGap) {
      return {
        ok: false,
        reason: `Analyzer · live momentum gap ${gap} > ${settings.maxMomentumGap}`,
      };
    }
  }

  return base;
}
