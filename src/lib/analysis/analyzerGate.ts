import type { BotSettings } from "../bot/types";
import { deskOf, isOverUnderSide, sideLabel } from "./contractSide";
import type { MarketSignal } from "./signal";

export type AnalyzerGateResult =
  | { ok: true; label: string }
  | { ok: false; reason: string };

type DeskSettings = Pick<
  BotSettings,
  "minColdGap" | "minSample" | "side" | "maxMomentumGap"
>;

/**
 * Digits Good / Trade now and bot buy — same gate.
 *
 * Practical Differs Good: #1 cold + gap + EV + clear lead. Multi-window agree
 * is a bonus (shown as Almost/firming) — requiring it made Good almost never.
 */
export function analyzerAllowsEntry(
  signal: MarketSignal,
  settings: DeskSettings,
): AnalyzerGateResult {
  const minGap = settings.minColdGap;
  const minSample = settings.minSample;
  const gap = signal.watching.signalGap;

  if (deskOf(settings.side) !== deskOf(signal.side)) {
    return {
      ok: false,
      reason: `Analyzer · waiting ${sideLabel(settings.side)} desk`,
    };
  }
  if (settings.side === "DIGITDIFF" && signal.side !== "DIGITDIFF") {
    return { ok: false, reason: "Analyzer · waiting Differs (not Matches)" };
  }
  if (settings.side === "DIGITMATCH" && signal.side !== "DIGITMATCH") {
    return { ok: false, reason: "Analyzer · waiting Matches" };
  }
  if (settings.side === "DIGITOVER" && signal.side !== "DIGITOVER") {
    return { ok: false, reason: "Analyzer · waiting Over" };
  }
  if (settings.side === "DIGITUNDER" && signal.side !== "DIGITUNDER") {
    return { ok: false, reason: "Analyzer · waiting Under" };
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
      reason: isOverUnderSide(signal.side)
        ? `Analyzer · barrier ${signal.digit} not aligned`
        : `Analyzer · ${signal.digit} is not the #1 ${signal.side === "DIGITDIFF" ? "cold" : "hot"}`,
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
    if (signal.digitPercent > 9.5) {
      return {
        ok: false,
        reason: `Analyzer · cold ${signal.digitPercent.toFixed(1)}% > 9.5%`,
      };
    }
    if (!signal.separationOk || !signal.coldMarginOk) {
      return {
        ok: false,
        reason: `Analyzer · cold lead thin (${signal.watching.separation || "—"})`,
      };
    }
  }
  if (isOverUnderSide(signal.side)) {
    const momCap = Math.max(0, settings.maxMomentumGap);
    if (gap === null || gap > momCap) {
      return {
        ok: false,
        reason: `Analyzer · gap ${gap ?? "—"}/≤${momCap} · not Good yet`,
      };
    }
    if (!signal.separationOk || !signal.coldMarginOk) {
      return {
        ok: false,
        reason: `Analyzer · barrier edge thin (${signal.watching.separation || "—"})`,
      };
    }
  }

  return {
    ok: true,
    label: `${sideLabel(signal.side)} ${signal.digit} · gap ${gap ?? "—"} · ${signal.digitPercent.toFixed(1)}%`,
  };
}

export function isAnalyzerGood(
  signal: MarketSignal,
  settings: DeskSettings,
): boolean {
  return analyzerAllowsEntry(signal, settings).ok;
}

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

  const window = Math.max(
    settings.minSample,
    signal.watching.sampleSize,
    1,
  );
  const tape = recentDigits.slice(-window);

  if (signal.side === "DIGITDIFF") {
    const gap = liveDigitGap(tape, signal.digit);
    if (gap === 0 || gap < Math.max(2, Math.floor(settings.minColdGap / 2))) {
      return {
        ok: false,
        reason: `Analyzer · live gap ${gap}/${settings.minColdGap} · Warming (tape)`,
      };
    }
  } else if (signal.side === "DIGITMATCH") {
    const gap = liveDigitGap(tape, signal.digit);
    if (gap > settings.maxMomentumGap) {
      return {
        ok: false,
        reason: `Analyzer · live momentum gap ${gap} > ${settings.maxMomentumGap}`,
      };
    }
  } else {
    // Over/Under — gap is ticks since last winning outcome vs barrier.
    let ouGap = 0;
    let found = false;
    for (let i = tape.length - 1; i >= 0; i -= 1) {
      const d = tape[i];
      const won =
        signal.side === "DIGITOVER" ? d > signal.digit : d < signal.digit;
      if (won) {
        found = true;
        break;
      }
      ouGap += 1;
    }
    if (!found || ouGap > settings.maxMomentumGap) {
      return {
        ok: false,
        reason: `Analyzer · live O/U gap ${found ? ouGap : "—"} > ${settings.maxMomentumGap}`,
      };
    }
  }

  return base;
}
