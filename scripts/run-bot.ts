/**
 * Headless run of the real trading pipeline against the demo account.
 *
 * Imports the app's own analyzer, entry gates, bulk buy and settlement code —
 * nothing here re-implements bot logic — then reports whether the recorded
 * session P&L matches the actual balance change.
 *
 *   npm run run-bot            # 5 trades
 *   TRADES=10 npm run run-bot
 */
import { DerivClient } from "../src/lib/deriv/client";
import { resolveAccount } from "../src/lib/deriv/rest";
import { lastDigit, type HistoryResponse, type TickResponse } from "../src/lib/deriv/types";
import { summarise } from "../src/lib/analysis/digits";
import { buildMarketSignal, pickBetterSignal, confirmScore } from "../src/lib/analysis/signal";
import { findBestMarket } from "../src/lib/analysis/bestMarket";
import { capStake, evaluateEntry, recoveryStake, stakeFromRisk } from "../src/lib/bot/gates";
import { effectiveDiffMultiple, settleContractPnl } from "../src/lib/bot/performance";
import { buyDigitContractsBulk, waitForBasketOutcome } from "../src/lib/deriv/trade";
import type { BotSettings } from "../src/lib/bot/types";

const APP_ID = process.env.VITE_DERIV_APP_ID?.trim() ?? "";
const TOKEN = process.env.VITE_DERIV_TOKEN_DEMO?.trim() ?? "";
const REST_URL = (process.env.VITE_DERIV_REST_URL ?? "https://api.derivws.com").replace(/\/$/, "");
const ACCOUNT_ID = process.env.VITE_DERIV_DEMO_ACCOUNT_ID?.trim() ?? "";
const TARGET_TRADES = Number(process.env.TRADES ?? 5);
const AGREEMENT_WINDOWS = [500, 1000, 2000];
const PRIMARY_WINDOW = 1000;

/**
 * Wilson score interval for a win rate, in percent. Preferred over the normal
 * approximation here because proportions near 90% on modest samples push the
 * simple interval above 100%.
 */
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

/** Mirrors defaultBotSettings() + CONFIRMED_ENTRY_PATCH in App.tsx (v12). */
function settings(): BotSettings {
  return {
    side: "DIGITDIFF",
    prediction: 0,
    stake: Number(process.env.STAKE ?? 1.75),
    contracts: Number(process.env.CONTRACTS ?? 1),
    duration: 1,
    martingale: false,
    martingaleMultiplier: 2,
    maxMartingaleSteps: 3,
    autoFollow: true,
    autoSide: true,
    sidePreference: "differs",
    parallelExecution: true,
    armSeconds: 0,
    minSample: 865,
    minEdgePercent: 0,
    skipLowConfidence: false,
    requireFullConfirm: false,
    requireMultiWindow: false,
    requireWindowsEv: false,
    requireTiming: true,
    requireUneven: false,
    pauseIfBelowBreakEvenAfter: 0,
    pauseIfExpectancyNegativeAfter: 0,
    maxDrawdownPercent: 0,
    maxTradesPerHour: 60,
    maxMomentumGap: 3,
    minColdGap: 6,
    cooldownTicks: 1,
    riskPercent: 0,
    dailyLossLimit: Number(process.env.VITE_DAILY_LOSS_LIMIT ?? 5),
    dailyProfitTarget: Number(process.env.VITE_DAILY_PROFIT_TARGET ?? 5),
    maxConsecutiveLosses: Number(process.env.VITE_MAX_CONSECUTIVE_LOSSES ?? 5),
    maxTradesPerDay: Number(process.env.VITE_MAX_TRADES_PER_DAY ?? 100),
    maxStake: Number(process.env.VITE_MAX_STAKE ?? 2),
    maxExposurePercent: Number(process.env.MAX_EXPOSURE_PERCENT ?? 2),
    takeProfit: Number(process.env.TAKE_PROFIT ?? 0),
    stopLoss: Number(process.env.STOP_LOSS ?? 0),
    maxRuns: Number(process.env.MAX_RUNS ?? 0),
    running: true,
  } as BotSettings;
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
    `Settings · ${bot.contracts}x ${bot.stake} · ${bot.sidePreference} · parallel=${bot.parallelExecution} · dailyCap ${bot.dailyLossLimit}\n`,
  );

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
  await client.subscribe<{ balance: { balance: number } }>({ balance: 1 }, (message) => {
    balance = message.balance.balance;
  });
  const startBalance = balance;
  console.log(`Balance: ${startBalance.toFixed(2)} ${currency}\n`);

  // 1. Real analyzer market scan, exactly as Start does.
  console.log("Scanning markets with the analyzer…");
  const scanStart = Date.now();
  const best = await findBestMarket(client, bot, "R_100");
  console.log(
    `Best: ${best.name} (${best.symbol}) · ${best.signal.label} · score ${best.score.toFixed(2)} · ${Date.now() - scanStart}ms`,
  );
  console.log(`  reason: ${best.signal.reason}\n`);

  const symbol = best.symbol;
  bot.side = best.signal.side;
  bot.prediction = best.signal.digit;

  // 2. Live tick feed for that market.
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
        ticks.push({ epoch, quote, pipSize, digit: lastDigit(quote, pipSize) });
      }
    },
  );

  // 3. Trade loop driven by the same signal + gate code the UI uses.
  const session = {
    trades: 0,
    wins: 0,
    losses: 0,
    pnl: 0,
    currentStake: stakeFromRisk(bot, balance, bot.maxStake),
    martingaleSteps: 0,
    consecutiveLosses: 0,
  };
  let open: null | {
    digit: number;
    stake: number;
    contracts: number;
    entryEpoch: number;
    payout: number;
    contractIds: number[];
  } = null;
  let handled = -1;
  let skips = 0;
  let lastEntryDigit: number | null = null;
  let lastEntryEpoch: number | null = null;

  const deadline = Date.now() + Number(process.env.RUN_SECONDS ?? 240) * 1000;
  while (session.trades < TARGET_TRADES && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const latest = ticks[ticks.length - 1];
    if (!latest || latest.epoch === handled) continue;
    handled = latest.epoch;

    const digits = ticks.map((tick) => tick.digit);
    const stats = summarise(digits.slice(-PRIMARY_WINDOW));
    const options = {
      windowStats: AGREEMENT_WINDOWS.map((size) => summarise(digits.slice(-size))),
      windowSizes: AGREEMENT_WINDOWS,
      minEdgePercent: bot.minEdgePercent,
      maxMomentumGap: bot.maxMomentumGap,
      minColdGap: bot.minColdGap,
    };
    const signal = pickBetterSignal(
      buildMarketSignal(stats, "DIGITMATCH", bot.prediction, options),
      buildMarketSignal(stats, "DIGITDIFF", bot.prediction, options),
      bot.sidePreference,
    );

    if (open) {
      // Authoritative outcome from Deriv, same as the app now does.
      const outcome = await waitForBasketOutcome(client, open.contractIds);
      const won = outcome.won;
      const exposure = open.stake * open.contracts;
      const pnl = outcome.profit;
      void settleContractPnl;
      session.pnl += pnl;
      session.trades += 1;
      session.wins += won ? 1 : 0;
      session.losses += won ? 0 : 1;
      session.consecutiveLosses = won ? 0 : session.consecutiveLosses + 1;

      console.log(
        `  ${won ? "WIN " : "LOSS"} · deriv profit ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} on ${exposure.toFixed(2)} risk · session ${session.pnl.toFixed(2)}`,
      );

      // Progress marker so a multi-hour run is legible at a glance.
      if (session.trades % 25 === 0) {
        const rate = (session.wins / session.trades) * 100;
        console.log(
          `\n  ▸ ${session.trades}/${TARGET_TRADES} trades · ${rate.toFixed(1)}% wins · P&L ${session.pnl.toFixed(2)} ${currency}\n`,
        );
      }

      if (won) {
        session.martingaleSteps = 0;
        session.currentStake = stakeFromRisk(bot, balance, bot.maxStake);
      } else if (bot.martingale) {
        const deficit = Math.abs(Math.min(0, session.pnl));
        const plan = recoveryStake(deficit, bot.side, bot.contracts, bot.stake, bot.maxStake);
        const budget = bot.dailyLossLimit - deficit;
        if (session.martingaleSteps + 1 > bot.maxMartingaleSteps) {
          session.martingaleSteps = 0;
          session.currentStake = stakeFromRisk(bot, balance, bot.maxStake);
          console.log("       reset · step cap");
        } else if (!plan.enough) {
          session.martingaleSteps = 0;
          session.currentStake = stakeFromRisk(bot, balance, bot.maxStake);
          console.log("       reset · recovery over max stake");
        } else if (plan.exposure > budget) {
          session.martingaleSteps = 0;
          session.currentStake = stakeFromRisk(bot, balance, bot.maxStake);
          console.log(
            `       reset · recovery ${plan.exposure.toFixed(2)} > daily room ${budget.toFixed(2)}`,
          );
        } else {
          session.martingaleSteps += 1;
          session.currentStake = plan.stake;
          console.log(
            `       recover step ${session.martingaleSteps} · ${plan.stake} x ${bot.contracts} = ${plan.exposure.toFixed(2)} to clear ${deficit.toFixed(2)}`,
          );
        }
      }

      if (session.pnl <= -bot.dailyLossLimit) {
        console.log("STOPPED · daily loss cap");
        break;
      }
      if (session.consecutiveLosses >= bot.maxConsecutiveLosses) {
        console.log("STOPPED · max consecutive losses");
        break;
      }
      open = null;
      continue;
    }

    // Same extras the app passes, so this run exercises the repeat-barrier
    // rule and the balance ceiling rather than a softer version of the gate.
    const lastEntryDigitPrinted =
      lastEntryDigit === null || lastEntryEpoch === null
        ? true
        : ticks.some((tick) => tick.epoch > lastEntryEpoch && tick.digit === lastEntryDigit);
    const gate = evaluateEntry(bot, signal, {
      tradesLastHour: 0,
      drawdownPercent: 0,
      lastEntryDigit,
      lastEntryDigitPrinted,
      balance,
    });
    if (!gate.ok) {
      skips += 1;
      if (skips % 10 === 1) console.log(`  skip: ${gate.reason}`);
      continue;
    }

    bot.side = signal.side;
    bot.prediction = signal.digit;
    const stake = capStake(
      session.martingaleSteps > 0 ? session.currentStake : bot.stake,
      bot,
      balance,
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

    const payout = bulk.filled.reduce((sum, leg) => sum + leg.payout, 0);
    console.log(
      `OPEN ${bot.side === "DIGITMATCH" ? "Matches" : "Differs"} ${bot.prediction} · ${bulk.filled.length}/${bot.contracts} legs · risk ${(stake * bulk.filled.length).toFixed(2)} / win +${(payout - stake * bulk.filled.length).toFixed(2)} · confirms ${confirmScore(signal)}/5`,
    );
    lastEntryDigit = bot.prediction;
    lastEntryEpoch = latest.epoch;
    open = {
      digit: bot.prediction,
      stake,
      contracts: bulk.filled.length,
      entryEpoch: latest.epoch,
      payout,
      contractIds: bulk.filled.map((leg) => leg.contractId),
    };
  }

  // Let the last settlement reach the balance stream.
  await new Promise((r) => setTimeout(r, 4000));

  console.log("\n──────── session ────────");
  console.log(`Trades         : ${session.trades} (${session.wins}W / ${session.losses}L)`);
  console.log(`Bot P&L        : ${session.pnl.toFixed(2)} ${currency}`);
  console.log(`Balance delta  : ${(balance - startBalance).toFixed(2)} ${currency}`);
  console.log(
    `Match          : ${Math.abs(session.pnl - (balance - startBalance)) < 0.01 ? "EXACT" : "MISMATCH"}`,
  );

  if (session.trades > 0) {
    const multiple = effectiveDiffMultiple(bot.stake, symbol);
    const breakEven = (1 / multiple) * 100;
    const ci = wilson(session.wins, session.trades);
    const rate = (session.wins / session.trades) * 100;

    console.log("\n──────── verdict ────────");
    console.log(`Win rate       : ${rate.toFixed(2)}%  95% CI [${ci.low.toFixed(2)} - ${ci.high.toFixed(2)}]`);
    console.log(`Break-even     : ${breakEven.toFixed(2)}%  (payout ${multiple.toFixed(4)}x on ${bot.stake})`);
    console.log(`Per trade      : ${(session.pnl / session.trades).toFixed(4)} ${currency}`);

    // The only question worth asking of a live sample: could this strategy be
    // profitable at all? If the whole interval sits under break-even the answer
    // is no. If break-even is inside it, the sample is simply too small to say.
    const verdict =
      ci.high < breakEven
        ? "LOSING · the entire confidence interval is below break-even."
        : ci.low > breakEven
          ? "PROFITABLE · the entire interval clears break-even."
          : "INCONCLUSIVE · break-even sits inside the interval; more trades needed.";
    console.log(`Verdict        : ${verdict}`);

    if (session.trades < 200) {
      console.log(
        `\nOnly ${session.trades} trades. Around 200 is the point where a 2-point\n` +
          `gap from break-even starts to separate from noise.`,
      );
    }
  }

  client.disconnect();
  process.exit(0);
}

main().catch((error: Error) => {
  console.error(`FATAL: ${error.message}`);
  process.exit(1);
});
