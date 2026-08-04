/**
 * Analyzer pace — user picks speed without watering down firm Digits gates.
 *
 * `steady` = Differs current desk (default).
 * `safer-fast` = same Differs firm gates, shorter waits.
 * `matches-firm` = Matches long prove (~2–3 min) · rare Trade now.
 * `overunder-firm` = Over/Under barrier edge · short prove.
 */

export type AnalyzerPaceId =
  | "steady"
  | "safer-fast"
  | "matches-firm"
  | "overunder-firm";

export interface AnalyzerPace {
  id: AnalyzerPaceId;
  label: string;
  shortLabel: string;
  recommended: boolean;
  blurb: string;
  lockTicks: number;
  lockMs: number;
  confirmTicks: number;
  confirmMs: number;
  coldSettleMs: number;
  stuckAlmostMs: number;
  lossCoolMs: number;
  cooldownTicks: number;
  maxMarketDwellMs: number;
}

/** What production Differs runs today — do not alter these numbers lightly. */
export const STEADY_PACE: AnalyzerPace = {
  id: "steady",
  label: "Steady (current)",
  shortLabel: "Steady",
  recommended: false,
  blurb: "Full prove times · longer cool after loss · same firm HIGH gates.",
  lockTicks: 6,
  lockMs: 6_000,
  confirmTicks: 3,
  confirmMs: 2_000,
  coldSettleMs: 4_000,
  stuckAlmostMs: 5_000,
  lossCoolMs: 50_000,
  cooldownTicks: 25,
  maxMarketDwellMs: 18_000,
};

/** Faster Differs waits; keeps HIGH + gap air + firm wire check. */
export const SAFER_FAST_PACE: AnalyzerPace = {
  id: "safer-fast",
  label: "Safer + fast",
  shortLabel: "Safer+fast",
  recommended: true,
  blurb: "Same firm HIGH filters · shorter lock/confirm/cool · hunts quicker.",
  lockTicks: 4,
  lockMs: 3_500,
  confirmTicks: 2,
  confirmMs: 1_200,
  coldSettleMs: 2_500,
  stuckAlmostMs: 3_500,
  lossCoolMs: 28_000,
  cooldownTicks: 12,
  maxMarketDwellMs: 14_000,
};

/**
 * Matches firm — efficient prove (seconds, not minutes).
 * Hunt best hot market, short lock/confirm, same-tick buy.
 * Differs paces must not use these numbers.
 */
export const MATCHES_FIRM_PACE: AnalyzerPace = {
  id: "matches-firm",
  label: "Matches firm",
  shortLabel: "Matches firm",
  recommended: true,
  blurb: "Hunt best hot · short firm prove · same-tick buy.",
  lockTicks: 5,
  lockMs: 5_000,
  confirmTicks: 2,
  confirmMs: 1_500,
  coldSettleMs: 2_500,
  stuckAlmostMs: 4_000,
  lossCoolMs: 25_000,
  cooldownTicks: 10,
  maxMarketDwellMs: 16_000,
};

/** Differs desk pace choices (Bot panel when on Differs). */
export const ANALYZER_PACES: readonly AnalyzerPace[] = [
  STEADY_PACE,
  SAFER_FAST_PACE,
];

/** Matches desk pace choices. */
export const MATCHES_ANALYZER_PACES: readonly AnalyzerPace[] = [MATCHES_FIRM_PACE];

/**
 * Over/Under Blitz — edge vs fair + payout EV, prove in ~2s, same-tick buy.
 * Pace id stays `overunder-firm` so stored settings keep working.
 */
export const OVER_UNDER_FIRM_PACE: AnalyzerPace = {
  id: "overunder-firm",
  label: "Over/Under Blitz",
  shortLabel: "O/U Blitz",
  recommended: true,
  blurb: "Shield · elite Over 1–2 / Under 7–8 · commit up to 7 fast runs.",
  lockTicks: 1,
  lockMs: 400,
  confirmTicks: 1,
  confirmMs: 200,
  coldSettleMs: 200,
  stuckAlmostMs: 800,
  lossCoolMs: 1_200,
  cooldownTicks: 1,
  maxMarketDwellMs: 6_000,
};

/** Over/Under desk pace choices. */
export const OVER_UNDER_ANALYZER_PACES: readonly AnalyzerPace[] = [
  OVER_UNDER_FIRM_PACE,
];

export function resolveAnalyzerPace(
  id: AnalyzerPaceId | undefined | null,
): AnalyzerPace {
  if (id === "safer-fast") return SAFER_FAST_PACE;
  if (id === "matches-firm") return MATCHES_FIRM_PACE;
  if (id === "overunder-firm") return OVER_UNDER_FIRM_PACE;
  return STEADY_PACE;
}

export function isAnalyzerPaceId(value: unknown): value is AnalyzerPaceId {
  return (
    value === "steady" ||
    value === "safer-fast" ||
    value === "matches-firm" ||
    value === "overunder-firm"
  );
}
