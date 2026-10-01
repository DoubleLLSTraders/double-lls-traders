/**
 * Downloads real Deriv tick history for the research scripts into showcase/data/real-ticks.json.
 * Usage: npx tsx showcase/scripts/fetch-real.ts [ticksPerSymbol]
 */
import { mkdir, writeFile } from "node:fs/promises";

const SYMBOLS = ["R_10", "R_25", "R_50", "R_75", "R_100", "1HZ10V", "1HZ25V", "1HZ50V", "1HZ75V", "1HZ100V"];
const TARGET = Number(process.argv[2] ?? 60_000);
const URL = "wss://api.derivws.com/trading/v1/options/ws/public";

function request<T>(ws: WebSocket, payload: object): Promise<T> {
  return new Promise((resolve, reject) => {
    const req_id = Math.floor(Math.random() * 1e9);
    const timer = setTimeout(() => reject(new Error("timeout")), 30_000);
    const onMsg = (e: MessageEvent) => {
      const data = JSON.parse(String(e.data));
      if (data.req_id !== req_id) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
      data.error ? reject(new Error(data.error.message)) : resolve(data as T);
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ ...payload, req_id }));
  });
}

async function fetchDigits(ws: WebSocket, symbol: string): Promise<number[]> {
  const digits: number[] = [];
  let end: number | "latest" = "latest";
  while (digits.length < TARGET) {
    const res = await request<{ history: { prices: number[]; times: number[] }; pip_size: number }>(ws, {
      ticks_history: symbol, end, count: 5000, style: "ticks",
    });
    const { prices, times } = res.history;
    if (!prices.length || (end !== "latest" && times[0] >= end)) break;
    digits.unshift(...prices.map((q) => { const s = q.toFixed(res.pip_size); return Number(s[s.length - 1]); }));
    end = times[0] - 1;
    process.stdout.write(`\r${symbol} ${digits.length}   `);
  }
  return digits.slice(-TARGET);
}

const ws = new WebSocket(URL);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
const out: Record<string, number[]> = {};
for (const s of SYMBOLS) out[s] = await fetchDigits(ws, s);
ws.close();
await mkdir("showcase/data", { recursive: true });
await writeFile("showcase/data/real-ticks.json", JSON.stringify({ fetchedAt: new Date().toISOString(), symbols: out }));
console.log("\nsaved showcase/data/real-ticks.json");
