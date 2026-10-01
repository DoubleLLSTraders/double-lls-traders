import { DigitBot, type BotSettings } from "./bot";
import { DemoMarket } from "./market";

export const SURVIVAL_SESSIONS = 100;
export const SURVIVAL_TICKS = 5000;
const SESSIONS_PER_CHUNK = 2;

export interface SurvivalReport {
  sessions: number;
  ticksPerSession: number;
  /** Share of sessions, in %, by how they ended. */
  takeProfit: number;
  stopLoss: number;
  /** Lost the whole balance, or too little left to place a stake. */
  blownUp: number;
  /** Still trading when the tick budget ran out. */
  unfinished: number;
  profitable: number;
  medianPnl: number;
  /** 5th and 95th percentile session P/L. */
  worstPnl: number;
  bestPnl: number;
  averagePnl: number;
  averageTrades: number;
  worstDrawdown: number;
  startBalance: number;
}

const percentile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];

/**
 * Plays many independent sessions with the user's settings on a market whose last digits are
 * uniformly random, like Deriv's real volatility indices, and reports how they ended.
 */
export async function runSurvival(
  settings: BotSettings,
  onProgress: (done: number) => void,
  signal: { cancelled: boolean },
  sessions = SURVIVAL_SESSIONS,
  ticks = SURVIVAL_TICKS,
): Promise<SurvivalReport | null> {
  const seed = Date.now();
  const pnls: number[] = [];
  let tp = 0;
  let sl = 0;
  let blown = 0;
  let unfinished = 0;
  let trades = 0;
  let worstDrawdown = 0;

  for (let i = 0; i < sessions; i++) {
    if (signal.cancelled) return null;
    const market = new DemoMarket("fair", seed + i * 7919, settings.mode);
    const bot = new DigitBot(settings);
    for (let t = 0; t < settings.window; t++) bot.onTick(market.next(), false);
    bot.start();
    for (let t = 0; t < ticks && bot.state.running; t++) bot.onTick(market.next(), false);
    const s = bot.state;
    const reason = s.stopReason ?? "";
    if (reason.startsWith("Take profit")) tp++;
    else if (reason.startsWith("Stop loss")) sl++;
    else if (reason.startsWith("Balance too low") || s.balance <= 0) blown++;
    else if (s.running) unfinished++;
    pnls.push(s.pnl);
    trades += s.trades;
    worstDrawdown = Math.max(worstDrawdown, s.maxDrawdown);
    if ((i + 1) % SESSIONS_PER_CHUNK === 0) {
      onProgress(i + 1);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const sorted = [...pnls].sort((a, b) => a - b);
  const share = (n: number) => (n / sessions) * 100;
  return {
    sessions,
    ticksPerSession: ticks,
    takeProfit: share(tp),
    stopLoss: share(sl),
    blownUp: share(blown),
    unfinished: share(unfinished),
    profitable: share(pnls.filter((p) => p > 0).length),
    medianPnl: percentile(sorted, 0.5),
    worstPnl: percentile(sorted, 0.05),
    bestPnl: percentile(sorted, 0.95),
    averagePnl: pnls.reduce((a, b) => a + b, 0) / sessions,
    averageTrades: trades / sessions,
    worstDrawdown,
    startBalance: settings.startBalance,
  };
}
