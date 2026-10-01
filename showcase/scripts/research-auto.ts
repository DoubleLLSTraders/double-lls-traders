/**
 * Auto market switching and stake stacking on real Deriv digits (showcase/data/real-ticks.json).
 * The ten indices are interleaved in real time: 1s indices tick every second, the others every two seconds.
 * Long run: $1,000, $1 stake, session limits off. Sessions: +$10 take profit / −$50 stop loss, back to back.
 */
import { readFile } from "node:fs/promises";
import { DEFAULT_SETTINGS, DigitBot, type BotSettings } from "../src/bot";
import type { Tick } from "../src/market";

const { symbols } = JSON.parse(await readFile("showcase/data/real-ticks.json", "utf8")) as { symbols: Record<string, number[]> };

function interleave(part: (d: number[]) => number[]): Tick[] {
  const streams = Object.entries(symbols).map(([sym, d]) => ({ sym, d: part(d), i: 0, every: sym.startsWith("1HZ") ? 1 : 2 }));
  const out: Tick[] = [];
  for (let sec = 0; streams.some((s) => s.i < s.d.length); sec++) {
    for (const s of streams) {
      if (sec % s.every !== 0 || s.i >= s.d.length) continue;
      out.push({ epoch: out.length, quote: 0, digit: s.d[s.i++], market: s.sym });
    }
    if (sec > 400_000) break;
  }
  return out;
}

const halves = [0, 1].map((h) => interleave((d) => (h === 0 ? d.slice(0, d.length >> 1) : d.slice(d.length >> 1))));
const seconds = (ticks: Tick[]) => {
  const per = new Map<string, number>();
  for (const t of ticks) per.set(t.market!, (per.get(t.market!) ?? 0) + 1);
  return Math.max(...[...per].map(([s, n]) => n * (s.startsWith("1HZ") ? 1 : 2)));
};

const base: BotSettings = { ...DEFAULT_SETTINGS, stake: 1, startBalance: 1000 };
const TURBO: [string, Partial<BotSettings>, boolean][] = [
  ["Auto market (current)", {}, true],
  ["Turbo, auto contracts, recovery", { turbo: true }, true],
  ["Turbo, auto contracts, no recovery", { turbo: true, martingale: false }, true],
  ["Turbo, Differs only, no recovery", { turbo: true, martingale: false, mode: "differs" }, true],
  ["Turbo, Even/Odd only, no recovery", { turbo: true, martingale: false, mode: "evenodd" }, true],
];
const VARIANTS: [string, Partial<BotSettings>, boolean][] = process.argv[2] === "turbo" ? TURBO : [
  ["One index at a time (old)", { stackStakes: false }, false],
  ["Auto market, no stacking", { stackStakes: false }, true],
  ["Auto market, stack up to 2", { stackStakes: true, maxStack: 2 }, true],
  ["Auto market, stack up to 3", { stackStakes: true, maxStack: 3 }, true],
  ["Auto market, stack up to 5", { stackStakes: true, maxStack: 5 }, true],
  ["Auto, stack 3, no recovery", { stackStakes: true, maxStack: 3, martingale: false }, true],
];

function run(ticks: Tick[], s: BotSettings, auto: boolean, limits: boolean) {
  const cfg = limits ? { ...s, takeProfit: 10, stopLoss: 50, maxConsecutiveLosses: 0 } : { ...s, takeProfit: 0, stopLoss: 0, maxConsecutiveLosses: 0 };
  const bots = auto ? null : new Map<string, DigitBot>();
  const one = new DigitBot(cfg);
  one.start();
  let tp = 0, sl = 0, sp = 0, stacked = 0;
  const all = () => (bots ? [...bots.values()] : [one]);
  for (const t of ticks) {
    let bot = one;
    if (bots) {
      bot = bots.get(t.market!) ?? new DigitBot(cfg);
      if (!bots.has(t.market!)) { bots.set(t.market!, bot); bot.start(); }
    }
    const before = bot.state.trades;
    bot.onTick(t, true);
    if (bot.state.open && bot.state.open.epoch === t.epoch && bot.state.open.units > 1) stacked++;
    void before;
    if (limits && !bot.state.running) {
      if (bot.state.stopReason === "Take profit reached") tp++; else sl++;
      sp += bot.state.pnl;
      bot.resetSession();
      bot.start();
    }
  }
  const st = all().map((b) => b.state);
  return {
    trades: st.reduce((a, x) => a + x.trades, 0),
    wins: st.reduce((a, x) => a + x.wins, 0),
    staked: st.reduce((a, x) => a + x.totalStaked, 0),
    pnl: st.reduce((a, x) => a + x.pnl, 0),
    dd: Math.max(...st.map((x) => x.maxDrawdown)),
    tp, sl, sp, stacked,
  };
}

console.log(`halves: ${halves.map((h) => `${h.length} ticks / ${(seconds(h) / 3600).toFixed(1)} h`).join(", ")}`);
console.log("variant                         half  trades  /min   win%   ROI%     P/L   worstDD  stacked  sessions TP/SL  session P/L");
for (const [name, patch, auto] of VARIANTS) {
  const s = { ...base, ...patch };
  halves.forEach((ticks, h) => {
    const r = run(ticks, s, auto, false);
    const q = run(ticks, s, auto, true);
    const mins = seconds(ticks) / 60;
    console.log(
      `${name.padEnd(31)} ${h ? "2nd" : "1st"}  ${String(r.trades).padStart(6)}  ${(r.trades / mins).toFixed(2).padStart(4)}  ${((r.wins / Math.max(1, r.trades)) * 100).toFixed(1).padStart(5)}  ${((r.pnl / Math.max(1, r.staked)) * 100).toFixed(2).padStart(5)}  ${r.pnl.toFixed(0).padStart(6)}  ${r.dd.toFixed(0).padStart(7)}  ${String(r.stacked).padStart(7)}   ${String(q.tp).padStart(5)}/${String(q.sl).padEnd(5)}  ${q.sp.toFixed(0).padStart(7)}`,
    );
  });
}
