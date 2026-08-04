/**
 * Does the new plan gate actually keep money?
 *
 * Replays the exact desk logic on real Deriv history: rank barriers by
 * observed rate minus payout break-even minus noise, commit only when the
 * net edge clears the floor, fire on a fresh win, drop the plan when the
 * edge fades. Reports trades, win rate and P&L per 1.00 stake.
 *
 *   npm run check-plan-gate
 */
import { DerivClient } from "../src/lib/deriv/client";
import { resolveAccount } from "../src/lib/deriv/rest";
import { lastDigit, type HistoryResponse } from "../src/lib/deriv/types";
import {
  barrierEdge,
  outcomeWon,
  pickWinPlan,
} from "../src/lib/analysis/overUnder";

const APP_ID = process.env.VITE_DERIV_APP_ID?.trim() ?? "";
const TOKEN = process.env.VITE_DERIV_TOKEN_DEMO?.trim() ?? "";
const REST_URL = (
  process.env.VITE_DERIV_REST_URL ?? "https://api.derivws.com"
).replace(/\/$/, "");
const SYMBOLS = ["R_10", "R_25", "R_75", "1HZ50V"];
const TARGET = 20000;
const PAGE = 1000;
const PAUSE_MS = 1500;

/** Desk settings mirrored from App.tsx. */
const MIN_NET = 0.25;
const STUDY_TICKS = 8;
/** 45s plan ≈ 45 ticks on a 1s index. */
const PLAN_TICKS = 45;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchDigits(
  client: DerivClient,
  symbol: string,
): Promise<number[]> {
  const prices: number[] = [];
  let pipSize = 2;
  let end: number | "latest" = "latest";

  while (prices.length < TARGET) {
    const message: HistoryResponse = await client.send<HistoryResponse>({
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
    await sleep(PAUSE_MS);
  }

  return prices.map((quote) => lastDigit(quote, pipSize));
}

interface Result {
  trades: number;
  wins: number;
  pnl: number;
  commits: number;
  barrierUse: Record<string, number>;
}

function replay(digits: number[]): Result {
  const res: Result = {
    trades: 0,
    wins: 0,
    pnl: 0,
    commits: 0,
    barrierUse: {},
  };
  let studyKey: string | null = null;
  let studyCount = 0;
  let plan:
    | { side: "DIGITOVER" | "DIGITUNDER"; barrier: number; left: number }
    | null = null;

  // Start once a full deep window exists; every read uses past ticks only.
  for (let i = 560; i < digits.length - 1; i += 1) {
    const past = digits.slice(0, i);

    if (plan) {
      const live = barrierEdge(past, plan.side, plan.barrier);
      if (!live || live.netEdge < MIN_NET || plan.left <= 0) {
        plan = null;
      } else {
        plan.left -= 1;
        // Fire on a fresh win; the contract settles on the next tick.
        if (outcomeWon(plan.side, plan.barrier, digits[i - 1])) {
          const won = outcomeWon(plan.side, plan.barrier, digits[i]);
          res.trades += 1;
          const key = `${plan.side === "DIGITOVER" ? "Over" : "Under"} ${plan.barrier}`;
          res.barrierUse[key] = (res.barrierUse[key] ?? 0) + 1;
          if (won) {
            res.wins += 1;
            res.pnl += live.payout - 1;
          } else {
            res.pnl -= 1;
          }
          // Fire cool-down: skip the settled tick plus a breather.
          i += 2;
        }
        continue;
      }
    }

    const best = pickWinPlan(past);
    if (!best || best.netEdge < MIN_NET) {
      studyKey = null;
      studyCount = 0;
      continue;
    }
    const key = `${best.side}${best.barrier}`;
    if (key === studyKey) studyCount += 1;
    else {
      studyKey = key;
      studyCount = 1;
    }
    if (studyCount >= STUDY_TICKS) {
      plan = { side: best.side, barrier: best.barrier, left: PLAN_TICKS };
      res.commits += 1;
      studyKey = null;
      studyCount = 0;
    }
  }
  return res;
}

async function main() {
  if (!APP_ID) throw new Error("VITE_DERIV_APP_ID missing");
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

  const totals: Result = {
    trades: 0,
    wins: 0,
    pnl: 0,
    commits: 0,
    barrierUse: {},
  };

  for (const symbol of SYMBOLS) {
    process.stdout.write(`Fetching ${symbol}… `);
    const digits = await fetchDigits(client, symbol);
    console.log(`${digits.length} ticks`);
    const res = replay(digits);
    totals.trades += res.trades;
    totals.wins += res.wins;
    totals.pnl += res.pnl;
    totals.commits += res.commits;
    for (const [k, v] of Object.entries(res.barrierUse)) {
      totals.barrierUse[k] = (totals.barrierUse[k] ?? 0) + v;
    }
    const rate = res.trades ? ((res.wins / res.trades) * 100).toFixed(1) : "—";
    console.log(
      `  plans ${res.commits} · trades ${res.trades} · win ${rate}% · pnl ${res.pnl >= 0 ? "+" : ""}${res.pnl.toFixed(2)}`,
    );
    await sleep(PAUSE_MS);
  }
  client.disconnect();

  const rate = totals.trades
    ? ((totals.wins / totals.trades) * 100).toFixed(2)
    : "—";
  const per = totals.trades ? (totals.pnl / totals.trades).toFixed(4) : "—";
  console.log(`\nTOTAL plans committed ${totals.commits}`);
  console.log(`TOTAL trades ${totals.trades} · win ${rate}%`);
  console.log(`TOTAL pnl ${totals.pnl >= 0 ? "+" : ""}${totals.pnl.toFixed(2)} per 1.00 stake`);
  console.log(`PER TRADE ${per} (0 = break even, -0.02 = house edge)`);
  console.log("\nBarriers actually used:");
  for (const [k, v] of Object.entries(totals.barrierUse).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`  ${k.padEnd(9)} ${v}`);
  }
}

void main();
