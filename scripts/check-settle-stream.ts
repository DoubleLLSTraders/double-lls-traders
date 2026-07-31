/**
 * Diagnoses why a live contract sometimes never reports settled.
 *
 *   npm run check-settle-stream
 *
 * Buys one tiny DIGITDIFF on DEMO through the real DerivClient, then logs every
 * proposal_open_contract frame that comes back, with timings. If the stream
 * stops before is_sold flips, the bot's settlement wait would hang the same way.
 */
import { DerivClient } from "../src/lib/deriv/client";
import { resolveAccount } from "../src/lib/deriv/rest";
import { buyDigitContract } from "../src/lib/deriv/trade";

const REST_URL = (process.env.VITE_DERIV_REST_URL ?? "https://api.derivws.com").replace(/\/$/, "");
const APP_ID = process.env.VITE_DERIV_APP_ID?.trim() ?? "";
const TOKEN = process.env.VITE_DERIV_TOKEN_DEMO?.trim() ?? "";
const ACCOUNT_ID = process.env.VITE_DERIV_DEMO_ACCOUNT_ID?.trim() ?? "";
const SYMBOL = process.env.SYMBOL?.trim() || "R_25";
const STAKE = Number(process.env.STAKE ?? 0.35);

interface OpenContract {
  contract_id: number;
  is_sold: 0 | 1;
  status: string;
  profit: number | string;
  exit_spot?: string;
  current_spot?: string;
}

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
    const off = client.onStateChange((state) => {
      if (state === "ready") {
        off();
        resolve();
      }
    });
    client.onError((error) => reject(error));
    client.connect();
  });
  console.log(`Connected · ${account.accountId} · ${SYMBOL} · stake ${STAKE}\n`);

  const buy = await buyDigitContract(client, {
    symbol: SYMBOL,
    side: "DIGITDIFF",
    digit: 5,
    stake: STAKE,
    currency: account.currency || "USD",
    duration: 1,
  });
  const boughtAt = Date.now();
  console.log(`Bought contract ${buy.contractId} · payout ${buy.payout}\n`);
  console.log("   t(ms)  frame  is_sold  status      profit  exit_spot");
  console.log("   ─────────────────────────────────────────────────────────────");

  let frames = 0;
  let settled = false;

  const stop = await client.subscribe<{ msg_type: string; proposal_open_contract: OpenContract }>(
    { proposal_open_contract: 1, contract_id: buy.contractId },
    (message) => {
      const c = message.proposal_open_contract;
      if (!c) return;
      frames += 1;
      console.log(
        `   ${String(Date.now() - boughtAt).padStart(5)}  ${String(frames).padStart(5)}  ${String(
          c.is_sold,
        ).padStart(7)}  ${(c.status ?? "—").padEnd(10)} ${String(c.profit).padStart(7)}  ${
          c.exit_spot ?? "—"
        }`,
      );
      if (c.is_sold === 1) settled = true;
    },
  );

  const deadline = Date.now() + 45_000;
  while (!settled && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  stop();

  console.log("\n   ─────────────────────────────────────────────────────────────");
  if (settled) {
    console.log(`   Settled after ${frames} frame(s). The subscription stream works.`);
  } else {
    console.log(
      `   NEVER SETTLED · ${frames} frame(s) in 45s.\n` +
        `   The stream stops before is_sold flips, so waiting on it hangs.`,
    );
  }

  client.disconnect();
  process.exit(settled ? 0 : 1);
}

main().catch((error: Error) => {
  console.error(`FATAL: ${error.message}`);
  process.exit(1);
});
