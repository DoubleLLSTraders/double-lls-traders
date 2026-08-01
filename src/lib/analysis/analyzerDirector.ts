/**
 * Analyzer director — Digits decides; the trade desk only follows.
 *
 * Steady but fast: short Lock → short Confirm → Trade now. Market hops are
 * blocked while Confirming / Trade now so the feed cannot change mid-fire.
 * (Desk may intentionally skip the first Trade now after Start, then buy
 * the next cycle immediately while the market stays glued.)
 */
import {
  analyzerAllowsEntry,
  type AnalyzerGateResult,
} from "./analyzerGate";
import type { MarketSignal } from "./signal";
import type { BotSettings } from "../bot/types";

/** Phase 1 — prove cold is real (~4s on 1s indices). */
export const LOCK_TICKS = 4;
export const LOCK_MS = 4_000;

/** Phase 2 — quick anti-fade check, then arm buy immediately. */
export const CONFIRM_TICKS = 2;
export const CONFIRM_MS = 1_500;

/** @deprecated use LOCK_TICKS — kept for UI copy helpers */
export const STEADY_TICKS = LOCK_TICKS + CONFIRM_TICKS;
/** @deprecated use LOCK_MS + CONFIRM_MS */
export const STEADY_MS = LOCK_MS + CONFIRM_MS;

/** Dead tape — hop quickly and keep searching. */
export const DEAD_MARKET_MS = 4_000;

/**
 * Max time on one volatility without Confirming / Trade now.
 * Soft “almost” setups must not park the carousel.
 */
export const MAX_MARKET_DWELL_MS = 14_000;

type DeskSettings = Pick<
  BotSettings,
  "minColdGap" | "minSample" | "side" | "maxMomentumGap"
>;

export interface AnalyzerHold {
  key: string;
  /** Ticks in the current phase. */
  count: number;
  lastGap: number;
  digit: number;
  side: MarketSignal["side"];
  /** When the current phase started. */
  sinceMs: number;
  phase: "lock" | "confirm";
  /** When the overall lock started (for display). */
  lockSinceMs: number;
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
  // +1 air is enough to reject soft flashes without waiting for a peak to die.
  return side === "DIGITDIFF" ? settings.minColdGap + 1 : settings.minColdGap;
}

/**
 * True only for a near-ready cold worth a short stay.
 * Warming / weak gaps return false so the carousel keeps hunting.
 */
export function isPromisingSetup(
  signal: MarketSignal,
  settings: DeskSettings,
): boolean {
  if (analyzerAllowsEntry(signal, settings).ok) return true;
  if (signal.side !== "DIGITDIFF" && settings.side === "DIGITDIFF") return false;

  const gap = signal.watching.signalGap ?? 0;
  const n = signal.watching.sampleSize;
  // Warming feed — do not park; keep searching other volatilities.
  if (n < 200) return false;
  if (!signal.primaryBarrier || !signal.barrierAligned) return false;
  if (signal.digitPercent > 9.2) return false;
  // Near Good: gap almost at floor with firm cold.
  if (gap >= settings.minColdGap - 1 && signal.digitPercent <= 9.1) return true;
  if (gap >= 5 && signal.digitPercent <= 9.0 && n >= Math.min(400, settings.minSample)) {
    return true;
  }
  return false;
}

/** Stay glued only while proving / firing a real entry. */
export function shouldHoldMarket(
  hold: AnalyzerHold | null,
  buyNow: boolean,
  nowMs: number = Date.now(),
): boolean {
  if (buyNow) return true;
  if (!hold) return false;
  if (hold.phase === "confirm") return true;
  // One clean lock attempt — if it keeps restarting, hunting resumes.
  return nowMs - hold.lockSinceMs < LOCK_MS + 1_500;
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
  };
  return {
    gate,
    buyNow: false,
    hold,
    label: "Locking",
    detail: `${sideLabel} ${digit} · ${why} · restart 1/${LOCK_TICKS} · gap ${gap}`,
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
  const gate = analyzerAllowsEntry(signal, settings);
  const digit = signal.digit;
  const side = signal.side;
  const sideLabel = side === "DIGITMATCH" ? "Matches" : "Differs";
  const gap = signal.watching.signalGap ?? 0;
  const firmGap = firmGapFloor(settings, side);

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

  // Firmer cold while proving — but 9.2 keeps real entries from dying mid-lock.
  if (side === "DIGITDIFF" && signal.digitPercent > 9.2) {
    return {
      gate: {
        ok: false,
        reason: `Analyzer · cold ${signal.digitPercent.toFixed(1)}% > 9.2% · not firm`,
      },
      buyNow: false,
      hold: null,
      label: "Almost",
      detail: `${sideLabel} ${digit} · cold ${signal.digitPercent.toFixed(1)}% · need ≤9.2% for steady`,
      digit,
      side,
    };
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
      gate,
      "new cold",
    );
  }

  // Allow 1-tick gap noise; only real fades restart (missed the peak otherwise).
  if (side === "DIGITDIFF" && gap < prev.lastGap - 1) {
    return restartLock(
      key,
      digit,
      side,
      gap,
      nowMs,
      sideLabel,
      gate,
      "gap faded",
    );
  }

  const heldMs = nowMs - prev.sinceMs;
  const count = prev.count + 1;
  // Track peak gap so noise dips of 1 do not lower the floor forever.
  const trackedGap = Math.max(gap, prev.lastGap);

  // ── Phase 1: Locking ────────────────────────────────────────────────
  if (prev.phase === "lock") {
    const hold: AnalyzerHold = {
      ...prev,
      count,
      lastGap: trackedGap,
      sinceMs: prev.sinceMs,
      phase: "lock",
    };
    const locked = count >= LOCK_TICKS && heldMs >= LOCK_MS;
    if (!locked) {
      return {
        gate,
        buyNow: false,
        hold,
        label: "Locking",
        detail: `${sideLabel} ${digit} · locking ${Math.min(count, LOCK_TICKS)}/${LOCK_TICKS} · ${Math.round(Math.min(heldMs, LOCK_MS) / 100) / 10}s/${Math.round(LOCK_MS / 1000)}s · gap ${gap}`,
        digit,
        side,
      };
    }
    // Enter confirm — do not buy on this tick.
    const confirmHold: AnalyzerHold = {
      key,
      count: 1,
      lastGap: trackedGap,
      digit,
      side,
      sinceMs: nowMs,
      phase: "confirm",
      lockSinceMs: prev.lockSinceMs,
    };
    return {
      gate,
      buyNow: false,
      hold: confirmHold,
      label: "Confirming",
      detail: `${sideLabel} ${digit} · confirming 1/${CONFIRM_TICKS} · proving steady · gap ${gap}`,
      digit,
      side,
    };
  }

  // ── Phase 2: Confirming → Trade now (desk must fire this streak) ────
  const hold: AnalyzerHold = {
    ...prev,
    count,
    lastGap: trackedGap,
    sinceMs: prev.sinceMs,
    phase: "confirm",
  };
  const confirmed = count >= CONFIRM_TICKS && heldMs >= CONFIRM_MS;
  if (!confirmed) {
    return {
      gate,
      buyNow: false,
      hold,
      label: "Confirming",
      detail: `${sideLabel} ${digit} · confirming ${Math.min(count, CONFIRM_TICKS)}/${CONFIRM_TICKS} · ${Math.round(Math.min(heldMs, CONFIRM_MS) / 100) / 10}s/${Math.round(CONFIRM_MS / 1000)}s · gap ${gap}`,
      digit,
      side,
    };
  }

  const pct = signal.digitPercent.toFixed(1);
  const totalSec = Math.round((nowMs - prev.lockSinceMs) / 1000);
  return {
    gate,
    buyNow: true,
    hold,
    label: "Trade now",
    detail: `ENTRY ${sideLabel} ${digit} · gap ${gap}/${settings.minColdGap} · cold ${pct}% · power ${signal.power} · steady ${totalSec}s`,
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
