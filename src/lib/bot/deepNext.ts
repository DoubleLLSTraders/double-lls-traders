/**
 * Deep pre-flight before any order fires (first entry and follow-ups).
 *
 * Number of runs (settings.maxRuns) owns how many wins this Start may take.
 * Every entry uses the same Digits Good analyzer gate.
 */
import { analyzerAllowsEntry } from "../analysis/analyzerGate";
import { isLowPayoutSymbol } from "./performance";
import type { MarketSignal } from "../analysis/signal";
import type { BotSettings } from "./types";

export type DeepNextVerdict =
  | { ok: true; summary: string }
  | { ok: false; reason: string; stop?: boolean };

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

/** @deprecated use settings.maxRuns — kept for any old imports */
export const MAX_WINS_BEFORE_BANK = 1;

function runCap(settings: BotSettings): number {
  return settings.maxRuns > 0 ? settings.maxRuns : Number.POSITIVE_INFINITY;
}

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

  const cap = runCap(settings);
  if (winsThisStart >= cap) {
    return {
      ok: false,
      stop: true,
      reason: `Deep · runs complete ${winsThisStart}/${settings.maxRuns || "∞"} · banked`,
    };
  }

  if (isLowPayoutSymbol(symbol)) {
    return { ok: false, stop: true, reason: `Deep · ${symbol} low payout · get out` };
  }

  if (signal.watching.sampleSize < settings.minSample) {
    return {
      ok: false,
      reason: `Deep · sample ${signal.watching.sampleSize}/${settings.minSample} too thin`,
    };
  }

  if (
    ctx.coolBarrierDigit !== null &&
    ctx.coolBarrierDigit !== undefined &&
    signal.digit === ctx.coolBarrierDigit
  ) {
    return {
      ok: false,
      stop: true,
      reason: `Deep · Differs ${signal.digit} already lost this run · get out`,
    };
  }

  // After a Differs win the barrier never printed — wait for a new Good setup
  // (or the digit to print) instead of ending the Start early.
  if (
    !firstEntry &&
    lastEntryDigit !== null &&
    signal.digit === lastEntryDigit &&
    !lastEntryDigitPrinted
  ) {
    return {
      ok: false,
      reason: `Deep · wait · Differs ${signal.digit} still open from last win · need print or new cold`,
    };
  }

  const analyzer = analyzerAllowsEntry(signal, settings);
  if (!analyzer.ok) {
    return {
      ok: false,
      reason: analyzer.reason.replace(/^Analyzer ·/, "Deep · "),
    };
  }

  const left = Number.isFinite(cap) ? `${winsThisStart}/${cap}` : `${winsThisStart}`;
  return {
    ok: true,
    summary: `Analyzer Good · ${analyzer.label} · run ${left} · power ${signal.power}`,
  };
}
