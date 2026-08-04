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
import { deskOf, isOverUnderSide, sideLabel as contractSideLabel } from "./contractSide";
import type { MarketSignal } from "./signal";
import type { BotSettings } from "../bot/types";
import { STEADY_PACE, type AnalyzerPace } from "./analyzerPace";
import {
  advanceTapeTemper,
  emptyTapeTemper,
  readTapeTemper,
  type TapeTemper,
} from "./tapeTemper";

export type { TapeTemper };
export { emptyTapeTemper, COLD_SETTLE_MS } from "./tapeTemper";
export type { AnalyzerPace, AnalyzerPaceId } from "./analyzerPace";
export {
  ANALYZER_PACES,
  MATCHES_ANALYZER_PACES,
  MATCHES_FIRM_PACE,
  OVER_UNDER_ANALYZER_PACES,
  OVER_UNDER_FIRM_PACE,
  resolveAnalyzerPace,
  SAFER_FAST_PACE,
  STEADY_PACE,
} from "./analyzerPace";

/** Phase 1 — Steady defaults (~6s on 1s indices). Pace may shorten. */
export const LOCK_TICKS = STEADY_PACE.lockTicks;
export const LOCK_MS = STEADY_PACE.lockMs;

/** Phase 2 — Steady defaults (~2s more). Pace may shorten. */
export const CONFIRM_TICKS = STEADY_PACE.confirmTicks;
export const CONFIRM_MS = STEADY_PACE.confirmMs;

/** Differs must stay this cold while proving. Soft lukewarm = leave alone. */
export const FIRM_COLD_MAX = 8.8;

/** Composite power floor — below this the digit is not strong enough. */
export const FIRM_POWER_MIN = 65;

/** Matches firm needs a stronger composite than Differs. */
export const MATCHES_FIRM_POWER_MIN = 70;

/** Matches firm hot frequency floor (unique HIGH still required). */
export const MATCHES_FIRM_HOT_MIN = 11.0;

/** Gap air above minColdGap required for a steady market entry. */
export const FIRM_GAP_AIR = 2;

/** @deprecated */
export const STEADY_TICKS = LOCK_TICKS + CONFIRM_TICKS;
/** @deprecated */
export const STEADY_MS = LOCK_MS + CONFIRM_MS;

export const DEAD_MARKET_MS = 3_500;
/** Soft Almost / pack cold — Steady default; pace may shorten. */
export const STUCK_ALMOST_MS = STEADY_PACE.stuckAlmostMs;
/** Hard cap on one market — Steady default; pace may shorten. */
export const MAX_MARKET_DWELL_MS = STEADY_PACE.maxMarketDwellMs;

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
  /** Updated tape temper for the next tick. */
  temper: TapeTemper;
}

function holdKey(symbol: string, signal: MarketSignal): string {
  return `${symbol}|${signal.side}|${signal.digit}`;
}

/** Over/Under Blitz — sure HIGH (power ≥ 85), still fires inside 1m. */
export const OVER_UNDER_FIRM_EDGE_MIN = 0;
export const OVER_UNDER_FIRM_POWER_MIN = 85;

function firmGapFloor(settings: DeskSettings, side: MarketSignal["side"]): number {
  return side === "DIGITDIFF"
    ? settings.minColdGap + FIRM_GAP_AIR
    : settings.minColdGap;
}

/**
 * Hysteresis floor for a call that is already Confirming or armed.
 *
 * Entry and exit used the same threshold, so a signal sitting on the line
 * armed and un-armed on alternate ticks — the executor bought the arm and the
 * call was gone by the time it filled. A held call now only breaks on real
 * deterioration: the proof lapsing, or power falling well under the entry bar.
 */
export const OVER_UNDER_KEEP_POWER_DROP = 15;

export function keepArmedCheck(
  signal: MarketSignal,
  settings: DeskSettings,
): AnalyzerGateResult {
  if (!isOverUnderSide(signal.side)) return firmSteadyCheck(signal, settings);
  if (signal.proven !== true) {
    return {
      ok: false,
      reason: `Analyzer · proof lapsed · ${signal.provenLabel ?? "unproven"} · stand down`,
    };
  }
  const floor = Math.max(0, OVER_UNDER_FIRM_POWER_MIN - OVER_UNDER_KEEP_POWER_DROP);
  if (signal.power < floor) {
    return {
      ok: false,
      reason: `Analyzer · power ${signal.power}/${floor} · call weakened`,
    };
  }
  return { ok: true, label: `Held · ${signal.provenLabel ?? "proven"}` };
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
  const label = contractSideLabel(signal.side);

  if (!signal.primaryBarrier || !signal.barrierAligned) {
    return {
      ok: false,
      reason: isOverUnderSide(signal.side)
        ? `Analyzer · barrier ${signal.digit} not aligned · leave alone`
        : `Analyzer · ${signal.digit} not #1 ${signal.side === "DIGITDIFF" ? "cold" : "hot"} · leave alone`,
    };
  }
  if (!signal.separationOk || !signal.coldMarginOk) {
    return {
      ok: false,
      reason: `Analyzer · thin lead · leave alone`,
    };
  }
  // Over/Under: HIGH + power ≥ 90 only — no medium / soft shortcuts.
  if (isOverUnderSide(signal.side)) {
    if (signal.confidence !== "high") {
      return {
        ok: false,
        reason: `Analyzer · ${signal.confidence} confidence · need HIGH · leave alone`,
      };
    }
    if (signal.power < OVER_UNDER_FIRM_POWER_MIN) {
      return {
        ok: false,
        reason: `Analyzer · power ${signal.power}/${OVER_UNDER_FIRM_POWER_MIN} · not sure enough`,
      };
    }
    if (!signal.evOk || !signal.uniqueEvOk) {
      return {
        ok: false,
        reason: `Analyzer · EV / lead not sure · leave alone`,
      };
    }
  } else if (signal.confidence !== "high") {
    return {
      ok: false,
      reason: `Analyzer · ${signal.confidence} confidence · need high · leave alone`,
    };
  }
  const powerMin =
    signal.side === "DIGITMATCH"
      ? MATCHES_FIRM_POWER_MIN
      : isOverUnderSide(signal.side)
        ? OVER_UNDER_FIRM_POWER_MIN
        : FIRM_POWER_MIN;
  if (signal.power < powerMin) {
    return {
      ok: false,
      reason: `Analyzer · power ${signal.power}/${powerMin} · not strong`,
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
    // Unique Wilson OR a clearly solo deep cold (pack of two EV-ok colds is common).
    const soloDeep =
      signal.digitPercent <= 8.6 &&
      gap >= firmGap &&
      signal.power >= FIRM_POWER_MIN + 3;
    if (!signal.uniqueEvOk && !soloDeep) {
      return {
        ok: false,
        reason: `Analyzer · pack cold · hunt other market`,
      };
    }
  } else if (isOverUnderSide(signal.side)) {
    const momCap = Math.max(0, settings.maxMomentumGap);
    if (gap === null || gap > momCap) {
      return {
        ok: false,
        reason: `Analyzer · gap ${gap ?? "—"}/${momCap} · need fresh OU win`,
      };
    }
    if (!signal.evOk) {
      return {
        ok: false,
        reason: `Analyzer · payout EV not sure · leave alone`,
      };
    }
    if (!signal.uniqueEvOk || !signal.coldMarginOk) {
      return {
        ok: false,
        reason: `Analyzer · lead not unique / deep enough · leave alone`,
      };
    }
    if (signal.power < OVER_UNDER_FIRM_POWER_MIN) {
      return {
        ok: false,
        reason: `Analyzer · power ${signal.power}/${OVER_UNDER_FIRM_POWER_MIN} · keep reading`,
      };
    }
  } else {
    // Matches firm — unique HIGH hot, recent print, elevated frequency.
    const momCap = Math.max(0, settings.maxMomentumGap);
    if (gap === null || gap > momCap) {
      return {
        ok: false,
        reason: `Analyzer · gap ${gap ?? "—"}/${momCap} · hot not recent`,
      };
    }
    if (!signal.uniqueEvOk) {
      return {
        ok: false,
        reason: `Analyzer · pack hot · hunt other market`,
      };
    }
    if (!signal.evOk) {
      return {
        ok: false,
        reason: `Analyzer · hot EV not clear · leave alone`,
      };
    }
    if (signal.digitPercent < MATCHES_FIRM_HOT_MIN) {
      return {
        ok: false,
        reason: `Analyzer · hot ${signal.digitPercent.toFixed(1)}% < ${MATCHES_FIRM_HOT_MIN}% · not firm`,
      };
    }
  }

  return {
    ok: true,
    label: `${label} ${signal.digit} · firm · gap ${gap ?? "—"} · ${signal.digitPercent.toFixed(1)}% · p${signal.power}`,
  };
}

/**
 * True only when this market can ripen into firm Trade now soon.
 * Pack-cold / leave-alone Almosts return false so the carousel keeps hunting.
 */
export function isPromisingSetup(
  signal: MarketSignal,
  settings: DeskSettings,
): boolean {
  if (firmSteadyCheck(signal, settings).ok) return true;
  // Side mismatch — do not park on the wrong contract type.
  if (signal.side !== settings.side && !signal.side) return false;
  if (deskOf(settings.side) !== deskOf(signal.side)) return false;
  if (settings.side === "DIGITDIFF" && signal.side !== "DIGITDIFF") return false;
  if (settings.side === "DIGITMATCH" && signal.side !== "DIGITMATCH") return false;
  if (settings.side === "DIGITOVER" && signal.side !== "DIGITOVER") return false;
  if (settings.side === "DIGITUNDER" && signal.side !== "DIGITUNDER") return false;

  const gap = signal.watching.signalGap ?? 0;
  const n = signal.watching.sampleSize;
  // Over/Under Blitz only needs ~36 ticks — Differs still parks on deep samples.
  const sampleFloor = isOverUnderSide(signal.side)
    ? Math.min(settings.minSample, 36)
    : 200;
  if (n < sampleFloor) return false;
  if (!signal.primaryBarrier || !signal.barrierAligned) return false;
  if (!signal.separationOk) return false;

  if (signal.side === "DIGITMATCH") {
    // Near firm hot: recent print, elevated %, unique EV path open.
    if (signal.power < 58) return false;
    if (gap > settings.maxMomentumGap + 1) return false;
    if (signal.digitPercent < 10.8) return false;
    if (signal.uniqueEvOk || signal.evOk) return true;
    return false;
  }

  if (isOverUnderSide(signal.side)) {
    // Park briefly on near-sure Almost — otherwise keep scanning (<1m idle).
    if (signal.power < 70) return false;
    if (gap > settings.maxMomentumGap + 1) return false;
    if (!signal.evOk) return false;
    if (signal.timingOk || signal.windowsEvOk) return true;
    return false;
  }

  if (!signal.coldMarginOk) return false;
  if (signal.digitPercent > 8.9) return false;
  if (signal.power < 55) return false;
  // Near firm: deep cold + air already, unique or solo-deep path open.
  if (gap < settings.minColdGap) return false;
  if (signal.uniqueEvOk) return true;
  if (signal.digitPercent <= 8.6 && gap >= settings.minColdGap + 1) return true;
  return false;
}

/** Soft Almost that will not firm here — hunt another volatility. */
export function shouldHuntOtherMarket(
  signal: MarketSignal,
  settings: DeskSettings,
): boolean {
  if (firmSteadyCheck(signal, settings).ok) return false;
  if (isPromisingSetup(signal, settings)) return false;
  return true;
}

export function shouldHoldMarket(
  hold: AnalyzerHold | null,
  buyNow: boolean,
  nowMs: number = Date.now(),
  lockMs: number = LOCK_MS,
): boolean {
  if (buyNow) return true;
  if (!hold) return false;
  if (hold.phase === "confirm") return true;
  return nowMs - hold.lockSinceMs < lockMs + 1_500;
}

function watchResult(
  digit: number,
  side: MarketSignal["side"],
  detail: string,
  gate: AnalyzerGateResult,
  temper: TapeTemper,
  label: "Watch" | "Almost" | "Cooling" = "Almost",
): AnalyzerDirective {
  return {
    gate,
    buyNow: false,
    hold: null,
    label,
    detail,
    digit,
    side,
    temper,
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
  temper: TapeTemper,
  lockTicks: number,
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
    detail: `${sideLabel} ${digit} · ${why} · 1/${lockTicks} · gap ${gap}`,
    digit,
    side,
    temper,
  };
}

export function advanceAnalyzerDirector(
  prev: AnalyzerHold | null,
  symbol: string,
  signal: MarketSignal,
  settings: DeskSettings,
  prevTemper: TapeTemper | null = null,
  pace: AnalyzerPace = STEADY_PACE,
  nowMs: number = Date.now(),
): AnalyzerDirective {
  const digit = signal.digit;
  const side = signal.side;
  const sideLabel = contractSideLabel(side);
  const gap = signal.watching.signalGap ?? 0;
  const lockTicks = pace.lockTicks;
  const lockMs = pace.lockMs;
  const confirmTicks = pace.confirmTicks;
  const confirmMs = pace.confirmMs;
  const temper = advanceTapeTemper(
    prevTemper ?? emptyTapeTemper(nowMs),
    signal,
    nowMs,
  );
  const tape = readTapeTemper(temper, signal, nowMs, pace.coldSettleMs);

  // Fast / hostile tape — wait for cool-down before any lock.
  if (!tape.ok) {
    return watchResult(
      digit,
      side,
      tape.reason.replace(/^Cooling · /, ""),
      { ok: false, reason: `Analyzer · ${tape.reason}` },
      temper,
      "Cooling",
    );
  }

  const firm = firmSteadyCheck(signal, settings);
  const key = holdKey(symbol, signal);

  if (!firm.ok) {
    // Hysteresis: a call already Confirming / armed on this exact barrier holds
    // through knife-edge ticks so the executor never trades a vanished call.
    const holding =
      prev !== null && prev.key === key && prev.phase === "confirm";
    const keep = holding ? keepArmedCheck(signal, settings) : null;
    if (!holding || !keep?.ok) {
      const soft = analyzerAllowsEntry(signal, settings);
      return watchResult(
        digit,
        side,
        firm.reason.replace(/^Analyzer ·/, ""),
        firm,
        temper,
        soft.ok ? "Almost" : "Watch",
      );
    }
  }

  if (!prev || prev.key !== key) {
    return restartLock(
      key,
      digit,
      side,
      gap,
      nowMs,
      sideLabel,
      firm,
      side === "DIGITDIFF"
        ? "firm cold"
        : isOverUnderSide(side)
          ? "firm barrier"
          : "firm hot",
      temper,
      lockTicks,
    );
  }

  // Differs: gap shrink / under firm air → restart.
  // Matches / Over/Under: winning side must stay recent (gap ≤ maxMomentumGap).
  const firmGap = firmGapFloor(settings, side);
  const momCap = Math.max(0, settings.maxMomentumGap);
  if (
    side === "DIGITDIFF" &&
    (gap < firmGap || gap < prev.lastGap || gap < prev.floorGap)
  ) {
    return restartLock(
      key,
      digit,
      side,
      gap,
      nowMs,
      sideLabel,
      firm,
      "gap not steady",
      temper,
      lockTicks,
    );
  }
  if ((side === "DIGITMATCH" || isOverUnderSide(side)) && gap > momCap) {
    return restartLock(
      key,
      digit,
      side,
      gap,
      nowMs,
      sideLabel,
      firm,
      isOverUnderSide(side) ? "barrier not steady" : "hot not steady",
      temper,
      lockTicks,
    );
  }

  const heldMs = nowMs - prev.sinceMs;
  const count = prev.count + 1;
  // Differs tracks floor gap (min); Matches / O/U tracks ceiling (max gap while proving).
  const floorGap =
    side === "DIGITDIFF" ? Math.min(prev.floorGap, gap) : Math.max(prev.floorGap, gap);
  const trackedGap = gap;

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
    const locked = count >= lockTicks && heldMs >= lockMs;
    if (!locked) {
      return {
        gate: firm,
        buyNow: false,
        hold,
        label: "Locking",
        detail: `${sideLabel} ${digit} · firm lock ${Math.min(count, lockTicks)}/${lockTicks} · ${Math.round(Math.min(heldMs, lockMs) / 100) / 10}s · gap ${gap} · p${signal.power}`,
        digit,
        side,
        temper,
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
      detail: `${sideLabel} ${digit} · confirm 1/${confirmTicks} · still firm · gap ${gap}`,
      digit,
      side,
      temper,
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
  const confirmed = count >= confirmTicks && heldMs >= confirmMs;
  if (!confirmed) {
    return {
      gate: firm,
      buyNow: false,
      hold,
      label: "Confirming",
      detail: `${sideLabel} ${digit} · confirm ${Math.min(count, confirmTicks)}/${confirmTicks} · ${Math.round(Math.min(heldMs, confirmMs) / 100) / 10}s · gap ${gap}`,
      digit,
      side,
      temper,
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
    temper,
  };
}

export function isAnalyzerCandidate(
  signal: MarketSignal,
  settings: DeskSettings,
): boolean {
  return firmSteadyCheck(signal, settings).ok;
}
