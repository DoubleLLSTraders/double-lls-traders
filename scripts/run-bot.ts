/**
 * Headless run of the real trading pipeline against the demo account.
 *
 * Uses the calibrated elite analyzer (v8), deep pre-flight, bulk buy and
 * settlement — same gates as the app. Demo token only.
 *
 *   npm run run-bot
 *   TRADES=3 RUN_SECONDS=1800 STAKE=0.35 npm run run-bot
 *
 * RESEARCH=1 keeps taking independent armed entries (new barrier after print)
 * so we can measure a few trades; the live UI still banks after 1 win.
 */
import { DerivClient } from "../src/lib/deriv/client";
import { resolveAccount } from "../src/lib/deriv/rest";
import { lastDigit, type HistoryResponse, type TickResponse } from "../src/lib/deriv/types";
import { summarise } from "../src/lib/analysis/digits";
import {
  buildMarketSignal,
  isArmedSignal,
  pickBetterSignal,
  confirmScore,
} from "../src/lib/analysis/signal";
import { findBestMarket } from "../src/lib/analysis/bestMarket";
import { capStake, evaluateEntry, stakeFromRisk } from "../src/lib/bot/gates";
import { analyzeNextPredictionDeep } from "../src/lib/bot/deepNext";
import {
  createDiffersFastBotSettings,
  DIFFERS_FAST_SYMBOL,
} from "../src/lib/bot/differsProfile";
import { effectiveDiffMultiple } from "../src/lib/bot/performance";
import { buyDigitContractsBulk, waitForBasketOutcome } from "../src/lib/deriv/trade";
import type { BotSettings } from "../src/lib/bot/types";

const APP_ID = process.env.VITE_DERIV_APP_ID?.trim() ?? "";
const TOKEN = process.env.VITE_DERIV_TOKEN_DEMO?.trim() ?? "";
const REST_URL = (process.env.VITE_DERIV_REST_URL ?? "https://api.derivws.com").replace(
  /\/$/,
  "",
);
const ACCOUNT_ID = process.env.VITE_DERIV_DEMO_ACCOUNT_ID?.trim() ?? "";
const TARGET_TRADES = Number(process.env.TRADES ?? 3);
const RESEARCH = process.env.RESEARCH !== "0";
const AGREEMENT_WINDOWS = [1000, 1500, 2000] as const;
const PRIMARY_WINDOW = 1500;

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
    dailyLossLimit: Number(process.env.VITE_DAILY_LOSS_LIMIT ?? 10),
    dailyProfitTarget: Number(process.env.VITE_DAILY_PROFIT_TARGET ?? 10),
    maxConsecutiveLosses: 1,
    maxTradesPerDay: 100,
    maxStake: Number(process.env.VITE_MAX_STAKE ?? 2),
  });
  const stake = Number(process.env.STAKE ?? base.stake);
  return {
    ...base,
    stake,
    maxStake: Math.max(base.maxStake, stake),
    contracts: Number(process.env.CONTRACTS ?? 1),
    maxRuns: RESEARCH ? TARGET_TRADES : 1,
    running: true,
  };
}

interface Tick {
  epoch: number;
  quote: number;
  pipSize: number;
  digit: number;
}

async function main() {
  const bot = settings();
  console.log(
    `Elite v8 · ${bot.contracts}x ${bot.stake} · gap≥${bot.minColdGap} · sample≥${bot.minSample} · research=${RESEARCH}`,
  );
  console.log(`Target ${TARGET_TRADES} armed trades on demo only.\n`);

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

  console.log("Scanning for an armed market…");
  const scanStart = Date.now();
  let best = await findBestMarket(client, bot, DIFFERS_FAST_SYMBOL, {
    requireReady: true,
  });
  if (!best) {
    console.log("No armed market yet · falling back to best available scan…");
    best = await findBestMarket(client, bot, DIFFERS_FAST_SYMBOL);
  }
  console.log(
    `Pick: ${best.name} (${best.symbol}) · ${best.signal.label} · power ${best.signal.power} · ${best.signal.confidence} · ${Date.now() - scanStart}ms`,
  );
  console.log(`  ${best.signal.reason.slice(0, 180)}\n`);

  const symbol = best.symbol;
  bot.side = best.signal.side;
  bot.prediction = best.signal.digit;

  let ticks: Tick[] = [];
  await client.subscribe<HistoryResponse | TickResponse>(
    {
      ticks_history: symbol,
      adjust_start_time: 1,
      count: 2500,
      end: "latest",
      style: "ticks",
    },
    (message) => {
      if (message.msg_type === "history") {
        const { prices, times } = message.history;
        const pipSize = message.pip_size;
        ticks = prices.map((quote, index) => ({
          epoch: times[index],
          quote,
          pipSize,
          digit: lastDigit(quote, pipSize),
        }));
      } else if (message.msg_type === "tick") {
        const { epoch, quote, pip_size: pipSize } = message.tick;
        if (ticks.length > 0 && ticks[ticks.length - 1].epoch >= epoch) return;
        ticks.push({
          epoch,
          quote,
          pipSize,
          digit: lastDigit(quote, pipSize),
        });
      }
    },
  );

  // Wait for feed to fill primary window.
  const feedDeadline = Date.now() + 60_000;
  while (ticks.length < PRIMARY_WINDOW && Date.now() < feedDeadline) {
    await new Promise((r) => setTimeout(r, 200));
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
    entryEpoch: number;
    contractIds: number[];
    label: string;
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

  const deadline = Date.now() + Number(process.env.RUN_SECONDS ?? 1800) * 1000;
  console.log(
    `Hunting armed entries until ${TARGET_TRADES} trades or ${Math.round((deadline - Date.now()) / 60000)}min…\n`,
  );

  while (session.trades < TARGET_TRADES && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
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
    const signal = pickBetterSignal(
      buildMarketSignal(stats, "DIGITMATCH", bot.prediction, options),
      buildMarketSignal(stats, "DIGITDIFF", bot.prediction, options),
      bot.sidePreference,
    );

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
        power: signal.power,
        gap: signal.watching.signalGap,
      });

      console.log(
        `  ${won ? "WIN " : "LOSS"} · ${open.label} · exit ${outcome.exitDigit ?? "?"} · ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} on ${exposure.toFixed(2)} · session ${session.pnl >= 0 ? "+" : ""}${session.pnl.toFixed(2)}`,
      );

      if (!won) {
        coolBarrierDigit = open.digit;
        if (!RESEARCH) {
          console.log("STOPPED · loss (live profile)");
          open = null;
          break;
        }
      } else if (!RESEARCH) {
        console.log("STOPPED · banked 1 win (live profile)");
        open = null;
        break;
      }

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

    const deep = analyzeNextPredictionDeep({
      signal,
      settings: bot,
      symbol,
      lastEntryDigit,
      lastEntryDigitPrinted,
      winsThisStart: RESEARCH ? 0 : session.wins,
      coolBarrierDigit,
      firstEntry: session.trades < 1 || RESEARCH,
    });
    if (!deep.ok) {
      skips += 1;
      if (skips % 20 === 1) {
        console.log(
          `  wait · ${deep.reason.replace(/^Deep · /, "")} · power ${signal.power} · ${signal.confidence}`,
        );
      }
      continue;
    }

    const gate = evaluateEntry(bot, signal, {
      tradesLastHour: 0,
      drawdownPercent: 0,
      lastEntryDigit,
      lastEntryDigitPrinted,
      coolBarrierDigit,
      balance,
      symbol,
    });
    if (!gate.ok) {
      skips += 1;
      if (skips % 20 === 1) console.log(`  skip · ${gate.reason}`);
      continue;
    }

    if (!isArmedSignal(signal)) {
      skips += 1;
      if (skips % 20 === 1) {
        console.log(
          `  wait · not armed · ${signal.confidence} · power ${signal.power}`,
        );
      }
      continue;
    }

    bot.side = signal.side;
    bot.prediction = signal.digit;
    const stake = capStake(bot.stake, bot, balance);

    console.log(
      `FIRE · ${deep.summary} · stake ${stake} · confirms ${confirmScore(signal)}/5`,
    );

    const bulk = await buyDigitContractsBulk(
      client,
      {
        symbol,
        side: bot.side,
        digit: bot.prediction,
        stake,
        currency,
        duration: bot.duration,
      },
      bot.contracts,
      { parallel: bot.parallelExecution },
    );

    if (bulk.filled.length === 0) {
      console.log(`  BUY FAIL · ${bulk.reasons[0] ?? "unknown"}`);
      continue;
    }

    const risk = stake * bulk.filled.length;
    const payout = bulk.filled.reduce((sum, leg) => sum + leg.payout, 0);
    const label = `${bot.side === "DIGITMATCH" ? "Matches" : "Differs"} ${bot.prediction}`;
    console.log(
      `OPEN ${label} · ${bulk.filled.length} leg · risk ${risk.toFixed(2)} / win +${(payout - risk).toFixed(2)} · power ${signal.power}`,
    );
    lastEntryDigit = bot.prediction;
    lastEntryEpoch = latest.epoch;
    open = {
      digit: bot.prediction,
      stake,
      contracts: bulk.filled.length,
      entryEpoch: latest.epoch,
      contractIds: bulk.filled.map((leg) => leg.contractId),
      label,
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
      power: 0,
      gap: null,
    });
    console.log(
      `  ${outcome.won ? "WIN " : "LOSS"} · exit ${outcome.exitDigit ?? "?"} · ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
    );
  }

  await new Promise((r) => setTimeout(r, 3000));

  console.log("\n──────── journal ────────");
  for (const [i, row] of journal.entries()) {
    console.log(
      `  #${i + 1} Differs ${row.digit} · ${row.won ? "WIN" : "LOSS"} · exit ${row.exit ?? "?"} · ${row.pnl >= 0 ? "+" : ""}${row.pnl.toFixed(2)}`,
    );
  }

  console.log("\n──────── session ────────");
  console.log(`Skips logged   : ~${skips}`);
  console.log(`Trades         : ${session.trades} (${session.wins}W / ${session.losses}L)`);
  console.log(`Bot P&L        : ${session.pnl >= 0 ? "+" : ""}${session.pnl.toFixed(2)} ${currency}`);
  console.log(`Balance delta  : ${(balance - startBalance) >= 0 ? "+" : ""}${(balance - startBalance).toFixed(2)} ${currency}`);
  console.log(
    `Match          : ${Math.abs(session.pnl - (balance - startBalance)) < 0.05 ? "OK" : "CHECK"}`,
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
    console.log(
      `Break-even     : ${breakEven.toFixed(2)}%  (payout ${multiple.toFixed(4)}x on ${bot.stake})`,
    );
    console.log(`Per trade      : ${(session.pnl / session.trades).toFixed(4)} ${currency}`);
    const verdict =
      ci.high < breakEven
        ? "LOSING · CI entirely under break-even."
        : ci.low > breakEven
          ? "PROFITABLE · CI entirely over break-even."
          : "INCONCLUSIVE · need more trades (fair Differs ≈90% vs BE ≈91%).";
    console.log(`Verdict        : ${verdict}`);
  } else {
    console.log("\nNo armed trade fired before timeout.");
    console.log("Elite bar is rare (~0.13% of ticks) — try RUN_SECONDS=3600.");
  }

  client.disconnect();
  process.exit(session.trades > 0 ? 0 : 2);
}

main().catch((error: Error) => {
  console.error(`FATAL: ${error.message}`);
  process.exit(1);
});
