import { DigitBot, type BotSettings, type ContractTally, type ContractType } from "./bot";
import { DemoMarket, type Regime } from "./market";

export interface BacktestResult {
  regime: Regime;
  ticks: number;
  trades: number;
  winRate: number;
  pnl: number;
  maxDrawdown: number;
  equity: number[];
  byContract: Partial<Record<ContractType, ContractTally>>;
}

/** Runs the bot non-stop (session stops off) so the long-run behaviour shows. */
export function runBacktest(
  regime: Regime,
  settings: BotSettings,
  ticks: number,
  seed: number,
): BacktestResult {
  const market = new DemoMarket(regime, seed, settings.mode);
  const bot = new DigitBot({ ...settings, takeProfit: 0, stopLoss: 0, maxConsecutiveLosses: 0 });
  bot.start();
  for (let i = 0; i < ticks; i++) bot.onTick(market.next(), false);

  const s = bot.state;
  return {
    regime,
    ticks,
    trades: s.trades,
    winRate: s.trades ? (s.wins / s.trades) * 100 : 0,
    pnl: s.pnl,
    maxDrawdown: s.maxDrawdown,
    equity: s.equity,
    byContract: s.byContract,
  };
}
