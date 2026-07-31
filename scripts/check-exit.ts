/**
 * Audits the trade ledger against Deriv itself.
 *
 *   npm run check-exit
 *
 * Buys a handful of tiny DIGITDIFF contracts on the DEMO account, then reads
 * back the exit tick Deriv judged each one on. For every contract it checks
 * that "exit digit equals the barrier" agrees with "Deriv paid nothing". A
 * mismatch would mean the outcome and the digit disagree at the source; an
 * agreement means the ledger can be trusted once it records this digit rather
 * than whatever tick happened to be newest locally.
 */
const REST_URL = (process.env.VITE_DERIV_REST_URL ?? "https://api.derivws.com").replace(/\/$/, "");
const APP_ID = process.env.VITE_DERIV_APP_ID?.trim() ?? "";
const TOKEN = process.env.VITE_DERIV_TOKEN_DEMO?.trim() ?? "";
const ACCOUNT_ID = process.env.VITE_DERIV_DEMO_ACCOUNT_ID?.trim() ?? "";
const SYMBOL = process.env.SYMBOL?.trim() || "R_25";
const STAKE = Number(process.env.STAKE ?? 0.35);
const ROUNDS = Number(process.env.ROUNDS ?? 12);
const BARRIER = Number(process.env.BARRIER ?? 8);

interface Reply {
  req_id?: number;
  msg_type?: string;
  error?: { code: string; message: string };
  buy?: { contract_id: number; buy_price: number; payout: number };
  proposal_open_contract?: {
    contract_id: number;
    is_sold: 0 | 1;
    profit: number | string;
    barrier?: string;
    entry_spot?: string;
    exit_spot?: string;
    [key: string]: unknown;
  };
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
const streams = new Map<number, (reply: Reply) => void>();

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

/** Subscribes to a contract and resolves on the settled snapshot. */
function awaitSettlement(
  socket: WebSocket,
  contractId: number,
): Promise<NonNullable<Reply["proposal_open_contract"]>> {
  const reqId = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      streams.delete(reqId);
      reject(new Error(`Contract ${contractId} did not settle in 60s.`));
    }, 60_000);
    streams.set(reqId, (reply) => {
      const contract = reply.proposal_open_contract;
      if (!contract || contract.is_sold !== 1) return;
      clearTimeout(timer);
      streams.delete(reqId);
      resolve(contract);
    });
    socket.send(
      JSON.stringify({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1, req_id: reqId }),
    );
  });
}

/** Deriv formats the quote to pip size, so the tail character is the digit. */
function digitOfQuote(display: string | undefined): number | null {
  if (!display) return null;
  const last = display.trim().slice(-1);
  return /[0-9]/.test(last) ? Number(last) : null;
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
  const account =
    accountsBody.data?.find((a) => a.account_id === ACCOUNT_ID) ??
    accountsBody.data?.find((a) => a.account_type === "demo");
  if (!account) {
    console.error("No demo account visible to this token.");
    process.exit(1);
  }
  if (account.account_type !== "demo") {
    console.error("Refusing to run: resolved account is not a demo account.");
    process.exit(1);
  }
  const currency = account.currency || "USD";
  console.log(
    `Account: ${account.account_id} (${account.account_type}) ${account.balance} ${currency}`,
  );
  console.log(`${SYMBOL} · Differs ${BARRIER} · ${STAKE} ${currency} · ${ROUNDS} rounds\n`);

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
    if (reply.req_id === undefined) return;
    const stream = streams.get(reply.req_id);
    if (stream) {
      stream(reply);
      return;
    }
    pending.get(reply.req_id)?.(reply);
    pending.delete(reply.req_id);
  });

  console.log("  #  barrier  entry     exit      exit digit  profit   Deriv says  digit says");
  console.log("  ─────────────────────────────────────────────────────────────────────────────");

  let agree = 0;
  let checked = 0;
  let missingExit = 0;

  for (let round = 1; round <= ROUNDS; round += 1) {
    const buy = await send(socket, {
      buy: 1,
      price: STAKE,
      parameters: {
        amount: STAKE,
        basis: "stake",
        contract_type: "DIGITDIFF",
        currency,
        underlying_symbol: SYMBOL,
        duration: 1,
        duration_unit: "t",
        barrier: String(BARRIER),
      },
    });
    if (buy.error || !buy.buy) {
      console.log(`  ${String(round).padStart(2)}  BUY ERROR ${buy.error?.message ?? "unknown"}`);
      continue;
    }

    const contract = await awaitSettlement(socket, buy.buy.contract_id);
    const profit = Number(contract.profit);
    const exitDigit = digitOfQuote(contract.exit_spot);
    const derivSays = profit > 0 ? "WIN" : "LOSS";
    const digitSays = exitDigit === null ? "—" : exitDigit === BARRIER ? "LOSS" : "WIN";

    if (exitDigit === null) missingExit += 1;
    else {
      checked += 1;
      if (derivSays === digitSays) agree += 1;
    }

    console.log(
      `  ${String(round).padStart(2)}  ${String(contract.barrier ?? BARRIER).padStart(7)}  ${(
        contract.entry_spot ?? "—"
      ).padEnd(9)} ${(contract.exit_spot ?? "—").padEnd(9)} ${String(
        exitDigit ?? "—",
      ).padStart(10)}  ${profit >= 0 ? "+" : ""}${profit.toFixed(2).padStart(6)}  ${derivSays.padStart(
        10,
      )}  ${digitSays.padStart(10)}${derivSays !== digitSays && exitDigit !== null ? "   <-- MISMATCH" : ""}`,
    );
  }

  console.log("\n  ─────────────────────────────────────────────────────────────────────────────");
  console.log(`  exit tick present on   ${checked}/${checked + missingExit} contracts`);
  console.log(`  outcome matches digit  ${agree}/${checked}`);
  console.log(
    agree === checked && checked > 0
      ? "\n  Deriv's win/loss and Deriv's exit digit agree on every contract.\n  Recording this digit makes the ledger auditable."
      : "\n  Disagreement at the source — investigate before trusting the ledger.",
  );

  socket.close();
}

main().catch((error: Error) => {
  console.error(`FATAL: ${error.message}`);
  process.exit(1);
});
