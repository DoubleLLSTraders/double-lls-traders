/**
 * One demo Differs buy — no analyzer hunt. Connect → buy coldest digit → settle.
 *
 *   npm run quick-trade
 */
import { DerivClient } from "../src/lib/deriv/client";
import { resolveAccount } from "../src/lib/deriv/rest";
import { lastDigit, type HistoryResponse } from "../src/lib/deriv/types";
import { summarise } from "../src/lib/analysis/digits";
import { buyDigitContractsBulk, waitForBasketOutcome } from "../src/lib/deriv/trade";

const APP_ID = process.env.VITE_DERIV_APP_ID?.trim() ?? "";
const TOKEN = process.env.VITE_DERIV_TOKEN_DEMO?.trim() ?? "";
const REST_URL = (process.env.VITE_DERIV_REST_URL ?? "https://api.derivws.com").replace(
  /\/$/,
  "",
);
const ACCOUNT_ID = process.env.VITE_DERIV_DEMO_ACCOUNT_ID?.trim() ?? "";
const SYMBOL = process.env.SYMBOL?.trim() || "R_75";
const STAKE = Number(process.env.STAKE ?? 0.35);

async function main() {
  const account = await resolveAccount(
    { appId: APP_ID, restUrl: REST_URL, token: TOKEN },
    "demo",
    ACCOUNT_ID || undefined,
  );
  const client = new DerivClient({
    appId: APP_ID,
    restUrl: REST_URL,
    token: TOKEN,
    accountId: account.accountId,
  });
  await new Promise<void>((resolve, reject) => {
    const off = client.onStateChange((s) => {
      if (s === "ready") {
        off();
        resolve();
      }
    });
    client.onError(reject);
    client.connect();
  });

  const hist = await client.send<HistoryResponse>({
    ticks_history: SYMBOL,
    adjust_start_time: 1,
    count: 200,
    end: "latest",
    style: "ticks",
  });
  const digits = hist.history.prices.map((q) => lastDigit(q, hist.pip_size));
  const digit = summarise(digits).coldest[0] ?? 0;
  const currency = account.currency || "USD";

  console.log(`Demo ${account.accountId} · ${SYMBOL} · Differs ${digit} · ${STAKE} ${currency}`);

  const bulk = await buyDigitContractsBulk(
    client,
    {
      symbol: SYMBOL,
      side: "DIGITDIFF",
      digit,
      stake: STAKE,
      currency,
      duration: 1,
    },
    1,
    { parallel: true },
  );
  if (bulk.filled.length === 0) {
    console.error(`BUY FAIL · ${bulk.reasons[0] ?? "unknown"}`);
    client.disconnect();
    process.exit(1);
  }

  console.log(`OPEN contract ${bulk.filled[0].contractId}`);
  const outcome = await waitForBasketOutcome(
    client,
    bulk.filled.map((l) => l.contractId),
  );
  console.log(
    `${outcome.won ? "WIN" : "LOSS"} · exit ${outcome.exitDigit ?? "?"} · ${outcome.profit >= 0 ? "+" : ""}${outcome.profit.toFixed(2)} ${currency}`,
  );
  client.disconnect();
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
