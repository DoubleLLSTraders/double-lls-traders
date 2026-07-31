import type { DigitStats } from "./digits";
import {
  barrierAlignsWithSide,
  coldBarrierMarginOk,
  hasClearDigitLead,
  pickStableDigit,
  wilsonInterval,
} from "./digits";
import {
  DIFF_PAYOUT_MULTIPLIER,
  MATCH_PAYOUT_MULTIPLIER,
  breakEvenDigitPercent,
} from "../bot/performance";

export type ContractSide = "DIGITMATCH" | "DIGITDIFF";

/** Win-rate % needed for Matches to break even at ×MATCH payout. */
export const MATCH_BREAK_EVEN_PCT = (1 / MATCH_PAYOUT_MULTIPLIER) * 100;
/** Max barrier frequency % for Differs to break even at ×DIFF payout. */
export const DIFF_BARRIER_BREAK_EVEN_PCT = (1 - 1 / DIFF_PAYOUT_MULTIPLIER) * 100;

/** Windows below this are too small to vote — ~865 needed to tell 12% from 10%. */
const WINDOW_READY_FLOOR = 865;

export interface MarketSignal {
  side: ContractSide;
  digit: number;
  label: string;
  reason: string;
  confidence: "low" | "medium" | "soft";
  /** True when short/mid/long windows pick the same signal digit. */
  windowsAgree: boolean;
  /** Window frequency of the signal digit (%). */
  digitPercent: number;
  /** Primary window clears break-even with Wilson-bound evidence. */
  evOk: boolean;
  /** Every ready multi-window also clears EV for this digit. */
  windowsEvOk: boolean;
  /**
   * Timing confirm: Matches = digit printed recently (momentum);
   * Differs = digit still absent (cold holds).
   */
  timingOk: boolean;
  /** χ² uneven AND clear lead over the runner-up digit. */
  structureOk: boolean;
  /** Count lead vs runner-up is stable (not a one-tick flap). */
  separationOk: boolean;
  /** Hot barrier for Matches / cold barrier for Differs — same digit the gate checks. */
  barrierAligned: boolean;
  /** χ² says the window is still consistent with fair 10% digits — no proven edge. */
  windowFair: boolean;
  /** Coldest digit leads runner-up by ≥1pp — not a tie on noise. */
  coldMarginOk: boolean;
  watching: {
    lastDigit: number | null;
    streak: string;
    hot: string;
    cold: string;
    evenOdd: string;
    sampleSize: number;
    signalGap: number | null;
    windowVotes: string;
    /** e.g. "12.0%@50 · 11.5%@100 · 10.8%@250" */
    windowEv: string;
    /** e.g. "lead +4 vs 3" */
    separation: string;
    /** Wilson bound used for EV, as percent. */
    wilsonBound: string;
  };
}

export interface SignalOptions {
  windowStats?: DigitStats[];
  windowSizes?: number[];
  minEdgePercent?: number;
  /** Matches: digit must have appeared within this many ticks. */
  maxMomentumGap?: number;
  /** Differs: digit must have been absent at least this many ticks. */
  minColdGap?: number;
  /** Break-even depends on the index — R_100 pays worse than the rest. */
  symbol?: string;
}

function windowReady(sampleSize: number, size: number): boolean {
  const need = size >= 500 ? Math.min(size, WINDOW_READY_FLOOR) : Math.min(40, size);
  return sampleSize >= need;
}

function clearsEv(
  side: ContractSide,
  digitPercent: number,
  minEdgePercent: number,
  symbol?: string,
): boolean {
  const breakEven = breakEvenDigitPercent(side, symbol);
  if (side === "DIGITMATCH") {
    return digitPercent >= breakEven + minEdgePercent;
  }
  return digitPercent <= breakEven - minEdgePercent;
}

/**
 * Point estimate can clear break-even on noise (coldest-of-10 ≈ 8.5% at n=1000).
 * Differs: Wilson upper must still clear — fewer false cold opens.
 * Matches: point estimate gates entry (Wilson shown for info); full Wilson-lower
 * rarely opens and starved the Operator.
 */
function clearsEvWithWilson(
  side: ContractSide,
  stats: DigitStats,
  digit: number,
  minEdgePercent: number,
  symbol?: string,
): { ok: boolean; boundLabel: string } {
  const count = stats.counts[digit] ?? 0;
  const n = stats.sampleSize;
  const pct = stats.percentages[digit] ?? 0;
  const breakEven = breakEvenDigitPercent(side, symbol);
  const rawOk = clearsEv(side, pct, minEdgePercent, symbol);
  if (!rawOk || n < 50) {
    return { ok: false, boundLabel: "—" };
  }

  if (side === "DIGITMATCH") {
    const { lower } = wilsonInterval(count, n, 1.64);
    const lowerPct = lower * 100;
    return {
      ok: true,
      boundLabel: `W↓ ${lowerPct.toFixed(1)}% · need ${breakEven.toFixed(1)}%`,
    };
  }

  // Differs fast: point under break-even is enough — Wilson is informational.
  // The coldest digit (~8%) almost always clears; barrier + gap gates add quality.
  const { upper } = wilsonInterval(count, n, 1.64);
  const upperPct = upper * 100;
  const maxBarrier = breakEven - minEdgePercent;
  const ok = pct <= maxBarrier;
  return {
    ok,
    boundLabel: `${pct.toFixed(1)}% · W↑ ${upperPct.toFixed(1)}% · max ${maxBarrier.toFixed(1)}%`,
  };
}

function windowVotes(
  side: ContractSide,
  windows: DigitStats[],
  sizes: number[],
  fallback: number,
  primaryFallback: number,
): { digit: number; agree: boolean; votes: string } {
  if (windows.length === 0) {
    return { digit: primaryFallback, agree: false, votes: "—" };
  }

  const picks = windows.map((stats, i) => {
    const size = sizes[i] ?? stats.sampleSize;
    return {
      size,
      digit: pickStableDigit(stats, side, fallback),
      ready: windowReady(stats.sampleSize, size),
    };
  });

  const ready = picks.filter((p) => p.ready);
  const voteText = picks.map((p) => `${p.digit}@${p.size}${p.ready ? "" : "?"}`).join(" · ");

  if (ready.length < 2) {
    return { digit: primaryFallback, agree: false, votes: voteText };
  }

  const first = ready[0].digit;
  const agree = ready.every((p) => p.digit === first);
  return {
    digit: agree ? first : primaryFallback,
    agree,
    votes: voteText,
  };
}

function multiWindowEv(
  side: ContractSide,
  digit: number,
  windows: DigitStats[],
  sizes: number[],
  minEdge: number,
  symbol?: string,
): { ok: boolean; detail: string } {
  if (windows.length === 0) {
    return { ok: false, detail: "—" };
  }

  const parts: string[] = [];
  let readyCount = 0;
  let passCount = 0;

  for (let i = 0; i < windows.length; i += 1) {
    const stats = windows[i];
    const size = sizes[i] ?? stats.sampleSize;
    const pct = stats.percentages[digit] ?? 0;
    const ready = windowReady(stats.sampleSize, size);
    const pass = ready && clearsEv(side, pct, minEdge, symbol);
    parts.push(`${pct.toFixed(1)}%@${size}${ready ? (pass ? "" : "×") : "?"}`);
    if (ready) {
      readyCount += 1;
      if (pass) passCount += 1;
    }
  }

  return {
    ok: readyCount >= 2 && passCount === readyCount,
    detail: parts.join(" · "),
  };
}

function timingClears(
  side: ContractSide,
  gap: number | null,
  maxMomentumGap: number,
  minColdGap: number,
): boolean {
  if (gap === null) return side === "DIGITDIFF";
  if (side === "DIGITMATCH") return gap <= maxMomentumGap;
  return gap >= minColdGap;
}

function separationLabel(
  stats: DigitStats,
  digit: number,
  side: ContractSide,
): string {
  const count = stats.counts[digit] ?? 0;
  if (side === "DIGITMATCH") {
    const rival = stats.hottest.find((d) => d !== digit);
    if (rival === undefined) return `lead ${count}`;
    const lead = count - (stats.counts[rival] ?? 0);
    return `lead +${lead} vs ${rival}`;
  }
  const rival = stats.coldest.find((d) => d !== digit);
  if (rival === undefined) return `cold ${count}`;
  const lead = (stats.counts[rival] ?? 0) - count;
  return `cold −${lead} vs ${rival}`;
}

/**
 * Frequency-persistence strategy with confirmation layers:
 * 1) Primary window clears payout break-even (Wilson-bounded)
 * 2) Multi-window digit agreement (powered windows only)
 * 3) Same digit clears EV in each ready window
 * 4) Timing: Matches = recent print; Differs = still absent
 * 5) Structure: χ² uneven + clear count lead vs runner-up
 */
export function buildMarketSignal(
  stats: DigitStats,
  preferredSide: ContractSide,
  fallbackDigit: number,
  options: SignalOptions = {},
): MarketSignal {
  const minEdge = options.minEdgePercent ?? 0;
  const maxMomentumGap = options.maxMomentumGap ?? 2;
  const minColdGap = options.minColdGap ?? 8;
  const evenPct = stats.sampleSize === 0 ? 0 : (stats.evenCount / stats.sampleSize) * 100;
  const primaryDigit = pickStableDigit(stats, preferredSide, fallbackDigit);
  const vote = windowVotes(
    preferredSide,
    options.windowStats ?? [],
    options.windowSizes ?? [],
    fallbackDigit,
    primaryDigit,
  );
  const digit = vote.agree ? vote.digit : primaryDigit;
  const digitPercent = stats.percentages[digit] ?? 0;
  const signalGap = stats.gaps[digit] ?? null;
  const wilson = clearsEvWithWilson(
    preferredSide,
    stats,
    digit,
    minEdge,
    options.symbol,
  );
  const evOk = wilson.ok;
  const multiEv = multiWindowEv(
    preferredSide,
    digit,
    options.windowStats ?? [],
    options.windowSizes ?? [],
    minEdge,
    options.symbol,
  );
  const timingOk = timingClears(preferredSide, signalGap, maxMomentumGap, minColdGap);
  const minLead = preferredSide === "DIGITDIFF" ? 2 : 2;
  const separationOk = hasClearDigitLead(stats, digit, preferredSide, minLead);
  const structureOk = stats.uniformity.significant && separationOk;
  const barrierAligned = barrierAlignsWithSide(stats, digit, preferredSide);
  const windowFair = !stats.uniformity.significant;
  const coldMarginOk =
    preferredSide !== "DIGITDIFF" || coldBarrierMarginOk(stats, digit, 1);

  const watching = {
    lastDigit: stats.currentStreak.digit,
    streak:
      stats.currentStreak.digit === null
        ? "—"
        : `${stats.currentStreak.digit} × ${stats.currentStreak.length}`,
    hot: stats.hottest.slice(0, 3).join(" · ") || "—",
    cold: stats.coldest.slice(0, 3).join(" · ") || "—",
    evenOdd: `${evenPct.toFixed(0)}% / ${(100 - evenPct).toFixed(0)}%`,
    sampleSize: stats.sampleSize,
    signalGap,
    windowVotes: vote.votes,
    windowEv: multiEv.detail,
    separation: separationLabel(stats, digit, preferredSide),
    wilsonBound: wilson.boundLabel,
  };

  const base = {
    side: preferredSide,
    digit,
    windowsAgree: vote.agree,
    digitPercent,
    evOk,
    windowsEvOk: multiEv.ok,
    timingOk,
    structureOk,
    separationOk,
    barrierAligned,
    windowFair,
    coldMarginOk,
    watching,
  };

  if (stats.sampleSize < 50) {
    return {
      ...base,
      digit: fallbackDigit,
      label: "Collecting ticks",
      reason: `Need ~50 ticks for ${
        preferredSide === "DIGITMATCH" ? "Matches" : "Differs"
      } frequency gates.`,
      confidence: "low",
      windowsAgree: false,
      digitPercent: stats.percentages[fallbackDigit] ?? 0,
      evOk: false,
      windowsEvOk: false,
      timingOk: false,
      structureOk: false,
      separationOk: false,
      barrierAligned: false,
      windowFair: true,
      coldMarginOk: false,
      watching: {
        ...watching,
        signalGap: stats.gaps[fallbackDigit] ?? null,
        separation: "—",
        wilsonBound: "—",
      },
    };
  }

  const allConfirm = evOk && vote.agree && multiEv.ok && timingOk && structureOk;
  const confidence: MarketSignal["confidence"] = allConfirm
    ? "medium"
    : stats.sampleSize >= WINDOW_READY_FLOOR && evOk && separationOk
      ? "soft"
      : "low";

  const confirmBits = [
    `EV ${evOk ? "ok" : "no"} (${wilson.boundLabel})`,
    `windows ${vote.agree ? "agree" : "split"}`,
    `multi-EV ${multiEv.ok ? "ok" : "no"}`,
    preferredSide === "DIGITMATCH"
      ? `momentum gap ${signalGap ?? "—"}≤${maxMomentumGap} ${timingOk ? "ok" : "no"}`
      : `cold gap ${signalGap ?? "—"}≥${minColdGap} ${timingOk ? "ok" : "no"}`,
    `lead ${separationOk ? "ok" : "thin"} · χ² ${stats.uniformity.significant ? "uneven" : "fair"}`,
  ].join(" · ");

  if (preferredSide === "DIGITMATCH") {
    const need = breakEvenDigitPercent("DIGITMATCH", options.symbol) + minEdge;
    if (allConfirm) {
      return {
        ...base,
        label: `Matches ${digit}`,
        reason: `Confirmed Matches ${digit}: hot ${digitPercent.toFixed(1)}% ≥ ${need.toFixed(1)}%, Wilson clear, stable lead, recent print, multi-window EV. ${confirmBits}`,
        confidence,
        evOk: true,
      };
    }
    return {
      ...base,
      label: `Watch Matches ${digit}`,
      reason: `Waiting on confirms for Matches ${digit} (${digitPercent.toFixed(1)}%, need ≥ ${need.toFixed(1)}%). ${confirmBits}`,
      confidence,
    };
  }

  const maxBarrier = breakEvenDigitPercent("DIGITDIFF", options.symbol) - minEdge;
  if (allConfirm) {
    return {
      ...base,
      label: `Differs ${digit}`,
      reason: `Confirmed Differs ${digit}: cold ${digitPercent.toFixed(1)}% ≤ ${maxBarrier.toFixed(1)}%, Wilson clear, stable lead, still absent, multi-window EV. ${confirmBits}`,
      confidence,
      evOk: true,
    };
  }

  return {
    ...base,
    label: `Watch Differs ${digit}`,
    reason: `Waiting on confirms for Differs ${digit} (${digitPercent.toFixed(1)}%, need ≤ ${maxBarrier.toFixed(1)}%). ${confirmBits}`,
    confidence,
  };
}

/** How many of the 5 confirmation layers are green. */
export function confirmScore(signal: MarketSignal): number {
  return [
    signal.evOk,
    signal.windowsAgree,
    signal.windowsEvOk,
    signal.timingOk,
    signal.structureOk,
  ].filter(Boolean).length;
}

export function isFullyConfirmed(signal: MarketSignal): boolean {
  return confirmScore(signal) === 5;
}

/** Edge distance past break-even in percentage points (higher = stronger setup). */
export function setupEdgePoints(signal: MarketSignal): number {
  if (signal.side === "DIGITMATCH") {
    return signal.digitPercent - MATCH_BREAK_EVEN_PCT;
  }
  return DIFF_BARRIER_BREAK_EVEN_PCT - signal.digitPercent;
}

/**
 * Prefer a fully confirmed side.
 * matches: always Matches. It pays ~8.3x, so one win clears a lost basket and
 *   the recovery ladder can actually work; Differs pays ~9% and cannot.
 * winrate: Differs first (≈90% hits) whenever it is armed.
 * edge: strongest break-even distance; Matches wins ties (better payout).
 */
export function pickBetterSignal(
  matches: MarketSignal,
  differs: MarketSignal,
  preference: "differs" | "matches" | "winrate" | "edge" = "edge",
): MarketSignal {
  const mFull = isFullyConfirmed(matches);
  const dFull = isFullyConfirmed(differs);

  if (preference === "differs") return differs;
  if (preference === "matches") return matches;

  if (preference === "winrate") {
    if (dFull) return differs;
    if (mFull) return matches;
    const dScore = confirmScore(differs);
    const mScore = confirmScore(matches);
    if (dScore !== mScore) return dScore > mScore ? differs : matches;
    return differs;
  }

  // edge (default): confirmed side first, then stronger distance; Matches on tie.
  if (mFull && !dFull) return matches;
  if (dFull && !mFull) return differs;
  const mScore = confirmScore(matches);
  const dScore = confirmScore(differs);
  if (mScore !== dScore) return mScore > dScore ? matches : differs;
  const mEdge = setupEdgePoints(matches);
  const dEdge = setupEdgePoints(differs);
  if (Math.abs(mEdge - dEdge) < 0.05) return matches;
  return mEdge >= dEdge ? matches : differs;
}
