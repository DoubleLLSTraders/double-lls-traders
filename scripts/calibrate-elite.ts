/**
 * Sweeps gate thresholds on real ticks to find the strongest bar that still
 * arms. Read-only.
 *
 *   npx tsx --env-file=.env scripts/calibrate-elite.ts
 */
import { DerivClient } from "../src/lib/deriv/client";
import { resolveAccount } from "../src/lib/deriv/rest";
import { lastDigit, type HistoryResponse } from "../src/lib/deriv/types";
import { summarise, wilsonInterval } from "../src/lib/analysis/digits";
import { breakEvenDigitPercent } from "../src/lib/bot/performance";

const APP_ID = process.env.VITE_DERIV_APP_ID?.trim() ?? "";
const TOKEN = process.env.VITE_DERIV_TOKEN_DEMO?.trim() ?? "";
const REST_URL = (process.env.VITE_DERIV_REST_URL ?? "https://api.derivws.com").replace(
  /\/$/,
  "",
);
const SYMBOL = "R_75";
const SAMPLE = 8000;
const PAGE = 1000;
const PRIMARY = 1500;
const WINDOWS = [1000, 1500, 2000] as const;

async function fetchDigits(client: DerivClient): Promise<number[]> {
  const prices: number[] = [];
  let pipSize = 2;
  let end: number | "latest" = "latest";
  while (prices.length < SAMPLE) {
    const message = await client.send<HistoryResponse>({
      ticks_history: SYMBOL,
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
  return prices.map((q) => lastDigit(q, pipSize));
}

function coldPct(counts: number[], digit: number, n: number): number {
  return ((counts[digit] ?? 0) / n) * 100;
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
    const off = client.onStateChange((s) => {
      if (s === "ready") {
        off();
        resolve();
      }
    });
    client.connect();
  });
  console.log("Fetching ticks…");
  const digits = await fetchDigits(client);
  client.disconnect();
  console.log(`Got ${digits.length}\n`);

  const be = breakEvenDigitPercent("DIGITDIFF", SYMBOL);
  const start = Math.max(...WINDOWS);

  type Cfg = {
    name: string;
    z: number;
    edge: number;
    minGap: number;
    minLead: number;
    minMarginPp: number;
    requireUniqueEv: boolean;
    requireWindowAgree: boolean;
  };

  const configs: Cfg[] = [
    { name: "broken-v7", z: 2.576, edge: 0.8, minGap: 14, minLead: 12, minMarginPp: 3, requireUniqueEv: true, requireWindowAgree: true },
    { name: "w90 g10 l6 m1.5 u", z: 1.64, edge: 0, minGap: 10, minLead: 6, minMarginPp: 1.5, requireUniqueEv: true, requireWindowAgree: true },
    { name: "w90 g10 l6 m1.0 u", z: 1.64, edge: 0, minGap: 10, minLead: 6, minMarginPp: 1.0, requireUniqueEv: true, requireWindowAgree: true },
    { name: "w90 g10 l5 m1.5 u", z: 1.64, edge: 0, minGap: 10, minLead: 5, minMarginPp: 1.5, requireUniqueEv: true, requireWindowAgree: true },
    { name: "w90 g12 l5 m1.5 u", z: 1.64, edge: 0, minGap: 12, minLead: 5, minMarginPp: 1.5, requireUniqueEv: true, requireWindowAgree: true },
    { name: "w90 g14 l5 m1.5 u", z: 1.64, edge: 0, minGap: 14, minLead: 5, minMarginPp: 1.5, requireUniqueEv: true, requireWindowAgree: true },
    { name: "w90 g10 l8 m1.5 u", z: 1.64, edge: 0, minGap: 10, minLead: 8, minMarginPp: 1.5, requireUniqueEv: true, requireWindowAgree: true },
    { name: "w90 g10 l6 m1.2 u", z: 1.64, edge: 0, minGap: 10, minLead: 6, minMarginPp: 1.2, requireUniqueEv: true, requireWindowAgree: true },
    { name: "w90 g10 l6 m1.5", z: 1.64, edge: 0, minGap: 10, minLead: 6, minMarginPp: 1.5, requireUniqueEv: false, requireWindowAgree: true },
    { name: "w90 e0.1 g10 l5 m1.5 u", z: 1.64, edge: 0.1, minGap: 10, minLead: 5, minMarginPp: 1.5, requireUniqueEv: true, requireWindowAgree: true },
  ];

  console.log(
    `${"config".padEnd(24)} armed   win%     wait   evOk  agree  uniq  margin`,
  );

  for (const cfg of configs) {
    let ticks = 0;
    let armed = 0;
    let wins = 0;
    let evOkN = 0;
    let agreeN = 0;
    let uniqN = 0;
    let marginN = 0;

    for (let i = start; i < digits.length - 1; i += 1) {
      const stats = summarise(digits.slice(i - PRIMARY, i));
      const windowStats = WINDOWS.map((size) =>
        summarise(digits.slice(Math.max(0, i - size), i)),
      );
      ticks += 1;

      const cold = stats.coldest[0];
      const rival = stats.coldest[1];
      const pct = coldPct(stats.counts, cold, stats.sampleSize);
      const rivalPct = coldPct(stats.counts, rival, stats.sampleSize);
      const gap = stats.gaps[cold] ?? 0;
      const lead = (stats.counts[rival] ?? 0) - (stats.counts[cold] ?? 0);
      const marginPp = rivalPct - pct;
      const maxBarrier = be - cfg.edge;

      let ev = pct <= maxBarrier;
      if (cfg.z > 0 && ev) {
        const { upper } = wilsonInterval(stats.counts[cold] ?? 0, stats.sampleSize, cfg.z);
        ev = pct <= maxBarrier && upper * 100 <= maxBarrier;
      }
      if (ev) evOkN += 1;

      let rivalEv = rivalPct <= maxBarrier;
      if (cfg.z > 0 && rivalEv) {
        const { upper } = wilsonInterval(stats.counts[rival] ?? 0, stats.sampleSize, cfg.z);
        rivalEv = rivalPct <= maxBarrier && upper * 100 <= maxBarrier;
      }
      const unique = ev && !rivalEv;
      if (unique) uniqN += 1;

      const picks = windowStats.map((ws) => ws.coldest[0]);
      const agree = picks.every((d) => d === cold);
      if (agree) agreeN += 1;

      const marginOk = marginPp >= cfg.minMarginPp;
      if (marginOk) marginN += 1;

      const ok =
        ev &&
        gap >= cfg.minGap &&
        lead >= cfg.minLead &&
        marginOk &&
        (!cfg.requireUniqueEv || unique) &&
        (!cfg.requireWindowAgree || agree);

      if (ok) {
        armed += 1;
        if (digits[i] !== cold) wins += 1;
      }
    }

    const winPct = armed ? ((wins / armed) * 100).toFixed(1) : "—";
    const wait =
      armed === 0 ? "never" : `${((ticks / armed) * 2).toFixed(0)}s`;
    console.log(
      `${cfg.name.padEnd(24)} ${String(armed).padStart(5)}  ${String(winPct).padStart(6)}  ${wait.padStart(6)}  ${((evOkN / ticks) * 100).toFixed(1).padStart(5)}% ${((agreeN / ticks) * 100).toFixed(1).padStart(5)}% ${((uniqN / ticks) * 100).toFixed(1).padStart(5)}% ${((marginN / ticks) * 100).toFixed(1).padStart(5)}%`,
    );
  }

  console.log(`\nBreak-even Differs ${SYMBOL}: ${be.toFixed(2)}%`);
  console.log("Pick the strongest config with armed>0 and win% not clearly <90.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
