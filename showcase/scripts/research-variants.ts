/**
 * Compares bot variants on real Deriv digits (showcase/data/real-ticks.json).
 * Long-run: session limits off. Sessions: $1,000, $1 stake, +$10 take profit / −$50 stop loss, back to back.
 * Each metric is reported for the first and second half of every symbol's history separately.
 */
import { readFile } from "node:fs/promises";
import { DEFAULT_SETTINGS, DigitBot, type BotSettings } from "../src/bot";

const { symbols } = JSON.parse(await readFile("showcase/data/real-ticks.json", "utf8")) as { symbols: Record<string, number[]> };

const base: BotSettings = { ...DEFAULT_SETTINGS, stake: 1, startBalance: 1000 };
const ROUND = process.argv[2] ?? "1";
const ROUND2: [string, Partial<BotSettings>][] = [
  ["Current defaults", {}],
  ["W300 conf 2.0", { window: 300, confirmWindow: 100, minConfidence: 2 }],
  ["W300 conf 2.5", { window: 300, confirmWindow: 100, minConfidence: 2.5 }],
  ["W500 conf 2.0", { window: 500, confirmWindow: 150, minConfidence: 2 }],
  ["W500 conf 2.5", { window: 500, confirmWindow: 150, minConfidence: 2.5 }],
  ["W300 conf 2.0 persist 3", { window: 300, confirmWindow: 100, minConfidence: 2, persistTicks: 3 }],
  ["W300 conf 2.0 no recovery", { window: 300, confirmWindow: 100, minConfidence: 2, martingale: false }],
  ["W500 conf 2.5 no recovery", { window: 500, confirmWindow: 150, minConfidence: 2.5, martingale: false }],
  ["W300 conf 2.0 manual 2 steps", { window: 300, confirmWindow: 100, minConfidence: 2, autoMartingale: false, maxMartingaleSteps: 2 }],
];
const VARIANTS: [string, Partial<BotSettings>][] = ROUND === "2" ? ROUND2 : [
  ["Current defaults", {}],
  ["No recovery", { martingale: false }],
  ["Strict stats", { strictStats: true }],
  ["Strict + persist 3", { strictStats: true, persistTicks: 3 }],
  ["Strict + persist 3 + loss cd 5", { strictStats: true, persistTicks: 3, lossCooldown: 5 }],
  ["Window 300 / confirm 100", { window: 300, confirmWindow: 100 }],
  ["Strict + window 300", { strictStats: true, window: 300, confirmWindow: 100 }],
  ["Differs only", { mode: "differs" }],
  ["Over/Under only", { mode: "overunder" }],
  ["Strict + persist 3, no recovery", { strictStats: true, persistTicks: 3, martingale: false }],
  ["Manual recovery 2 steps", { autoMartingale: false, maxMartingaleSteps: 2 }],
];

function longRun(digits: number[], s: BotSettings) {
  const bot = new DigitBot({ ...s, takeProfit: 0, stopLoss: 0, maxConsecutiveLosses: 0 });
  bot.start();
  digits.forEach((d, i) => bot.onTick({ epoch: i, quote: 0, digit: d }, true));
  return bot.state;
}

function sessions(digits: number[], s: BotSettings) {
  const bot = new DigitBot({ ...s, takeProfit: 10, stopLoss: 50, maxConsecutiveLosses: 0 });
  bot.start();
  let tp = 0, sl = 0, pnl = 0, ticks = 0;
  digits.forEach((d, i) => {
    bot.onTick({ epoch: i, quote: 0, digit: d }, true);
    if (!bot.state.running) {
      if (bot.state.stopReason === "Take profit reached") tp++;
      else sl++;
      pnl += bot.state.pnl;
      bot.resetSession();
      bot.start();
    }
    ticks++;
  });
  return { tp, sl, pnl, openPnl: bot.state.pnl };
}

const halfTicks = Object.values(symbols).reduce((a, d) => a + Math.floor(d.length / 2), 0);
console.log(`each half: ${halfTicks} ticks across ${Object.keys(symbols).length} symbols`);
console.log("variant                              half  trades   win%    ROI%    P/L     worstDD   sessions TP/SL  TP%    session P/L");
for (const [name, patch] of VARIANTS) {
  const s = { ...base, ...patch };
  for (const half of [0, 1]) {
    let trades = 0, wins = 0, staked = 0, pnl = 0, worst = 0, tp = 0, sl = 0, sp = 0;
    for (const d of Object.values(symbols)) {
      const mid = Math.floor(d.length / 2);
      const part = half === 0 ? d.slice(0, mid) : d.slice(mid);
      const r = longRun(part, s);
      trades += r.trades; wins += r.wins; staked += r.totalStaked; pnl += r.pnl; worst = Math.max(worst, r.maxDrawdown);
      const q = sessions(part, s);
      tp += q.tp; sl += q.sl; sp += q.pnl;
    }
    console.log(
      `${name.padEnd(36)} ${half === 0 ? "1st" : "2nd"}  ${String(trades).padStart(6)}  ${((wins / Math.max(1, trades)) * 100).toFixed(1).padStart(5)}  ${((pnl / Math.max(1, staked)) * 100).toFixed(2).padStart(6)}  ${pnl.toFixed(0).padStart(7)}  ${worst.toFixed(0).padStart(7)}   ${String(tp).padStart(5)}/${String(sl).padEnd(5)}   ${((tp / Math.max(1, tp + sl)) * 100).toFixed(0).padStart(3)}%  ${sp.toFixed(0).padStart(7)}`,
    );
  }
}
