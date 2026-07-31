/**
 * Measures whether the current elite analyzer can actually arm on real ticks,
 * and what a slightly stricter bar would do. Read-only — no buys.
 *
 *   npx tsx --env-file=.env scripts/probe-elite.ts
 */
import { DerivClient } from "../src/lib/deriv/client";
import { resolveAccount } from "../src/lib/deriv/rest";
import { lastDigit, type HistoryResponse } from "../src/lib/deriv/types";
import { summarise, wilsonInterval } from "../src/lib/analysis/digits";
import {
  buildMarketSignal,
  isArmedSignal,
  type MarketSignal,
} from "../src/lib/analysis/signal";
import { analyzeNextPredictionDeep } from "../src/lib/bot/deepNext";
import { evaluateEntry } from "../src/lib/bot/gates";
import { DIFFERS_FAST_GATES } from "../src/lib/bot/differsProfile";
import { breakEvenDigitPercent } from "../src/lib/bot/performance";
import type { BotSettings } from "../src/lib/bot/types";

const APP_ID = process.env.VITE_DERIV_APP_ID?.trim() ?? "";
const TOKEN = process.env.VITE_DERIV_TOKEN_DEMO?.trim() ?? "";
const REST_URL = (process.env.VITE_DERIV_REST_URL ?? "https://api.derivws.com").replace(
  /\/$/,
  "",
);

const SYMBOL = process.env.PROBE_SYMBOL?.trim() || "R_75";
const SAMPLE = Number(process.env.PROBE_SAMPLE ?? "8000");
const PAGE = 1000;
const PRIMARY = 1500;
const WINDOWS = [1500, 2000, 2500] as const;

const settings: BotSettings = {
  prediction: 0,
  martingaleMultiplier: 2,
  maxMartingaleSteps: 3,
  contracts: 1,
  stake: 1.75,
  riskPercent: 0,
  maxExposurePercent: 2,
  takeProfit: 0.2,
  stopLoss: 10,
  maxRuns: 1,
  running: false,
  dailyLossLimit: 50,
  dailyProfitTarget: 50,
  maxConsecutiveLosses: 1,
  maxTradesPerDay: 50,
  maxStake: 5,
  side: "DIGITDIFF",
  autoSide: false,
  autoFollow: true,
  sidePreference: "differs",
  duration: 1,
  ...DIFFERS_FAST_GATES,
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

function pct(n: number, d: number): string {
  if (d === 0) return "—";
  return `${((n / d) * 100).toFixed(2)}%`;
}

/** Extra checks that would be "one notch higher" than live elite. */
function probeStricter(signal: MarketSignal, statsSample: number): {
  wilson99p9: boolean;
  gap22: boolean;
  lead15: boolean;
  sample1800: boolean;
  power100: boolean;
} {
  const gap = signal.watching.signalGap ?? 0;
  const sep = signal.watching.separation || "";
  const leadMatch = /cold −(\d+)/.exec(sep);
  const lead = leadMatch ? Number(leadMatch[1]) : 0;
  return {
    wilson99p9: signal.evOk, // placeholder filled below when we have counts
    gap22: gap >= 22,
    lead15: lead >= 15,
    sample1800: statsSample >= 1800,
    power100: signal.power >= 100,
  };
}

async function main() {
  if (!APP_ID || !TOKEN) {
    console.error("Need VITE_DERIV_APP_ID and VITE_DERIV_TOKEN_DEMO in .env");
    process.exit(1);
  }

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

  console.log(`Fetching ~${SAMPLE} ticks of ${SYMBOL}…`);
  const digits = await fetchDigits(client, SYMBOL);
  client.disconnect();
  console.log(`Got ${digits.length} digits. Walking elite gate…\n`);

  const start = Math.max(...WINDOWS);
  let ticks = 0;
  const layers = {
    evOk: 0,
    windowsAgree: 0,
    windowsEvOk: 0,
    timingOk: 0,
    structureOk: 0,
    primaryBarrier: 0,
    uniqueEvOk: 0,
    coldMarginOk: 0,
    separationOk: 0,
    high: 0,
    power100: 0,
    armed: 0,
    gateOk: 0,
    deepOk: 0,
    gap22: 0,
    lead15: 0,
    sample1800: 0,
    // hypothetical: 99.9% Wilson (z=3.291) on primary cold digit
    wilson99p9: 0,
    // armed AND gap22 AND lead15 AND sample1800 AND wilson99p9
    ultra: 0,
  };
  let armedWin = 0;
  let armedSettle = 0;
  const confHist: Record<string, number> = { low: 0, soft: 0, medium: 0, high: 0 };
  let maxPower = 0;
  let best: MarketSignal | null = null;

  const breakEven = breakEvenDigitPercent("DIGITDIFF", SYMBOL);

  for (let i = start; i < digits.length - 1; i += 1) {
    const slice = digits.slice(i - PRIMARY, i);
    const stats = summarise(slice);
    const windowStats = WINDOWS.map((size) =>
      summarise(digits.slice(Math.max(0, i - size), i)),
    );
    const signal = buildMarketSignal(stats, "DIGITDIFF", 0, {
      windowStats,
      windowSizes: [...WINDOWS],
      minEdgePercent: settings.minEdgePercent,
      maxMomentumGap: settings.maxMomentumGap,
      minColdGap: settings.minColdGap,
      symbol: SYMBOL,
    });

    ticks += 1;
    confHist[signal.confidence] = (confHist[signal.confidence] ?? 0) + 1;
    if (signal.power > maxPower) {
      maxPower = signal.power;
      best = signal;
    }

    if (signal.evOk) layers.evOk += 1;
    if (signal.windowsAgree) layers.windowsAgree += 1;
    if (signal.windowsEvOk) layers.windowsEvOk += 1;
    if (signal.timingOk) layers.timingOk += 1;
    if (signal.structureOk) layers.structureOk += 1;
    if (signal.primaryBarrier) layers.primaryBarrier += 1;
    if (signal.uniqueEvOk) layers.uniqueEvOk += 1;
    if (signal.coldMarginOk) layers.coldMarginOk += 1;
    if (signal.separationOk) layers.separationOk += 1;
    if (signal.confidence === "high") layers.high += 1;
    if (signal.power >= 100) layers.power100 += 1;

    const digit = signal.digit;
    const count = stats.counts[digit] ?? 0;
    const n = stats.sampleSize;
    const { upper } = wilsonInterval(count, n, 3.291);
    const upperPct = upper * 100;
    const maxBarrier = breakEven - settings.minEdgePercent;
    const w999 = stats.percentages[digit] <= maxBarrier && upperPct <= maxBarrier;
    if (w999) layers.wilson99p9 += 1;

    const strict = probeStricter(signal, stats.sampleSize);
    if (strict.gap22) layers.gap22 += 1;
    if (strict.lead15) layers.lead15 += 1;
    if (strict.sample1800) layers.sample1800 += 1;

    const armed = isArmedSignal(signal);
    if (armed) {
      layers.armed += 1;
      armedSettle += 1;
      if (digits[i] !== signal.digit) armedWin += 1;
    }

    if (evaluateEntry(settings, signal, { symbol: SYMBOL, balance: 1000 }).ok) {
      layers.gateOk += 1;
    }

    const deep = analyzeNextPredictionDeep({
      signal,
      settings,
      symbol: SYMBOL,
      lastEntryDigit: null,
      lastEntryDigitPrinted: true,
      winsThisStart: 0,
      firstEntry: true,
    });
    if (deep.ok) layers.deepOk += 1;

    if (armed && w999 && strict.gap22 && strict.lead15 && strict.sample1800) {
      layers.ultra += 1;
    }
  }

  console.log(`Symbol ${SYMBOL} · ${ticks} evaluated ticks · break-even ${breakEven.toFixed(2)}%`);
  console.log(`Profile: sample≥${settings.minSample} gap≥${settings.minColdGap} edge≥${settings.minEdgePercent}`);
  console.log("");
  console.log("Layer pass rates (current elite):");
  for (const [k, v] of Object.entries(layers)) {
    if (["gap22", "lead15", "sample1800", "wilson99p9", "ultra"].includes(k)) continue;
    console.log(`  ${k.padEnd(16)} ${String(v).padStart(6)}  ${pct(v, ticks)}`);
  }
  console.log("");
  console.log("Confidence histogram:");
  for (const [k, v] of Object.entries(confHist)) {
    console.log(`  ${k.padEnd(8)} ${String(v).padStart(6)}  ${pct(v, ticks)}`);
  }
  console.log("");
  console.log("One-notch-higher candidates:");
  console.log(`  gap≥22           ${String(layers.gap22).padStart(6)}  ${pct(layers.gap22, ticks)}`);
  console.log(`  lead≥15          ${String(layers.lead15).padStart(6)}  ${pct(layers.lead15, ticks)}`);
  console.log(`  sample≥1800      ${String(layers.sample1800).padStart(6)}  ${pct(layers.sample1800, ticks)}`);
  console.log(`  Wilson 99.9%     ${String(layers.wilson99p9).padStart(6)}  ${pct(layers.wilson99p9, ticks)}`);
  console.log(`  ultra (all+)     ${String(layers.ultra).padStart(6)}  ${pct(layers.ultra, ticks)}`);
  console.log("");
  if (armedSettle > 0) {
    console.log(
      `Armed settle win rate: ${armedWin}/${armedSettle} = ${pct(armedWin, armedSettle)} (fair ~90%)`,
    );
  } else {
    console.log("Armed settle win rate: no armed ticks in sample");
  }
  console.log(`Max power seen: ${maxPower}`);
  if (best) {
    console.log(
      `Best signal: ${best.label} · ${best.confidence} · power ${best.power} · gap ${best.watching.signalGap} · ${best.digitPercent.toFixed(1)}% · ${best.watching.wilsonBound}`,
    );
    console.log(`  reason: ${best.reason.slice(0, 200)}`);
  }

  // Verdict for whether we can safely raise further.
  console.log("\n--- verdict ---");
  if (layers.armed === 0 && layers.deepOk === 0) {
    console.log("FAIL · current elite never armed in this sample — do NOT raise further; loosen blockers.");
  } else if (layers.ultra === 0) {
    console.log(
      `OK · elite armed ${layers.armed}× / deep ${layers.deepOk}× · ultra never fired — raise only layers that still pass.`,
    );
  } else {
    console.log(
      `OK · elite armed ${layers.armed}× · ultra ${layers.ultra}× — safe to adopt ultra extras that still fire.`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
