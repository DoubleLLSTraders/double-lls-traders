/**
 * Prints Deriv's real payout multiples for digit contracts, so the bot's
 * settlement math matches what the exchange actually pays.
 * Proposals only — places no orders.
 *
 *   npm run check-payout
 */
const REST_URL = (process.env.VITE_DERIV_REST_URL ?? "https://api.derivws.com").replace(/\/$/, "");
const APP_ID = process.env.VITE_DERIV_APP_ID?.trim() ?? "";
const TOKEN = process.env.VITE_DERIV_TOKEN_DEMO?.trim() ?? "";

const SYMBOLS = [
  "R_10",
  "R_25",
  "R_50",
  "R_75",
  "R_100",
  "1HZ10V",
  "1HZ25V",
  "1HZ50V",
  "1HZ75V",
  "1HZ100V",
];
const STAKES = [0.35, 0.7, 1, 1.75, 2, 2.5, 3, 3.5, 4, 5];

interface Reply {
  req_id?: number;
  error?: { code: string; message: string };
  proposal?: { ask_price: number; payout: number };
}

let nextId = 1;
const pending = new Map<number, (reply: Reply) => void>();

function send(socket: WebSocket, request: Record<string, unknown>): Promise<Reply> {
  const reqId = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      resolve({ error: { code: "TIMEOUT", message: "no reply" } });
    }, 15_000);
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

  // Cent rounding on the payout hits small stakes hardest, so the effective
  // multiple is reported next to the win rate it would need to break even.
  for (const side of ["DIGITDIFF", "DIGITMATCH"] as const) {
    console.log(`\n=== ${side} · effective multiple by stake ===`);
    console.log(`  stake  ${SYMBOLS.map((s) => s.padStart(8)).join("")}`);

    for (const stake of STAKES) {
      const cells: string[] = [];
      for (const symbol of SYMBOLS) {
        const reply = await send(socket, {
          proposal: 1,
          amount: stake,
          basis: "stake",
          contract_type: side,
          currency,
          underlying_symbol: symbol,
          duration: 1,
          duration_unit: "t",
          barrier: "5",
        });
        if (reply.error) cells.push("   err".padStart(8));
        else if (reply.proposal) {
          const mult = reply.proposal.payout / reply.proposal.ask_price;
          cells.push(mult.toFixed(4).padStart(8));
        } else cells.push("     —".padStart(8));
      }
      console.log(`  ${String(stake).padEnd(6)} ${cells.join("")}`);
    }

    console.log(`\n  break-even win rate needed = 1 / multiple`);
    if (side === "DIGITDIFF") {
      console.log(
        `  digits are uniform, so the real win rate is 90.00% no matter the symbol`,
      );
    }
  }

  socket.close();
}

main().catch((error: Error) => {
  console.error(`FATAL: ${error.message}`);
  process.exit(1);
});
