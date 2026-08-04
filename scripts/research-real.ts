/**
 * Honest strategy research on Deriv's REAL markets (forex, gold, crypto).
 *
 * The rule that makes this research instead of curve-fitting: parameters are
 * chosen on the FIRST 65% of history, then scored once on the last 35% the
 * search never saw. A strategy that looks good in-sample and dies
 * out-of-sample was fitted to noise — that is the normal outcome, and it is
 * reported as a failure rather than dressed up.
 *
 * Costs are charged on every trade, so nothing here is "profitable before
 * spread". Read-only: it never places an order.
 *
 *   npm run research
 */
import { DerivClient } from "../src/lib/deriv/client";
import { resolveAccount } from "../src/lib/deriv/rest";
import { runBacktest, type BacktestResult } from "../src/lib/research/backtest";
import {
  GRANULARITIES,
  REAL_INSTRUMENTS,
  fetchCandles,
  type Bar,
  type Instrument,
} from "../src/lib/research/candles";
import { STRATEGIES } from "../src/lib/research/strategies";

const APP_ID = process.env.VITE_DERIV_APP_ID?.trim() ?? "";
const TOKEN = process.env.VITE_DERIV_TOKEN_DEMO?.trim() ?? "";
const REST_URL = (
  process.env.VITE_DERIV_REST_URL ?? "https://api.derivws.com"
).replace(/\/$/, "");

const BARS = 5000;
/** Fraction of history the parameter search is allowed to see. */
const IN_SAMPLE = 0.65;
/** Fewer trades than this and the result is noise, not evidence. */
const MIN_TRADES = 30;
const ATR_PERIOD = 14;
const MAX_HOLD_BARS = 60;
const REQUEST_GAP_MS = 1200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Candidate {
  instrument: Instrument;
  timeframe: string;
  strategy: string;
  label: string;
  atrMult: number;
  rMultiple: number;
  inSample: BacktestResult;
  outOfSample: BacktestResult;
}

function searchBest(
  instrument: Instrument,
  timeframe: string,
  bars: Bar[],
): Candidate | null {
  const split = Math.floor(bars.length * IN_SAMPLE);
  const trainBars = bars.slice(0, split);
  const testBars = bars.slice(split);
  let best: Candidate | null = null;

  for (const strategy of STRATEGIES) {
    // Signals are recomputed per slice so the test half cannot borrow
    // indicator state that was warmed up on the training half.
    const trainRuns = strategy.runs(trainBars);
    const testRuns = strategy.runs(testBars);
    for (let idx = 0; idx < trainRuns.length; idx += 1) {
      const train = trainRuns[idx];
      const test = testRuns[idx];
      for (const atrMult of [1, 1.5, 2]) {
        for (const rMultiple of [1, 1.5, 2, 3]) {
          const config = {
            atrMult,
            rMultiple,
            spread: instrument.spread,
            atrPeriod: ATR_PERIOD,
            maxHoldBars: MAX_HOLD_BARS,
          };
          const inSample = runBacktest(trainBars, train.signals, config);
          if (inSample.trades < MIN_TRADES) continue;
          if (!best || inSample.expectancyR > best.inSample.expectancyR) {
            best = {
              instrument,
              timeframe,
              strategy: strategy.name,
              label: `${train.label} · stop ${atrMult}×ATR · target ${rMultiple}R`,
              atrMult,
              rMultiple,
              inSample,
              outOfSample: runBacktest(testBars, test.signals, config),
            };
          }
        }
      }
    }
  }
  return best;
}

function line(result: BacktestResult): string {
  return (
    `${String(result.trades).padStart(4)} trades · ` +
    `win ${result.winRate.toFixed(1).padStart(5)}% · ` +
    `exp ${(result.expectancyR >= 0 ? "+" : "") + result.expectancyR.toFixed(3)}R · ` +
    `total ${(result.totalR >= 0 ? "+" : "") + result.totalR.toFixed(1)}R · ` +
    `PF ${result.profitFactor.toFixed(2)} · ` +
    `maxDD ${result.maxDrawdownR.toFixed(1)}R · ` +
    `cost ${result.costR.toFixed(3)}R`
  );
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

  const survivors: Candidate[] = [];
  const all: Candidate[] = [];

  for (const instrument of REAL_INSTRUMENTS) {
    for (const [timeframe, granularity] of Object.entries(GRANULARITIES)) {
      let bars: Bar[] = [];
      try {
        bars = await fetchCandles(client, instrument.symbol, granularity, BARS, {
          pageGapMs: REQUEST_GAP_MS,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`${instrument.name} ${timeframe} · skipped · ${message}`);
        await sleep(REQUEST_GAP_MS);
        continue;
      }
      await sleep(REQUEST_GAP_MS);
      if (bars.length < 500) {
        console.log(
          `${instrument.name} ${timeframe} · only ${bars.length} bars · skipped`,
        );
        continue;
      }

      const best = searchBest(instrument, timeframe, bars);
      if (!best) {
        console.log(
          `${instrument.name.padEnd(9)} ${timeframe.padEnd(3)} · nothing reached ${MIN_TRADES} trades`,
        );
        continue;
      }
      all.push(best);
      const held =
        best.outOfSample.trades >= MIN_TRADES &&
        best.outOfSample.expectancyR > 0;
      if (held) survivors.push(best);
      console.log(
        `\n${instrument.name} ${timeframe} · ${bars.length} bars · best in-sample: ${best.strategy} · ${best.label}`,
      );
      console.log(`   in-sample  ${line(best.inSample)}`);
      console.log(
        `   OUT-SAMPLE ${line(best.outOfSample)}  ${held ? "<< HELD UP" : "(collapsed)"}`,
      );
    }
  }

  client.disconnect();

  console.log(`\n${"=".repeat(72)}`);
  console.log(
    `Tested ${all.length} market/timeframe combinations. ` +
      `${survivors.length} kept a positive expectancy on unseen data.`,
  );
  if (survivors.length === 0) {
    console.log(
      "VERDICT: no edge survived. Nothing here is worth trading — every\n" +
        "candidate was fitted to the training half and fell apart on fresh\n" +
        "data, which is what noise does.",
    );
    return;
  }
  console.log("\nSurvivors, strongest first (still only a candidate — not proof):");
  for (const candidate of survivors.sort(
    (a, b) => b.outOfSample.expectancyR - a.outOfSample.expectancyR,
  )) {
    console.log(
      `  ${candidate.instrument.name} ${candidate.timeframe} · ${candidate.strategy} · ${candidate.label}\n` +
        `     out-of-sample ${line(candidate.outOfSample)}`,
    );
  }
  console.log(
    "\nA survivor still needs: a walk-forward re-test, then demo forward\n" +
      "testing, before any real money. One backtest is a hypothesis.",
  );
}

void main();
