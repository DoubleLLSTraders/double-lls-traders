/**
 * Deriv total payout multiples (stake included), measured from live proposals.
 *
 * Matches pays 8.33–8.93× and Differs 1.087–1.0965× depending on the index, so
 * these are the worst case of each — paper results should never look better
 * than the exchange would actually pay. Live trades settle on the payout Deriv
 * returns at buy time instead of these, which also captures the cent rounding
 * that hurts very small stakes.
 */
export const MATCH_PAYOUT_MULTIPLIER = 8.33;
export const DIFF_PAYOUT_MULTIPLIER = 1.087;

/**
 * Payouts split into two tiers, measured across every index in check-payout.
 * These three pay about a cent less per unit, which costs ~0.9 percentage
 * points of expected value on Differs for no compensating benefit.
 */
const LOW_PAYOUT_SYMBOLS = new Set(["R_100", "1HZ10V", "1HZ100V"]);
const LOW_PAYOUTS = { match: 8.3333, diff: 1.087 };
const TYPICAL_PAYOUTS = { match: 8.9286, diff: 1.0965 };

export function payoutMultiplier(
  side: "DIGITMATCH" | "DIGITDIFF",
  symbol?: string,
): number {
  const table = symbol && LOW_PAYOUT_SYMBOLS.has(symbol) ? LOW_PAYOUTS : TYPICAL_PAYOUTS;
  return side === "DIGITMATCH" ? table.match : table.diff;
}

/** True when the index sits in the cheaper payout tier. */
export function isLowPayoutSymbol(symbol: string): boolean {
  return LOW_PAYOUT_SYMBOLS.has(symbol);
}

/**
 * Effective Differs multiple once Deriv rounds the quoted payout to whole
 * cents. Splitting a basket into many tiny contracts is punished hard: five
 * legs of 0.35 pay 1.0571x each, while one leg of 1.75 pays 1.0971x for the
 * exact same money at risk. Measured from live proposals on R_75.
 */
const DIFF_MULTIPLE_BY_STAKE: Array<[stake: number, multiple: number]> = [
  [0.35, 1.0571],
  [0.7, 1.0857],
  [1.0, 1.09],
  [1.75, 1.0971],
  [2.0, 1.095],
  [2.5, 1.096],
  [3.0, 1.0967],
  [4.0, 1.0975],
  [5.0, 1.096],
];

export function effectiveDiffMultiple(stake: number, symbol?: string): number {
  const table = DIFF_MULTIPLE_BY_STAKE;
  let base = table[table.length - 1][1];
  if (stake <= table[0][0]) {
    base = table[0][1];
  } else {
    for (let i = 1; i < table.length; i += 1) {
      const [hiStake, hiMult] = table[i];
      if (stake <= hiStake) {
        const [loStake, loMult] = table[i - 1];
        const span = hiStake - loStake;
        const t = span === 0 ? 0 : (stake - loStake) / span;
        base = loMult + (hiMult - loMult) * t;
        break;
      }
    }
  }
  // The low tier sits about one cent per unit below the rest.
  return symbol && LOW_PAYOUT_SYMBOLS.has(symbol) ? base - 0.0095 : base;
}

/** Expected value per unit staked on Differs, given uniform digits. */
export function diffExpectedValue(stake: number, symbol?: string): number {
  return 0.9 * effectiveDiffMultiple(stake, symbol) - 1;
}

/**
 * Barrier-digit frequency at which the side breaks even.
 * Matches must clear it from below; Differs must stay under it.
 */
export function breakEvenDigitPercent(
  side: "DIGITMATCH" | "DIGITDIFF",
  symbol?: string,
): number {
  const multiple = payoutMultiplier(side, symbol);
  return side === "DIGITMATCH" ? 100 / multiple : 100 * (1 - 1 / multiple);
}

/** Profit per 1.0 of exposure on a win (payout minus the stake back). */
export function profitRate(side: "DIGITMATCH" | "DIGITDIFF"): number {
  return (
    (side === "DIGITMATCH" ? MATCH_PAYOUT_MULTIPLIER : DIFF_PAYOUT_MULTIPLIER) - 1
  );
}

export interface PerformanceStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  lossRate: number;
  pnl: number;
  expectancy: number;
  profitFactor: number | null;
  breakEvenWinRate: number;
  edgeVsBreakEven: number;
  maxDrawdown: number;
  grossWins: number;
  grossLosses: number;
}

export function computePerformance(input: {
  trades: number;
  wins: number;
  losses: number;
  pnl: number;
  grossWins: number;
  grossLosses: number;
  maxDrawdown: number;
  payoutMultiplier?: number;
}): PerformanceStats {
  const payout = input.payoutMultiplier ?? MATCH_PAYOUT_MULTIPLIER;
  const trades = input.trades;
  const winRate = trades === 0 ? 0 : (input.wins / trades) * 100;
  const lossRate = trades === 0 ? 0 : (input.losses / trades) * 100;
  const expectancy = trades === 0 ? 0 : input.pnl / trades;
  const profitFactor =
    input.grossLosses === 0 ? null : input.grossWins / input.grossLosses;
  const breakEvenWinRate = (1 / payout) * 100;
  const edgeVsBreakEven = winRate - breakEvenWinRate;

  return {
    trades,
    wins: input.wins,
    losses: input.losses,
    winRate,
    lossRate,
    pnl: input.pnl,
    expectancy,
    profitFactor,
    breakEvenWinRate,
    edgeVsBreakEven,
    maxDrawdown: input.maxDrawdown,
    grossWins: input.grossWins,
    grossLosses: input.grossLosses,
  };
}

/**
 * @param actualPayout Total payout Deriv quoted for the basket. Live trades
 * pass this so profit matches the balance; paper falls back to the estimate.
 */
export function settleContractPnl(
  exposure: number,
  won: boolean,
  side: "DIGITMATCH" | "DIGITDIFF",
  actualPayout?: number,
) {
  if (!won) return -exposure;
  if (actualPayout !== undefined && actualPayout > 0) return actualPayout - exposure;
  const payout =
    side === "DIGITMATCH" ? MATCH_PAYOUT_MULTIPLIER : DIFF_PAYOUT_MULTIPLIER;
  return exposure * (payout - 1);
}

/** @deprecated use settleContractPnl */
export function settleMatchesPnl(exposure: number, won: boolean, payout = MATCH_PAYOUT_MULTIPLIER) {
  return won ? exposure * (payout - 1) : -exposure;
}

/** Newest-first journal → average P/L over the last `count` closes. */
export function rollingExpectancy(
  journal: Array<{ pnl: number }>,
  count: number,
): number | null {
  if (count <= 0 || journal.length < count) return null;
  const slice = journal.slice(0, count);
  const total = slice.reduce((sum, entry) => sum + entry.pnl, 0);
  return total / slice.length;
}
