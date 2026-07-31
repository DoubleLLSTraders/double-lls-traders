/**
 * Searches for any exploitable structure in the last digit, with enough
 * statistical power to tell a real edge from a lucky window.
 *
 * Every test is trained on the first 60% of history and scored on the unseen
 * last 40%, and every claim is Bonferroni-corrected for the number of things
 * tried. Read-only: fetches history, places no orders.
 *
 *   npm run find-edge
 */
import { DerivClient } from "../src/lib/deriv/client";
import { resolveAccount } from "../src/lib/deriv/rest";
import { lastDigit, type HistoryResponse } from "../src/lib/deriv/types";
import { chiSquareSurvival } from "../src/lib/analysis/digits";
import { payoutMultiplier } from "../src/lib/bot/performance";

const APP_ID = process.env.VITE_DERIV_APP_ID?.trim() ?? "";
const TOKEN = process.env.VITE_DERIV_TOKEN_DEMO?.trim() ?? "";
const REST_URL = (process.env.VITE_DERIV_REST_URL ?? "https://api.derivws.com").replace(
  /\/$/,
  "",
);

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
const TRAIN_FRACTION = 0.6;

interface Series {
  symbol: string;
  digits: number[];
  prices: number[];
  pipSize: number;
}

async function fetchSeries(client: DerivClient, symbol: string): Promise<Series> {
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
  }

  return {
    symbol,
    prices,
    pipSize,
    digits: prices.map((quote) => lastDigit(quote, pipSize)),
  };
}

function counts10(digits: number[]): number[] {
  const out = new Array<number>(10).fill(0);
  for (const d of digits) out[d] += 1;
  return out;
}

/** One-sided Wilson bounds; upper for "is it rare", lower for "is it common". */
function wilson(successes: number, n: number, z: number) {
  const p = successes / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const denom = 1 + z2 / n;
  return { lower: (centre - margin) / denom, upper: (centre + margin) / denom };
}

function chi2Uniform(counts: number[]): { stat: number; p: number } {
  const n = counts.reduce((a, b) => a + b, 0);
  const expected = n / counts.length;
  let stat = 0;
  for (const c of counts) stat += (c - expected) ** 2 / expected;
  return { stat, p: chiSquareSurvival(stat, counts.length - 1) };
}

// --- Test 1 · is any digit persistently rare on a given symbol? -------------

function staticBias(series: Series[], z: number) {
  console.log("\n1 · Stable per-symbol digit bias (train 60% → test 40%)\n");
  console.log(
    "  symbol    n_train  rarest  train%   test%    need<    verdict",
  );

  let anyEdge = false;
  for (const s of series) {
    const split = Math.floor(s.digits.length * TRAIN_FRACTION);
    const train = s.digits.slice(0, split);
    const test = s.digits.slice(split);
    if (test.length < 1000) continue;

    const trainCounts = counts10(train);
    let rarest = 0;
    for (let d = 1; d < 10; d += 1) if (trainCounts[d] < trainCounts[rarest]) rarest = d;

    const trainPct = (trainCounts[rarest] / train.length) * 100;
    const testCounts = counts10(test);
    const testPct = (testCounts[rarest] / test.length) * 100;

    const mult = payoutMultiplier("DIGITDIFF", s.symbol);
    const needBelow = (1 - 1 / mult) * 100;
    // Bonferroni over 10 symbols already folded into z by the caller.
    const bound = wilson(testCounts[rarest], test.length, z).upper * 100;
    const edge = bound < needBelow;
    if (edge) anyEdge = true;

    console.log(
      `  ${s.symbol.padEnd(9)} ${String(train.length).padStart(6)}   ${rarest}      ${trainPct
        .toFixed(2)
        .padStart(5)}   ${testPct.toFixed(2).padStart(5)}   ${needBelow.toFixed(2)}    ${
        edge ? "REAL EDGE" : `no (95% upper ${bound.toFixed(2)}%)`
      }`,
    );
  }
  if (!anyEdge) {
    console.log("\n  No symbol has a digit provably rare enough to beat the payout.");
  }
}

// --- Test 2 · does the next digit depend on the current one? ----------------

function markov(series: Series[], z: number) {
  console.log("\n2 · Serial dependence · P(next digit | current digit)\n");
  console.log("  symbol    chi2(81df)   p-value     out-of-sample win%   need%   verdict");

  for (const s of series) {
    const split = Math.floor(s.digits.length * TRAIN_FRACTION);
    const train = s.digits.slice(0, split);
    const test = s.digits.slice(split);
    if (test.length < 1000) continue;

    // 10x10 transition counts on the training half.
    const trans: number[][] = Array.from({ length: 10 }, () => new Array<number>(10).fill(0));
    for (let i = 1; i < train.length; i += 1) trans[train[i - 1]][train[i]] += 1;

    // Chi-square test of independence across the whole table.
    const rowSums = trans.map((row) => row.reduce((a, b) => a + b, 0));
    const colSums = new Array<number>(10).fill(0);
    for (const row of trans) for (let d = 0; d < 10; d += 1) colSums[d] += row[d];
    const total = rowSums.reduce((a, b) => a + b, 0);

    let stat = 0;
    for (let a = 0; a < 10; a += 1) {
      for (let b = 0; b < 10; b += 1) {
        const expected = (rowSums[a] * colSums[b]) / total;
        if (expected > 0) stat += (trans[a][b] - expected) ** 2 / expected;
      }
    }
    const p = chiSquareSurvival(stat, 81);

    // Strategy: bet Differs on the successor the training half says is rarest.
    const rarestNext = trans.map((row) => {
      let best = 0;
      for (let d = 1; d < 10; d += 1) if (row[d] < row[best]) best = d;
      return best;
    });

    let bets = 0;
    let wins = 0;
    for (let i = 1; i < test.length; i += 1) {
      const pick = rarestNext[test[i - 1]];
      bets += 1;
      if (test[i] !== pick) wins += 1;
    }
    const winPct = (wins / bets) * 100;
    const mult = payoutMultiplier("DIGITDIFF", s.symbol);
    const need = (1 / mult) * 100;
    const bound = wilson(wins, bets, z).lower * 100;

    console.log(
      `  ${s.symbol.padEnd(9)} ${stat.toFixed(1).padStart(8)}    ${p.toFixed(4)}      ${winPct
        .toFixed(2)
        .padStart(6)}             ${need.toFixed(2)}   ${
        bound > need ? "REAL EDGE" : `no (95% lower ${bound.toFixed(2)}%)`
      }`,
    );
  }
}

// --- Test 2b · the step distribution, which is where the power actually is --

/**
 * The full 10x10 table costs 81 degrees of freedom. If the price moves a small
 * number of pips per tick, the structure lives entirely in (next - current)
 * mod 10, which is a 9-degree-of-freedom test and far more sensitive.
 */
function stepDistribution(series: Series[], z: number) {
  console.log("\n2b · Step distribution · (next − current) mod 10\n");
  console.log(
    "  symbol    chi2(9df)   p-value     rarest step  out-of-sample win%  need%   verdict",
  );

  const pooledCounts = new Array<number>(10).fill(0);

  for (const s of series) {
    const split = Math.floor(s.digits.length * TRAIN_FRACTION);
    const train = s.digits.slice(0, split);
    const test = s.digits.slice(split);
    if (test.length < 1000) continue;

    const steps = new Array<number>(10).fill(0);
    for (let i = 1; i < train.length; i += 1) {
      steps[(train[i] - train[i - 1] + 10) % 10] += 1;
    }
    for (let d = 0; d < 10; d += 1) pooledCounts[d] += steps[d];

    const { stat, p } = chi2Uniform(steps);
    let rarest = 0;
    for (let d = 1; d < 10; d += 1) if (steps[d] < steps[rarest]) rarest = d;

    let bets = 0;
    let wins = 0;
    for (let i = 1; i < test.length; i += 1) {
      const pick = (test[i - 1] + rarest) % 10;
      bets += 1;
      if (test[i] !== pick) wins += 1;
    }
    const winPct = (wins / bets) * 100;
    const mult = payoutMultiplier("DIGITDIFF", s.symbol);
    const need = (1 / mult) * 100;
    const bound = wilson(wins, bets, z).lower * 100;

    console.log(
      `  ${s.symbol.padEnd(9)} ${stat.toFixed(1).padStart(7)}    ${p.toFixed(4)}      ${String(
        rarest,
      ).padStart(6)}       ${winPct.toFixed(2).padStart(6)}            ${need.toFixed(2)}   ${
        bound > need ? "REAL EDGE" : `no (95% lower ${bound.toFixed(2)}%)`
      }`,
    );
  }

  const { stat, p } = chi2Uniform(pooledCounts);
  const total = pooledCounts.reduce((a, b) => a + b, 0);
  const pct = pooledCounts.map((c) => ((c / total) * 100).toFixed(2));
  console.log(`\n  pooled steps 0-9 (%): ${pct.join(" ")}`);
  console.log(
    `  pooled chi2=${stat.toFixed(1)} p=${p.toFixed(4)} ${p < 0.005 ? "NON-UNIFORM" : "uniform"}`,
  );
}

// --- Test 3 · how far does the price actually move each tick? ---------------

function quantisation(series: Series[]) {
  console.log("\n3 · Why the last digit is hard to predict\n");
  console.log("  symbol    pip   median |move| in pips   digits of real randomness");

  for (const s of series) {
    const steps: number[] = [];
    const unit = 10 ** -s.pipSize;
    for (let i = 1; i < Math.min(s.prices.length, 20000); i += 1) {
      steps.push(Math.abs(s.prices[i] - s.prices[i - 1]) / unit);
    }
    steps.sort((a, b) => a - b);
    const median = steps[Math.floor(steps.length / 2)];
    console.log(
      `  ${s.symbol.padEnd(9)} ${String(s.pipSize).padStart(3)}   ${median
        .toFixed(0)
        .padStart(10)}              ${
        median > 100 ? "last digit fully scrambled" : "possible structure"
      }`,
    );
  }
}

// --- Test 4 · pooled power check --------------------------------------------

function powerCheck() {
  console.log("\n4 · How much data would settle this\n");
  const mult = payoutMultiplier("DIGITDIFF", "default");
  const need = 1 / mult;
  const base = 0.9;
  const lift = need - base;
  // n for a one-sided 95% test with 80% power to detect the required lift.
  const n = Math.ceil(((1.645 + 0.84) ** 2 * base * (1 - base)) / lift ** 2);
  console.log(
    `  Differs needs ${(need * 100).toFixed(2)}% vs the fair ${(base * 100).toFixed(2)}%.`,
  );
  console.log(
    `  Detecting that ${(lift * 100).toFixed(2)}pp lift with 80% power needs ~${n.toLocaleString()} settled trades.`,
  );
  console.log(
    `  At 5 contracts per basket that is ~${Math.ceil(n / 5).toLocaleString()} baskets before the result means anything.`,
  );
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

  console.log(`Fetching up to ${TARGET} ticks per symbol…`);
  const series: Series[] = [];
  for (const symbol of SYMBOLS) {
    const s = await fetchSeries(client, symbol);
    series.push(s);
    process.stdout.write(`\r  ${symbol}: ${s.digits.length} ticks          `);
  }
  console.log("\n");

  const pooled = series.reduce((sum, s) => sum + s.digits.length, 0);
  console.log(`Total ${pooled.toLocaleString()} ticks.`);

  // Bonferroni across 10 symbols: one-sided 0.05/10 → z = 2.576.
  const z = 2.576;

  staticBias(series, z);
  markov(series, z);
  stepDistribution(series, z);
  quantisation(series);

  console.log("\n5 · Pooled uniformity over all history\n");
  for (const s of series) {
    const c = counts10(s.digits);
    const { stat, p } = chi2Uniform(c);
    const pct = c.map((x) => (x / s.digits.length) * 100);
    const min = Math.min(...pct);
    const max = Math.max(...pct);
    console.log(
      `  ${s.symbol.padEnd(9)} n=${String(s.digits.length).padStart(6)}  chi2=${stat
        .toFixed(1)
        .padStart(6)}  p=${p.toFixed(4)}  range ${min.toFixed(2)}–${max.toFixed(2)}%  ${
        p < 0.005 ? "NON-UNIFORM" : "uniform"
      }`,
    );
  }

  powerCheck();

  client.disconnect();
  process.exit(0);
}

main().catch((error: Error) => {
  console.error(`FATAL: ${error.message}`);
  process.exit(1);
});
