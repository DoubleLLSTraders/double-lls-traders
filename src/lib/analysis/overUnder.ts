import {
  breakEvenDigitPercent,
  overUnderPayoutMultiplier,
} from "../bot/performance";
import type { DigitStats } from "./digits";
import {
  BARRIER_COMPARISONS,
  judgeEvidence,
  type EvidenceVerdict,
} from "./evidence";
import {
  sideLabel,
  type ContractSide,
  type MarketSignal,
  type SignalOptions,
} from "./signal";

export type OverUnderSide = "DIGITOVER" | "DIGITUNDER";

/**
 * How the Over/Under desk enters.
 *  oneRun   — one history-picked buy per Start, then stop.
 *  momentum — keeps picking and trading number after number.
 *  proven   — only a statistically proven edge, may never fire.
 */
export type OuEntryMode = "oneRun" | "momentum" | "proven";

/** Micro tape for Blitz momentum (seconds on 1s indices). */
export const OU_BLITZ_MICRO = 16;
/** Confirm window — deep enough to filter fakes, short enough to fire <1m. */
export const OU_BLITZ_SHORT = 48;

/**
 * Liquid Over/Under barriers — fair win ~60–90%.
 * Ranked by edge vs fair / payout EV, not raw hit-rate (that always crowned Under 9).
 */
const BLITZ_OVER_BARRIERS = [0, 1, 2, 3] as const;
const BLITZ_UNDER_BARRIERS = [6, 7, 8, 9] as const;

export interface BarrierScore {
  side: OverUnderSide;
  barrier: number;
  /** Observed win-rate % on the scoring window. */
  winPercent: number;
  wins: number;
  sampleSize: number;
  breakEven: number;
  /** Short-window win% − payout break-even %. */
  edge: number;
  /** Micro win% − fair win% (uniform digits). */
  microEdge: number;
  /** Short win% − fair win%. */
  shortEdge: number;
  /** Micro expected value per unit stake: p·payout − 1. */
  microEv: number;
  /** Ticks since last winning outcome for this setup. */
  gap: number | null;
  payout: number;
  /** Fair win probability % under uniform digits. */
  fairPercent: number;
  /** Recent consecutive winning outcomes from the newest tick. */
  streak: number;
  /** Micro-window (last ~12) win %. */
  microPercent: number;
  /** Blitz composite used to rank setups (edge / EV first). */
  blitzScore: number;
  /**
   * Search-corrected proof that this barrier beats its payout break-even.
   * Measured on the widest tape available, not the momentum windows — a
   * 16-tick read cannot separate a real 2pp edge from a coin flip.
   */
  evidence: EvidenceVerdict;
}

/** Fair win probability under uniform digits. */
export function fairWinProb(side: OverUnderSide, barrier: number): number {
  if (side === "DIGITOVER") {
    if (barrier < 0 || barrier > 8) return 0;
    return (9 - barrier) / 10;
  }
  if (barrier < 1 || barrier > 9) return 0;
  return barrier / 10;
}

export function outcomeWon(
  side: OverUnderSide,
  barrier: number,
  digit: number,
): boolean {
  return side === "DIGITOVER" ? digit > barrier : digit < barrier;
}

function winStreak(
  digits: readonly number[],
  side: OverUnderSide,
  barrier: number,
): number {
  let streak = 0;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    if (!outcomeWon(side, barrier, digits[i])) break;
    streak += 1;
  }
  return streak;
}

function gapSinceWin(
  digits: readonly number[],
  side: OverUnderSide,
  barrier: number,
): number | null {
  for (let offset = 0; offset < digits.length; offset += 1) {
    if (outcomeWon(side, barrier, digits[digits.length - 1 - offset])) {
      return offset;
    }
  }
  return null;
}

function windowStats(
  digits: readonly number[],
  side: OverUnderSide,
  barrier: number,
): { wins: number; sampleSize: number; winPercent: number } {
  const sampleSize = digits.length;
  let wins = 0;
  for (const digit of digits) {
    if (outcomeWon(side, barrier, digit)) wins += 1;
  }
  return {
    wins,
    sampleSize,
    winPercent: sampleSize === 0 ? 0 : (wins / sampleSize) * 100,
  };
}

/**
 * Score one barrier from Over/Under market math:
 * win = digit > barrier (Over) or digit < barrier (Under),
 * rank by excess vs fair + payout EV — not absolute win%.
 */
export function scoreBarrierBlitz(
  digits: readonly number[],
  side: OverUnderSide,
  barrier: number,
): BarrierScore {
  const micro = digits.slice(-OU_BLITZ_MICRO);
  const short = digits.slice(-OU_BLITZ_SHORT);
  const microStats = windowStats(micro, side, barrier);
  const shortStats = windowStats(short, side, barrier);
  // Proof runs on the whole tape; momentum windows are far too small to
  // separate the ~2pp house edge from sampling noise.
  const proofStats = windowStats(digits, side, barrier);
  const streak = winStreak(digits, side, barrier);
  const gap = gapSinceWin(digits, side, barrier);
  const fairPct = fairWinProb(side, barrier) * 100;
  const payout = overUnderPayoutMultiplier(side, barrier);
  const breakEven = breakEvenDigitPercent(side, undefined, barrier);
  const edge = shortStats.winPercent - breakEven;
  const microEdge = microStats.winPercent - fairPct;
  const shortEdge = shortStats.winPercent - fairPct;
  const microEv = (microStats.winPercent / 100) * payout - 1;
  const shortEv = (shortStats.winPercent / 100) * payout - 1;
  // Long streaks are cheap on Under 9 (fair 90%) — credit rarer wins more.
  const rare = Math.max(0.08, 1 - fairPct / 100);
  const streakWeight = streak * rare * 32;

  let blitzScore =
    microEdge * 2.4 +
    shortEdge * 1.15 +
    microEv * 70 +
    shortEv * 40 +
    streakWeight +
    edge * 1.4;
  if (gap === 0) blitzScore += 12;
  else if (gap === 1) blitzScore += 6;
  else if (gap !== null && gap <= 2) blitzScore += 2;
  if (microEdge >= 0) blitzScore += 10;
  if (microEdge >= 4) blitzScore += 8;
  if (microEv > 0) blitzScore += 14;
  if (shortEv > 0) blitzScore += 12;
  if (edge >= 0) blitzScore += 10;
  // Cheap high-hit barriers (Under 9 / Over 0) look "sure" but bleed — bury them.
  if (fairPct >= 85) {
    blitzScore -= microEv > 0.06 && shortEv > 0.05 && edge >= 2.5 ? 18 : 80;
  } else if (payout < 1.25) {
    blitzScore -= microEv > 0.04 && edge >= 1.5 ? 6 : 30;
  }

  const evidence = judgeEvidence({
    wins: proofStats.wins,
    n: proofStats.sampleSize,
    breakEvenPercent: breakEven,
    comparisons: BARRIER_COMPARISONS,
  });
  // A proven barrier outranks any amount of momentum flattery.
  if (evidence.ok) blitzScore += 120;

  return {
    evidence,
    side,
    barrier,
    winPercent: shortStats.winPercent,
    wins: shortStats.wins,
    sampleSize: shortStats.sampleSize,
    breakEven,
    edge,
    microEdge,
    shortEdge,
    microEv,
    gap,
    payout,
    fairPercent: fairPct,
    streak,
    microPercent: microStats.winPercent,
    blitzScore,
  };
}

export function scoreAllBarriers(digits: readonly number[]): BarrierScore[] {
  const scores: BarrierScore[] = [];
  for (const b of BLITZ_OVER_BARRIERS) {
    scores.push(scoreBarrierBlitz(digits, "DIGITOVER", b));
  }
  for (const b of BLITZ_UNDER_BARRIERS) {
    scores.push(scoreBarrierBlitz(digits, "DIGITUNDER", b));
  }
  return scores;
}

/** @deprecated alias — Blitz uses scoreBarrierBlitz. */
export function scoreBarrier(
  digits: readonly number[],
  side: OverUnderSide,
  barrier: number,
): BarrierScore {
  return scoreBarrierBlitz(digits, side, barrier);
}

function pickBestScore(
  scores: BarrierScore[],
  preferredSide?: OverUnderSide | null,
  fallbackBarrier = 1,
): BarrierScore {
  const pool = preferredSide
    ? scores.filter((s) => s.side === preferredSide)
    : scores;
  if (pool.length === 0) {
    const side = preferredSide ?? "DIGITOVER";
    const fairPercent = fairWinProb(side, fallbackBarrier) * 100;
    const payout = overUnderPayoutMultiplier(side, fallbackBarrier);
    return {
      side,
      barrier: fallbackBarrier,
      winPercent: 0,
      wins: 0,
      sampleSize: 0,
      breakEven: breakEvenDigitPercent(side, undefined, fallbackBarrier),
      edge: -breakEvenDigitPercent(side, undefined, fallbackBarrier),
      microEdge: -fairPercent,
      shortEdge: -fairPercent,
      microEv: -1,
      gap: null,
      payout,
      fairPercent,
      streak: 0,
      microPercent: 0,
      blitzScore: 0,
      evidence: judgeEvidence({
        wins: 0,
        n: 0,
        breakEvenPercent: breakEvenDigitPercent(side, undefined, fallbackBarrier),
      }),
    };
  }
  // Proven barriers first. Only when nothing is proven does momentum decide,
  // and that pick can never be called "sure" downstream.
  const proven = pool.filter((s) => s.evidence.ok);
  if (proven.length > 0) {
    return proven.reduce((best, cur) =>
      cur.evidence.lowerPercent - cur.evidence.needPercent >
      best.evidence.lowerPercent - best.evidence.needPercent
        ? cur
        : best,
    );
  }
  // Prefer barriers with real payout EV; never crown a negative-EV Under 9
  // just because the raw hit-rate looks high.
  const profitable = pool.filter(
    (s) => s.microEv > 0 && (s.winPercent / 100) * s.payout - 1 > 0,
  );
  const ranked = profitable.length > 0 ? profitable : pool;
  return ranked.reduce((best, cur) =>
    cur.blitzScore >= best.blitzScore ? cur : best,
  );
}

function scorePower(parts: {
  evOk: boolean;
  timingOk: boolean;
  structureOk: boolean;
  streakHot: boolean;
  gapStrong: boolean;
  microHot: boolean;
  uniqueEvOk: boolean;
}): number {
  let power = 0;
  if (parts.evOk) power += 18;
  if (parts.timingOk) power += 20;
  if (parts.structureOk) power += 14;
  if (parts.streakHot) power += 16;
  if (parts.gapStrong) power += 14;
  if (parts.microHot) power += 12;
  if (parts.uniqueEvOk) power += 6;
  return Math.min(100, power);
}

/**
 * Over/Under Blitz — market-form scoring (edge vs fair + payout EV).
 * `digit` = barrier, `digitPercent` = short-window contract win %.
 */
export function buildOverUnderSignal(
  digits: readonly number[],
  stats: DigitStats,
  preferredSide: OverUnderSide | null,
  fallbackBarrier: number,
  options: SignalOptions = {},
): MarketSignal {
  const maxMomentumGap = options.maxMomentumGap ?? 1;
  const minSampleForHigh = Math.min(
    options.minSampleForHigh ?? OU_BLITZ_SHORT,
    OU_BLITZ_SHORT,
  );
  const scores = scoreAllBarriers(digits);
  const best = pickBestScore(scores, preferredSide, fallbackBarrier);
  const side: ContractSide = best.side;
  const barrier = best.barrier;
  const fairPct = best.fairPercent;
  const gap = best.gap;
  const n = best.sampleSize;
  const rare = Math.max(0.08, 1 - fairPct / 100);
  /** Tape clears payout break-even after correcting for the barrier search. */
  const proven = best.evidence.ok;

  // Market form: beat fair / break-even — block fake Under 9, still fire inside 1m.
  const shortEv = (best.winPercent / 100) * best.payout - 1;
  const microHot = best.microEdge >= 2;
  const shortHot = best.shortEdge >= 1 && best.edge >= 1;
  const streakHot =
    best.streak >= 2 &&
    (best.microEdge >= 2 || best.streak * rare >= 0.4);
  const timingOk =
    gap !== null &&
    gap <= maxMomentumGap &&
    (streakHot || microHot);
  const gapStrong = gap !== null && gap <= Math.max(0, maxMomentumGap);
  // Payout EV only counts as "ok" once the bound proves it — a positive EV
  // computed from a 16-tick window is a rounding artefact, not an edge.
  const evOk =
    proven &&
    best.microEv > 0.025 &&
    shortEv > 0.015 &&
    best.edge >= 1 &&
    best.shortEdge >= 1;
  const structureOk =
    best.microEdge >= 2 && (streakHot || best.microEdge >= 3);
  const rival = scores
    .filter((s) => !(s.side === best.side && s.barrier === barrier))
    .reduce<BarrierScore | null>((acc, s) => {
      if (!acc || s.blitzScore > acc.blitzScore) return s;
      return acc;
    }, null);
  const uniqueEvOk =
    !rival || best.blitzScore >= rival.blitzScore + 8;
  const barrierAligned = true;
  const primaryBarrier = true;
  const sampleElite = n >= minSampleForHigh;
  const separationOk = structureOk;
  const coldMarginOk = best.microEdge >= 2 && best.edge >= 1;
  // Cheap 90%-ish fair barriers need fat EV — otherwise never HIGH.
  const cheapSureTrap =
    fairPct >= 85 &&
    !(best.microEv > 0.05 && shortEv > 0.04 && best.edge >= 2);

  const evenPct =
    stats.sampleSize === 0 ? 0 : (stats.evenCount / stats.sampleSize) * 100;
  const edgeSign = best.microEdge >= 0 ? "+" : "";

  const watching = {
    lastDigit: stats.currentStreak.digit,
    streak:
      best.streak > 0
        ? `${sideLabel(side)} ×${best.streak}`
        : stats.currentStreak.digit === null
          ? "—"
          : `${stats.currentStreak.digit} × ${stats.currentStreak.length}`,
    hot: stats.hottest.slice(0, 3).join(" · ") || "—",
    cold: stats.coldest.slice(0, 3).join(" · ") || "—",
    evenOdd: `${evenPct.toFixed(0)}% / ${(100 - evenPct).toFixed(0)}%`,
    sampleSize: n,
    signalGap: gap,
    windowVotes: scores
      .filter((s) => s.side === best.side)
      .sort((a, b) => b.blitzScore - a.blitzScore)
      .slice(0, 3)
      .map(
        (s) =>
          `${s.barrier}@${s.microEdge >= 0 ? "+" : ""}${s.microEdge.toFixed(0)}`,
      )
      .join(" · "),
    windowEv: `OU · fair ${fairPct.toFixed(0)}% · µ${edgeSign}${best.microEdge.toFixed(0)} · BE ${best.edge >= 0 ? "+" : ""}${best.edge.toFixed(1)} · EV ${best.microEv >= 0 ? "+" : ""}${best.microEv.toFixed(2)} · ×${best.payout.toFixed(2)}`,
    separation: rival
      ? `edge ${best.blitzScore.toFixed(0)} vs ${sideLabel(rival.side)} ${rival.barrier}`
      : `edge ${best.blitzScore.toFixed(0)}`,
    wilsonBound: best.evidence.ok
      ? `PROVEN · ${best.evidence.label}`
      : best.evidence.ticksNeeded === null
        ? `no edge · ${best.evidence.label}`
        : `unproven · ${best.evidence.label} · needs ~${best.evidence.ticksNeeded} ticks`,
  };

  const deskConfirm =
    evOk &&
    timingOk &&
    structureOk &&
    barrierAligned &&
    primaryBarrier &&
    !cheapSureTrap;
  const highArmed =
    deskConfirm &&
    coldMarginOk &&
    gapStrong &&
    sampleElite &&
    uniqueEvOk &&
    (streakHot || (microHot && shortHot)) &&
    best.microEv > 0.03 &&
    shortEv > 0.02 &&
    best.edge >= 1.2 &&
    best.streak >= 2;

  const momentumPower = scorePower({
    evOk,
    timingOk,
    structureOk,
    streakHot,
    gapStrong,
    microHot,
    uniqueEvOk,
  });
  /**
   * Momentum can rank barriers but it cannot certify one. Without a
   * search-corrected bound above break-even the tape has not shown an edge,
   * so power is capped below the entry floor and the call stays a watch.
   * This is what stops the analyzer promising "sure" and reverting a tick later.
   */
  const power = proven ? momentumPower : Math.min(momentumPower, 60);
  const sureHigh = proven && highArmed && momentumPower >= 85;

  const confidence: MarketSignal["confidence"] = sureHigh
    ? "high"
    : deskConfirm && gapStrong && power >= 65
      ? "medium"
      : deskConfirm
        ? "soft"
        : "low";

  const labelSide = sideLabel(side);
  const base: MarketSignal = {
    side,
    digit: barrier,
    label: `${labelSide} ${barrier}`,
    reason: "",
    confidence,
    power,
    windowsAgree: true,
    digitPercent: best.winPercent,
    evOk,
    windowsEvOk: microHot && shortHot,
    timingOk,
    structureOk,
    separationOk,
    barrierAligned,
    windowFair: !stats.uniformity.significant,
    coldMarginOk,
    primaryBarrier,
    uniqueEvOk,
    proven,
    provenLabel: best.evidence.label,
    watching,
  };

  if (digits.length < OU_BLITZ_MICRO) {
    return {
      ...base,
      digit: fallbackBarrier,
      label: "Collecting ticks",
      reason: `Blitz needs ~${OU_BLITZ_MICRO} ticks for ${labelSide} market form.`,
      confidence: "low",
      power: 0,
      digitPercent: 0,
      evOk: false,
      windowsEvOk: false,
      timingOk: false,
      structureOk: false,
      separationOk: false,
      barrierAligned: false,
      coldMarginOk: false,
      primaryBarrier: false,
      uniqueEvOk: false,
      watching: {
        ...watching,
        sampleSize: digits.length,
        signalGap: null,
        separation: "—",
        wilsonBound: "—",
      },
    };
  }

  const confirmBits = [
    `µ ${edgeSign}${best.microEdge.toFixed(0)} vs fair`,
    `BE ${best.edge >= 0 ? "+" : ""}${best.edge.toFixed(1)}`,
    `EV ${best.microEv >= 0 ? "+" : ""}${best.microEv.toFixed(2)}`,
    `streak ${best.streak}`,
    `gap ${gap ?? "—"}≤${maxMomentumGap}`,
    `power ${power} · ${confidence}`,
  ].join(" · ");

  if (!proven) {
    const ev = best.evidence;
    const why =
      ev.ticksNeeded === null
        ? `tape is at ${ev.observedPercent.toFixed(1)}% but the ×${best.payout.toFixed(2)} payout needs ${ev.needPercent.toFixed(1)}% — no edge to trade`
        : `bound ${ev.lowerPercent.toFixed(1)}% is ${ev.shortfallPercent.toFixed(1)}pp under the ${ev.needPercent.toFixed(1)}% break-even · ~${ev.ticksNeeded} ticks would prove it`;
    return {
      ...base,
      label: `Watch ${labelSide} ${barrier}`,
      reason: `Unproven ${labelSide} ${barrier}: ${why}. No entry on unproven tape. ${confirmBits}`,
    };
  }

  if (sureHigh) {
    return {
      ...base,
      confidence: "high",
      label: `${labelSide} ${barrier}`,
      reason: `Blitz HIGH ${labelSide} ${barrier}: sure · tape beats fair (${fairPct.toFixed(0)}%) by ${edgeSign}${best.microEdge.toFixed(0)}pp · payout ×${best.payout.toFixed(2)}. ${confirmBits}`,
    };
  }
  if (deskConfirm) {
    return {
      ...base,
      label: `${labelSide} ${barrier}`,
      reason: `Blitz armed ${labelSide} ${barrier}: edge live — proving… ${confirmBits}`,
    };
  }
  return {
    ...base,
    label: `Watch ${labelSide} ${barrier}`,
    reason: `Blitz hunting ${labelSide} ${barrier}: wait edge vs fair / EV. ${confirmBits}`,
  };
}

/**
 * The committed plan: a barrier whose measured rate clears what its own
 * payout demands, by more than the noise of the measurement.
 */
export type WinPlan = BarrierEdge;

/**
 * Plan candidates. The thin-payout barriers (Over 0/1, Under 8/9) are
 * excluded on purpose: at ×1.09–×1.22 a single loss erases 4–11 wins, so
 * a 60%-winning run still ends deep red. Everything here pays ≥ ×1.39,
 * where one loss costs at most ~2.5 wins.
 */
const PLAN_BARRIERS: Array<{ side: OverUnderSide; barrier: number }> = [
  { side: "DIGITOVER", barrier: 2 },
  { side: "DIGITOVER", barrier: 3 },
  { side: "DIGITOVER", barrier: 4 },
  { side: "DIGITUNDER", barrier: 5 },
  { side: "DIGITUNDER", barrier: 6 },
  { side: "DIGITUNDER", barrier: 7 },
];

/** Deep read for the base rate; recent read for form. Kept disjoint. */
const PLAN_DEEP_TICKS = 500;
const PLAN_RECENT_TICKS = 60;
const PLAN_DEEP_WEIGHT = 0.45;
const PLAN_RECENT_WEIGHT = 0.55;

export interface BarrierEdge {
  side: OverUnderSide;
  barrier: number;
  longPercent: number;
  recentPercent: number;
  fairPercent: number;
  /** Weighted blend of the deep and recent windows. */
  observedPercent: number;
  payout: number;
  /** Win % the payout demands to break even — 100 / payout. */
  breakEven: number;
  /**
   * observed − breakEven. The ONLY edge that pays: beating the fair rate
   * is worthless when the payout is priced below fair.
   */
  edge: number;
  /** One standard error of the blended estimate, in pp. */
  noise: number;
  /** edge − noise: the part that survives measurement error. */
  netEdge: number;
  /** Wins erased by a single loss — 1 / (payout − 1). */
  lossPerWin: number;
  sampleSize: number;
  /**
   * Confidence in sigmas: how many standard errors the observed rate sits
   * above the payout break-even. This is the honest ranking key — raw hit
   * rate always crowns whichever barrier has the highest fair rate, which
   * is why a hit-rate ranking gets stuck on one number forever.
   */
  zScore: number;
}

/** Every tradable Over/Under barrier — the full board, both sides. */
export const ALL_OU_BARRIERS: Array<{
  side: OverUnderSide;
  barrier: number;
}> = [
  ...([0, 1, 2, 3, 4, 5, 6, 7, 8] as const).map((barrier) => ({
    side: "DIGITOVER" as const,
    barrier,
  })),
  ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((barrier) => ({
    side: "DIGITUNDER" as const,
    barrier,
  })),
];

/**
 * Measure one barrier the way the money works: observed win rate against
 * the rate its payout demands, discounted by the noise of the windows it
 * was measured on. A 60-tick window carries ~6pp of noise, so a "+1.7pp"
 * reading is not a signal — netEdge is what must be positive.
 */
export function barrierEdge(
  digits: readonly number[],
  side: OverUnderSide,
  barrier: number,
): BarrierEdge | null {
  if (digits.length < 80) return null;
  const recentWindow = digits.slice(-PLAN_RECENT_TICKS);
  const deepWindow = digits.slice(-PLAN_DEEP_TICKS, -PLAN_RECENT_TICKS);
  if (deepWindow.length < 20) return null;
  const deep = windowStats(deepWindow, side, barrier);
  const recent = windowStats(recentWindow, side, barrier);
  const payout = overUnderPayoutMultiplier(side, barrier);
  const breakEven = breakEvenDigitPercent(side, undefined, barrier);
  const observedPercent =
    deep.winPercent * PLAN_DEEP_WEIGHT +
    recent.winPercent * PLAN_RECENT_WEIGHT;
  const p = observedPercent / 100;
  const spread = p * (1 - p);
  const noise =
    Math.sqrt(
      PLAN_DEEP_WEIGHT ** 2 * (spread / deep.sampleSize) +
        PLAN_RECENT_WEIGHT ** 2 * (spread / recent.sampleSize),
    ) * 100;
  const edge = observedPercent - breakEven;
  return {
    side,
    barrier,
    longPercent: deep.winPercent,
    recentPercent: recent.winPercent,
    fairPercent: fairWinProb(side, barrier) * 100,
    observedPercent,
    payout,
    breakEven,
    edge,
    noise,
    netEdge: edge - noise,
    lossPerWin: payout > 1 ? 1 / (payout - 1) : Number.POSITIVE_INFINITY,
    sampleSize: deep.sampleSize + recent.sampleSize,
    zScore: noise > 0 ? edge / noise : 0,
  };
}

/**
 * Payout floor for an answer. Over 0/1 and Under 8/9 pay ×1.09–×1.22, so a
 * single loss erases 4–11 wins: they are scanned and reported but never
 * offered as the trade, however confident they look.
 */
export const MIN_ANSWER_PAYOUT = 1.35;

/**
 * Read the whole board — every Over and every Under barrier — and rank by
 * confidence that the barrier is beating what its payout demands. Highest
 * confidence first. Thin-payout barriers are dropped unless asked for.
 */
export function rankBarriersByConfidence(
  digits: readonly number[],
  options?: { includeThinPayouts?: boolean },
): BarrierEdge[] {
  const scored: BarrierEdge[] = [];
  for (const { side, barrier } of ALL_OU_BARRIERS) {
    const edge = barrierEdge(digits, side, barrier);
    if (!edge) continue;
    if (
      options?.includeThinPayouts !== true &&
      edge.payout < MIN_ANSWER_PAYOUT
    ) {
      continue;
    }
    scored.push(edge);
  }
  return scored.sort((a, b) => b.zScore - a.zScore);
}

/**
 * Study the tape and name the barrier with the largest edge over its own
 * payout break-even, after noise. Ranking against break-even (not fair)
 * is the whole point: Over 1 running 81.7% looks strong against its 80%
 * fair rate, yet it needs 82.0% to break even, so buying it is a
 * guaranteed bleed. A null / negative-net answer means do not trade.
 */
export function pickWinPlan(digits: readonly number[]): WinPlan | null {
  let best: WinPlan | null = null;
  for (const { side, barrier } of PLAN_BARRIERS) {
    const edge = barrierEdge(digits, side, barrier);
    if (!edge) continue;
    if (!best || edge.netEdge > best.netEdge) best = edge;
  }
  return best;
}

/**
 * One-run pick: the most confident barrier on the whole board.
 */
export function pickBestChance(digits: readonly number[]): BarrierEdge | null {
  return rankBarriersByConfidence(digits)[0] ?? null;
}

/** Live window the chance estimate tracks — short, so it moves with the tape. */
const CHANCE_LIVE_TICKS = 120;
/**
 * Strength of the fair-rate prior, in pseudo-ticks. Digits come from a
 * CSPRNG, so the fair rate is very close to the truth and a short window's
 * wobble is mostly noise. A heavy prior keeps the estimate honest while
 * still letting the live tape move it a few points.
 */
const CHANCE_PRIOR_TICKS = 280;

/**
 * The two highest-hit barriers on the board — Over 0 and Under 9 both land
 * ~90% of the time. One-run mode only chooses between these two.
 */
export const SAFE_PAIR_BARRIERS: Array<{
  side: OverUnderSide;
  barrier: number;
}> = [
  { side: "DIGITOVER", barrier: 0 },
  { side: "DIGITUNDER", barrier: 9 },
];

/**
 * A barrier rated by the only thing that matters for a single trade: the
 * chance the very next tick lands inside it.
 */
export interface BarrierChance {
  side: OverUnderSide;
  barrier: number;
  /** Exact rate under uniform digits — the anchor. */
  fairPercent: number;
  /** Hit rate over the live window — what the tape is doing right now. */
  livePercent: number;
  /** livePercent − fairPercent, in pp: which way the tape leans. */
  tilt: number;
  /**
   * The answer: live window shrunk toward the fair rate. This is the honest
   * probability, and it is what the pick is ranked on.
   */
  chancePercent: number;
  payout: number;
  /** Rate the payout demands to break even — 100 / payout. */
  breakEven: number;
  /** chance × payout − 1, as a percent of stake. Negative on every barrier. */
  evPercent: number;
  /** Wins erased by one loss — 1 / (payout − 1). */
  lossPerWin: number;
  sampleSize: number;
}

export interface ChanceRankOptions {
  /** Restrict the board to these barriers (e.g. Over 0 / Under 9 only). */
  barriers?: ReadonlyArray<{ side: OverUnderSide; barrier: number }>;
  /** Minimum live ticks before a barrier is ranked. */
  minSample?: number;
}

/**
 * Rate barriers by the chance the next tick lands, highest first.
 *
 * Thin payouts are included — for a single trade, likeliest-to-land is the
 * right ranking key. Pass `barriers` to restrict the board (One run uses
 * only Over 0 and Under 9).
 */
export function rankBarriersByChance(
  digits: readonly number[],
  options?: ChanceRankOptions,
): BarrierChance[] {
  const minSample = options?.minSample ?? 30;
  if (digits.length < minSample) return [];
  const universe = options?.barriers ?? ALL_OU_BARRIERS;
  const live = digits.slice(-CHANCE_LIVE_TICKS);
  const board: BarrierChance[] = [];
  for (const { side, barrier } of universe) {
    const stats = windowStats(live, side, barrier);
    if (stats.sampleSize < minSample) continue;
    const fairPercent = fairWinProb(side, barrier) * 100;
    const payout = overUnderPayoutMultiplier(side, barrier);
    if (payout <= 1) continue;
    const chancePercent =
      ((fairPercent / 100) * CHANCE_PRIOR_TICKS + stats.wins) /
      (CHANCE_PRIOR_TICKS + stats.sampleSize) *
      100;
    board.push({
      side,
      barrier,
      fairPercent,
      livePercent: stats.winPercent,
      tilt: stats.winPercent - fairPercent,
      chancePercent,
      payout,
      breakEven: breakEvenDigitPercent(side, undefined, barrier),
      evPercent: ((chancePercent / 100) * payout - 1) * 100,
      lossPerWin: 1 / (payout - 1),
      sampleSize: stats.sampleSize,
    });
  }
  // Likeliest to land first; where two are level, the one that pays more.
  return board.sort(
    (a, b) =>
      b.chancePercent - a.chancePercent || b.evPercent - a.evPercent,
  );
}

/** One-run board: only Over 0 vs Under 9 — pick the hotter of the two. */
export function rankSafePairByChance(
  digits: readonly number[],
): BarrierChance[] {
  return rankBarriersByChance(digits, {
    barriers: SAFE_PAIR_BARRIERS,
    minSample: 30,
  });
}

/**
 * Shield Momentum — elite commit.
 *
 * Thin Over 0 / Under 9 OFF. Board: high-fair Over 1–2 / Under 7–8 only.
 * Trade now only on elite tape (live+micro+deep over BE, streak, gap≤1).
 * App commits that barrier on that market for up to 7 fast runs.
 */
export const MOMENTUM_GROWTH_BARRIERS: Array<{
  side: OverUnderSide;
  barrier: number;
}> = [
  { side: "DIGITOVER", barrier: 1 },
  { side: "DIGITOVER", barrier: 2 },
  { side: "DIGITUNDER", barrier: 7 },
  { side: "DIGITUNDER", barrier: 8 },
];
export const MOMENTUM_RECOVERY_BARRIERS = MOMENTUM_GROWTH_BARRIERS;
/** @deprecated — use growth/recovery lists via rankMomentumBoard({ recovery }). */
export const MOMENTUM_BARRIERS = MOMENTUM_GROWTH_BARRIERS;

export const MOMENTUM_MIN_EDGE_PP = 2;
export const MOMENTUM_MIN_TILT_PP = 0;
export const MOMENTUM_MICRO_TICKS = 24;
export const MOMENTUM_MIN_MICRO_EDGE_PP = 1;
export const MOMENTUM_DEEP_TICKS = 48;
export const MOMENTUM_MIN_DEEP_EDGE_PP = 0.5;
export const MOMENTUM_MIN_STREAK = 4;
export const MOMENTUM_MAX_CLEAN_GAP = 1;
export const MOMENTUM_MAX_HOLD_GAP = 1;
export const MOMENTUM_MIN_SAMPLE = 36;
export const MOMENTUM_MIN_CHANCE_EDGE_PP = 0;
export const MOMENTUM_MIN_FAIR_PERCENT = 70;
export const MOMENTUM_SAFE_FAIR_PERCENT = 85;
export const MOMENTUM_NEAR_BE_SLACK_PP = 0.5;
export const MOMENTUM_GROWTH_LIVE_TICKS = 48;
export const MOMENTUM_RECOVERY_MIN_EDGE_PP = 2;
export const MOMENTUM_RECOVERY_NEAR_BE_SLACK_PP = 0;
export const MOMENTUM_RECOVERY_MIN_STREAK = 4;
export const MOMENTUM_RECOVERY_LIVE_TICKS = 40;
export const MOMENTUM_RECOVERY_DEEP_TICKS = 48;
export const MOMENTUM_RECOVERY_MIN_DEEP_EDGE_PP = 0.5;
export const MOMENTUM_RECOVERY_MIN_MICRO_EDGE_PP = 1;
export const MOMENTUM_LOW_FAIR_EXTRA_EDGE_PP = 0.5;
export const MOMENTUM_THIN_PAY_EXTRA_EDGE_PP = 4;
export const MOMENTUM_THIN_PAYOUT = 1.28;
/** Max consecutive runs on one elite market+barrier. */
export const MOMENTUM_COMMIT_RUNS = 7;
/** Break commit after this many losses on that setup. */
export const MOMENTUM_COMMIT_MAX_LOSSES = 2;

export interface MomentumPick extends BarrierChance {
  edgePp: number;
  microEdgePp: number;
  microPercent: number;
  deepEdgePp: number;
  deepPercent: number;
  streak: number;
  gap: number | null;
  clean: boolean;
  /** Top-tier only — required for Trade now. */
  elite: boolean;
  gear: "growth" | "recovery";
  edgeNeed: number;
}

export function momentumEdgeFloor(
  entry: Pick<BarrierChance, "fairPercent" | "payout">,
  recovery: boolean,
): {
  edge: number;
  micro: number;
  deep: number;
  streak: number;
  chance: number;
  tilt: number;
} {
  if (recovery) {
    return {
      edge: MOMENTUM_RECOVERY_MIN_EDGE_PP,
      micro: MOMENTUM_RECOVERY_MIN_MICRO_EDGE_PP,
      deep: MOMENTUM_RECOVERY_MIN_DEEP_EDGE_PP,
      streak: MOMENTUM_RECOVERY_MIN_STREAK,
      chance: MOMENTUM_MIN_CHANCE_EDGE_PP,
      tilt: MOMENTUM_MIN_TILT_PP,
    };
  }
  let edge = MOMENTUM_MIN_EDGE_PP;
  if (entry.fairPercent < 75) edge += MOMENTUM_LOW_FAIR_EXTRA_EDGE_PP;
  if (entry.payout < MOMENTUM_THIN_PAYOUT) {
    edge += MOMENTUM_THIN_PAY_EXTRA_EDGE_PP;
  }
  return {
    edge,
    micro: MOMENTUM_MIN_MICRO_EDGE_PP,
    deep: MOMENTUM_MIN_DEEP_EDGE_PP,
    streak: MOMENTUM_MIN_STREAK,
    chance: MOMENTUM_MIN_CHANCE_EDGE_PP,
    tilt: MOMENTUM_MIN_TILT_PP,
  };
}

/** Soft hold while committed — still over BE with a recent win. */
export function isMomentumHoldable(pick: MomentumPick): boolean {
  const gap = pick.gap ?? 99;
  if (pick.payout < MOMENTUM_THIN_PAYOUT) return false;
  if (pick.livePercent < pick.breakEven) return false;
  return (
    pick.edgePp >= pick.edgeNeed - MOMENTUM_NEAR_BE_SLACK_PP &&
    pick.microEdgePp >= 0 &&
    pick.streak >= 2 &&
    gap <= MOMENTUM_MAX_HOLD_GAP
  );
}

/**
 * Shield ranking — elite Over 1–2 / Under 7–8 only.
 */
export function rankMomentumBoard(
  digits: readonly number[],
  options?: {
    exclude?: ReadonlyArray<{ side: OverUnderSide; barrier: number }>;
    recovery?: boolean;
  },
): MomentumPick[] {
  const recovery = options?.recovery === true;
  const gear: "growth" | "recovery" = recovery ? "recovery" : "growth";
  const universe = recovery
    ? MOMENTUM_RECOVERY_BARRIERS
    : MOMENTUM_GROWTH_BARRIERS;
  const board = rankBarriersByChance(digits, {
    barriers: universe,
    minSample: MOMENTUM_MIN_SAMPLE,
  });
  const excluded = options?.exclude ?? [];
  const liveTicks = recovery
    ? MOMENTUM_RECOVERY_LIVE_TICKS
    : MOMENTUM_GROWTH_LIVE_TICKS;
  const liveWindow = digits.slice(-liveTicks);
  const micro = digits.slice(-MOMENTUM_MICRO_TICKS);
  const deep = digits.slice(
    -(recovery ? MOMENTUM_RECOVERY_DEEP_TICKS : MOMENTUM_DEEP_TICKS),
  );
  const picks: MomentumPick[] = [];
  for (const entry of board) {
    if (
      excluded.some(
        (skip) =>
          skip.side === entry.side &&
          skip.barrier === entry.barrier,
      )
    ) {
      continue;
    }
    const floor = momentumEdgeFloor(entry, recovery);
    const liveStats = windowStats(liveWindow, entry.side, entry.barrier);
    const livePercent = liveStats.winPercent;
    const edgePp = livePercent - entry.breakEven;
    const microStats = windowStats(micro, entry.side, entry.barrier);
    const deepStats = windowStats(deep, entry.side, entry.barrier);
    const microEdgePp = microStats.winPercent - entry.breakEven;
    const deepEdgePp = deepStats.winPercent - entry.breakEven;
    const streak = winStreak(digits, entry.side, entry.barrier);
    const gap = gapSinceWin(digits, entry.side, entry.barrier);
    const gapOk = gap !== null && gap <= MOMENTUM_MAX_CLEAN_GAP;
    const clean =
      entry.payout >= MOMENTUM_THIN_PAYOUT &&
      entry.fairPercent >= MOMENTUM_MIN_FAIR_PERCENT &&
      livePercent >= entry.breakEven &&
      edgePp >= floor.edge &&
      deepEdgePp >= floor.deep &&
      microEdgePp >= floor.micro &&
      streak >= floor.streak &&
      gapOk;
    const elite =
      clean &&
      (gap === 0 || gap === 1) &&
      microEdgePp >= floor.micro &&
      deepEdgePp >= floor.deep;
    picks.push({
      ...entry,
      livePercent,
      tilt: livePercent - entry.fairPercent,
      edgePp,
      microEdgePp,
      microPercent: microStats.winPercent,
      deepEdgePp,
      deepPercent: deepStats.winPercent,
      streak,
      gap,
      clean,
      elite,
      gear,
      edgeNeed: floor.edge,
    });
  }
  return picks.sort((a, b) => {
    if (a.elite !== b.elite) return a.elite ? -1 : 1;
    if (a.clean !== b.clean) return a.clean ? -1 : 1;
    if (a.elite && b.elite) {
      return (
        b.edgePp - a.edgePp ||
        b.microEdgePp - a.microEdgePp ||
        b.streak - a.streak ||
        b.evPercent - a.evPercent
      );
    }
    const aGap = Math.max(0, a.edgeNeed - a.edgePp);
    const bGap = Math.max(0, b.edgeNeed - b.edgePp);
    return aGap - bGap || b.edgePp - a.edgePp || b.streak - a.streak;
  });
}

/** Prefer the stronger of Over vs Under when auto-side is on. */
export function pickBetterOverUnder(
  over: MarketSignal,
  under: MarketSignal,
): MarketSignal {
  const score = (s: MarketSignal) =>
    s.power +
    (s.confidence === "high"
      ? 50
      : s.confidence === "medium"
        ? 28
        : s.confidence === "soft"
          ? 10
          : 0) +
    (s.evOk ? 12 : 0) +
    (s.timingOk ? 14 : 0) +
    // Prefer edge over fair hit-rate — Under 9 must earn the pick.
    (s.digitPercent -
      fairWinProb(s.side as OverUnderSide, s.digit) * 100);
  return score(over) >= score(under) ? over : under;
}
