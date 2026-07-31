/**
 * Tests the single decision the analyzer actually makes: bet Differs on the
 * coldest digit of the trailing window.
 *
 * If digits are IID uniform that should win exactly 90%, the same as betting
 * on any fixed digit. Anything below means the pick is worse than choosing at
 * random, which would make the analyzer actively harmful rather than merely
 * useless. Read-only: fetches history, places no orders.
 *
 *   npm run check-coldpick
 */
import { DerivClient } from "../src/lib/deriv/client";
import { resolveAccount } from "../src/lib/deriv/rest";
import { lastDigit, type HistoryResponse } from "../src/lib/deriv/types";

const APP_ID = process.env.VITE_DERIV_APP_ID?.trim() ?? "";
const TOKEN = process.env.VITE_DERIV_TOKEN_DEMO?.trim() ?? "";
const REST_URL = (process.env.VITE_DERIV_REST_URL ?? "https://api.derivws.com").replace(/\/$/, "");

const SYMBOLS = [
  "R_10",
  "R_25",
  "R_50",
  "R_75",
  "R_100",
  "1HZ10V",
  "1HZ25V",
  "1HZ50V",
  "1HZ75V",
  "1HZ100V",
];
const TARGET = 40000;
const PAGE = 1000;
const WINDOWS = [100, 250, 500, 1000, 2000];

async function fetchDigits(client: DerivClient, symbol: string): Promise<number[]> {
  const prices: number[] = [];
  let pipSize = 2;
  let end: number | "latest" = "latest";
  while (prices.length < TARGET) {
    const message = await client.send<HistoryResponse>({
      ticks_history: symbol,
      adjust_start_time: 1,
      count: PAGE,
      end,
      style: "ticks",
    });
    const times = message.history?.times ?? [];
    if (times.length === 0) break;
    pipSize = message.pip_size ?? pipSize;
    prices.unshift(...message.history.prices);
    const earliest = times[0];
    if (end !== "latest" && earliest >= end) break;
    end = earliest - 1;
  }
  return prices.map((quote) => lastDigit(quote, pipSize));
}

/** Matches summarise(): ties resolve to the highest digit holding the min. */
function coldestOf(counts: number[]): number {
  let best = 0;
  for (let d = 1; d < 10; d += 1) if (counts[d] <= counts[best]) best = d;
  return best;
}

/** Matches summarise(): ties resolve to the lowest digit holding the max. */
function hottestOf(counts: number[]): number {
  let best = 0;
  for (let d = 1; d < 10; d += 1) if (counts[d] > counts[best]) best = d;
  return best;
}

interface Result {
  hits: number;
  n: number;
}

function rate(r: Result): number {
  return r.n === 0 ? 0 : (r.hits / r.n) * 100;
}

/** Two-sided 95% CI on the appearance rate, in percent. */
function ci(r: Result): [number, number] {
  const p = r.hits / r.n;
  const se = Math.sqrt((p * (1 - p)) / r.n);
  return [(p - 1.96 * se) * 100, (p + 1.96 * se) * 100];
}

function main2(all: Map<string, number[]>) {
  console.log(
    "\nHow often the chosen digit actually shows up next (10.00% = fair)\n",
  );
  console.log(
    "  window   coldest pick        hottest pick        fixed digit 5",
  );

  for (const window of WINDOWS) {
    const cold: Result = { hits: 0, n: 0 };
    const hot: Result = { hits: 0, n: 0 };
    const fixed: Result = { hits: 0, n: 0 };

    for (const digits of all.values()) {
      const counts = new Array<number>(10).fill(0);
      for (let i = 0; i < window && i < digits.length; i += 1) counts[digits[i]] += 1;

      for (let i = window; i < digits.length; i += 1) {
        const next = digits[i];
        if (next === coldestOf(counts)) cold.hits += 1;
        cold.n += 1;
        if (next === hottestOf(counts)) hot.hits += 1;
        hot.n += 1;
        if (next === 5) fixed.hits += 1;
        fixed.n += 1;

        counts[digits[i - window]] -= 1;
        counts[next] += 1;
      }
    }

    const fmt = (r: Result) => {
      const [lo, hi] = ci(r);
      return `${rate(r).toFixed(3)}% [${lo.toFixed(2)}-${hi.toFixed(2)}]`;
    };
    console.log(
      `  ${String(window).padStart(5)}   ${fmt(cold).padEnd(21)}${fmt(hot).padEnd(21)}${fmt(fixed)}`,
    );
  }

  console.log(
    "\nDiffers win rate implied by each pick (needs 91.3% to break even)\n",
  );
  console.log("  window   coldest    hottest    fixed");
  for (const window of WINDOWS) {
    const cold: Result = { hits: 0, n: 0 };
    const hot: Result = { hits: 0, n: 0 };
    const fixed: Result = { hits: 0, n: 0 };
    for (const digits of all.values()) {
      const counts = new Array<number>(10).fill(0);
      for (let i = 0; i < window && i < digits.length; i += 1) counts[digits[i]] += 1;
      for (let i = window; i < digits.length; i += 1) {
        const next = digits[i];
        if (next !== coldestOf(counts)) cold.hits += 1;
        cold.n += 1;
        if (next !== hottestOf(counts)) hot.hits += 1;
        hot.n += 1;
        if (next !== 5) fixed.hits += 1;
        fixed.n += 1;
        counts[digits[i - window]] -= 1;
        counts[next] += 1;
      }
    }
    console.log(
      `  ${String(window).padStart(5)}   ${rate(cold).toFixed(3)}%   ${rate(hot).toFixed(
        3,
      )}%   ${rate(fixed).toFixed(3)}%`,
    );
  }
}

async function main() {
  const account = await resolveAccount(
    { appId: APP_ID, restUrl: REST_URL, token: TOKEN },
    "demo",
    process.env.VITE_DERIV_DEMO_ACCOUNT_ID?.trim() || undefined,
  );
  const client = new DerivClient({
    appId: APP_ID,
    restUrl: REST_URL,
    token: TOKEN,
    accountId: account.accountId,
  });
  await new Promise<void>((resolve) => {
    const off = client.onStateChange((state) => {
      if (state === "ready") {
        off();
        resolve();
      }
    });
    client.connect();
  });

  console.log(`Fetching ${TARGET} ticks per symbol…`);
  const all = new Map<string, number[]>();
  for (const symbol of SYMBOLS) {
    all.set(symbol, await fetchDigits(client, symbol));
    process.stdout.write(`\r  ${symbol}            `);
  }
  const total = [...all.values()].reduce((s, d) => s + d.length, 0);
  console.log(`\n\nPooled ${total.toLocaleString()} ticks.`);

  main2(all);

  client.disconnect();
  process.exit(0);
}

main().catch((error: Error) => {
  console.error(`FATAL: ${error.message}`);
  process.exit(1);
});
