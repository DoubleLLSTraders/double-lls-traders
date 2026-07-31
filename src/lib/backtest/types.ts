/** Deriv's minimum stake per contract, in USD. */
export const MIN_STAKE_PER_CONTRACT = 0.35;

/**
 * How a round's total stake is spread over the digits in a basket.
 *
 * - `split`      — one stake divided between the digits. Same expected value
 *                  as a single contract of that stake, but lower variance.
 * - `perContract` — the full stake on every digit, so turnover scales with
 *                  basket size, and so does expected loss.
 */
export type StakeMode = "split" | "perContract";

export interface StrategyContext {
  /** Digits observed so far, oldest first. Excludes the digit being predicted. */
  history: number[];
  /** Rounds lost back-to-back, for strategies that react to drawdown. */
  consecutiveLosses: number;
  balance: number;
}

export interface Strategy {
  name: string;
  description: string;
  /**
   * Digits to buy DIGITMATCH on for the next tick. An empty array sits out.
   * Duplicate digits are collapsed: buying the same digit twice is one bet.
   */
  select(context: StrategyContext): number[];
}

export interface MartingaleConfig {
  /** Stake multiplier applied after a losing round. 1 disables escalation. */
  factor: number;
  /** Give up escalating and reset once this many losses have stacked up. */
  resetAfterLosses: number;
}

export interface RiskConfig {
  maxStakePerRound: number;
  dailyLossLimit: number;
  maxConsecutiveLosses: number;
  maxRounds: number;
}

export interface BacktestOptions {
  /** Total return per 1.00 staked on a winning Matches contract, stake included. */
  payoutMultiplier: number;
  startingBalance: number;
  baseStake: number;
  stakeMode: StakeMode;
  martingale: MartingaleConfig | null;
  risk: RiskConfig;
  /** Ticks reserved for warm-up so early rounds see a full analysis window. */
  warmup: number;
}

export interface Round {
  index: number;
  digits: number[];
  winningDigit: number;
  stakePerContract: number;
  totalStake: number;
  payout: number;
  profit: number;
  balance: number;
  won: boolean;
}

export type StopReason =
  | "completed"
  | "ruin"
  | "dailyLossLimit"
  | "maxConsecutiveLosses"
  | "maxRounds"
  | "stakeBelowMinimum"
  | "stakeAboveCap";

export interface BacktestReport {
  strategy: string;
  stakeMode: StakeMode;
  rounds: number;
  wins: number;
  winRate: number;
  /** Sum of every stake placed. The base the house edge is charged on. */
  turnover: number;
  netProfit: number;
  /** netProfit / turnover — the realised edge per dollar risked. */
  edgePerTurnover: number;
  finalBalance: number;
  peakBalance: number;
  maxDrawdown: number;
  longestLossStreak: number;
  largestStakePlaced: number;
  stopReason: StopReason;
  history: Round[];
}
