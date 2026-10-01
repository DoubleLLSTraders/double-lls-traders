/**
 * Runs the showcase engine over real Deriv tick history (public API, no login).
 * Usage: npx tsx showcase/scripts/real-market-test.ts [ticksPerSymbol]
 */
import { DEFAULT_SETTINGS, DigitBot, type BotSettings } from "../src/bot";
import type { Tick } from "../src/market";

const SYMBOLS = ["R_10", "R_25", "R_50", "R_75", "R_100", "1HZ10V", "1HZ25V", "1HZ50V", "1HZ75V", "1HZ100V"];
const TARGET = Number(process.argv[2] ?? 30_000);
const PAGE = 5000;
const URL = "wss://api.derivws.com/trading/v1/options/ws/public";

function request<T>(ws: WebSocket, payload: object): Promise<T> {
  return new Promise((resolve, reject) => {
    const req_id = Math.floor(Math.random() * 1e9);
    const onMsg = (e: MessageEvent) => {
      const data = JSON.parse(String(e.data));
      if (data.req_id !== req_id) return;
      ws.removeEventListener("message", onMsg);
      data.error ? reject(new Error(data.error.message)) : resolve(data as T);
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ ...payload, req_id }));
  });
}

async function fetchTicks(ws: WebSocket, symbol: string): Promise<Tick[]> {
  const out: Tick[] = [];
  let end: number | "latest" = "latest";
  while (out.length < TARGET) {
    const res = await request<{ history: { prices: number[]; times: number[] }; pip_size: number }>(ws, {
      ticks_history: symbol, end, count: PAGE, style: "ticks",
    });
    const { prices, times } = res.history;
    if (!prices.length) break;
    const pip = res.pip_size;
    const page = prices.map((q, i) => {
      const s = q.toFixed(pip);
      return { epoch: times[i], quote: q, digit: Number(s[s.length - 1]) };
    });
    out.unshift(...page);
    if (end !== "latest" && times[0] >= end) break;
    end = times[0] - 1;
  }
  return out.slice(-TARGET);
}

function run(ticks: Tick[], settings: BotSettings) {
  const bot = new DigitBot({ ...settings, takeProfit: 0, stopLoss: 0, maxConsecutiveLosses: 0 });
  bot.start();
  for (const t of ticks) bot.onTick(t, true);
  const s = bot.state;
  return { trades: s.trades, winRate: s.trades ? (s.wins / s.trades) * 100 : 0, pnl: s.pnl, staked: s.totalStaked, dd: s.maxDrawdown, bal: s.balance, largest: s.largestStake };
}

function chiSquare(ticks: Tick[]) {
  const c = new Array(10).fill(0);
  for (const t of ticks) c[t.digit]++;
  const e = ticks.length / 10;
  return { chi: c.reduce((a, x) => a + (x - e) ** 2 / e, 0), pct: c.map((x) => ((x / ticks.length) * 100).toFixed(2)) };
}

const ws = new WebSocket(URL);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

const configs: [string, BotSettings][] = [
  ["Defaults (auto recovery)", { ...DEFAULT_SETTINGS, stake: 1 }],
  ["Flat $1, no recovery", { ...DEFAULT_SETTINGS, stake: 1, martingale: false }],
];
const totals = configs.map(() => ({ trades: 0, pnl: 0, staked: 0, wins: 0 }));

for (const sym of SYMBOLS) {
  const ticks = await fetchTicks(ws, sym);
  const { chi, pct } = chiSquare(ticks);
  console.log(`\n${sym}  ${ticks.length} ticks  chi²=${chi.toFixed(1)} (9 df, >16.9 = biased at 95%)  digits% ${pct.join(" ")}`);
  configs.forEach(([name, cfg], i) => {
    const r = run(ticks, cfg);
    totals[i].trades += r.trades;
    totals[i].pnl += r.pnl;
    totals[i].staked += r.staked;
    totals[i].wins += (r.winRate / 100) * r.trades;
    console.log(
      `  ${name.padEnd(26)} trades=${String(r.trades).padStart(5)} win=${r.winRate.toFixed(1).padStart(5)}%  P/L=${r.pnl.toFixed(2).padStart(9)}  staked=${r.staked.toFixed(0).padStart(7)}  ROI=${(r.staked ? (r.pnl / r.staked) * 100 : 0).toFixed(2).padStart(6)}%  maxDD=${r.dd.toFixed(2)}  largest=${r.largest.toFixed(2)}`,
    );
  });
}

console.log("\nTOTAL across all symbols ($10,000 start each, $1 base stake)");
configs.forEach(([name], i) => {
  const t = totals[i];
  console.log(`  ${name.padEnd(26)} trades=${t.trades}  win=${((t.wins / Math.max(1, t.trades)) * 100).toFixed(1)}%  P/L=${t.pnl.toFixed(2)}  staked=${t.staked.toFixed(0)}  ROI=${((t.pnl / Math.max(1, t.staked)) * 100).toFixed(2)}%`);
});
ws.close();
