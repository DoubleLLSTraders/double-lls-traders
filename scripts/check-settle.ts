/**
 * Determines which tick a 1-tick digit contract actually settles on, by buying
 * one contract and comparing Deriv's own entry/exit spots against the local
 * tick stream. Diagnoses off-by-one errors in the bot's settlement rule.
 *
 *   npm run check-settle
 */
import { DerivClient } from "../src/lib/deriv/client";
import { resolveAccount } from "../src/lib/deriv/rest";
import { lastDigit, type HistoryResponse, type TickResponse } from "../src/lib/deriv/types";
import { buyDigitContract } from "../src/lib/deriv/trade";

const APP_ID = process.env.VITE_DERIV_APP_ID?.trim() ?? "";
const TOKEN = process.env.VITE_DERIV_TOKEN_DEMO?.trim() ?? "";
const REST_URL = (process.env.VITE_DERIV_REST_URL ?? "https://api.derivws.com").replace(/\/$/, "");
const SYMBOL = process.env.VITE_DEFAULT_SYMBOL?.trim() || "R_100";
const STAKE = Number(process.env.VITE_BASE_STAKE ?? 0.35);
const DIGIT = 5;

interface Poc {
  proposal_open_contract: {
    is_sold: 0 | 1;
    profit: number | string;
    entry_spot?: number;
    exit_tick?: number;
    entry_tick_time?: number;
    exit_tick_time?: number;
    status: string;
  };
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

  const ticks: Array<{ epoch: number; digit: number; quote: number }> = [];
  await client.subscribe<HistoryResponse | TickResponse>(
    { ticks_history: SYMBOL, adjust_start_time: 1, count: 20, end: "latest", style: "ticks" },
    (message) => {
      if (message.msg_type === "history") {
        const { prices, times } = message.history;
        for (let i = 0; i < prices.length; i += 1) {
          ticks.push({
            epoch: times[i],
            quote: prices[i],
            digit: lastDigit(prices[i], message.pip_size),
          });
        }
      } else if (message.msg_type === "tick") {
        const { epoch, quote, pip_size: pipSize } = message.tick;
        if (ticks.length > 0 && ticks[ticks.length - 1].epoch >= epoch) return;
        ticks.push({ epoch, quote, digit: lastDigit(quote, pipSize) });
      }
    },
  );

  const TRIALS = Number(process.env.TRIALS ?? 12);
  const agree = [0, 0, 0];
  const seen = [0, 0, 0];
  let informative = 0;

  for (let trial = 0; trial < TRIALS; trial += 1) {
    await new Promise((r) => setTimeout(r, 1200));
    const entryEpoch = ticks[ticks.length - 1].epoch;

    const result = await buyDigitContract(client, {
      symbol: SYMBOL,
      side: "DIGITDIFF",
      digit: DIGIT,
      stake: STAKE,
      currency: account.currency || "USD",
      duration: 1,
    });

    // Wait for at least 3 ticks past entry so every offset is observable.
    for (let wait = 0; wait < 40; wait += 1) {
      if (ticks.filter((tick) => tick.epoch > entryEpoch).length >= 3) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    let poc: Poc["proposal_open_contract"] | null = null;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const reply = await client.send<Poc>({
        proposal_open_contract: 1,
        contract_id: result.contractId,
      });
      if (reply.proposal_open_contract.is_sold === 1) {
        poc = reply.proposal_open_contract;
        break;
      }
      await new Promise((r) => setTimeout(r, 900));
    }
    if (!poc) {
      console.log(`trial ${trial + 1}: never settled, skipping`);
      continue;
    }

    const after = ticks.filter((tick) => tick.epoch > entryEpoch);
    const derivWon = Number(poc.profit) > 0;
    const digits = after.slice(0, 3).map((tick) => tick.digit);

    // entry_spot identifies which local tick the contract actually started on.
    const startIndex = after.findIndex((tick) => tick.quote === Number(poc!.entry_spot));
    console.log(
      `        quotes +1=${after[0]?.quote} +2=${after[1]?.quote} · entry_spot=${poc.entry_spot} → starts at +${startIndex + 1}, so 1-tick exit = +${startIndex + 2}`,
    );

    // Only trials where the offsets disagree can tell them apart.
    const verdicts = digits.map((digit) => digit !== DIGIT);
    const decisive = verdicts.length >= 2 && verdicts[0] !== verdicts[1];
    if (decisive) informative += 1;

    for (let i = 0; i < digits.length && i < 3; i += 1) {
      seen[i] += 1;
      if (verdicts[i] === derivWon) agree[i] += 1;
    }

    console.log(
      `trial ${String(trial + 1).padStart(2)}: deriv=${derivWon ? "WIN " : "LOSS"} · ticks +1=${digits[0]} +2=${digits[1]} +3=${digits[2] ?? "-"} · entry_spot ${poc.entry_spot}${decisive ? "  <- decisive" : ""}`,
    );
  }

  console.log(`\nDecisive trials: ${informative}/${TRIALS}`);
  for (let i = 0; i < 3; i += 1) {
    if (seen[i] === 0) continue;
    console.log(`  settle on +${i + 1} tick: agreed ${agree[i]}/${seen[i]}`);
  }

  client.disconnect();
  process.exit(0);
}

main().catch((error: Error) => {
  console.error(`FATAL: ${error.message}`);
  process.exit(1);
});
