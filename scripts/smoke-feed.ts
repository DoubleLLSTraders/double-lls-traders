/**
 * End-to-end smoke: resolve demo account, open OTP socket, load tick history.
 */
import { DerivClient } from "../src/lib/deriv/client";
import { resolveAccount } from "../src/lib/deriv/rest";
import { lastDigit } from "../src/lib/deriv/types";
import type { HistoryResponse, TickResponse } from "../src/lib/deriv/types";

const appId = process.env.VITE_DERIV_APP_ID!.trim();
const restUrl = (process.env.VITE_DERIV_REST_URL ?? "https://api.derivws.com").replace(/\/$/, "");
const token = process.env.VITE_DERIV_TOKEN_DEMO!.trim();
const preferredId = process.env.VITE_DERIV_DEMO_ACCOUNT_ID?.trim();

async function main() {
  const account = await resolveAccount({ appId, restUrl, token }, "demo", preferredId || undefined);
  console.log(`Account ${account.accountId} balance ${account.balance} ${account.currency}`);

  const client = new DerivClient({ appId, restUrl, token, accountId: account.accountId });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for ready.")), 20_000);
    client.onError(reject);
    client.onStateChange((state) => {
      console.log(`state → ${state}`);
      if (state === "ready") {
        clearTimeout(timer);
        resolve();
      }
    });
    client.connect();
  });

  const history = await new Promise<{ count: number; lastDigit: number; quote: number }>(
    (resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("No history received.")), 20_000);
      void client
        .subscribe<HistoryResponse | TickResponse>(
          {
            ticks_history: "R_100",
            adjust_start_time: 1,
            count: 50,
            end: "latest",
            style: "ticks",
          },
          (message) => {
            if (message.msg_type !== "history") return;
            clearTimeout(timer);
            const prices = message.history.prices;
            const quote = prices[prices.length - 1];
            resolve({
              count: prices.length,
              quote,
              lastDigit: lastDigit(quote, message.pip_size),
            });
          },
        )
        .catch(reject);
    },
  );

  console.log(
    `History: ${history.count} ticks, last quote ${history.quote}, digit ${history.lastDigit}`,
  );
  client.disconnect();
  console.log("Smoke passed.");
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
