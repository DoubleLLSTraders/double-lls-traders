/**
 * End-to-end check of the bot's economics on the demo account: places a bulk
 * basket, waits for it to settle, and compares the realised balance change
 * against what the bot's settlement math would have recorded.
 *
 *   npm run check-cycle
 */
import { settleContractPnl, profitRate } from "../src/lib/bot/performance";
import { recoveryStake } from "../src/lib/bot/gates";

const REST_URL = (process.env.VITE_DERIV_REST_URL ?? "https://api.derivws.com").replace(/\/$/, "");
const APP_ID = process.env.VITE_DERIV_APP_ID?.trim() ?? "";
const TOKEN = process.env.VITE_DERIV_TOKEN_DEMO?.trim() ?? "";
const SYMBOL = process.env.VITE_DEFAULT_SYMBOL?.trim() || "R_100";
const STAKE = Number(process.env.VITE_BASE_STAKE ?? 0.35);
const CONTRACTS = 5;
const SIDE = (process.env.CHECK_SIDE === "DIGITDIFF"
  ? "DIGITDIFF"
  : "DIGITMATCH") as "DIGITMATCH" | "DIGITDIFF";
const DIGIT = 5;

interface Reply {
  req_id?: number;
  error?: { code: string; message: string };
  buy?: { contract_id: number; buy_price: number; payout: number; balance_after: number };
  proposal_open_contract?: { is_sold: 0 | 1; profit: number; status: string };
  balance?: { balance: number };
}

let nextId = 1;
const pending = new Map<number, (reply: Reply) => void>();

function send(socket: WebSocket, request: Record<string, unknown>): Promise<Reply> {
  const reqId = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error("no reply in 20s"));
    }, 20_000);
    pending.set(reqId, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
    socket.send(JSON.stringify({ ...request, req_id: reqId }));
  });
}

async function main() {
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    "Deriv-App-ID": APP_ID,
    Accept: "application/json",
  };
  const accountsRes = await fetch(`${REST_URL}/trading/v1/options/accounts`, { headers });
  const accountsBody = (await accountsRes.json()) as {
    data?: Array<{ account_id: string; account_type: string; currency: string }>;
  };
  const account = accountsBody.data?.find((a) => a.account_type === "demo");
  if (!account) throw new Error("no demo account");
  const currency = account.currency || "USD";

  const otpRes = await fetch(
    `${REST_URL}/trading/v1/options/accounts/${encodeURIComponent(account.account_id)}/otp`,
    { method: "POST", headers },
  );
  const otpBody = (await otpRes.json()) as { data?: { url?: string } };
  if (!otpBody.data?.url) throw new Error("no otp url");

  const socket = await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(otpBody.data!.url!);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error("ws error")));
  });
  socket.addEventListener("message", (event) => {
    const reply = JSON.parse(String(event.data)) as Reply;
    if (reply.req_id !== undefined) {
      pending.get(reply.req_id)?.(reply);
      pending.delete(reply.req_id);
    }
  });

  const before = (await send(socket, { balance: 1 })).balance?.balance ?? 0;
  console.log(`Balance before: ${before.toFixed(2)} ${currency}`);
  console.log(`Firing bulk ${CONTRACTS}x ${STAKE} ${SIDE} ${DIGIT} on ${SYMBOL}\n`);

  const params = {
    amount: STAKE,
    basis: "stake",
    contract_type: SIDE,
    currency,
    underlying_symbol: SYMBOL,
    duration: 1,
    duration_unit: "t",
    barrier: String(DIGIT),
  };

  const buys = await Promise.allSettled(
    Array.from({ length: CONTRACTS }, () =>
      send(socket, { buy: 1, price: STAKE, parameters: params }),
    ),
  );

  const ids: number[] = [];
  let quotedPayout = 0;
  for (const result of buys) {
    if (result.status === "fulfilled" && result.value.buy) {
      ids.push(result.value.buy.contract_id);
      quotedPayout += result.value.buy.payout;
    } else {
      const why =
        result.status === "rejected"
          ? String(result.reason)
          : (result.value.error?.message ?? "unknown");
      console.log(`  leg failed: ${why}`);
    }
  }
  console.log(`Filled ${ids.length}/${CONTRACTS} legs · quoted payout ${quotedPayout.toFixed(2)}`);

  const exposure = STAKE * ids.length;

  // Poll each contract until Deriv marks it sold.
  let realised = 0;
  let wins = 0;
  for (const id of ids) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const reply = await send(socket, { proposal_open_contract: 1, contract_id: id });
      const poc = reply.proposal_open_contract;
      if (poc?.is_sold === 1) {
        const profit = Number(poc.profit);
        realised += profit;
        if (profit > 0) wins += 1;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const after = (await send(socket, { balance: 1 })).balance?.balance ?? 0;
  const won = wins > 0;

  console.log(`\nSettled: ${wins}/${ids.length} legs won`);
  console.log(`Deriv realised profit : ${realised.toFixed(2)} ${currency}`);
  console.log(`Balance delta         : ${(after - before).toFixed(2)} ${currency}`);
  console.log(
    `Bot settlement math   : ${settleContractPnl(exposure, won, SIDE, won ? quotedPayout : undefined).toFixed(2)} ${currency}`,
  );

  console.log(`\nprofitRate(${SIDE}) = ${profitRate(SIDE).toFixed(4)} per 1.0 exposure`);
  const plan = recoveryStake(exposure, SIDE, CONTRACTS, STAKE, Number(process.env.VITE_MAX_STAKE ?? 2));
  console.log(
    `Recovery after losing ${exposure.toFixed(2)}: needs ${plan.stake} x ${CONTRACTS} = ${plan.exposure} · possible=${plan.enough}`,
  );

  socket.close();
}

main().catch((error: Error) => {
  console.error(`FATAL: ${error.message}`);
  process.exit(1);
});
