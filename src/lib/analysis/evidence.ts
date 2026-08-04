/**
 * Evidence gate — does the tape actually prove an edge, or is it noise?
 *
 * Every barrier the analyzer looks at is a coin-flip estimate from a short
 * window. On a 48-tick window a 70%-fair barrier has a standard error near
 * 6.6pp, so "win rate beats fair by 20pp" is three standard errors of nothing
 * and shows up constantly. Ranking eight barriers and then reporting the best
 * one makes it worse: the maximum of eight noisy estimates is biased upward by
 * construction, which is why the old scorer kept crowning a "sure" barrier that
 * reverted a tick later.
 *
 * So entries are judged on a one-sided Wilson lower bound instead of the point
 * estimate, with a Sidak correction for how many barriers were searched. The
 * bound answers the only question that matters: after allowing for the search,
 * is the *worst* plausible win rate still above the payout break-even?
 */

/** Barriers scanned per market — the multiple-comparison family. */
export const BARRIER_COMPARISONS = 8;

/** Default family-wise error rate for an entry call. */
export const EVIDENCE_ALPHA = 0.05;

/**
 * Inverse standard normal CDF (Acklam's rational approximation,
 * |error| < 1.15e-9). Needed to turn a corrected alpha into a z score.
 */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

/**
 * Sidak-corrected one-sided z for searching `comparisons` candidates at
 * family-wise error `alpha`. Exact under independence and slightly tighter
 * than Bonferroni.
 */
export function searchCorrectedZ(
  alpha = EVIDENCE_ALPHA,
  comparisons = BARRIER_COMPARISONS,
): number {
  const m = Math.max(1, comparisons);
  const perTest = 1 - Math.pow(1 - alpha, 1 / m);
  return normalQuantile(1 - perTest);
}

/** One-sided Wilson lower bound on the true success rate, as a proportion. */
export function wilsonLower(wins: number, n: number, z: number): number {
  if (n <= 0) return 0;
  const p = Math.min(1, Math.max(0, wins / n));
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denom);
}

/**
 * Ticks needed before an observed rate could clear break-even at this
 * confidence. Infinite when the observed rate is already at or below it —
 * no amount of sample proves an edge that is not in the data.
 */
export function sampleNeeded(
  observed: number,
  breakEven: number,
  z: number,
): number {
  const delta = observed - breakEven;
  if (delta <= 0) return Infinity;
  return Math.ceil((z * z * observed * (1 - observed)) / (delta * delta));
}

export interface EvidenceVerdict {
  /** Lower bound clears break-even after the search correction. */
  ok: boolean;
  /** Wilson lower bound on the win rate, percent. */
  lowerPercent: number;
  /** Observed win rate, percent. */
  observedPercent: number;
  /** Win rate the payout needs to break even, percent. */
  needPercent: number;
  /** How far the bound sits below what is needed, percent (0 when ok). */
  shortfallPercent: number;
  sampleSize: number;
  /** Ticks required to prove the observed rate, or null when unprovable. */
  ticksNeeded: number | null;
  z: number;
  label: string;
}

/**
 * Judge one barrier's tape against its payout break-even.
 * `wins` / `n` must come from the same window.
 */
export function judgeEvidence(params: {
  wins: number;
  n: number;
  breakEvenPercent: number;
  comparisons?: number;
  alpha?: number;
}): EvidenceVerdict {
  const { wins, n, breakEvenPercent } = params;
  const z = searchCorrectedZ(
    params.alpha ?? EVIDENCE_ALPHA,
    params.comparisons ?? BARRIER_COMPARISONS,
  );
  const observed = n > 0 ? wins / n : 0;
  const need = breakEvenPercent / 100;
  const lower = wilsonLower(wins, n, z);
  const ok = n > 0 && lower > need;
  const ticks = sampleNeeded(observed, need, z);
  const lowerPercent = lower * 100;

  return {
    ok,
    lowerPercent,
    observedPercent: observed * 100,
    needPercent: breakEvenPercent,
    shortfallPercent: ok ? 0 : breakEvenPercent - lowerPercent,
    sampleSize: n,
    ticksNeeded: Number.isFinite(ticks) ? ticks : null,
    z,
    label: `${(observed * 100).toFixed(1)}% · low ${lowerPercent.toFixed(1)}% vs need ${breakEvenPercent.toFixed(1)}% · n ${n}`,
  };
}
