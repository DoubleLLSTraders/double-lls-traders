/**
 * Replays real ticks through the exact signal + gate pipeline the app uses and
 * reports how often each confirmation layer fires, so a bot that never trades
 * can be traced to the specific layer blocking it.
 *
 * Read-only: fetches history, places no orders.
 *
 *   npm run diagnose-gate
 */
import { DerivClient } from "../src/lib/deriv/client";
import { resolveAccount } from "../src/lib/deriv/rest";
import { lastDigit, type HistoryResponse } from "../src/lib/deriv/types";
import { summarise } from "../src/lib/analysis/digits";
import { buildMarketSignal, confirmScore } from "../src/lib/analysis/signal";
import { evaluateEntry } from "../src/lib/bot/gates";
import type { BotSettings } from "../src/lib/bot/types";

const APP_ID = process.env.VITE_DERIV_APP_ID?.trim() ?? "";
const TOKEN = process.env.VITE_DERIV_TOKEN_DEMO?.trim() ?? "";
const REST_URL = (process.env.VITE_DERIV_REST_URL ?? "https://api.derivws.com").replace(/\/$/, "");

// Mirrors App.tsx exactly.
const PRIMARY_WINDOW = 1000;
const AGREEMENT_WINDOWS = [500, 1000, 2000];
const SYMBOLS = ["R_10", "R_25", "R_50", "R_75", "1HZ25V", "1HZ50V", "1HZ75V"];
const SAMPLE = 12000;
const PAGE = 1000;

/** Seconds between ticks, used to turn a hit rate into a human wait. */
const TICK_SECONDS: Record<string, number> = {
  R_10: 2,
  R_25: 2,
  R_50: 2,
  R_75: 2,
  R_100: 2,
  "1HZ10V": 1,
  "1HZ25V": 1,
  "1HZ50V": 1,
  "1HZ75V": 1,
  "1HZ100V": 1,
};

const BASE: BotSettings = {
  stake: 1.75,
  contracts: 1,
  side: "DIGITDIFF",
  prediction: 5,
  martingale: false,
  martingaleMultiplier: 2,
  autoFollow: true,
  autoSide: true,
  sidePreference: "differs",
  parallelExecution: true,
  armSeconds: 0,
  maxMomentumGap: 3,
  minColdGap: 6,
  minSample: 865,
  minEdgePercent: 0,
  skipLowConfidence: false,
  // Mirrors CONFIRMED_ENTRY_PATCH in App.tsx (v14).
  requireFullConfirm: false,
  requireMultiWindow: false,
  requireWindowsEv: false,
  requireTiming: true,
  requireUneven: false,
  cooldownTicks: 1,
  riskPercent: 0,
  dailyLossLimit: 50,
  dailyProfitTarget: 50,
  maxConsecutiveLosses: 5,
  maxTradesPerDay: 500,
  maxStake: 20,
  takeProfit: 0,
  stopLoss: 0,
  maxRuns: 0,
  pauseIfBelowBreakEvenAfter: 0,
  pauseIfExpectancyNegativeAfter: 0,
  maxDrawdownPercent: 0,
  maxTradesPerHour: 60,
  running: false,
};

async function fetchDigits(client: DerivClient, symbol: string): Promise<number[]> {
  const prices: number[] = [];
  let pipSize = 2;
  let end: number | "latest" = "latest";

  while (prices.length < SAMPLE) {
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

interface Tally {
  ticks: number;
  evOk: number;
  windowsAgree: number;
  windowsEvOk: number;
  timingOk: number;
  structureOk: number;
  full: number;
  gateOk: number;
  scoreHist: number[];
  /** Differs wins when the gate fired, by how many ticks late it settles. */
  wins: number[];
  settled: number[];
  /** Consecutive gate opens that reused the previous trade's digit. */
  repeatDigit: number;
  repeatPairs: number;
  /** Longest unbroken run of trades on one digit. */
  longestRun: number;
  /** Same gate, but a barrier may not be re-backed until it prints. */
  dedupTaken: number;
  dedupWins: number;
  dedupRepeat: number;
  dedupPairs: number;
  dedupLongestRun: number;
}

/** Ticks between placing the order and the tick that decides it. */
const OFFSETS = [0, 1, 2];

function empty(): Tally {
  return {
    ticks: 0,
    evOk: 0,
    windowsAgree: 0,
    windowsEvOk: 0,
    timingOk: 0,
    structureOk: 0,
    full: 0,
    gateOk: 0,
    scoreHist: new Array<number>(6).fill(0),
    wins: new Array<number>(OFFSETS.length).fill(0),
    settled: new Array<number>(OFFSETS.length).fill(0),
    repeatDigit: 0,
    repeatPairs: 0,
    longestRun: 0,
    dedupTaken: 0,
    dedupWins: 0,
    dedupRepeat: 0,
    dedupPairs: 0,
    dedupLongestRun: 0,
  };
}

function walk(digits: number[], symbol: string, settings: BotSettings): Tally {
  const tally = empty();
  const start = Math.max(...AGREEMENT_WINDOWS);
  let lastDigit: number | null = null;
  let run = 0;
  let heldDigit: number | null = null;
  let heldSince = 0;
  let dedupRun = 0;

  for (let i = start; i < digits.length; i += 1) {
    const stats = summarise(digits.slice(i - PRIMARY_WINDOW, i));
    const windowStats = AGREEMENT_WINDOWS.map((size) =>
      summarise(digits.slice(Math.max(0, i - size), i)),
    );
    const signal = buildMarketSignal(stats, "DIGITDIFF", settings.prediction, {
      windowStats,
      windowSizes: AGREEMENT_WINDOWS,
      minEdgePercent: settings.minEdgePercent,
      maxMomentumGap: settings.maxMomentumGap,
      minColdGap: settings.minColdGap,
      symbol,
    });

    tally.ticks += 1;
    if (signal.evOk) tally.evOk += 1;
    if (signal.windowsAgree) tally.windowsAgree += 1;
    if (signal.windowsEvOk) tally.windowsEvOk += 1;
    if (signal.timingOk) tally.timingOk += 1;
    if (signal.structureOk) tally.structureOk += 1;

    const score = confirmScore(signal);
    tally.scoreHist[score] += 1;
    if (score === 5) tally.full += 1;

    if (evaluateEntry(settings, signal).ok) {
      tally.gateOk += 1;

      if (lastDigit !== null) {
        tally.repeatPairs += 1;
        if (lastDigit === signal.digit) {
          tally.repeatDigit += 1;
          run += 1;
        } else {
          run = 1;
        }
      } else {
        run = 1;
      }
      lastDigit = signal.digit;
      if (run > tally.longestRun) tally.longestRun = run;

      // Mirror of the live rule in gates.ts: a barrier is off the table until
      // it actually prints, so the next order asks a genuinely new question.
      const blocked =
        heldDigit !== null &&
        heldDigit === signal.digit &&
        !digits.slice(heldSince, i).includes(heldDigit);
      if (!blocked) {
        tally.dedupTaken += 1;
        if (digits[i] !== signal.digit) tally.dedupWins += 1;
        if (heldDigit !== null) {
          tally.dedupPairs += 1;
          if (heldDigit === signal.digit) {
            tally.dedupRepeat += 1;
            dedupRun += 1;
          } else {
            dedupRun = 1;
          }
        } else {
          dedupRun = 1;
        }
        if (dedupRun > tally.dedupLongestRun) tally.dedupLongestRun = dedupRun;
        heldDigit = signal.digit;
        heldSince = i;
      }

      // digits[i] is the very next tick after everything the signal saw, so
      // offset 0 is an instant fill and the rest model settlement latency.
      for (let k = 0; k < OFFSETS.length; k += 1) {
        const at = i + OFFSETS[k];
        if (at >= digits.length) continue;
        tally.settled[k] += 1;
        if (digits[at] !== signal.digit) tally.wins[k] += 1;
      }
    }
  }
  return tally;
}

/** Two-sided 95% CI on a win rate, in percent. */
function winCi(wins: number, n: number): string {
  if (n === 0) return "—";
  const p = wins / n;
  const se = Math.sqrt((p * (1 - p)) / n);
  return `${(p * 100).toFixed(2)}% [${((p - 1.96 * se) * 100).toFixed(2)}-${((p + 1.96 * se) * 100).toFixed(2)}]`;
}

function pct(part: number, total: number): string {
  return total === 0 ? "  0.00%" : `${((part / total) * 100).toFixed(2).padStart(6)}%`;
}

function wait(hits: number, ticks: number, symbol: string): string {
  if (hits === 0) return "never seen";
  const perTick = hits / ticks;
  const seconds = TICK_SECONDS[symbol] ?? 2 / perTick;
  const secs = (1 / perTick) * (TICK_SECONDS[symbol] ?? 2);
  void seconds;
  if (secs < 90) return `${secs.toFixed(0)}s`;
  if (secs < 5400) return `${(secs / 60).toFixed(1)}min`;
  return `${(secs / 3600).toFixed(1)}h`;
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

  console.log("Replaying real ticks through the live gate chain…\n");
  console.log(
    "  symbol     ticks     EV   agree  multiEV  timing    chi2     5/5   gate open   avg wait",
  );

  const totals = empty();
  for (const symbol of SYMBOLS) {
    const digits = await fetchDigits(client, symbol);
    const t = walk(digits, symbol, BASE);

    totals.ticks += t.ticks;
    totals.evOk += t.evOk;
    totals.windowsAgree += t.windowsAgree;
    totals.windowsEvOk += t.windowsEvOk;
    totals.timingOk += t.timingOk;
    totals.structureOk += t.structureOk;
    totals.full += t.full;
    totals.gateOk += t.gateOk;
    for (let s = 0; s <= 5; s += 1) totals.scoreHist[s] += t.scoreHist[s];
    for (let k = 0; k < OFFSETS.length; k += 1) {
      totals.wins[k] += t.wins[k];
      totals.settled[k] += t.settled[k];
    }
    totals.repeatDigit += t.repeatDigit;
    totals.repeatPairs += t.repeatPairs;
    totals.longestRun = Math.max(totals.longestRun, t.longestRun);
    totals.dedupTaken += t.dedupTaken;
    totals.dedupWins += t.dedupWins;
    totals.dedupRepeat += t.dedupRepeat;
    totals.dedupPairs += t.dedupPairs;
    totals.dedupLongestRun = Math.max(totals.dedupLongestRun, t.dedupLongestRun);

    console.log(
      `  ${symbol.padEnd(8)} ${String(t.ticks).padStart(6)} ${pct(t.evOk, t.ticks)} ${pct(
        t.windowsAgree,
        t.ticks,
      )} ${pct(t.windowsEvOk, t.ticks)} ${pct(t.timingOk, t.ticks)} ${pct(
        t.structureOk,
        t.ticks,
      )} ${pct(t.full, t.ticks)}  ${pct(t.gateOk, t.ticks)}  ${wait(t.gateOk, t.ticks, symbol).padStart(10)}`,
    );
  }

  console.log(
    `\n  POOLED   ${String(totals.ticks).padStart(6)} ${pct(totals.evOk, totals.ticks)} ${pct(
      totals.windowsAgree,
      totals.ticks,
    )} ${pct(totals.windowsEvOk, totals.ticks)} ${pct(totals.timingOk, totals.ticks)} ${pct(
      totals.structureOk,
      totals.ticks,
    )} ${pct(totals.full, totals.ticks)}  ${pct(totals.gateOk, totals.ticks)}`,
  );

  console.log(
    "\nDIFFERS WIN RATE ON THE TRADES THE GATE ACTUALLY TAKES (needs 91.3%)\n",
  );
  for (let k = 0; k < OFFSETS.length; k += 1) {
    console.log(
      `  settles ${OFFSETS[k]} tick(s) late   n=${String(totals.settled[k]).padStart(
        5,
      )}   ${winCi(totals.wins[k], totals.settled[k])}`,
    );
  }
  console.log(
    `\n  A fair coin on these digits is 90.00%. Anything inside the interval\n  above is indistinguishable from picking a digit at random.`,
  );

  const repeatPct = (totals.repeatDigit / Math.max(1, totals.repeatPairs)) * 100;
  console.log("\nARE CONSECUTIVE TRADES INDEPENDENT BETS?\n");
  console.log(
    `  back-to-back trades on the same digit   ${repeatPct.toFixed(1)}%  (10% if independent)`,
  );
  console.log(`  longest unbroken run on one digit       ${totals.longestRun} trades`);
  console.log(
    `\n  Repeats mean one unlucky tick settles a whole run of trades at once,\n  so losses arrive in clumps even though the win rate is unchanged.`,
  );

  const dedupRepeatPct = (totals.dedupRepeat / Math.max(1, totals.dedupPairs)) * 100;
  console.log("\nWITH THE ONE-BET-PER-BARRIER RULE APPLIED\n");
  console.log(
    `  trades taken                            ${totals.dedupTaken} (was ${totals.gateOk}, ${(
      (totals.dedupTaken / Math.max(1, totals.gateOk)) *
      100
    ).toFixed(1)}%)`,
  );
  console.log(
    `  back-to-back trades on the same digit   ${dedupRepeatPct.toFixed(1)}%  (was ${repeatPct.toFixed(1)}%)`,
  );
  console.log(
    `  longest unbroken run on one digit       ${totals.dedupLongestRun} (was ${totals.longestRun})`,
  );
  console.log(
    `  win rate                                ${winCi(totals.dedupWins, totals.dedupTaken)}`,
  );

  console.log("\nHow many confirms are green at a typical tick:\n");
  for (let s = 0; s <= 5; s += 1) {
    const bar = "#".repeat(Math.round((totals.scoreHist[s] / totals.ticks) * 60));
    console.log(`  ${s}/5  ${pct(totals.scoreHist[s], totals.ticks)}  ${bar}`);
  }

  console.log("\nRelaxing one layer at a time (how often the gate would open):\n");
  // requireFullConfirm short-circuits ahead of the individual toggles, so each
  // variant turns it off to let the layer under test actually matter.
  const soft = { requireFullConfirm: false } as Partial<BotSettings>;
  const variants: Array<[string, Partial<BotSettings>]> = [
    ["shipped default (EV + timing)", {}],
    ["all five layers", { requireFullConfirm: true }],
    ["all layers, no master switch", { ...soft, requireMultiWindow: true, requireWindowsEv: true, requireUneven: true }],
    ["drop chi-square", { ...soft, requireUneven: false }],
    ["drop multi-window EV", { ...soft, requireWindowsEv: false }],
    ["drop window agreement", { ...soft, requireMultiWindow: false }],
    ["drop cold-gap timing", { ...soft, requireTiming: false }],
    ["drop chi-square + multiEV", { ...soft, requireUneven: false, requireWindowsEv: false }],
    [
      "EV + agreement + timing",
      { ...soft, requireUneven: false, requireWindowsEv: false },
    ],
    [
      "EV + timing only",
      { ...soft, requireUneven: false, requireWindowsEv: false, requireMultiWindow: false },
    ],
    [
      "EV only",
      {
        ...soft,
        requireUneven: false,
        requireWindowsEv: false,
        requireMultiWindow: false,
        requireTiming: false,
      },
    ],
  ];

  const cache = new Map<string, number[]>();
  for (const symbol of SYMBOLS) cache.set(symbol, await fetchDigits(client, symbol));

  for (const [label, patch] of variants) {
    const settings = { ...BASE, ...patch };
    let open = 0;
    let ticks = 0;
    for (const symbol of SYMBOLS) {
      const t = walk(cache.get(symbol)!, symbol, settings);
      open += t.gateOk;
      ticks += t.ticks;
    }
    const perTick = open / ticks;
    const secs = perTick > 0 ? (1 / perTick) * 2 : Infinity;
    console.log(
      `  ${label.padEnd(28)} ${pct(open, ticks)}   ${
        perTick === 0
          ? "never"
          : secs < 90
            ? `${secs.toFixed(0)}s between trades`
            : secs < 5400
              ? `${(secs / 60).toFixed(1)}min between trades`
              : `${(secs / 3600).toFixed(1)}h between trades`
      }`,
    );
  }

  client.disconnect();
  process.exit(0);
}

main().catch((error: Error) => {
  console.error(`FATAL: ${error.message}`);
  process.exit(1);
});
