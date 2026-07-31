/**
 * Walk-forward audit of the Differs analyzer.
 *
 * For every tick we rebuild the signal from history the bot would actually
 * have had, then score it against the very next tick. A fair-RNG control runs
 * the same gates so we can separate "found an edge" from "found noise".
 * Read-only: fetches history, places no orders.
 *
 *   npm run check-differs
 */
import { DerivClient } from "../src/lib/deriv/client";
import { resolveAccount } from "../src/lib/deriv/rest";
import { lastDigit, type HistoryResponse } from "../src/lib/deriv/types";
import { uniformityTest, type DigitStats } from "../src/lib/analysis/digits";
import { buildMarketSignal } from "../src/lib/analysis/signal";
import { breakEvenDigitPercent, payoutMultiplier } from "../src/lib/bot/performance";

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
const SAMPLE = 12000;
/** Deriv caps a single ticks_history call, so history is paged backwards. */
const PAGE = 1000;
const WINDOWS = [500, 1000, 2000];
const PRIMARY = 1000;
const WARMUP = 2100;
const MIN_COLD_GAP = 6;

async function fetchHistory(client: DerivClient, symbol: string): Promise<number[]> {
  const prices: number[] = [];
  let pipSize = 2;
  let end: number | "latest" = "latest";

  while (prices.length < SAMPLE) {
    const message: HistoryResponse = await client.send<HistoryResponse>({
      ticks_history: symbol,
      adjust_start_time: 1,
      count: Math.min(PAGE, SAMPLE - prices.length),
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

/** prefix[i * 10 + d] = count of digit d in digits[0..i-1]. */
function buildPrefix(digits: number[]): Int32Array {
  const prefix = new Int32Array((digits.length + 1) * 10);
  for (let i = 0; i < digits.length; i += 1) {
    const base = i * 10;
    const next = base + 10;
    for (let d = 0; d < 10; d += 1) prefix[next + d] = prefix[base + d];
    prefix[next + digits[i]] += 1;
  }
  return prefix;
}

function countsIn(prefix: Int32Array, start: number, end: number): number[] {
  const counts = new Array<number>(10);
  for (let d = 0; d < 10; d += 1) {
    counts[d] = prefix[end * 10 + d] - prefix[start * 10 + d];
  }
  return counts;
}

/** Same shape as summarise(), built from prefix sums so the walk stays fast. */
function statsAt(
  digits: number[],
  prefix: Int32Array,
  end: number,
  size: number,
): DigitStats {
  return statsRange(digits, prefix, Math.max(0, end - size), end);
}

function statsRange(
  digits: number[],
  prefix: Int32Array,
  start: number,
  end: number,
): DigitStats {
  const sampleSize = end - start;
  const counts = countsIn(prefix, start, end);
  const percentages = counts.map((c) => (sampleSize === 0 ? 0 : (c / sampleSize) * 100));

  const ranked = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].sort((a, b) => counts[b] - counts[a]);

  const gaps = new Array<number | null>(10).fill(null);
  let found = 0;
  for (let offset = 0; offset < sampleSize && found < 10; offset += 1) {
    const digit = digits[end - 1 - offset];
    if (gaps[digit] === null) {
      gaps[digit] = offset;
      found += 1;
    }
  }

  let streakDigit: number | null = null;
  let streakLength = 0;
  if (sampleSize > 0) {
    streakDigit = digits[end - 1];
    streakLength = 1;
    for (let i = end - 2; i >= start && digits[i] === streakDigit; i -= 1) streakLength += 1;
  }

  let evenCount = 0;
  for (let d = 0; d < 10; d += 2) evenCount += counts[d];

  return {
    sampleSize,
    counts,
    percentages,
    hottest: ranked.slice(0, 3),
    coldest: ranked.slice(-3).reverse(),
    gaps,
    currentStreak: { digit: streakDigit, length: streakLength },
    evenCount,
    oddCount: sampleSize - evenCount,
    uniformity: uniformityTest(counts),
  };
}

/**
 * One-sided Wilson upper bound on the true rate. Differs needs the barrier
 * digit to be genuinely rare, so the honest test is whether even the top of
 * the interval sits under break-even.
 */
function wilsonUpper(successes: number, n: number, z: number): number {
  if (n === 0) return 1;
  const p = successes / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return (centre + margin) / (1 + z2 / n);
}

interface Tally {
  fired: number;
  wins: number;
}

function record(tally: Tally, won: boolean) {
  tally.fired += 1;
  if (won) tally.wins += 1;
}

/** One walk-forward observation, kept so many gate combos share one pass. */
interface Row {
  won: boolean;
  evOk: boolean;
  windowsAgree: boolean;
  windowsEvOk: boolean;
  timingOk: boolean;
  structureOk: boolean;
  digitPercent: number;
  coldGap: number;
  wilson95: boolean;
  disjointAgree: boolean;
  /** Full confirm when the three windows are disjoint instead of nested. */
  disjointFull: boolean;
  disjointWon: boolean;
  disjointEdge1: boolean;
  /** Signal rebuilt with minEdgePercent applied inside every EV layer. */
  edge05Full: boolean;
  edge05Won: boolean;
  edge10Full: boolean;
  edge10Won: boolean;
  /** Break-even barrier % for the symbol this row came from. */
  breakEven: number;
  mult: number;
}

const rows: Row[] = [];
const controlRows: Row[] = [];

function report(name: string, tally: Tally, needPct: number, mult: number): string {
  if (tally.fired === 0) return `  ${name.padEnd(34)} never fired`;
  const winPct = (tally.wins / tally.fired) * 100;
  const ev = (winPct / 100) * mult - 1;
  const flag = ev > 0 ? "PROFIT" : "loss";
  return `  ${name.padEnd(34)} ${String(tally.fired).padStart(6)} signals   win ${winPct
    .toFixed(2)
    .padStart(6)}%   need ${needPct.toFixed(2)}%   EV ${(ev * 100)
    .toFixed(2)
    .padStart(7)}%  ${flag}`;
}

function walk(
  digits: number[],
  symbol: string,
  tallies: Record<string, Tally>,
  sink?: Row[],
) {
  const prefix = buildPrefix(digits);
  const breakEven = breakEvenDigitPercent("DIGITDIFF", symbol);
  // Bonferroni across the 10 digits: we always cherry-pick the coldest, so a
  // plain 95% bound would fire on noise roughly one window in two.
  const zBonferroni = 2.576; // one-sided 0.005
  const zPlain = 1.645; // one-sided 0.05

  for (let t = WARMUP; t < digits.length; t += 1) {
    const primary = statsAt(digits, prefix, t, PRIMARY);
    const windowStats = WINDOWS.map((size) => statsAt(digits, prefix, t, size));
    const signal = buildMarketSignal(primary, "DIGITDIFF", 0, {
      windowStats,
      windowSizes: WINDOWS,
      minEdgePercent: 0,
      minColdGap: MIN_COLD_GAP,
      symbol,
    });

    const actual = digits[t];
    const won = actual !== signal.digit;
    const digit = signal.digit;

    // A · what ships today.
    if (signal.evOk) record(tallies.evOnly, won);
    if (
      signal.evOk &&
      signal.windowsAgree &&
      signal.windowsEvOk &&
      signal.timingOk &&
      signal.structureOk
    ) {
      record(tallies.fullConfirm, won);
    }

    // B · prove the digit is cold instead of just ranking it lowest.
    const count = primary.counts[digit];
    const upperPlain = wilsonUpper(count, primary.sampleSize, zPlain) * 100;
    const upperBonf = wilsonUpper(count, primary.sampleSize, zBonferroni) * 100;
    if (upperPlain <= breakEven) record(tallies.wilson95, won);
    if (upperBonf <= breakEven) record(tallies.wilsonBonf, won);

    // C · disjoint blocks, so "windows agree" is real persistence and not the
    // same ticks counted three times.
    let disjointAgree = false;
    if (t >= 2100) {
      const blocks = [
        countsIn(prefix, t - 700, t),
        countsIn(prefix, t - 1400, t - 700),
        countsIn(prefix, t - 2100, t - 1400),
      ];
      const coldPer = blocks.map((counts) => {
        let best = 0;
        for (let d = 1; d < 10; d += 1) if (counts[d] < counts[best]) best = d;
        return best;
      });
      const agree = coldPer.every((d) => d === coldPer[0]);
      // Only counts as confirmation when the blocks agree on OUR digit.
      disjointAgree = agree && coldPer[0] === digit;
      if (agree) {
        record(tallies.disjointAgree, actual !== coldPer[0]);
        const pooled = countsIn(prefix, t - 2100, t);
        const upper = wilsonUpper(pooled[coldPer[0]], 2100, zBonferroni) * 100;
        if (upper <= breakEven) {
          record(tallies.disjointPlusWilson, actual !== coldPer[0]);
        }
      }
    }

    // Baseline: bet Differs on a fixed digit, no analysis at all.
    record(tallies.alwaysTrade, actual !== 0);

    // D · the config I actually want to ship: same five layers, but the three
    // confirming windows share no ticks, so agreement means persistence.
    let disjointFull = false;
    let disjointWon = false;
    let disjointEdge1 = false;
    if (t >= 2100) {
      const blocks = [
        statsRange(digits, prefix, t - 700, t),
        statsRange(digits, prefix, t - 1400, t - 700),
        statsRange(digits, prefix, t - 2100, t - 1400),
      ];
      const dSignal = buildMarketSignal(primary, "DIGITDIFF", 0, {
        windowStats: blocks,
        windowSizes: [700, 700, 700],
        minEdgePercent: 0,
        minColdGap: MIN_COLD_GAP,
        symbol,
      });
      disjointFull =
        dSignal.evOk &&
        dSignal.windowsAgree &&
        dSignal.windowsEvOk &&
        dSignal.timingOk &&
        dSignal.structureOk;
      disjointWon = actual !== dSignal.digit;
      disjointEdge1 = disjointFull && dSignal.digitPercent <= breakEven - 1.0;
    }

    // E · the real shipping candidate: minEdgePercent threaded through every
    // EV layer, not bolted on after the fact.
    const withEdge = (edge: number) => {
      const s = buildMarketSignal(primary, "DIGITDIFF", 0, {
        windowStats,
        windowSizes: WINDOWS,
        minEdgePercent: edge,
        minColdGap: MIN_COLD_GAP,
        symbol,
      });
      return {
        full: s.evOk && s.windowsAgree && s.windowsEvOk && s.timingOk && s.structureOk,
        won: actual !== s.digit,
      };
    };
    const e05 = withEdge(0.5);
    const e10 = withEdge(1.0);

    sink?.push({
      won,
      disjointFull,
      disjointWon,
      disjointEdge1,
      edge05Full: e05.full,
      edge05Won: e05.won,
      edge10Full: e10.full,
      edge10Won: e10.won,
      evOk: signal.evOk,
      windowsAgree: signal.windowsAgree,
      windowsEvOk: signal.windowsEvOk,
      timingOk: signal.timingOk,
      structureOk: signal.structureOk,
      digitPercent: signal.digitPercent,
      coldGap: signal.watching.signalGap ?? 0,
      wilson95: upperPlain <= breakEven,
      disjointAgree,
      breakEven,
      mult: payoutMultiplier("DIGITDIFF", symbol),
    });
  }
}

interface Combo {
  name: string;
  test: (row: Row) => boolean;
  /** Disjoint gates pick their own digit, so they score their own outcome. */
  useDisjointOutcome?: boolean;
  /** Gates that rebuild the signal score against their own chosen digit. */
  outcome?: "edge05" | "edge10";
}

const COMBOS: Combo[] = [
  { name: "always trade (no analysis)", test: () => true },
  { name: "EV only [current default]", test: (r) => r.evOk },
  {
    name: "full 5/5 confirm",
    test: (r) => r.evOk && r.windowsAgree && r.windowsEvOk && r.timingOk && r.structureOk,
  },
  {
    name: "5/5 + edge 0.5pp",
    test: (r) =>
      r.evOk &&
      r.windowsAgree &&
      r.windowsEvOk &&
      r.timingOk &&
      r.structureOk &&
      r.digitPercent <= r.breakEven - 0.5,
  },
  {
    name: "5/5 + edge 1.0pp",
    test: (r) =>
      r.evOk &&
      r.windowsAgree &&
      r.windowsEvOk &&
      r.timingOk &&
      r.structureOk &&
      r.digitPercent <= r.breakEven - 1.0,
  },
  {
    name: "5/5 + disjoint blocks agree",
    test: (r) =>
      r.evOk &&
      r.windowsAgree &&
      r.windowsEvOk &&
      r.timingOk &&
      r.structureOk &&
      r.disjointAgree,
  },
  {
    name: "5/5 + Wilson 95%",
    test: (r) =>
      r.evOk &&
      r.windowsAgree &&
      r.windowsEvOk &&
      r.timingOk &&
      r.structureOk &&
      r.wilson95,
  },
  {
    name: "5/5 + cold gap >= 20",
    test: (r) =>
      r.evOk &&
      r.windowsAgree &&
      r.windowsEvOk &&
      r.timingOk &&
      r.structureOk &&
      r.coldGap >= 20,
  },
  { name: "windows agree + chi2 only", test: (r) => r.windowsAgree && r.structureOk },
  { name: "chi2 uneven only", test: (r) => r.structureOk },
  { name: "disjoint blocks agree only", test: (r) => r.disjointAgree },
  { name: "Wilson 95% only", test: (r) => r.wilson95 },
  { name: "D · disjoint 5/5", test: (r) => r.disjointFull, useDisjointOutcome: true },
  {
    name: "D · disjoint 5/5 + edge 1.0pp",
    test: (r) => r.disjointEdge1,
    useDisjointOutcome: true,
  },
  { name: "E · 5/5, minEdge=0.5 built in", test: (r) => r.edge05Full, outcome: "edge05" },
  { name: "E · 5/5, minEdge=1.0 built in", test: (r) => r.edge10Full, outcome: "edge10" },
];

/** Wald 95% interval on the win rate, so tiny samples cannot look like edges. */
function evaluate(name: string, data: Row[], combo?: Combo): string {
  const outcomeOf = (row: Row): boolean => {
    if (combo?.useDisjointOutcome) return row.disjointWon;
    if (combo?.outcome === "edge05") return row.edge05Won;
    if (combo?.outcome === "edge10") return row.edge10Won;
    return row.won;
  };

  let fired = 0;
  let wins = 0;
  let needSum = 0;
  let multSum = 0;
  for (const row of data) {
    fired += 1;
    if (outcomeOf(row)) wins += 1;
    needSum += (1 / row.mult) * 100;
    multSum += row.mult;
  }
  if (fired === 0) return `  ${name.padEnd(30)} never fired`;

  const win = wins / fired;
  const mult = multSum / fired;
  const need = needSum / fired;
  const ev = win * mult - 1;
  const se = Math.sqrt((win * (1 - win)) / fired);
  const evLow = (win - 1.96 * se) * mult - 1;
  const evHigh = (win + 1.96 * se) * mult - 1;
  const verdict =
    evLow > 0 ? "PROFITABLE" : evHigh < 0 ? "loses" : "inconclusive";

  return `  ${name.padEnd(30)} ${String(fired).padStart(6)}  win ${(win * 100)
    .toFixed(2)
    .padStart(6)}%  need ${need.toFixed(2)}%  EV ${(ev * 100)
    .toFixed(2)
    .padStart(6)}%  95%CI [${(evLow * 100).toFixed(2)}, ${(evHigh * 100)
    .toFixed(2)}]  ${verdict}`;
}

function sweep(label: string, data: Row[]) {
  console.log(`\n${label}\n`);
  for (const combo of COMBOS) {
    console.log(evaluate(combo.name, data.filter(combo.test), combo));
  }
}

function freshTallies(): Record<string, Tally> {
  const names = [
    "evOnly",
    "fullConfirm",
    "wilson95",
    "wilsonBonf",
    "disjointAgree",
    "disjointPlusWilson",
    "alwaysTrade",
  ];
  const out: Record<string, Tally> = {};
  for (const name of names) out[name] = { fired: 0, wins: 0 };
  return out;
}

function printTallies(tallies: Record<string, Tally>, symbol: string) {
  const mult = payoutMultiplier("DIGITDIFF", symbol);
  const need = (1 / mult) * 100;
  console.log(report("A · EV gate only (ships today)", tallies.evOnly, need, mult));
  console.log(report("A · full 5/5 confirm (ships today)", tallies.fullConfirm, need, mult));
  console.log(report("B · Wilson 95% upper bound", tallies.wilson95, need, mult));
  console.log(report("B · Wilson + Bonferroni x10", tallies.wilsonBonf, need, mult));
  console.log(report("C · disjoint blocks agree", tallies.disjointAgree, need, mult));
  console.log(report("C · disjoint + Wilson", tallies.disjointPlusWilson, need, mult));
  console.log(report("— · no analysis, always trade", tallies.alwaysTrade, need, mult));
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

  console.log(
    `Walk-forward Differs audit · ${SAMPLE} ticks/symbol · signal rebuilt every tick\n`,
  );

  const pooled = freshTallies();

  for (const symbol of SYMBOLS) {
    const digits = await fetchHistory(client, symbol);
    if (digits.length <= WARMUP + 10) {
      console.log(`  ${symbol}: only ${digits.length} ticks, skipped`);
      continue;
    }

    const local = freshTallies();
    walk(digits, symbol, local, rows);
    for (const key of Object.keys(local)) {
      pooled[key].fired += local[key].fired;
      pooled[key].wins += local[key].wins;
    }

    const mult = payoutMultiplier("DIGITDIFF", symbol);
    const need = (1 / mult) * 100;
    const ev = local.evOnly;
    const evTxt =
      ev.fired === 0
        ? "never fired"
        : `${((ev.wins / ev.fired) * 100).toFixed(2)}% win vs ${need.toFixed(2)}% needed`;
    console.log(`  ${symbol.padEnd(9)} ${String(ev.fired).padStart(5)} EV signals · ${evTxt}`);
  }

  console.log("\nPooled across all symbols (real market data):\n");
  printTallies(pooled, "default");

  // Fair-RNG control. Any gate that keeps firing here is reading noise.
  console.log("\nControl · same gates on a fair random generator:\n");
  const control = freshTallies();
  for (let run = 0; run < SYMBOLS.length; run += 1) {
    const digits = Array.from({ length: SAMPLE }, () => Math.floor(Math.random() * 10));
    walk(digits, "default", control, controlRows);
  }
  printTallies(control, "default");

  sweep("Gate sweep · REAL market data", rows);
  sweep("Gate sweep · FAIR RNG control (everything here should lose)", controlRows);

  const be = breakEvenDigitPercent("DIGITDIFF", "default");
  console.log(
    `\nDiffers needs the barrier digit under ${be.toFixed(2)}% (fair is 10.00%).`,
  );
  console.log(
    `At 1000 ticks the coldest of 10 digits averages ~8.5% on pure noise, which is why`,
  );
  console.log(`a raw "lowest digit" reading clears the bar without any real edge.`);

  client.disconnect();
  process.exit(0);
}

main().catch((error: Error) => {
  console.error(`FATAL: ${error.message}`);
  process.exit(1);
});
