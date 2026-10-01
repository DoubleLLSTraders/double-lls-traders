import type { Tick } from "./market";

export type ContractType = "DIGITMATCH" | "DIGITDIFF" | "DIGITOVER" | "DIGITUNDER" | "DIGITEVEN" | "DIGITODD";
export type StrategyMode = "auto" | "differs" | "matches" | "overunder" | "evenodd";

export interface BotSettings {
  /** Deriv symbol traded on the real feed and by the exported bots; "auto" watches every volatility index. */
  symbol: string;
  mode: StrategyMode;
  stake: number;
  /** Stop once session P/L reaches +this. 0 = off. */
  takeProfit: number;
  /** Stop once session P/L reaches -this. 0 = off. */
  stopLoss: number;
  /** Ticks in the main scoring window. */
  window: number;
  /** Ticks in the confirmation window; the setup must also clear break-even here. */
  confirmWindow: number;
  /** Standard errors the win rate must sit above break-even before entry. */
  minConfidence: number;
  /** Only trade setups whose recent win rate is at least this %. 0 = off. */
  minWinRate: number;
  /** Stop after this many losses in a row. 0 = off. */
  maxConsecutiveLosses: number;
  /** Ticks to wait after a trade settles before the next entry. */
  cooldownTicks: number;
  /** After a loss, size the next trade to win back the streak's losses plus one normal win. */
  martingale: boolean;
  /** Let the bot size recovery itself from the balance, payout and stop loss (ignores the two manual limits below). */
  autoMartingale: boolean;
  /** Recovery attempts before the loss is accepted and the stake resets. */
  maxMartingaleSteps: number;
  /** Hard cap on any single stake, as % of the current balance. */
  maxStakePercent: number;
  /** Balance a test session starts with. */
  startBalance: number;
  /** Raise the confidence bar to account for scanning many setups at once (Bonferroni), so chance spikes don't trade. */
  strictStats: boolean;
  /** A setup must stay qualified for this many consecutive ticks before entry. 0 = off. */
  persistTicks: number;
  /** Extra ticks to wait after a losing trade. */
  lossCooldown: number;
  /** Buy extra stake units when a setup clears the confidence bar by a wide margin. */
  stackStakes: boolean;
  /** Most stake units one entry may stack. */
  maxStack: number;
  /** Trade every tick of every market: one position per market at a time, re-entering as soon as it settles. */
  turbo: boolean;
  /** Size each entry from the measured edge (fractional Kelly) instead of the flat stake. */
  kellySizing: boolean;
  /** Share of the full Kelly stake to bet, 0–1. */
  kellyFraction: number;
  /** Halve stakes and pause recovery while the session is down this % of the start balance from its peak. 0 = off. */
  drawdownBrake: number;
  /** Stop once today's sessions together have lost this much. 0 = off. */
  dailyLossLimit: number;
  /** Only trade when the window's digits are measurably uneven (chi-square, p < 0.10). */
  randomnessFilter: boolean;
  /** Skip entries when the latest ticks' digit mix breaks sharply from the rest of the window (chi-square, p < 0.01). */
  regimeGuard: boolean;
}

export const DEMO_BALANCE = 10_000;
export const MIN_BALANCE = 1;
export const MAX_BALANCE = 1_000_000;

export const DEFAULT_SETTINGS: BotSettings = {
  symbol: "auto",
  mode: "auto",
  stake: 50,
  takeProfit: 10000,
  stopLoss: 1000,
  window: 300,
  confirmWindow: 100,
  minConfidence: 2,
  minWinRate: 80,
  maxConsecutiveLosses: 0,
  cooldownTicks: 0,
  martingale: true,
  autoMartingale: true,
  maxMartingaleSteps: 3,
  maxStakePercent: 5,
  startBalance: DEMO_BALANCE,
  strictStats: false,
  persistTicks: 3,
  lossCooldown: 0,
  stackStakes: true,
  maxStack: 3,
  turbo: false,
  kellySizing: false,
  kellyFraction: 0.1,
  drawdownBrake: 0,
  dailyLossLimit: 0,
  randomnessFilter: false,
  regimeGuard: false,
};

/** Extra σ above the confidence bar that earns each additional stake unit. */
export const STACK_STEP_SIGMA = 1;
/** Symbol key used when the bot sees a single market. */
export const SINGLE_MARKET = "";

export type ProfileId = "careful" | "balanced" | "active";
type ProfileKeys = "window" | "confirmWindow" | "minConfidence" | "persistTicks" | "strictStats" | "martingale" | "autoMartingale";

/**
 * Presets tuned on ~516k real Deriv ticks (10 volatility indices, Oct 2026), $1 stake on $1,000,
 * each checked on both halves of the data. `tested` is the combined result; positive figures are within chance.
 */
export const PROFILES: { id: ProfileId; label: string; note: string; tested: string; values: Pick<BotSettings, ProfileKeys> }[] = [
  {
    id: "careful",
    label: "Careful",
    note: "Trades rarely, flat stakes, smallest drawdowns.",
    tested: "714 trades · P/L −$14 · worst drawdown $6",
    values: { window: 500, confirmWindow: 150, minConfidence: 2.5, persistTicks: 0, strictStats: false, martingale: false, autoMartingale: true },
  },
  {
    id: "balanced",
    label: "Balanced",
    note: "Default. Longer evidence window, edge must hold 3 ticks, auto recovery.",
    tested: "6,060 trades · P/L +$2 · worst drawdown $171 · 23 of 23 sessions hit take profit",
    values: { window: 300, confirmWindow: 100, minConfidence: 2, persistTicks: 3, strictStats: false, martingale: true, autoMartingale: true },
  },
  {
    id: "active",
    label: "Active",
    note: "More trades, no persistence check, auto recovery.",
    tested: "6,730 trades · P/L −$136 · worst drawdown $296 · 16 of 17 sessions hit take profit",
    values: { window: 300, confirmWindow: 100, minConfidence: 2, persistTicks: 0, strictStats: false, martingale: true, autoMartingale: true },
  },
];

export function profileOf(s: BotSettings): ProfileId | null {
  const match = PROFILES.find((p) => (Object.keys(p.values) as ProfileKeys[]).every((k) => s[k] === p.values[k]));
  return match?.id ?? null;
}

/** Stake and stop loss sized to a starting balance, in the same proportions as the defaults; take profit off so growth is visible. */
export function settingsForBalance(settings: BotSettings, balance: number): BotSettings {
  const round = (n: number) => Math.round(n * 100) / 100;
  const stake = Math.max(MIN_STAKE, round(balance * 0.005));
  return {
    ...settings,
    startBalance: round(balance),
    stake,
    stopLoss: Math.min(round(balance), Math.max(round(balance * 0.1), round(stake * 3))),
    takeProfit: 0,
  };
}

export const MIN_STAKE = 0.35;

/** Auto martingale: largest single stake, and most one recovery streak may risk, as % of balance. */
export const AUTO_STAKE_CAP_PERCENT = 8;
export const AUTO_LADDER_BUDGET_PERCENT = 15;
export const AUTO_MAX_STEPS = 6;
export const RECOVERY_SPLIT = 4;

export const MODES: { id: StrategyMode; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "differs", label: "Differs" },
  { id: "matches", label: "Matches" },
  { id: "overunder", label: "Over / Under" },
  { id: "evenodd", label: "Even / Odd" },
];

/** Deriv total payout multiples (stake included), conservative typical quotes. */
const MATCH_PAYOUT = 8.9286;
const DIFF_PAYOUT = 1.0965;
const EVEN_ODD_PAYOUT = 1.95;
export const OVER_PAYOUT: Record<number, number> = { 0: 1.09, 1: 1.22, 2: 1.39, 3: 1.61 };
export const UNDER_PAYOUT: Record<number, number> = { 6: 1.61, 7: 1.39, 8: 1.22, 9: 1.09 };

export interface Setup {
  contract: ContractType;
  barrier: number | null;
}

export function payoutMultiple({ contract, barrier }: Setup): number {
  switch (contract) {
    case "DIGITMATCH":
      return MATCH_PAYOUT;
    case "DIGITDIFF":
      return DIFF_PAYOUT;
    case "DIGITEVEN":
    case "DIGITODD":
      return EVEN_ODD_PAYOUT;
    case "DIGITOVER":
      return OVER_PAYOUT[barrier!];
    case "DIGITUNDER":
      return UNDER_PAYOUT[barrier!];
  }
}

export function setupWins({ contract, barrier }: Setup, digit: number): boolean {
  switch (contract) {
    case "DIGITMATCH":
      return digit === barrier;
    case "DIGITDIFF":
      return digit !== barrier;
    case "DIGITOVER":
      return digit > barrier!;
    case "DIGITUNDER":
      return digit < barrier!;
    case "DIGITEVEN":
      return digit % 2 === 0;
    case "DIGITODD":
      return digit % 2 === 1;
  }
}

export const CONTRACT_NAMES: Record<ContractType, string> = {
  DIGITMATCH: "Matches",
  DIGITDIFF: "Differs",
  DIGITOVER: "Over",
  DIGITUNDER: "Under",
  DIGITEVEN: "Even",
  DIGITODD: "Odd",
};

export function setupLabel(s: Setup): string {
  return s.barrier === null ? CONTRACT_NAMES[s.contract] : `${CONTRACT_NAMES[s.contract]} ${s.barrier}`;
}

function setupsFor(mode: StrategyMode): Setup[] {
  const digits = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const differs = digits.map((d) => ({ contract: "DIGITDIFF" as const, barrier: d }));
  const matches = digits.map((d) => ({ contract: "DIGITMATCH" as const, barrier: d }));
  const overUnder = [
    ...[0, 1, 2, 3].map((b) => ({ contract: "DIGITOVER" as const, barrier: b })),
    ...[6, 7, 8, 9].map((b) => ({ contract: "DIGITUNDER" as const, barrier: b })),
  ];
  const evenOdd: Setup[] = [
    { contract: "DIGITEVEN", barrier: null },
    { contract: "DIGITODD", barrier: null },
  ];
  switch (mode) {
    case "differs":
      return differs;
    case "matches":
      return matches;
    case "overunder":
      return overUnder;
    case "evenodd":
      return evenOdd;
    case "auto":
      return [...differs, ...matches, ...overUnder, ...evenOdd];
  }
}

export const setupCount = (mode: StrategyMode) => setupsFor(mode).length;

export interface Candidate {
  setup: Setup;
  label: string;
  payout: number;
  /** Win % needed to break even. */
  breakEven: number;
  /** Observed win % on the main window. */
  winRate: number;
  /** Observed win % on the confirmation window. */
  confirmRate: number;
  /** Standard errors above break-even on the main window. */
  confidence: number;
  /** Expected profit per 1 staked at the observed win rate. */
  ev: number;
  ready: boolean;
}

export interface Scan {
  sample: number;
  percents: number[];
  candidates: Candidate[];
  ready: Candidate[];
  best: Candidate | null;
  /** Chi-square of the window's digits against an even spread (9 degrees of freedom). */
  unevenness: number;
  /** Chi-square between the confirmation window and the rest of the main window (9 degrees of freedom). */
  shift: number;
  /** Why entries are held back by a filter, if they are. */
  blocked: string | null;
}

const HISTORY_LIMIT = 3000;
/** Chi-square critical values at 9 degrees of freedom. */
export const CHI_UNEVEN = 14.684;
export const CHI_SHIFT = 21.666;
const JOURNAL_LIMIT = 100;

function countDigits(history: number[], n: number): { counts: number[]; size: number } {
  const counts = new Array<number>(10).fill(0);
  const start = Math.max(0, history.length - n);
  for (let i = start; i < history.length; i++) counts[history[i]] += 1;
  return { counts, size: history.length - start };
}

function winShare(setup: Setup, counts: number[], size: number): number {
  if (!size) return 0;
  let wins = 0;
  for (let d = 0; d < 10; d++) if (setupWins(setup, d)) wins += counts[d];
  return wins / size;
}

/** Required win % above break-even for contracts that can never reach the user's minimum (Matches, Even/Odd). */
export const WIN_RATE_MARGIN = 1.15;

/**
 * The user's minimum win rate. When a single contract type is chosen whose payout makes that minimum
 * impossible, a margin above break-even instead; Auto keeps the strict minimum so it favours high win rates.
 */
export function requiredWinRate(breakEvenPct: number, settings: Pick<BotSettings, "minWinRate" | "mode">): number {
  if (settings.mode === "auto") return settings.minWinRate;
  return Math.min(settings.minWinRate, breakEvenPct * WIN_RATE_MARGIN);
}

/** Standard normal upper-tail probability. */
function normalTail(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z >= 0 ? p : 1 - p;
}

/** z with the given upper-tail probability (bisection; precision is ample for a threshold). */
function normalQuantileUpper(p: number): number {
  let lo = -10;
  let hi = 10;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (normalTail(mid) > p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Confidence bar actually applied: the user's σ, or its family-wise equivalent across `tests` setups. */
export function effectiveConfidence(settings: Pick<BotSettings, "minConfidence" | "strictStats">, tests: number): number {
  if (!settings.strictStats || tests <= 1) return settings.minConfidence;
  return normalQuantileUpper(normalTail(settings.minConfidence) / tests);
}

/** Scores every setup for the mode and returns them strongest first. */
export function scanMarket(history: number[], settings: BotSettings): Scan {
  const main = countDigits(history, settings.window);
  const confirm = countDigits(history, settings.confirmWindow);
  const percents = main.counts.map((c) => (main.size ? (c / main.size) * 100 : 0));
  const full = main.size >= settings.window;
  const setups = setupsFor(settings.mode);
  const zBar = effectiveConfidence(settings, setups.length);

  const candidates = setups.map((setup): Candidate => {
    const payout = payoutMultiple(setup);
    const be = 1 / payout;
    const minRate = requiredWinRate(be * 100, settings);
    const p = winShare(setup, main.counts, main.size);
    const pc = winShare(setup, confirm.counts, confirm.size);
    const se = Math.sqrt((be * (1 - be)) / Math.max(1, main.size));
    const confidence = (p - be) / se;
    const ev = p * payout - 1;
    return {
      setup,
      label: setupLabel(setup),
      payout,
      breakEven: be * 100,
      winRate: p * 100,
      confirmRate: pc * 100,
      confidence,
      ev,
      ready:
        full &&
        confidence >= zBar &&
        pc >= be &&
        ev > 0 &&
        p * 100 >= minRate &&
        pc * 100 >= minRate,
    };
  });
  candidates.sort((a, b) => b.confidence - a.confidence);
  const unevenness = uniformChiSquare(main.counts, main.size);
  const shift = shiftChiSquare(main.counts, confirm.counts);
  const blocked = !full
    ? null
    : settings.randomnessFilter && unevenness < CHI_UNEVEN
      ? "digits look evenly random right now (randomness filter)"
      : settings.regimeGuard && shift > CHI_SHIFT
        ? "the latest ticks broke from the window's digit mix (regime guard)"
        : null;
  const ready = blocked ? [] : candidates.filter((c) => c.ready).sort((a, b) => b.ev - a.ev);
  return { sample: main.size, percents, candidates, ready, best: ready[0] ?? null, unevenness, shift, blocked };
}

function uniformChiSquare(counts: number[], size: number): number {
  if (!size) return 0;
  const expected = size / 10;
  return counts.reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0);
}

/** Homogeneity test between the newest ticks (`recent`, part of `all`) and the older rest of the window. */
function shiftChiSquare(all: number[], recent: number[]): number {
  const older = all.map((c, d) => c - recent[d]);
  if (older.some((c) => c < 0)) return 0;
  const n1 = older.reduce((a, b) => a + b, 0);
  const n2 = recent.reduce((a, b) => a + b, 0);
  const n = n1 + n2;
  if (!n1 || !n2) return 0;
  let chi = 0;
  for (let d = 0; d < 10; d++) {
    const total = older[d] + recent[d];
    if (!total) continue;
    const e1 = (total * n1) / n;
    const e2 = (total * n2) / n;
    chi += (older[d] - e1) ** 2 / e1 + (recent[d] - e2) ** 2 / e2;
  }
  return chi;
}

/**
 * Fractional Kelly stake for a candidate. Uses half the measured edge over break-even,
 * since short-window win rates overstate it.
 */
export function kellyStake(c: Candidate, balance: number, fraction: number): number {
  const be = c.breakEven / 100;
  const p = be + (Math.min(c.winRate, c.confirmRate) / 100 - be) / 2;
  const b = c.payout - 1;
  return Math.max(0, balance * fraction * (p - (1 - p) / b));
}

/**
 * Turbo entry when nothing qualifies: the most confident setup among those that clear the user's
 * minimum win rate (so Auto stays on high-win contracts), or the most confident overall.
 */
export function turboPick(scan: Scan, settings: BotSettings): Candidate | null {
  if (scan.sample < settings.window || !scan.candidates.length) return null;
  return scan.candidates.find((c) => c.winRate >= requiredWinRate(c.breakEven, settings)) ?? scan.candidates[0];
}

/**
 * Recovery entry: the ready setup whose win-back stake risks the least.
 * Expected loss of a recovery trade is stake × (1 − p), and stake scales with 1 / profit rate.
 */
function recoverySetup(ready: Candidate[]): Candidate | null {
  let pick: Candidate | null = null;
  let bestRisk = Infinity;
  for (const c of ready) {
    const p = Math.min(c.winRate, c.confirmRate) / 100;
    const risk = (1 - p) / (c.payout - 1);
    if (risk < bestRisk) {
      bestRisk = risk;
      pick = c;
    }
  }
  return pick;
}

export interface Trade {
  id: number;
  epoch: number;
  setup: Setup;
  label: string;
  stake: number;
  settleDigit: number;
  won: boolean;
  pnl: number;
  /** Symbol traded; absent on the simulated market. */
  market?: string;
  /** Stake units stacked on this entry. */
  units?: number;
  /** Why the bot took the trade and sized it as it did. */
  reason?: string;
}

export interface OpenTrade {
  setup: Setup;
  label: string;
  stake: number;
  epoch: number;
  market: string;
  units: number;
  reason: string;
}

export interface ContractTally {
  trades: number;
  wins: number;
  pnl: number;
}

export interface BotState {
  running: boolean;
  stopReason: string | null;
  startBalance: number;
  balance: number;
  pnl: number;
  trades: number;
  wins: number;
  losses: number;
  consecutiveLosses: number;
  peakPnl: number;
  maxDrawdown: number;
  /** Most recent open position, for display. */
  open: OpenTrade | null;
  /** Every open position; turbo holds up to one per market. */
  positions: OpenTrade[];
  cooldownUntil: number;
  journal: Trade[];
  equity: number[];
  byContract: Partial<Record<ContractType, ContractTally>>;
  /** Losses since the last win that recovery staking is trying to win back. */
  recoveryLoss: number;
  /** Largest amount owed during the current recovery, for showing progress. */
  recoveryPeak: number;
  recoveryStep: number;
  largestStake: number;
  /** Sum of every settled stake; money returned is totalStaked + pnl. */
  totalStaked: number;
}

const cents = (n: number) => Math.round(n * 100) / 100;

function freshState(startBalance: number): BotState {
  return {
    running: false,
    stopReason: null,
    startBalance,
    balance: startBalance,
    pnl: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    consecutiveLosses: 0,
    peakPnl: 0,
    maxDrawdown: 0,
    open: null,
    positions: [],
    cooldownUntil: 0,
    journal: [],
    equity: [],
    byContract: {},
    recoveryLoss: 0,
    recoveryPeak: 0,
    recoveryStep: 0,
    largestStake: 0,
    totalStaked: 0,
  };
}

/**
 * Multi-contract digit bot: scans Matches, Differs, Over/Under and Even/Odd on
 * every tick and buys the setup with the best expected value, but only when
 * its win rate is statistically above that contract's break-even.
 */
interface MarketBook {
  history: number[];
  scan: Scan;
  streak: Map<string, number>;
}

export interface MarketView {
  market: string;
  scan: Scan;
}

export class DigitBot {
  settings: BotSettings;
  state: BotState;
  /** Scan of the focus market: the one being traded, or the one with the strongest qualified setup. */
  scan: Scan;
  focus = SINGLE_MARKET;
  /** P/L of today's earlier sessions, counted toward the daily loss limit. */
  dayPnlBefore = 0;
  /** Positions are real contracts: they settle through settleLive with the broker's result, not on the next tick. */
  live = false;
  private markets = new Map<string, MarketBook>();

  constructor(settings: BotSettings, startBalance = settings.startBalance || DEMO_BALANCE) {
    this.settings = settings;
    this.state = freshState(startBalance);
    this.scan = scanMarket([], settings);
  }

  /** Every market seen so far with its latest scan. */
  get marketViews(): MarketView[] {
    return [...this.markets].map(([market, b]) => ({ market, scan: b.scan }));
  }

  /** Forgets all market histories, e.g. when the feed changes. */
  clearMarkets() {
    this.markets.clear();
    this.focus = SINGLE_MARKET;
    this.scan = scanMarket([], this.settings);
  }

  private book(market: string): MarketBook {
    let b = this.markets.get(market);
    if (!b) {
      b = { history: [], scan: scanMarket([], this.settings), streak: new Map() };
      this.markets.set(market, b);
    }
    return b;
  }

  /** Focus follows the open trade (except in turbo, where trades are everywhere); otherwise the market whose best qualified setup is most confident. */
  private updateFocus(fallback: string) {
    const s = this.state;
    let focus = this.settings.turbo ? null : s.open?.market ?? null;
    if (focus === null) {
      let top = -Infinity;
      for (const [market, b] of this.markets) {
        const c = b.scan.best;
        if (c && c.confidence > top) {
          top = c.confidence;
          focus = market;
        }
      }
    }
    if (focus === null) focus = this.markets.has(this.focus) ? this.focus : fallback;
    this.focus = focus;
    this.scan = this.book(focus).scan;
  }

  /** Stake units for an entry: one, plus one per STACK_STEP_SIGMA the setup clears the bar by. */
  unitsFor(c: Candidate): number {
    const { stackStakes, maxStack, mode, kellySizing } = this.settings;
    if (!stackStakes || kellySizing || maxStack <= 1 || this.state.recoveryLoss > 0 || this.braked) return 1;
    const bar = effectiveConfidence(this.settings, setupCount(mode));
    const extra = Math.floor((c.confidence - bar) / STACK_STEP_SIGMA);
    return Math.max(1, Math.min(Math.floor(maxStack), 1 + extra));
  }

  /** Total stake for an entry on this candidate, stacking included. */
  entryStake(c: Candidate): number {
    let stake = this.stakeFor(c.setup);
    if (this.settings.kellySizing && this.state.recoveryLoss <= 0) {
      stake = cents(Math.max(MIN_STAKE, Math.min(kellyStake(c, this.state.balance, this.settings.kellyFraction), this.stakeCap())));
    }
    if (this.braked) stake = cents(Math.max(MIN_STAKE, stake / 2));
    const units = this.unitsFor(c);
    if (units <= 1) return stake;
    return cents(Math.max(stake, Math.min(stake * units, this.stakeCap())));
  }

  /** Session is down `drawdownBrake` % of the start balance from its peak: stakes halve and recovery pauses. */
  get braked(): boolean {
    const { drawdownBrake } = this.settings;
    const s = this.state;
    return drawdownBrake > 0 && s.peakPnl - s.pnl >= (s.startBalance * drawdownBrake) / 100;
  }

  get dailyLimitHit(): boolean {
    const { dailyLossLimit } = this.settings;
    return dailyLossLimit > 0 && this.dayPnlBefore + this.state.pnl <= -dailyLossLimit;
  }

  private explain(c: Candidate, units: number, forced: boolean): string {
    const { window, confirmWindow, kellySizing } = this.settings;
    const s = this.state;
    const sigma = `${c.confidence >= 0 ? "+" : ""}${c.confidence.toFixed(1)}σ`;
    const parts = [
      forced
        ? `Turbo: nothing qualified, took the most confident setup (${c.winRate.toFixed(1)}% vs ${c.breakEven.toFixed(1)}% needed)`
        : `Won ${c.winRate.toFixed(1)}% of the last ${window} ticks vs ${c.breakEven.toFixed(1)}% needed (${sigma}), ${c.confirmRate.toFixed(1)}% on the last ${confirmWindow}`,
    ];
    if (s.recoveryLoss > 0) parts.push(`recovery step ${s.recoveryStep}, winning back $${s.recoveryLoss.toFixed(2)}`);
    else if (kellySizing) parts.push("stake sized by Kelly from the edge");
    if (units > 1) parts.push(`×${units} on a strong signal`);
    if (this.braked) parts.push("drawdown brake on: half stake");
    return parts.join(" · ");
  }

  start() {
    this.state.running = true;
    this.state.stopReason = null;
  }

  stop(reason: string) {
    this.state.running = false;
    this.state.stopReason = reason;
  }

  resetSession() {
    this.state = freshState(this.settings.startBalance || this.state.startBalance);
  }

  onTick(tick: Tick, rescan = true) {
    const s = this.state;
    const market = tick.market ?? SINGLE_MARKET;
    const b = this.book(market);
    if (!this.live) for (const p of s.positions.filter((x) => x.market === market)) this.settle(tick, p);
    if (s.running && !s.positions.length && this.dailyLimitHit) this.stop("Daily loss limit reached");

    b.history.push(tick.digit);
    if (b.history.length > HISTORY_LIMIT) b.history.splice(0, b.history.length - HISTORY_LIMIT);

    const turbo = this.settings.turbo;
    const wantsEntry = s.running && (turbo ? !s.positions.some((p) => p.market === market) : !s.open && tick.epoch >= s.cooldownUntil);
    if (!rescan && !s.running) return;
    b.scan = this.persistent(b, scanMarket(b.history, this.settings));
    if (s.recoveryLoss > 0) b.scan.best = recoverySetup(b.scan.ready);
    this.updateFocus(market);
    const pick = turbo ? b.scan.best ?? turboPick(b.scan, this.settings) : b.scan.best;
    if (!wantsEntry || !pick || (!turbo && this.focus !== market)) return;

    const stake = this.entryStake(pick);
    const committed = s.positions.reduce((sum, p) => sum + p.stake, 0);
    if (stake > s.balance - committed) {
      if (!committed) this.stop("Balance too low for the stake");
      return;
    }
    s.largestStake = Math.max(s.largestStake, stake);
    const units = this.unitsFor(pick);
    const reason = this.explain(pick, units, turbo && !b.scan.best);
    s.open = { setup: pick.setup, label: pick.label, stake, epoch: tick.epoch, market, units, reason };
    s.positions.push(s.open);
    this.updateFocus(market);
  }

  /** Keeps only setups that have stayed qualified for `persistTicks` consecutive scans of their market. */
  private persistent(b: MarketBook, scan: Scan): Scan {
    const need = this.settings.persistTicks;
    for (const c of scan.candidates) {
      if (c.ready) b.streak.set(c.label, (b.streak.get(c.label) ?? 0) + 1);
      else b.streak.delete(c.label);
    }
    if (need <= 0) return scan;
    const ready = scan.ready.filter((c) => (b.streak.get(c.label) ?? 0) >= need);
    return { ...scan, ready, best: ready[0] ?? null };
  }

  /** Wins a losing streak is paid back over; smaller recovery stakes survive a second loss. */
  recoverySplit = RECOVERY_SPLIT;

  /** Base stake, or in recovery the stake that wins back a share of the streak plus one normal win. */
  stakeFor(setup: Setup): number {
    const { stake, martingale, turbo } = this.settings;
    const base = Math.max(MIN_STAKE, stake);
    const s = this.state;
    if (!martingale || turbo || s.recoveryLoss <= 0) return base;
    return cents(Math.max(base, Math.min(this.recoveryStake(s.recoveryLoss, setup), this.stakeCap())));
  }

  private recoveryStake(owed: number, setup: Setup): number {
    return owed / ((payoutMultiple(setup) - 1) * this.recoverySplit) + Math.max(MIN_STAKE, this.settings.stake);
  }

  private stakeCap(): number {
    const { autoMartingale, maxStakePercent } = this.settings;
    const percent = autoMartingale ? AUTO_STAKE_CAP_PERCENT : maxStakePercent;
    return percent > 0 ? (this.state.balance * percent) / 100 : Infinity;
  }

  /** Whether another recovery trade fits, given the losses so far in this streak (including the latest). */
  private canRecover(lossSoFar: number, step: number, setup: Setup): boolean {
    const { autoMartingale, maxMartingaleSteps, stopLoss } = this.settings;
    if (this.braked) return false;
    if (!autoMartingale) return step < maxMartingaleSteps;
    if (step >= AUTO_MAX_STEPS) return false;
    const s = this.state;
    const next = Math.min(this.recoveryStake(lossSoFar, setup), this.stakeCap());
    let budget = (s.balance * AUTO_LADDER_BUDGET_PERCENT) / 100;
    if (stopLoss > 0) budget = Math.min(budget, stopLoss + s.pnl);
    return lossSoFar + next <= budget;
  }

  /** Recovery steps the auto sizer would allow right now for this setup's payout. */
  autoRecoverySteps(setup: Setup): number {
    let loss = 0;
    let step = 0;
    let stake = Math.max(MIN_STAKE, this.settings.stake);
    while (true) {
      loss += stake;
      if (!this.canRecover(loss, step, setup)) return step;
      step += 1;
      stake = Math.min(this.recoveryStake(loss, setup), this.stakeCap());
    }
  }

  /** Records a real contract's result. `epoch` is the tick count the cooldown is measured from. */
  settleLive(open: OpenTrade, profit: number, digit: number, epoch: number) {
    if (!this.state.positions.includes(open)) return;
    this.settle({ epoch, quote: 0, digit }, open, profit);
  }

  /** Drops a position the broker refused, without counting it as a trade. */
  cancelLive(open: OpenTrade) {
    const s = this.state;
    s.positions = s.positions.filter((p) => p !== open);
    s.open = s.positions[s.positions.length - 1] ?? null;
  }

  private settle(tick: Tick, open: OpenTrade, actualPnl?: number) {
    const s = this.state;
    const won = actualPnl === undefined ? setupWins(open.setup, tick.digit) : actualPnl > 0;
    const pnl = cents(actualPnl ?? (won ? open.stake * (payoutMultiple(open.setup) - 1) : -open.stake));

    s.positions = s.positions.filter((p) => p !== open);
    s.open = s.positions[s.positions.length - 1] ?? null;
    s.trades += 1;
    s.totalStaked = cents(s.totalStaked + open.stake);
    s.pnl = cents(s.pnl + pnl);
    s.balance = cents(s.balance + pnl);
    if (won) {
      s.wins += 1;
      s.consecutiveLosses = 0;
      const normalWin = Math.max(MIN_STAKE, this.settings.stake) * (payoutMultiple(open.setup) - 1);
      s.recoveryLoss = cents(Math.max(0, s.recoveryLoss - (pnl - normalWin)));
      s.recoveryStep = 0;
    } else {
      s.losses += 1;
      s.consecutiveLosses += 1;
      const lossSoFar = cents(s.recoveryLoss + open.stake);
      if (this.settings.martingale && !this.settings.turbo && this.canRecover(lossSoFar, s.recoveryStep, open.setup)) {
        s.recoveryLoss = lossSoFar;
        s.recoveryStep += 1;
      } else {
        s.recoveryLoss = 0;
        s.recoveryStep = 0;
      }
    }
    s.recoveryPeak = s.recoveryLoss > 0 ? Math.max(s.recoveryPeak, s.recoveryLoss) : 0;
    s.peakPnl = Math.max(s.peakPnl, s.pnl);
    s.maxDrawdown = Math.max(s.maxDrawdown, cents(s.peakPnl - s.pnl));
    s.equity.push(s.pnl);

    const tally = (s.byContract[open.setup.contract] ??= { trades: 0, wins: 0, pnl: 0 });
    tally.trades += 1;
    if (won) tally.wins += 1;
    tally.pnl = cents(tally.pnl + pnl);

    s.journal.unshift({
      id: s.trades,
      epoch: tick.epoch,
      setup: open.setup,
      label: open.label,
      stake: open.stake,
      settleDigit: tick.digit,
      won,
      pnl,
      ...(open.market !== SINGLE_MARKET && { market: open.market }),
      ...(open.units > 1 && { units: open.units }),
      reason: open.reason,
    });
    if (s.journal.length > JOURNAL_LIMIT) s.journal.pop();
    s.cooldownUntil = tick.epoch + this.settings.cooldownTicks + 1 + (won ? 0 : this.settings.lossCooldown);

    const { takeProfit, stopLoss, maxConsecutiveLosses } = this.settings;
    if (takeProfit > 0 && s.pnl >= takeProfit) this.stop("Take profit reached");
    else if (stopLoss > 0 && s.pnl <= -stopLoss) this.stop("Stop loss reached");
    else if (this.dailyLimitHit) this.stop("Daily loss limit reached");
    else if (maxConsecutiveLosses > 0 && s.consecutiveLosses >= maxConsecutiveLosses) {
      this.stop(`${s.consecutiveLosses} losses in a row`);
    }
  }
}
