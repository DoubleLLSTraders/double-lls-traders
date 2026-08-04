/**
 * Tape temper — feel when Differs market is too fast / hostile to trust.
 * Hostile tape → Cooling (no Trade now). Wait for the cold to settle.
 */
import type { MarketSignal } from "./signal";

export interface TapeTemper {
  /** Current #1 cold / signal digit. */
  coldDigit: number;
  /** When this cold became #1. */
  coldSinceMs: number;
  /** Cold leadership flips inside the recent window. */
  flips: number;
  windowStartMs: number;
  lastGap: number;
  gapDrops: number;
}

const FLIP_WINDOW_MS = 20_000;
/** This many cold flips in the window ⇒ tape is chaotic. */
const HOSTILE_FLIPS = 3;
/** Cold must hold #1 this long before we trust a lock (Steady default). */
export const COLD_SETTLE_MS = 4_000;
/** Gap shrinks this many times while “building” ⇒ unstable. */
const HOSTILE_GAP_DROPS = 3;

export function emptyTapeTemper(nowMs: number = Date.now()): TapeTemper {
  return {
    coldDigit: -1,
    coldSinceMs: nowMs,
    flips: 0,
    windowStartMs: nowMs,
    lastGap: 0,
    gapDrops: 0,
  };
}

export function advanceTapeTemper(
  prev: TapeTemper,
  signal: MarketSignal,
  nowMs: number = Date.now(),
): TapeTemper {
  let next = { ...prev };
  if (nowMs - next.windowStartMs > FLIP_WINDOW_MS) {
    next = {
      ...next,
      flips: 0,
      gapDrops: 0,
      windowStartMs: nowMs,
    };
  }

  const digit = signal.digit;
  if (next.coldDigit !== digit) {
    if (next.coldDigit >= 0) {
      next.flips += 1;
    }
    next.coldDigit = digit;
    next.coldSinceMs = nowMs;
  }

  const gap = signal.watching.signalGap ?? 0;
  if (signal.side === "DIGITDIFF" && gap + 1 < next.lastGap) {
    next.gapDrops += 1;
  }
  next.lastGap = gap;
  return next;
}

export type TemperVerdict =
  | { ok: true }
  | { ok: false; reason: string; label: "Cooling" };

/**
 * True when the market is changing too fast to trust a Differs entry.
 */
export function readTapeTemper(
  temper: TapeTemper,
  signal: MarketSignal,
  nowMs: number = Date.now(),
  coldSettleMs: number = COLD_SETTLE_MS,
): TemperVerdict {
  if (signal.side !== "DIGITDIFF") return { ok: true };

  const gap = signal.watching.signalGap ?? 0;
  const coldAge = nowMs - temper.coldSinceMs;
  const settleMs = Math.max(500, coldSettleMs);

  // Barrier just printed — tape is hot.
  if (signal.watching.lastDigit === signal.digit) {
    return {
      ok: false,
      label: "Cooling",
      reason: `Cooling · ${signal.digit} just printed · wait settle`,
    };
  }

  // Cold leadership thrashing across digits.
  if (temper.flips >= HOSTILE_FLIPS) {
    return {
      ok: false,
      label: "Cooling",
      reason: `Cooling · cold flipping (${temper.flips}×) · tape too fast`,
    };
  }

  // Gap collapsing repeatedly — flashy, not steady.
  if (temper.gapDrops >= HOSTILE_GAP_DROPS) {
    return {
      ok: false,
      label: "Cooling",
      reason: `Cooling · gap unstable (${temper.gapDrops} drops) · wait`,
    };
  }

  // New #1 cold — give it time before any lock.
  if (temper.coldDigit === signal.digit && coldAge < settleMs && gap >= 3) {
    return {
      ok: false,
      label: "Cooling",
      reason: `Cooling · cold ${signal.digit} settling ${Math.round(coldAge / 100) / 10}s/${settleMs / 1000}s`,
    };
  }

  return { ok: true };
}
