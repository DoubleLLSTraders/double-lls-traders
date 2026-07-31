/**
 * Downloads tick history from Deriv into data/<symbol>.json so backtests run
 * offline and repeatedly over the same series.
 *
 *   npm run fetch-ticks -- --symbol R_100 --count 50000
 */
import { mkdir, writeFile } from "node:fs/promises";
import { lastDigit } from "../src/lib/deriv/types";

const MAX_PER_REQUEST = 5000;

interface Args {
  symbol: string;
  count: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const read = (flag: string, fallback: string): string => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  return {
    symbol: read("--symbol", process.env.VITE_DEFAULT_SYMBOL ?? "R_100"),
    count: Number(read("--count", "50000")),
  };
}

interface HistoryMessage {
  msg_type?: string;
  req_id?: number;
  error?: { code: string; message: string };
  pip_size?: number;
  history?: { prices: number[]; times: number[] };
}

function connect(appId: string): Promise<WebSocket> {
  const url = `wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(appId)}`;
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("Could not reach Deriv.")), {
      once: true,
    });
  });
}

function request(socket: WebSocket, payload: Record<string, unknown>): Promise<HistoryMessage> {
  const reqId = Math.floor(Math.random() * 1_000_000);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("Deriv did not respond within 20s."));
    }, 20_000);

    function onMessage(event: MessageEvent) {
      const message = JSON.parse(event.data as string) as HistoryMessage;
      if (message.req_id !== reqId) return;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      if (message.error) reject(new Error(`${message.error.code}: ${message.error.message}`));
      else resolve(message);
    }

    socket.addEventListener("message", onMessage);
    socket.send(JSON.stringify({ ...payload, req_id: reqId }));
  });
}

async function main() {
  const { symbol, count } = parseArgs();
  const appId = process.env.VITE_DERIV_APP_ID?.trim();
  if (!appId) {
    console.error("VITE_DERIV_APP_ID is not set. Fill it into .env first.");
    process.exit(1);
  }

  console.log(`Fetching ${count} ticks of ${symbol}…`);
  const socket = await connect(appId);

  const times: number[] = [];
  const prices: number[] = [];
  let pipSize = 2;
  let end: number | "latest" = "latest";

  while (times.length < count) {
    const batchSize = Math.min(MAX_PER_REQUEST, count - times.length);
    const message = await request(socket, {
      ticks_history: symbol,
      adjust_start_time: 1,
      count: batchSize,
      end,
      style: "ticks",
    });

    if (!message.history || message.history.times.length === 0) break;
    pipSize = message.pip_size ?? pipSize;

    // Batches arrive newest-last and we page backwards, so prepend.
    times.unshift(...message.history.times);
    prices.unshift(...message.history.prices);

    const earliest = message.history.times[0];
    if (end !== "latest" && earliest >= end) break;
    end = earliest - 1;

    process.stdout.write(`\r  ${times.length} ticks`);
  }

  socket.close();
  console.log("");

  const digits = prices.map((quote) => lastDigit(quote, pipSize));
  await mkdir("data", { recursive: true });

  const file = `data/${symbol}.json`;
  await writeFile(
    file,
    JSON.stringify({
      symbol,
      pipSize,
      fetchedAt: new Date().toISOString(),
      from: times[0],
      to: times[times.length - 1],
      digits,
    }),
  );

  const span = (times[times.length - 1] - times[0]) / 3600;
  console.log(`Saved ${digits.length} ticks to ${file} (${span.toFixed(1)} hours of history).`);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
