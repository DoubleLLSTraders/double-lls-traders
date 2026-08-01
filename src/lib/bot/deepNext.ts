/**
 * Deep pre-flight before any order fires (first entry and follow-ups).
 *
 * Thresholds are calibrated against live R_75 ticks (scripts/calibrate-elite.ts):
 * Wilson-90 + gap≥14 + lead≥8 + margin≥1.5pp still arms; tighter stacks did not.
 * Caller stops on refusal (follow-ups) or waits (first entry).
 */
import { breakEvenDigitPercent, isLowPayoutSymbol } from "./performance";
import {
  confirmScore,
  isArmedSignal,
  type MarketSignal,
} from "../analysis/signal";
import type { BotSettings } from "./types";

export type DeepNextVerdict =
  | { ok: true; summary: string }
  | { ok: false; reason: string };

export interface DeepNextContext {
  signal: MarketSignal;
  settings: BotSettings;
  symbol: string;
  lastEntryDigit: number | null;
  lastEntryDigitPrinted: boolean;
  winsThisStart: number;
  coolBarrierDigit?: number | null;
  firstEntry?: boolean;
}

/** Extra cold-gap ticks beyond the form minimum (calibrated: +2 still fires). */
const GAP_BUFFER = 2;
/** Point-estimate cushion under break-even (pp). */
const MIN_EV_CUSHION_PP = 0.2;
const MIN_POWER = 90;
/** One armed trade then bank — never press. */
export const MAX_WINS_BEFORE_BANK = 1;

export function analyzeNextPredictionDeep(ctx: DeepNextContext): DeepNextVerdict {
  const {
    signal,
    settings,
    symbol,
    lastEntryDigit,
    lastEntryDigitPrinted,
    winsThisStart,
    firstEntry = false,
  } = ctx;

  if (!firstEntry && winsThisStart >= MAX_WINS_BEFORE_BANK) {
    return {
      ok: false,
      reason: `Deep · banked ${winsThisStart} win(s) · will not press further`,
    };
  }

  if (isLowPayoutSymbol(symbol)) {
    return { ok: false, reason: `Deep · ${symbol} low payout · get out` };
  }

  // Match the form / profile floor — do not raise above settings.minSample
  // while the live signal window is built to that same size (see App tradeStats).
  if (signal.watching.sampleSize < settings.minSample) {
    return {
      ok: false,
      reason: `Deep · sample ${signal.watching.sampleSize}/${settings.minSample} too thin`,
    };
  }

  if (
    !firstEntry &&
    lastEntryDigit !== null &&
    signal.digit === lastEntryDigit &&
    !lastEntryDigitPrinted
  ) {
    return {
      ok: false,
      reason: `Deep · next is still Differs ${signal.digit} · same bet as last win · get out`,
    };
  }

  if (
    ctx.coolBarrierDigit !== null &&
    ctx.coolBarrierDigit !== undefined &&
    signal.digit === ctx.coolBarrierDigit
  ) {
    return {
      ok: false,
      reason: `Deep · Differs ${signal.digit} already lost this run · get out`,
    };
  }

  if (
    !firstEntry &&
    signal.side === "DIGITDIFF" &&
    settings.side === "DIGITDIFF" &&
    lastEntryDigit !== null &&
    signal.digit === lastEntryDigit
  ) {
    return {
      ok: false,
      reason: `Deep · cold pick did not change (${signal.digit}) · get out`,
    };
  }

  if (!signal.barrierAligned || !signal.primaryBarrier) {
    return {
      ok: false,
      reason: `Deep · ${signal.digit} is not the #1 cold/hot barrier · get out`,
    };
  }

  if (!signal.uniqueEvOk) {
    return {
      ok: false,
      reason: "Deep · runner-up also clears EV · not a unique barrier · get out",
    };
  }

  if (!signal.timingOk) {
    return {
      ok: false,
      reason:
        signal.side === "DIGITDIFF"
          ? `Deep · cold gap ${signal.watching.signalGap ?? "—"} < ${settings.minColdGap} · get out`
          : `Deep · momentum gap weak · get out`,
    };
  }

  const gap = signal.watching.signalGap;
  const needGap = settings.minColdGap + GAP_BUFFER;
  if (signal.side === "DIGITDIFF" && (gap === null || gap < needGap)) {
    return {
      ok: false,
      reason: `Deep · cold gap ${gap ?? "—"} < ${needGap} (need clear absence) · get out`,
    };
  }

  if (!signal.evOk) {
    return {
      ok: false,
      reason: `Deep · EV closed (${signal.watching.wilsonBound || `${signal.digitPercent.toFixed(1)}%`}) · get out`,
    };
  }

  const breakEven = breakEvenDigitPercent(signal.side, symbol);
  if (signal.side === "DIGITDIFF") {
    const cushion = breakEven - signal.digitPercent;
    if (cushion < MIN_EV_CUSHION_PP) {
      return {
        ok: false,
        reason: `Deep · only ${cushion.toFixed(1)}pp under break-even ${breakEven.toFixed(1)}% · get out`,
      };
    }
  }

  if (!signal.coldMarginOk || !signal.separationOk) {
    return {
      ok: false,
      reason: `Deep · cold lead thin (${signal.watching.separation || "—"}) · get out`,
    };
  }

  const sep = signal.watching.separation || "";
  const leadMatch = /cold −(\d+)/.exec(sep);
  if (signal.side === "DIGITDIFF" && leadMatch) {
    const lead = Number(leadMatch[1]);
    // Absolute lead floor matches signal.ts / calibrate-elite (lead ≥ 8).
    // A pp×n floor (~23 at n=1500) was stricter than the live-calibrated bar.
    if (lead < 8) {
      return {
        ok: false,
        reason: `Deep · cold lead only ${lead} ticks (need 8) · get out`,
      };
    }
  }

  if (!signal.windowsAgree) {
    return {
      ok: false,
      reason: `Deep · windows split (${signal.watching.windowVotes || "—"}) · get out`,
    };
  }
  if (!signal.windowsEvOk) {
    return {
      ok: false,
      reason: `Deep · multi-window EV failed (${signal.watching.windowEv || "—"}) · get out`,
    };
  }
  if (!signal.structureOk) {
    return {
      ok: false,
      reason: "Deep · cold structure not decisive · get out",
    };
  }

  const score = confirmScore(signal);
  if (!isArmedSignal(signal, MIN_POWER)) {
    return {
      ok: false,
      reason: `Deep · confirms ${score}/5 · confidence ${signal.confidence} · power ${signal.power} · get out`,
    };
  }

  return {
    ok: true,
    summary: `Deep clear · ${signal.label} · gap ${gap ?? "—"} · ${signal.digitPercent.toFixed(1)}% · power ${signal.power} · high`,
  };
}
