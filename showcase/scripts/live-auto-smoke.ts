/** Connects to Deriv's public feed for every volatility index and runs the auto-market bot on live ticks (seconds = argv[2], default 20; argv[3] "turbo"). */
import { DEFAULT_SETTINGS, DigitBot } from "../src/bot";
import { REAL_SYMBOLS } from "../src/market";

const bot = new DigitBot({ ...DEFAULT_SETTINGS, stake: 1, startBalance: 1000, turbo: process.argv[3] === "turbo" });
const ws = new WebSocket("wss://api.derivws.com/trading/v1/options/ws/public");
const pips = new Map<string, number>();
const live = new Map<string, number>();
let seq = 0;
const digit = (q: number, pip: number) => Number(q.toFixed(pip).slice(-1));

ws.onopen = () => REAL_SYMBOLS.forEach((m) => ws.send(JSON.stringify({ ticks_history: m.id, end: "latest", count: 1000, style: "ticks" })));
ws.onmessage = (e) => {
  const msg = JSON.parse(String(e.data));
  if (msg.error) return console.log("error", msg.error.message);
  if (msg.msg_type === "history") {
    const sym = msg.echo_req.ticks_history as string;
    pips.set(sym, msg.pip_size);
    (msg.history.prices as number[]).forEach((q, i, a) => bot.onTick({ epoch: seq++, quote: q, digit: digit(q, msg.pip_size), market: sym }, i === a.length - 1));
    ws.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
    if (pips.size === REAL_SYMBOLS.length) {
      console.log(`histories loaded for ${pips.size} markets, focus ${bot.focus}`);
      bot.start();
    }
  } else if (msg.msg_type === "tick") {
    const sym = msg.tick.symbol as string;
    live.set(sym, (live.get(sym) ?? 0) + 1);
    bot.onTick({ epoch: seq++, quote: msg.tick.quote, digit: digit(msg.tick.quote, pips.get(sym) ?? 2), market: sym });
  }
};

setTimeout(() => {
  const s = bot.state;
  console.log(`live ticks: ${[...live].map(([k, n]) => `${k}=${n}`).join(" ")}`);
  console.log(`trades ${s.trades}, pnl ${s.pnl}, open ${s.open ? `${s.open.market} ${s.open.label} x${s.open.units}` : "none"}, focus ${bot.focus}`);
  console.log(`markets with a qualified setup now: ${bot.marketViews.filter((v) => v.scan.best).map((v) => `${v.market}:${v.scan.best!.label}`).join(", ") || "none"}`);
  for (const t of s.journal.slice(0, 8)) console.log(`  #${t.id} ${t.market} ${t.label}${t.units ? ` x${t.units}` : ""} $${t.stake} ${t.won ? "WIN" : "LOSS"} ${t.pnl}`);
  ws.close();
  process.exit(0);
}, Number(process.argv[2] ?? 20) * 1000);
