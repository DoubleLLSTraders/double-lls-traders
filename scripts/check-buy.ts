/**
 * Places one real DIGITDIFF/DIGITMATCH order on the DEMO account using the same
 * proposal → buy payload the app sends, and prints Deriv's exact reply.
 *
 *   npm run check-buy
 *
 * Also probes a 5x parallel burst to reproduce the "5 parallel buys failed" case.
 */
const REST_URL = (process.env.VITE_DERIV_REST_URL ?? "https://api.derivws.com").replace(/\/$/, "");
const APP_ID = process.env.VITE_DERIV_APP_ID?.trim() ?? "";
const TOKEN = process.env.VITE_DERIV_TOKEN_DEMO?.trim() ?? "";
const ACCOUNT_ID = process.env.VITE_DERIV_DEMO_ACCOUNT_ID?.trim() ?? "";
const SYMBOL = process.env.VITE_DEFAULT_SYMBOL?.trim() || "R_100";
const STAKE = Number(process.env.VITE_BASE_STAKE ?? 0.35);

interface Reply {
  req_id?: number;
  msg_type?: string;
  error?: { code: string; message: string };
  proposal?: { id: string; ask_price: number; payout: number };
  buy?: { contract_id: number; buy_price: number; payout: number };
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error("WebSocket open timed out.")), 15_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket transport error."));
    });
  });
}

let nextId = 1;
const pending = new Map<number, (reply: Reply) => void>();

function send(socket: WebSocket, request: Record<string, unknown>): Promise<Reply> {
  const reqId = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error("Deriv did not respond within 20s."));
    }, 20_000);
    pending.set(reqId, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
    socket.send(JSON.stringify({ ...request, req_id: reqId }));
  });
}

async function buyOnce(
  socket: WebSocket,
  side: "DIGITDIFF" | "DIGITMATCH",
  digit: number,
  stake: number,
  currency: string,
): Promise<string> {
  const buy = await send(socket, {
    buy: 1,
    price: stake,
    parameters: {
      amount: stake,
      basis: "stake",
      contract_type: side,
      currency,
      underlying_symbol: SYMBOL,
      duration: 1,
      duration_unit: "t",
      barrier: String(digit),
    },
  });
  if (buy.error) {
    return `BUY ERROR [${buy.error.code}] ${buy.error.message}`;
  }
  return `BUY OK contract=${buy.buy?.contract_id} price=${buy.buy?.buy_price} payout=${buy.buy?.payout}`;
}

async function main() {
  if (!APP_ID || !TOKEN) {
    console.error("Need VITE_DERIV_APP_ID and VITE_DERIV_TOKEN_DEMO in .env.");
    process.exit(1);
  }

  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    "Deriv-App-ID": APP_ID,
    Accept: "application/json",
  };

  const accountsRes = await fetch(`${REST_URL}/trading/v1/options/accounts`, { headers });
  const accountsBody = (await accountsRes.json()) as {
    data?: Array<{ account_id: string; account_type: string; balance: string; currency: string }>;
    message?: string;
  };
  if (!accountsRes.ok) {
    console.error(`Accounts failed: ${accountsBody.message ?? JSON.stringify(accountsBody)}`);
    process.exit(1);
  }

  const account =
    accountsBody.data?.find((a) => a.account_id === ACCOUNT_ID) ??
    accountsBody.data?.find((a) => a.account_type === "demo");
  if (!account) {
    console.error("No demo account visible to this token.");
    process.exit(1);
  }
  const currency = account.currency || "USD";
  console.log(`Account: ${account.account_id} (${account.account_type}) ${account.balance} ${currency}`);
  console.log(`Symbol: ${SYMBOL} · stake ${STAKE} ${currency}`);

  const otpRes = await fetch(
    `${REST_URL}/trading/v1/options/accounts/${encodeURIComponent(account.account_id)}/otp`,
    { method: "POST", headers },
  );
  const otpBody = (await otpRes.json()) as { data?: { url?: string }; message?: string };
  if (!otpRes.ok || !otpBody.data?.url) {
    console.error(`OTP failed: ${otpBody.message ?? JSON.stringify(otpBody)}`);
    process.exit(1);
  }

  const socket = await connect(otpBody.data.url);
  socket.addEventListener("message", (event) => {
    const reply = JSON.parse(String(event.data)) as Reply;
    if (reply.req_id !== undefined) pending.get(reply.req_id)?.(reply);
    if (reply.req_id !== undefined) pending.delete(reply.req_id);
  });
  console.log("Socket: connected\n");

  console.log("--- Test 1: single DIGITDIFF buy ---");
  console.log(await buyOnce(socket, "DIGITDIFF", 5, STAKE, currency));

  console.log("\n--- Test 2: single DIGITMATCH buy ---");
  console.log(await buyOnce(socket, "DIGITMATCH", 5, STAKE, currency));

  console.log("\n--- Test 3: bulk 5x parallel DIGITDIFF ---");
  const parallelStart = Date.now();
  const burst = await Promise.all(
    Array.from({ length: 5 }, () => buyOnce(socket, "DIGITDIFF", 5, STAKE, currency)),
  );
  burst.forEach((line, index) => console.log(`  [${index + 1}] ${line}`));
  console.log(`  elapsed ${Date.now() - parallelStart}ms`);

  console.log("\n--- Test 4: bulk 5x sequential DIGITDIFF ---");
  const seqStart = Date.now();
  for (let i = 0; i < 5; i += 1) {
    console.log(`  [${i + 1}] ${await buyOnce(socket, "DIGITDIFF", 5, STAKE, currency)}`);
  }
  console.log(`  elapsed ${Date.now() - seqStart}ms`);

  socket.close();
  console.log("\nDone.");
}

main().catch((error: Error) => {
  console.error(`FATAL: ${error.message}`);
  process.exit(1);
});
