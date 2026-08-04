/**
 * Does the Over/Under analyzer's momentum read predict the next tick?
 *
 * Two questions, both answered on real Deriv history, read-only:
 *
 *   1. Baseline — over the whole tape, does any barrier's win rate beat the
 *      payout break-even? (If not, no entry filter can be profitable, because
 *      a filter only reshuffles which ticks you bet on.)
 *   2. Conditional — restrict to the ticks where the old Blitz momentum
 *      conditions fired (micro edge, win streak, fresh gap) and measure the
 *      win rate on the NEXT tick, which is what the contract actually settles
 *      on. If momentum carries information this must beat the baseline.
 *
 *   npm run check-overunder
 */
import { DerivClient } from "../src/lib/deriv/client";
import { resolveAccount } from "../src/lib/deriv/rest";
import { lastDigit, type HistoryResponse } from "../src/lib/deriv/types";
import { overUnderPayoutMultiplier } from "../src/lib/bot/performance";
import { judgeEvidence } from "../src/lib/analysis/evidence";
import {
  OU_BLITZ_MICRO,
  OU_BLITZ_SHORT,
  fairWinProb,
  outcomeWon,
  type OverUnderSide,
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

const BARRIERS: Array<{ side: OverUnderSide; barrier: number }> = [
  { side: "DIGITOVER", barrier: 0 },
  { side: "DIGITOVER", barrier: 1 },
  { side: "DIGITOVER", barrier: 2 },
  { side: "DIGITOVER", barrier: 3 },
  { side: "DIGITUNDER", barrier: 6 },
  { side: "DIGITUNDER", barrier: 7 },
  { side: "DIGITUNDER", barrier: 8 },
  { side: "DIGITUNDER", barrier: 9 },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchDigits(client: DerivClient, symbol: string): Promise<number[]> {
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

function winRate(digits: number[], side: OverUnderSide, barrier: number) {
  let wins = 0;
  for (const d of digits) if (outcomeWon(side, barrier, d)) wins += 1;
  return { wins, n: digits.length };
}

/** The old Blitz entry read, evaluated at index i using only past ticks. */
function momentumFires(
  digits: number[],
  i: number,
  side: OverUnderSide,
  barrier: number,
): boolean {
  if (i < OU_BLITZ_SHORT) return false;
  const micro = digits.slice(i - OU_BLITZ_MICRO, i);
  const short = digits.slice(i - OU_BLITZ_SHORT, i);
  const fairPct = fairWinProb(side, barrier) * 100;

  const microWins = micro.filter((d) => outcomeWon(side, barrier, d)).length;
  const shortWins = short.filter((d) => outcomeWon(side, barrier, d)).length;
  const microEdge = (microWins / micro.length) * 100 - fairPct;
  const shortEdge = (shortWins / short.length) * 100 - fairPct;

  let streak = 0;
  for (let k = i - 1; k >= 0; k -= 1) {
    if (!outcomeWon(side, barrier, digits[k])) break;
    streak += 1;
  }
  const gapFresh = outcomeWon(side, barrier, digits[i - 1]);

  // Same shape as the shipped gate: micro beats fair, short confirms,
  // a live win streak, and a fresh win on the previous tick.
  return microEdge >= 2 && shortEdge >= 1 && streak >= 2 && gapFresh;
}

function pct(x: number): string {
  return `${x.toFixed(2)}%`;
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

  const tape: Record<string, number[]> = {};
  for (const symbol of SYMBOLS) {
    process.stdout.write(`Fetching ${symbol}… `);
    tape[symbol] = await fetchDigits(client, symbol);
    console.log(`${tape[symbol].length} ticks`);
    await sleep(PAUSE_MS);
  }
  client.disconnect();

  const all = Object.values(tape).flat();
  console.log(`\nPooled tape: ${all.length} ticks\n`);

  console.log("BASELINE — whole tape vs payout break-even");
  console.log(
    "side   bar  payout   fair    observed   need     edge      proven?",
  );
  for (const { side, barrier } of BARRIERS) {
    const { wins, n } = winRate(all, side, barrier);
    const payout = overUnderPayoutMultiplier(side, barrier);
    const need = 100 / payout;
    const obs = (wins / n) * 100;
    const v = judgeEvidence({ wins, n, breakEvenPercent: need });
    console.log(
      `${side === "DIGITOVER" ? "OVER " : "UNDER"}  ${barrier}    x${payout.toFixed(2)}   ` +
        `${pct(fairWinProb(side, barrier) * 100).padStart(7)}  ${pct(obs).padStart(8)}  ` +
        `${pct(need).padStart(7)}  ${(obs - need >= 0 ? "+" : "") + (obs - need).toFixed(2)}pp`.padStart(
          10,
        ) +
        `   ${v.ok ? "YES" : "no"}`,
    );
  }

  console.log("\nCONDITIONAL — next tick after the momentum read fires");
  console.log(
    "side   bar  entries   next-tick win   baseline    need      lift",
  );
  let totalEntries = 0;
  let totalPnl = 0;
  for (const { side, barrier } of BARRIERS) {
    const payout = overUnderPayoutMultiplier(side, barrier);
    const need = 100 / payout;
    let entries = 0;
    let wins = 0;
    for (const digits of Object.values(tape)) {
      for (let i = OU_BLITZ_SHORT; i < digits.length; i += 1) {
        if (!momentumFires(digits, i, side, barrier)) continue;
        entries += 1;
        if (outcomeWon(side, barrier, digits[i])) wins += 1;
      }
    }
    const base = winRate(all, side, barrier);
    const basePct = (base.wins / base.n) * 100;
    const condPct = entries > 0 ? (wins / entries) * 100 : 0;
    const pnl = entries > 0 ? wins * (payout - 1) - (entries - wins) : 0;
    totalEntries += entries;
    totalPnl += pnl;
    console.log(
      `${side === "DIGITOVER" ? "OVER " : "UNDER"}  ${barrier}    ${String(entries).padStart(6)}   ` +
        `${pct(condPct).padStart(12)}   ${pct(basePct).padStart(8)}   ${pct(need).padStart(7)}   ` +
        `${(condPct - basePct >= 0 ? "+" : "") + (condPct - basePct).toFixed(2)}pp`,
    );
  }

  console.log(
    `\nAll momentum entries: ${totalEntries} · P&L ${totalPnl.toFixed(1)} units ` +
      `(${((totalPnl / Math.max(1, totalEntries)) * 100).toFixed(2)}% per trade)`,
  );
}

main().catch((error) => {
  console.error(`FATAL: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
