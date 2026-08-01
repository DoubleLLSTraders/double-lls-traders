/**
 * Analyzer director — Digits decides; the trade desk only follows.
 *
 * Only firm, steady digits in a steady market reach Trade now.
 * Weak / soft / flipping colds are left alone. Once Trade now arms,
 * the desk must buy that streak immediately (skip-first still applies
 * after Start).
 */
import {
  analyzerAllowsEntry,
  type AnalyzerGateResult,
} from "./analyzerGate";
import type { MarketSignal } from "./signal";
import type { BotSettings } from "../bot/types";

/** Phase 1 — prove the cold is firm and stable (~4s on 1s indices). */
export const LOCK_TICKS = 4;
export const LOCK_MS = 4_000;

/** Phase 2 — brief anti-fade, then arm buy on the next ticks. */
export const CONFIRM_TICKS = 2;
export const CONFIRM_MS = 1_000;

/** Differs must stay this cold while proving. Soft lukewarm = leave alone. */
export const FIRM_COLD_MAX = 9.1;

/** Composite power floor — below this the digit is not strong enough. */
export const FIRM_POWER_MIN = 60;

/** Gap air above minColdGap required for a steady market entry. */
export const FIRM_GAP_AIR = 1;

/** @deprecated */
export const STEADY_TICKS = LOCK_TICKS + CONFIRM_TICKS;
/** @deprecated */
export const STEADY_MS = LOCK_MS + CONFIRM_MS;

export const DEAD_MARKET_MS = 4_000;
/** Dead tape rotates; building colds stay longer via isPromisingSetup. */
export const MAX_MARKET_DWELL_MS = 40_000;

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
  phase: "lock" | "confirm";
  lockSinceMs: number;
  /** Lowest gap seen while proving — must stay firm. */
  floorGap: number;
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

function firmGapFloor(settings: DeskSettings, side: MarketSignal["side"]): number {
  return side === "DIGITDIFF"
    ? settings.minColdGap + FIRM_GAP_AIR
    : settings.minColdGap;
}

/**
 * Strong + firm digit in a steady market — otherwise leave it alone.
 */
export function firmSteadyCheck(
  signal: MarketSignal,
  settings: DeskSettings,
): AnalyzerGateResult {
  const base = analyzerAllowsEntry(signal, settings);
  if (!base.ok) return base;

  const gap = signal.watching.signalGap;
  const firmGap = firmGapFloor(settings, signal.side);
  const sideLabel = signal.side === "DIGITMATCH" ? "Matches" : "Differs";

  if (!signal.primaryBarrier || !signal.barrierAligned) {
    return {
      ok: false,
      reason: `Analyzer · ${signal.digit} not #1 ${signal.side === "DIGITDIFF" ? "cold" : "hot"} · leave alone`,
    };
  }
  if (!signal.separationOk || !signal.coldMarginOk) {
    return {
      ok: false,
      reason: `Analyzer · thin lead · leave alone`,
    };
  }
  if (signal.confidence !== "high") {
    return {
      ok: false,
      reason: `Analyzer · ${signal.confidence} confidence · need high · leave alone`,
    };
  }
  if (signal.power < FIRM_POWER_MIN) {
    return {
      ok: false,
      reason: `Analyzer · power ${signal.power}/${FIRM_POWER_MIN} · not strong`,
    };
  }
  if (signal.side === "DIGITDIFF") {
    if (gap === null || gap < firmGap) {
      return {
        ok: false,
        reason: `Analyzer · gap ${gap ?? "—"}/${firmGap} · need steady air`,
      };
    }
    if (signal.digitPercent > FIRM_COLD_MAX) {
      return {
        ok: false,
        reason: `Analyzer · cold ${signal.digitPercent.toFixed(1)}% > ${FIRM_COLD_MAX}% · not firm`,
      };
    }
  }

  return {
    ok: true,
    label: `${sideLabel} ${signal.digit} · firm · gap ${gap ?? "—"} · ${signal.digitPercent.toFixed(1)}% · p${signal.power}`,
  };
}

/**
 * Stay while a real cold is building — do not hop every few seconds and
 * kill the gap before HIGH confidence can form.
 */
export function isPromisingSetup(
  signal: MarketSignal,
  settings: DeskSettings,
): boolean {
  if (firmSteadyCheck(signal, settings).ok) return true;
  if (signal.side !== "DIGITDIFF" && settings.side === "DIGITDIFF") return false;

  const gap = signal.watching.signalGap ?? 0;
  const n = signal.watching.sampleSize;
  if (n < 150) return false;
  if (!signal.primaryBarrier || !signal.barrierAligned) return false;
  if (signal.digitPercent > 9.2) return false;
  // Gap growing on a firm-ish #1 cold — park and let it ripen to HIGH.
  if (gap >= 2 && signal.digitPercent <= 9.2) return true;
  if (
    gap >= Math.max(3, settings.minColdGap - 2) &&
    signal.digitPercent <= 9.1 &&
    signal.power >= 40
  ) {
    return true;
  }
  return false;
}

export function shouldHoldMarket(
  hold: AnalyzerHold | null,
  buyNow: boolean,
  nowMs: number = Date.now(),
): boolean {
  if (buyNow) return true;
  if (!hold) return false;
  if (hold.phase === "confirm") return true;
  return nowMs - hold.lockSinceMs < LOCK_MS + 1_500;
}

function watchResult(
  digit: number,
  side: MarketSignal["side"],
  detail: string,
  gate: AnalyzerGateResult,
  label: "Watch" | "Almost" = "Almost",
): AnalyzerDirective {
  return {
    gate,
    buyNow: false,
    hold: null,
    label,
    detail,
    digit,
    side,
  };
}

function restartLock(
  key: string,
  digit: number,
  side: MarketSignal["side"],
  gap: number,
  nowMs: number,
  sideLabel: string,
  gate: AnalyzerGateResult,
  why: string,
): AnalyzerDirective {
  const hold: AnalyzerHold = {
    key,
    count: 1,
    lastGap: gap,
    digit,
    side,
    sinceMs: nowMs,
    phase: "lock",
    lockSinceMs: nowMs,
    floorGap: gap,
  };
  return {
    gate,
    buyNow: false,
    hold,
    label: "Locking",
    detail: `${sideLabel} ${digit} · ${why} · 1/${LOCK_TICKS} · gap ${gap}`,
    digit,
    side,
  };
}

export function advanceAnalyzerDirector(
  prev: AnalyzerHold | null,
  symbol: string,
  signal: MarketSignal,
  settings: DeskSettings,
  nowMs: number = Date.now(),
): AnalyzerDirective {
  const digit = signal.digit;
  const side = signal.side;
  const sideLabel = side === "DIGITMATCH" ? "Matches" : "Differs";
  const gap = signal.watching.signalGap ?? 0;
  const firm = firmSteadyCheck(signal, settings);

  if (!firm.ok) {
    const soft = analyzerAllowsEntry(signal, settings);
    return watchResult(
      digit,
      side,
      firm.reason.replace(/^Analyzer ·/, ""),
      firm,
      soft.ok ? "Almost" : "Watch",
    );
  }

  const key = holdKey(symbol, signal);

  if (!prev || prev.key !== key) {
    return restartLock(
      key,
      digit,
      side,
      gap,
      nowMs,
      sideLabel,
      firm,
      "firm cold",
    );
  }

  // Real fade (2+ ticks of gap loss) or floor dropped under firm air → leave alone.
  const firmGap = firmGapFloor(settings, side);
  if (side === "DIGITDIFF" && (gap < firmGap || gap < prev.floorGap - 1)) {
    return restartLock(
      key,
      digit,
      side,
      gap,
      nowMs,
      sideLabel,
      firm,
      "gap not steady",
    );
  }

  const heldMs = nowMs - prev.sinceMs;
  const count = prev.count + 1;
  const floorGap = Math.min(prev.floorGap, gap);
  const trackedGap = Math.max(gap, prev.lastGap);

  // ── Phase 1: Locking — same firm digit, steady market ───────────────
  if (prev.phase === "lock") {
    const hold: AnalyzerHold = {
      ...prev,
      count,
      lastGap: trackedGap,
      floorGap,
      sinceMs: prev.sinceMs,
      phase: "lock",
    };
    const locked = count >= LOCK_TICKS && heldMs >= LOCK_MS;
    if (!locked) {
      return {
        gate: firm,
        buyNow: false,
        hold,
        label: "Locking",
        detail: `${sideLabel} ${digit} · firm lock ${Math.min(count, LOCK_TICKS)}/${LOCK_TICKS} · ${Math.round(Math.min(heldMs, LOCK_MS) / 100) / 10}s · gap ${gap} · p${signal.power}`,
        digit,
        side,
      };
    }
    const confirmHold: AnalyzerHold = {
      key,
      count: 1,
      lastGap: trackedGap,
      digit,
      side,
      sinceMs: nowMs,
      phase: "confirm",
      lockSinceMs: prev.lockSinceMs,
      floorGap,
    };
    return {
      gate: firm,
      buyNow: false,
      hold: confirmHold,
      label: "Confirming",
      detail: `${sideLabel} ${digit} · confirm 1/${CONFIRM_TICKS} · still firm · gap ${gap}`,
      digit,
      side,
    };
  }

  // ── Phase 2: Confirm → Trade now (desk fires this streak fast) ──────
  const hold: AnalyzerHold = {
    ...prev,
    count,
    lastGap: trackedGap,
    floorGap,
    sinceMs: prev.sinceMs,
    phase: "confirm",
  };
  const confirmed = count >= CONFIRM_TICKS && heldMs >= CONFIRM_MS;
  if (!confirmed) {
    return {
      gate: firm,
      buyNow: false,
      hold,
      label: "Confirming",
      detail: `${sideLabel} ${digit} · confirm ${Math.min(count, CONFIRM_TICKS)}/${CONFIRM_TICKS} · ${Math.round(Math.min(heldMs, CONFIRM_MS) / 100) / 10}s · gap ${gap}`,
      digit,
      side,
    };
  }

  const pct = signal.digitPercent.toFixed(1);
  const totalSec = Math.round((nowMs - prev.lockSinceMs) / 1000);
  return {
    gate: firm,
    buyNow: true,
    hold,
    label: "Trade now",
    detail: `ENTRY ${sideLabel} ${digit} · gap ${gap}/${firmGap} · cold ${pct}% · power ${signal.power} · firm ${totalSec}s`,
    digit,
    side,
  };
}

export function isAnalyzerCandidate(
  signal: MarketSignal,
  settings: DeskSettings,
): boolean {
  return firmSteadyCheck(signal, settings).ok;
}
