/**
 * Deep pre-flight before any order fires (first entry and follow-ups).
 *
 * First entry follows the desk profile (settings): EV + timing + #1 cold.
 * Follow-ups stay strict and bank after one win.
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

/** One trade then bank — never press. */
export const MAX_WINS_BEFORE_BANK = 1;
const MIN_LEAD_FIRST = 4;
const MIN_LEAD_FOLLOW = 8;
const MIN_POWER_FOLLOW = 90;

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
  if (
    signal.side === "DIGITDIFF" &&
    (gap === null || gap < settings.minColdGap)
  ) {
    return {
      ok: false,
      reason: `Deep · cold gap ${gap ?? "—"} < ${settings.minColdGap} · get out`,
    };
  }

  if (!signal.evOk) {
    return {
      ok: false,
      reason: `Deep · EV closed (${signal.watching.wilsonBound || `${signal.digitPercent.toFixed(1)}%`}) · get out`,
    };
  }

  if (signal.side === "DIGITDIFF" && (!signal.coldMarginOk || !signal.separationOk)) {
    return {
      ok: false,
      reason: `Deep · cold lead thin (${signal.watching.separation || "—"}) · get out`,
    };
  }

  const sep = signal.watching.separation || "";
  const leadMatch = /cold −(\d+)/.exec(sep);
  const needLead = firstEntry ? MIN_LEAD_FIRST : MIN_LEAD_FOLLOW;
  if (signal.side === "DIGITDIFF" && leadMatch) {
    const lead = Number(leadMatch[1]);
    if (lead < needLead) {
      return {
        ok: false,
        reason: `Deep · cold lead only ${lead} ticks (need ${needLead}) · get out`,
      };
    }
  }

  // First entry: desk profile — EV + timing + #1 cold is enough.
  if (firstEntry) {
    const breakEven = breakEvenDigitPercent(signal.side, symbol);
    if (signal.side === "DIGITDIFF") {
      const cushion = breakEven - signal.digitPercent;
      if (cushion < 0) {
        return {
          ok: false,
          reason: `Deep · digit above break-even ${breakEven.toFixed(1)}% · get out`,
        };
      }
    }
    return {
      ok: true,
      summary: `Desk clear · ${signal.label} · gap ${gap ?? "—"} · ${signal.digitPercent.toFixed(1)}% · power ${signal.power}`,
    };
  }

  // Follow-ups: keep the elite stack (rare / bank after one win anyway).
  if (!signal.uniqueEvOk) {
    return {
      ok: false,
      reason: "Deep · runner-up also clears EV · not a unique barrier · get out",
    };
  }
  if (settings.requireMultiWindow && !signal.windowsAgree) {
    return {
      ok: false,
      reason: `Deep · windows split (${signal.watching.windowVotes || "—"}) · get out`,
    };
  }
  if (settings.requireWindowsEv && !signal.windowsEvOk) {
    return {
      ok: false,
      reason: `Deep · multi-window EV failed (${signal.watching.windowEv || "—"}) · get out`,
    };
  }
  if (settings.requireUneven && !signal.structureOk) {
    return {
      ok: false,
      reason: "Deep · cold structure not decisive · get out",
    };
  }

  const score = confirmScore(signal);
  if (settings.requireFullConfirm && !isArmedSignal(signal, MIN_POWER_FOLLOW)) {
    return {
      ok: false,
      reason: `Deep · confirms ${score}/5 · confidence ${signal.confidence} · power ${signal.power} · get out`,
    };
  }

  return {
    ok: true,
    summary: `Deep clear · ${signal.label} · gap ${gap ?? "—"} · ${signal.digitPercent.toFixed(1)}% · power ${signal.power}`,
  };
}
