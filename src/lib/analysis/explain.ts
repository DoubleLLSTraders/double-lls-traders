import type { DigitStats } from "./digits";
import {
  DIFF_BARRIER_BREAK_EVEN_PCT,
  MATCH_BREAK_EVEN_PCT,
  type MarketSignal,
} from "./signal";
import type { GateResult } from "../bot/gates";
import {
  DIFF_PAYOUT_MULTIPLIER,
  MATCH_PAYOUT_MULTIPLIER,
} from "../bot/performance";

export interface AiBrief {
  headline: string;
  bullets: string[];
  caution: string;
  decision: string;
}

export function buildAiBrief(input: {
  signal: MarketSignal;
  stats: DigitStats;
  gate: GateResult;
  botDigit: number;
  minEdgePercent: number;
}): AiBrief {
  const { signal, stats, gate, botDigit, minEdgePercent } = input;
  const matches = signal.side === "DIGITMATCH";
  const payout = matches ? MATCH_PAYOUT_MULTIPLIER : DIFF_PAYOUT_MULTIPLIER;
  const breakEven = matches ? MATCH_BREAK_EVEN_PCT : (1 / DIFF_PAYOUT_MULTIPLIER) * 100;
  const digitPct = signal.digitPercent;
  const gap = signal.watching.signalGap;

  const bullets: string[] = [];

  if (matches) {
    const need = MATCH_BREAK_EVEN_PCT + minEdgePercent;
    bullets.push(
      `Matches stack: stable hot digit + Wilson EV (≥ ${need.toFixed(1)}% point + bound) + multi-window EV + recent print + χ² lead.`,
    );
  } else {
    const maxBarrier = DIFF_BARRIER_BREAK_EVEN_PCT - minEdgePercent;
    bullets.push(
      `Differs stack: stable cold barrier + Wilson EV (≤ ${maxBarrier.toFixed(1)}%) + multi-window EV + still absent + χ² lead. ×${payout} needs ~${breakEven.toFixed(1)}% hits.`,
    );
  }

  bullets.push(
    `Digit ${signal.digit}: ${digitPct.toFixed(1)}% · ${signal.watching.separation} · ${signal.watching.wilsonBound} · gap ${gap ?? "—"}.`,
  );
  bullets.push(
    `Confirms · EV ${signal.evOk ? "ok" : "no"} · windows ${signal.windowsAgree ? "agree" : "split"} · multi-EV ${signal.windowsEvOk ? "ok" : "no"} · timing ${signal.timingOk ? "ok" : "no"} · structure ${signal.structureOk ? "ok" : "no"}.`,
  );
  bullets.push(`Multi-window votes: ${signal.watching.windowVotes || "—"}.`);
  bullets.push(`Multi-window EV: ${signal.watching.windowEv || "—"}.`);
  bullets.push(
    `χ² p=${stats.uniformity.pValue.toFixed(3)} · ${
      stats.uniformity.significant ? "uneven vs fair 10%" : "looks fair — hold if require-uneven is on"
    }.`,
  );
  bullets.push(
    `Bot digit ${botDigit} ${botDigit === signal.digit ? "matches signal" : `manual vs signal ${signal.digit}`}.`,
  );

  return {
    headline: matches
      ? "Matches · Wilson-cleared hot persistence"
      : "Differs · Wilson-cleared cold barrier",
    bullets,
    caution:
      "Cleaner filters cut noise and correlated spam. They do not create edge on near-fair digits — journal expectancy is the scoreboard.",
    decision: gate.ok
      ? `Entry filter: PASS · ${signal.label} · ${signal.confidence}`
      : `Entry filter: ${gate.reason}`,
  };
}
