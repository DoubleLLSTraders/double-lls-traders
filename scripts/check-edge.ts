/**
 * Measures the real house edge per side, and tests whether digit frequencies
 * on the synthetic indices deviate from uniform by enough to beat it.
 * Read-only: fetches history, places no orders.
 *
 *   npm run check-edge
 */
import { DerivClient } from "../src/lib/deriv/client";
import { resolveAccount } from "../src/lib/deriv/rest";
import { lastDigit, type HistoryResponse } from "../src/lib/deriv/types";

const APP_ID = process.env.VITE_DERIV_APP_ID?.trim() ?? "";
const TOKEN = process.env.VITE_DERIV_TOKEN_DEMO?.trim() ?? "";
const REST_URL = (process.env.VITE_DERIV_REST_URL ?? "https://api.derivws.com").replace(/\/$/, "");

const SYMBOLS = ["R_10", "R_25", "R_50", "R_75", "R_100", "1HZ50V", "1HZ100V"];
const SAMPLE = 5000;
/** Measured in check-payout. */
const PAYOUT: Record<string, { match: number; diff: number }> = {
  default: { match: 8.9286, diff: 1.0965 },
  R_100: { match: 8.3333, diff: 1.087 },
};

function payoutFor(symbol: string) {
  return PAYOUT[symbol] ?? PAYOUT.default;
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

  console.log("House edge per trade at the measured payouts:\n");
  for (const symbol of ["R_100", "R_50"]) {
    const p = payoutFor(symbol);
    const matchEv = 0.1 * p.match - 1;
    const diffEv = 0.9 * p.diff - 1;
    console.log(
      `  ${symbol.padEnd(7)} Matches ${p.match}x → EV ${(matchEv * 100).toFixed(1)}%   Differs ${p.diff}x → EV ${(diffEv * 100).toFixed(1)}%`,
    );
  }

  console.log(`\nDigit distribution over ${SAMPLE} ticks (uniform = 10.00%):\n`);
  console.log(
    "  symbol   min%    max%    chi2      p<0.05?  best Matches EV   best Differs EV",
  );

  for (const symbol of SYMBOLS) {
    const message = await client.send<HistoryResponse>({
      ticks_history: symbol,
      adjust_start_time: 1,
      count: SAMPLE,
      end: "latest",
      style: "ticks",
    });
    const digits = message.history.prices.map((quote) =>
      lastDigit(quote, message.pip_size),
    );
    const n = digits.length;
    const counts = new Array<number>(10).fill(0);
    for (const digit of digits) counts[digit] += 1;
    const pct = counts.map((count) => (count / n) * 100);

    const expected = n / 10;
    const chi2 = counts.reduce(
      (sum, count) => sum + (count - expected) ** 2 / expected,
      0,
    );
    // 9 degrees of freedom, 95% critical value.
    const significant = chi2 > 16.919;

    const p = payoutFor(symbol);
    const maxPct = Math.max(...pct);
    const minPct = Math.min(...pct);
    // Best case: bet Matches on the hottest digit, Differs on the coldest.
    const bestMatchEv = (maxPct / 100) * p.match - 1;
    const bestDiffEv = (1 - minPct / 100) * p.diff - 1;

    console.log(
      `  ${symbol.padEnd(8)} ${minPct.toFixed(2)}   ${maxPct.toFixed(2)}   ${chi2.toFixed(2).padStart(6)}    ${significant ? "YES" : "no "}      ${(bestMatchEv * 100).toFixed(1)}%            ${(bestDiffEv * 100).toFixed(1)}%`,
    );
  }

  console.log(
    `\nSample needed to prove a 12% digit is real (not 10% noise), 95% conf: ~${Math.ceil(
      (1.96 ** 2 * 0.1 * 0.9) / 0.02 ** 2,
    )} ticks`,
  );

  // The strategy only works if a digit that was hot stays hot. Pick the hot and
  // cold digits from the first half, then measure them in the unseen second half.
  console.log("\nOut-of-sample persistence (pick on first half, test on second):\n");
  console.log("  symbol   hot digit  in-sample%  out-sample%   cold digit  in%    out%");

  let hotCarry = 0;
  let coldCarry = 0;
  let tested = 0;

  for (const symbol of SYMBOLS) {
    const message = await client.send<HistoryResponse>({
      ticks_history: symbol,
      adjust_start_time: 1,
      count: SAMPLE * 2,
      end: "latest",
      style: "ticks",
    });
    const digits = message.history.prices.map((quote) =>
      lastDigit(quote, message.pip_size),
    );
    const half = Math.floor(digits.length / 2);
    const train = digits.slice(0, half);
    const test = digits.slice(half);

    const freq = (list: number[], digit: number) =>
      (list.filter((value) => value === digit).length / list.length) * 100;

    const trainPct = Array.from({ length: 10 }, (_, digit) => freq(train, digit));
    const hot = trainPct.indexOf(Math.max(...trainPct));
    const cold = trainPct.indexOf(Math.min(...trainPct));

    const hotOut = freq(test, hot);
    const coldOut = freq(test, cold);
    hotCarry += hotOut;
    coldCarry += coldOut;
    tested += 1;

    console.log(
      `  ${symbol.padEnd(8)} ${hot}          ${trainPct[hot].toFixed(2)}       ${hotOut.toFixed(2)}         ${cold}           ${trainPct[cold].toFixed(2)}  ${coldOut.toFixed(2)}`,
    );
  }

  console.log(
    `\n  average hot digit out-of-sample : ${(hotCarry / tested).toFixed(2)}%  (needs >12.00% for Matches to profit)`,
  );
  console.log(
    `  average cold digit out-of-sample: ${(coldCarry / tested).toFixed(2)}%  (needs <8.00% for Differs to profit)`,
  );

  client.disconnect();
  process.exit(0);
}

main().catch((error: Error) => {
  console.error(`FATAL: ${error.message}`);
  process.exit(1);
});
