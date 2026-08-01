import type { ContractSide } from "../analysis/signal";

export interface BotSettings {
  side: ContractSide;
  prediction: number;
  stake: number;
  contracts: number;
  duration: number;
  martingale: boolean;
  martingaleMultiplier: number;
  /** Hard cap on martingale step-ups (0 = use config consecutive losses). */
  maxMartingaleSteps: number;
  autoFollow: boolean;
  /**
   * When on, analyzer picks Matches vs Differs from whichever setup is
   * fully confirmed (or has the stronger edge).
   */
  autoSide: boolean;
  /**
   * differs = Differs only, never falls back to Matches.
   * winrate = prefer Differs (high hit rate) whenever armed.
   * edge = pick whichever clears break-even by more.
   */
  sidePreference: "differs" | "matches" | "winrate" | "edge";
  /** Fire bulk contracts as parallel live buys (same tick). */
  parallelExecution: boolean;
  /** Seconds to wait before feeding the live signal and starting. 0 = immediate. */
  armSeconds: number;
  /** Skip entries until analyzer sample is at least this large. */
  minSample: number;
  /**
   * Extra percentage points beyond payout break-even before entry.
   * Matches: digit % ≥ BE + edge. Differs: digit % ≤ barrier BE − edge.
   */
  minEdgePercent: number;
  /** Skip low-confidence analyzer signals. */
  skipLowConfidence: boolean;
  /** Require all 5 confirmation layers before entry. */
  requireFullConfirm: boolean;
  /** Require short/mid/long windows to pick the same digit. */
  requireMultiWindow: boolean;
  /** Require the signal digit to clear EV in every ready window. */
  requireWindowsEv: boolean;
  /** Matches: recent print. Differs: still absent. */
  requireTiming: boolean;
  /** Only enter when χ² says the window is uneven vs fair 10%. */
  requireUneven: boolean;
  /** Matches timing: max ticks since digit last appeared. */
  maxMomentumGap: number;
  /** Differs timing: min ticks since digit last appeared. */
  minColdGap: number;
  /** Minimum ticks to wait between closing one trade and opening the next. */
  cooldownTicks: number;
  /** After this many trades, pause if win rate is below break-even. */
  pauseIfBelowBreakEvenAfter: number;
  /** After this many trades, pause if average P/L per trade is negative. */
  pauseIfExpectancyNegativeAfter: number;
  /** Stake as % of live balance; 0 = use fixed base stake. */
  riskPercent: number;
  /** Stop session when drawdown from peak P/L reaches this % of |peak| or balance basis. */
  maxDrawdownPercent: number;
  /** Cap opens in a rolling 60 minutes. 0 = off. */
  maxTradesPerHour: number;
  /** Session daily loss stop (absolute currency). */
  dailyLossLimit: number;
  /** Session daily profit take (absolute currency). */
  dailyProfitTarget: number;
  /** Stop after this many losses in a row. */
  maxConsecutiveLosses: number;
  /** Hard cap on trades opened today. */
  maxTradesPerDay: number;
  /** Max stake per contract (martingale ceiling). */
  maxStake: number;
  /**
   * Hard ceiling on what one basket may risk, as % of live balance. Outranks
   * maxStake and the martingale ladder, so no single loss can take the account.
   * 0 = off.
   */
  maxExposurePercent: number;
  /** Stop this run once session P/L reaches +this. 0 = off. */
  takeProfit: number;
  /** When true, stake changes do not overwrite take profit. */
  takeProfitManual?: boolean;
  /** Stop this run once session P/L reaches -this. 0 = off. */
  stopLoss: number;
  /** Stop after this many settled baskets. 0 = unlimited. */
  maxRuns: number;
  running: boolean;
}

export interface TradeJournalEntry {
  id: string;
  at: number;
  side: ContractSide;
  digit: number;
  stake: number;
  contracts: number;
  won: boolean;
  pnl: number;
  /** Deriv's exit tick. null when it could not be read. */
  settleDigit: number | null;
  mode: "paper" | "live";
  contractId?: number;
  note?: string;
  /** Epoch when the order opened (settle time stays on `at`). */
  entryAt?: number;
  /** Spot quote at entry. */
  entrySpot?: number;
  /** Digits analyzer gap at entry. */
  entryGap?: number | null;
  /** Cold/hot % at entry. */
  entryPercent?: number;
  /** Analyzer power at entry. */
  entryPower?: number;
}

export interface BotSession {
  trades: number;
  wins: number;
  losses: number;
  pnl: number;
  consecutiveLosses: number;
  currentStake: number;
  grossWins: number;
  grossLosses: number;
  peakPnl: number;
  maxDrawdown: number;
  lastCloseEpoch: number | null;
  /** Barrier of the last order, and when it went on. */
  lastEntryDigit: number | null;
  lastEntryEpoch: number | null;
  /** After a Differs loss, skip this barrier until the cold pick moves. */
  coolBarrierDigit: number | null;
  skipped: number;
  /** Epoch seconds of trade opens (for trades/hour). */
  openEpochs: number[];
  journal: TradeJournalEntry[];
  martingaleSteps: number;
  open: null | {
    side: ContractSide;
    digit: number;
    stake: number;
    contracts: number;
    entryEpoch: number;
    settleAfter: number;
    mode: "paper" | "live";
    contractId?: number;
    /** Every filled leg, so live settlement can read the real outcome. */
    contractIds?: number[];
    /** Total payout Deriv quoted across the filled legs (live only). */
    payout?: number;
    /** Copied to the journal on settle (e.g. AI Operator tag). */
    note?: string;
    entrySpot?: number;
    entryGap?: number | null;
    entryPercent?: number;
    entryPower?: number;
  };
}
