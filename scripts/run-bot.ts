/**
 * Headless demo trading — FAST research by default so buys actually fire.
 *
 *   npm run run-bot                         # fast research, 5 trades
 *   TRADES=5 STAKE=0.35 npm run run-bot
 *   FAST=0 npm run run-bot                  # elite gates (slow / rare)
 *
 * Demo token only. Does not change the app's live elite profile.
 */
import { DerivClient } from "../src/lib/deriv/client";
import { resolveAccount } from "../src/lib/deriv/rest";
import { lastDigit, type HistoryResponse, type TickResponse } from "../src/lib/deriv/types";
import { summarise } from "../src/lib/analysis/digits";
import {
  buildMarketSignal,
  isArmedSignal,
  confirmScore,
  type MarketSignal,
} from "../src/lib/analysis/signal";
import { capStake, evaluateEntry, exposureCap, stakeFromRisk } from "../src/lib/bot/gates";
import { analyzeNextPredictionDeep } from "../src/lib/bot/deepNext";
import {
  createDiffersFastBotSettings,
  DIFFERS_FAST_SYMBOL,
} from "../src/lib/bot/differsProfile";
import { effectiveDiffMultiple, isLowPayoutSymbol } from "../src/lib/bot/performance";
import { buyDigitContractsBulk, waitForBasketOutcome } from "../src/lib/deriv/trade";
import type { BotSettings } from "../src/lib/bot/types";

const APP_ID = process.env.VITE_DERIV_APP_ID?.trim() ?? "";
const TOKEN = process.env.VITE_DERIV_TOKEN_DEMO?.trim() ?? "";
const REST_URL = (process.env.VITE_DERIV_REST_URL ?? "https://api.derivws.com").replace(
  /\/$/,
  "",
);
const ACCOUNT_ID = process.env.VITE_DERIV_DEMO_ACCOUNT_ID?.trim() ?? "";
const TARGET_TRADES = Number(process.env.TRADES ?? 5);
/** Fast research is ON by default — elite waits forever in live time. */
const FAST = process.env.FAST !== "0";
const SYMBOL = process.env.SYMBOL?.trim() || DIFFERS_FAST_SYMBOL;
const AGREEMENT_WINDOWS = FAST
  ? ([500, 1000] as const)
  : ([1000, 1500, 2000] as const);
const PRIMARY_WINDOW = FAST ? 500 : 1500;

function wilson(wins: number, n: number, z = 1.96): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 100 };
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    low: ((centre - spread) / denom) * 100,
    high: ((centre + spread) / denom) * 100,
  };
}

function settings(): BotSettings {
  const base = createDiffersFastBotSettings({
    dailyLossLimit: Number(process.env.VITE_DAILY_LOSS_LIMIT ?? 20),
    dailyProfitTarget: Number(process.env.VITE_DAILY_PROFIT_TARGET ?? 20),
    maxConsecutiveLosses: 99,
    maxTradesPerDay: 500,
    maxStake: Number(process.env.VITE_MAX_STAKE ?? 5),
  });
  const stake = Number(process.env.STAKE ?? 0.35);

  if (FAST) {
    // Soft research gates — timing + sample + barrier. Fires in seconds/minutes.
    return {
      ...base,
      stake,
      maxStake: Math.max(base.maxStake, stake),
      contracts: Number(process.env.CONTRACTS ?? 1),
      minSample: 200,
      minEdgePercent: 0,
      minColdGap: 4,
      maxMomentumGap: 3,
      skipLowConfidence: false,
      requireFullConfirm: false,
      requireMultiWindow: false,
      requireWindowsEv: false,
      requireTiming: true,
      requireUneven: false,
      maxTradesPerHour: 120,
      maxRuns: TARGET_TRADES,
      maxConsecutiveLosses: 99,
      running: true,
    };
  }

  return {
    ...base,
    stake,
    maxStake: Math.max(base.maxStake, stake),
    contracts: Number(process.env.CONTRACTS ?? 1),
    maxRuns: TARGET_TRADES,
    running: true,
  };
}

/** Fast path: Differs #1 cold with gap + sample. No unique-EV / power-100. */
function fastEntryOk(
  signal: MarketSignal,
  bot: BotSettings,
  extras: {
    lastEntryDigit: number | null;
    lastEntryDigitPrinted: boolean;
    coolBarrierDigit: number | null;
    symbol: string;
  },
): { ok: true } | { ok: false; reason: string } {
  if (isLowPayoutSymbol(extras.symbol)) {
    return { ok: false, reason: `Skip · ${extras.symbol} low payout` };
  }
  if (signal.side !== "DIGITDIFF") {
    return { ok: false, reason: "Skip · not Differs" };
  }
  if (signal.watching.sampleSize < bot.minSample) {
    return {
      ok: false,
      reason: `Skip · sample ${signal.watching.sampleSize}/${bot.minSample}`,
    };
  }
  if (!signal.primaryBarrier && !signal.barrierAligned) {
    return { ok: false, reason: "Skip · not cold barrier" };
  }
  if (!signal.timingOk) {
    return {
      ok: false,
      reason: `Skip · cold gap ${signal.watching.signalGap ?? "—"} < ${bot.minColdGap}`,
    };
  }
  if (
    extras.coolBarrierDigit !== null &&
    signal.digit === extras.coolBarrierDigit
  ) {
    return { ok: false, reason: `Skip · lost on ${signal.digit} already` };
  }
  if (
    extras.lastEntryDigit !== null &&
    extras.lastEntryDigit === signal.digit &&
    !extras.lastEntryDigitPrinted
  ) {
    return {
      ok: false,
      reason: `Wait · re-backing ${signal.digit} · need print first`,
    };
  }
  return { ok: true };
}

interface Tick {
  epoch: number;
  quote: number;
  pipSize: number;
  digit: number;
}

async function bootstrapHistory(
  client: DerivClient,
  symbol: string,
  need: number,
): Promise<Tick[]> {
  const prices: number[] = [];
  const times: number[] = [];
  let pipSize = 2;
  let end: number | "latest" = "latest";
  while (prices.length < need) {
    const message = await client.send<HistoryResponse>({
      ticks_history: symbol,
      adjust_start_time: 1,
      count: 1000,
      end,
      style: "ticks",
    });
    const batchTimes = message.history?.times ?? [];
    if (batchTimes.length === 0) break;
    pipSize = message.pip_size ?? pipSize;
    prices.unshift(...message.history.prices);
    times.unshift(...batchTimes);
    const earliest = batchTimes[0];
    if (end !== "latest" && earliest >= end) break;
    end = earliest - 1;
  }
  return prices.map((quote, index) => ({
    epoch: times[index],
    quote,
    pipSize,
    digit: lastDigit(quote, pipSize),
  }));
}

async function main() {
  const bot = settings();
  console.log(
    `${FAST ? "FAST research" : "Elite"} · ${bot.contracts}x ${bot.stake} · gap≥${bot.minColdGap} · sample≥${bot.minSample} · ${SYMBOL}`,
  );
  console.log(`Target ${TARGET_TRADES} demo trades — buys WILL fire when gate clears.\n`);

  const account = await resolveAccount(
    { appId: APP_ID, restUrl: REST_URL, token: TOKEN },
    "demo",
    ACCOUNT_ID || undefined,
  );
  const currency = account.currency || "USD";
  const client = new DerivClient({
    appId: APP_ID,
    restUrl: REST_URL,
    token: TOKEN,
    accountId: account.accountId,
  });

  await new Promise<void>((resolve, reject) => {
    const off = client.onStateChange((state) => {
      if (state === "ready") {
        off();
        resolve();
      }
    });
    client.onError((error) => reject(error));
    client.connect();
  });
  console.log(`Connected · ${account.accountId}`);

  let balance = account.balance;
  await client.subscribe<{ balance: { balance: number } }>(
    { balance: 1 },
    (message) => {
      balance = message.balance.balance;
    },
  );
  const startBalance = balance;
  console.log(`Balance: ${startBalance.toFixed(2)} ${currency}\n`);

  const symbol = SYMBOL;
  console.log(`Bootstrapping ${symbol}…`);
  let ticks = await bootstrapHistory(client, symbol, FAST ? 800 : 2500);
  console.log(`History · ${ticks.length} ticks`);

  await client.subscribe<HistoryResponse | TickResponse>(
    {
      ticks_history: symbol,
      adjust_start_time: 1,
      count: 5,
      end: "latest",
      style: "ticks",
    },
    (message) => {
      if (message.msg_type === "tick") {
        const { epoch, quote, pip_size: pip } = message.tick;
        if (ticks.length > 0 && ticks[ticks.length - 1].epoch >= epoch) return;
        ticks.push({
          epoch,
          quote,
          pipSize: pip,
          digit: lastDigit(quote, pip),
        });
        if (ticks.length > 4000) ticks = ticks.slice(-3500);
      }
    },
  );

  while (ticks.length < PRIMARY_WINDOW) {
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log(`Feed ready · ${ticks.length} ticks on ${symbol}\n`);

  const session = {
    trades: 0,
    wins: 0,
    losses: 0,
    pnl: 0,
    currentStake: stakeFromRisk(bot, balance, bot.maxStake),
  };
  let open: null | {
    digit: number;
    stake: number;
    contracts: number;
    contractIds: number[];
    label: string;
    power: number;
    gap: number | null;
  } = null;
  let handled = -1;
  let skips = 0;
  let lastEntryDigit: number | null = null;
  let lastEntryEpoch: number | null = null;
  let coolBarrierDigit: number | null = null;
  const journal: Array<{
    digit: number;
    won: boolean;
    pnl: number;
    exit: number | null;
    power: number;
    gap: number | null;
  }> = [];

  const deadline =
    Date.now() + Number(process.env.RUN_SECONDS ?? (FAST ? 600 : 2400)) * 1000;
  console.log(
    `Hunting until ${TARGET_TRADES} trades or ${Math.round((deadline - Date.now()) / 60000)}min…\n`,
  );

  while (session.trades < TARGET_TRADES && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, FAST ? 120 : 250));
    const latest = ticks[ticks.length - 1];
    if (!latest || latest.epoch === handled) continue;
    handled = latest.epoch;

    const digits = ticks.map((tick) => tick.digit);
    const stats = summarise(digits.slice(-PRIMARY_WINDOW));
    const options = {
      windowStats: AGREEMENT_WINDOWS.map((size) => summarise(digits.slice(-size))),
      windowSizes: [...AGREEMENT_WINDOWS],
      minEdgePercent: bot.minEdgePercent,
      maxMomentumGap: bot.maxMomentumGap,
      minColdGap: bot.minColdGap,
      symbol,
    };
    const signal = buildMarketSignal(stats, "DIGITDIFF", bot.prediction, options);

    if (open) {
      const outcome = await waitForBasketOutcome(client, open.contractIds);
      const won = outcome.won;
      const exposure = open.stake * open.contracts;
      const pnl = outcome.profit;
      session.pnl += pnl;
      session.trades += 1;
      session.wins += won ? 1 : 0;
      session.losses += won ? 0 : 1;
      journal.push({
        digit: open.digit,
        won,
        pnl,
        exit: outcome.exitDigit,
        power: open.power,
        gap: open.gap,
      });

      console.log(
        `  ${won ? "WIN " : "LOSS"} · ${open.label} · exit ${outcome.exitDigit ?? "?"} · ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} on ${exposure.toFixed(2)} · session ${session.pnl >= 0 ? "+" : ""}${session.pnl.toFixed(2)}`,
      );

      if (!won) coolBarrierDigit = open.digit;
      open = null;
      session.currentStake = stakeFromRisk(bot, balance, bot.maxStake);
      continue;
    }

    const lastEntryDigitPrinted =
      lastEntryDigit === null || lastEntryEpoch === null
        ? true
        : ticks.some(
            (tick) => tick.epoch > lastEntryEpoch! && tick.digit === lastEntryDigit,
          );

    let allow = false;
    let reason = "";

    if (FAST) {
      const fast = fastEntryOk(signal, bot, {
        lastEntryDigit,
        lastEntryDigitPrinted,
        coolBarrierDigit,
        symbol,
      });
      allow = fast.ok;
      reason = fast.ok ? "" : fast.reason;
      // Exposure ceiling only — do not run elite EV/confidence (those never fire).
      if (allow) {
        const cap = exposureCap(bot, balance);
        if (cap && !cap.affordable) {
          allow = false;
          reason = `Skip · balance too small for ${bot.maxExposurePercent}% cap`;
        }
      }
    } else {
      const deep = analyzeNextPredictionDeep({
        signal,
        settings: bot,
        symbol,
        lastEntryDigit,
        lastEntryDigitPrinted,
        winsThisStart: 0,
        coolBarrierDigit,
        firstEntry: true,
      });
      if (!deep.ok) {
        allow = false;
        reason = deep.reason;
      } else if (!isArmedSignal(signal)) {
        allow = false;
        reason = `not armed · ${signal.confidence} · power ${signal.power}`;
      } else {
        const gate = evaluateEntry(bot, signal, {
          lastEntryDigit,
          lastEntryDigitPrinted,
          coolBarrierDigit,
          balance,
          symbol,
        });
        allow = gate.ok;
        reason = gate.ok ? "" : gate.reason;
      }
    }

    if (!allow) {
      skips += 1;
      if (skips % (FAST ? 8 : 20) === 1) {
        console.log(
          `  wait · ${reason.replace(/^Deep · /, "")} · gap ${signal.watching.signalGap ?? "—"} · ${signal.digitPercent.toFixed(1)}% · power ${signal.power}`,
        );
      }
      continue;
    }

    bot.side = signal.side;
    bot.prediction = signal.digit;
    const stake = capStake(bot.stake, bot, balance);

    console.log(
      `FIRE · Differs ${signal.digit} · gap ${signal.watching.signalGap} · ${signal.digitPercent.toFixed(1)}% · power ${signal.power} · confirms ${confirmScore(signal)}/5 · stake ${stake}`,
    );

    const bulk = await buyDigitContractsBulk(
      client,
      {
        symbol,
        side: "DIGITDIFF",
        digit: signal.digit,
        stake,
        currency,
        duration: bot.duration,
      },
      bot.contracts,
      { parallel: true },
    );

    if (bulk.filled.length === 0) {
      console.log(`  BUY FAIL · ${bulk.reasons[0] ?? "unknown"}`);
      continue;
    }

    const risk = stake * bulk.filled.length;
    const payout = bulk.filled.reduce((sum, leg) => sum + leg.payout, 0);
    const label = `Differs ${signal.digit}`;
    console.log(
      `OPEN ${label} · risk ${risk.toFixed(2)} / win +${(payout - risk).toFixed(2)} · id ${bulk.filled[0].contractId}`,
    );
    lastEntryDigit = signal.digit;
    lastEntryEpoch = latest.epoch;
    open = {
      digit: signal.digit,
      stake,
      contracts: bulk.filled.length,
      contractIds: bulk.filled.map((leg) => leg.contractId),
      label,
      power: signal.power,
      gap: signal.watching.signalGap,
    };
  }

  if (open) {
    console.log("Waiting final settlement…");
    const outcome = await waitForBasketOutcome(client, open.contractIds);
    const pnl = outcome.profit;
    session.pnl += pnl;
    session.trades += 1;
    session.wins += outcome.won ? 1 : 0;
    session.losses += outcome.won ? 0 : 1;
    journal.push({
      digit: open.digit,
      won: outcome.won,
      pnl,
      exit: outcome.exitDigit,
      power: open.power,
      gap: open.gap,
    });
    console.log(
      `  ${outcome.won ? "WIN " : "LOSS"} · exit ${outcome.exitDigit ?? "?"} · ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
    );
  }

  await new Promise((r) => setTimeout(r, 2000));

  console.log("\n──────── journal ────────");
  for (const [i, row] of journal.entries()) {
    console.log(
      `  #${i + 1} Differs ${row.digit} · ${row.won ? "WIN" : "LOSS"} · exit ${row.exit ?? "?"} · ${row.pnl >= 0 ? "+" : ""}${row.pnl.toFixed(2)} · gap ${row.gap ?? "—"}`,
    );
  }

  console.log("\n──────── session ────────");
  console.log(`Mode           : ${FAST ? "FAST research" : "elite"}`);
  console.log(`Skips          : ${skips}`);
  console.log(`Trades         : ${session.trades} (${session.wins}W / ${session.losses}L)`);
  console.log(
    `Bot P&L        : ${session.pnl >= 0 ? "+" : ""}${session.pnl.toFixed(2)} ${currency}`,
  );
  console.log(
    `Balance delta  : ${balance - startBalance >= 0 ? "+" : ""}${(balance - startBalance).toFixed(2)} ${currency}`,
  );

  if (session.trades > 0) {
    const multiple = effectiveDiffMultiple(bot.stake, symbol);
    const breakEven = (1 / multiple) * 100;
    const ci = wilson(session.wins, session.trades);
    const rate = (session.wins / session.trades) * 100;
    console.log("\n──────── verdict ────────");
    console.log(
      `Win rate       : ${rate.toFixed(2)}%  95% CI [${ci.low.toFixed(2)} - ${ci.high.toFixed(2)}]`,
    );
    console.log(`Break-even     : ${breakEven.toFixed(2)}%`);
    console.log(`Per trade      : ${(session.pnl / session.trades).toFixed(4)} ${currency}`);
  } else {
    console.log("\nNo trades fired — check token / feed.");
  }

  client.disconnect();
  process.exit(session.trades > 0 ? 0 : 2);
}

main().catch((error: Error) => {
  console.error(`FATAL: ${error.message}`);
  process.exit(1);
});
