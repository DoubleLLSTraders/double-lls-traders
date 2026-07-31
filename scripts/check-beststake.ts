/**
 * Finds the stake at which Deriv's cent-rounding costs the least.
 *
 *   npm run check-beststake
 *
 * The house edge cannot be removed, but it is not flat: Deriv rounds each
 * payout down to a whole cent, so some stakes hand back materially more than
 * others for the identical bet. This scans finely and reports the stake with
 * the smallest loss per unit risked. Proposals only — places no orders.
 */
const REST_URL = (process.env.VITE_DERIV_REST_URL ?? "https://api.derivws.com").replace(/\/$/, "");
const APP_ID = process.env.VITE_DERIV_APP_ID?.trim() ?? "";
const TOKEN = process.env.VITE_DERIV_TOKEN_DEMO?.trim() ?? "";

const SYMBOLS = (process.env.SYMBOLS ?? "R_10,R_25,R_50,R_75").split(",");
/** True digit win rate, established over 400k ticks in find-edge. */
const WIN_RATE = 0.9;

function stakeLadder(): number[] {
  const out: number[] = [];
  for (let v = 0.35; v <= 3.0001; v += 0.05) out.push(Number(v.toFixed(2)));
  for (let v = 3.25; v <= 10.0001; v += 0.25) out.push(Number(v.toFixed(2)));
  return out;
}

interface Reply {
  req_id?: number;
  error?: { code: string; message: string };
  proposal?: { ask_price: number; payout: number };
}

async function main() {
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    "Deriv-App-ID": APP_ID,
    Accept: "application/json",
  };
  const res = await fetch(`${REST_URL}/trading/v1/options/accounts`, { headers });
  const body = (await res.json()) as {
    data?: Array<{ account_id: string; account_type: string; currency: string }>;
  };
  const account = body.data?.find((a) => a.account_type === "demo");
  if (!account) throw new Error("no demo account");
  const currency = account.currency || "USD";

  const otpRes = await fetch(
    `${REST_URL}/trading/v1/options/accounts/${encodeURIComponent(account.account_id)}/otp`,
    { method: "POST", headers },
  );
  const otp = (await otpRes.json()) as { data?: { url?: string } };
  if (!otp.data?.url) throw new Error("no otp url");

  const socket = await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(otp.data!.url!);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error("socket error")));
  });

  let nextId = 1;
  const pending = new Map<number, (reply: Reply) => void>();
  socket.addEventListener("message", (event) => {
    const reply = JSON.parse(String(event.data)) as Reply;
    if (reply.req_id === undefined) return;
    pending.get(reply.req_id)?.(reply);
    pending.delete(reply.req_id);
  });
  const send = (request: Record<string, unknown>): Promise<Reply> => {
    const reqId = nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(reqId);
        resolve({ error: { code: "TIMEOUT", message: "no reply" } });
      }, 20_000);
      pending.set(reqId, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      socket.send(JSON.stringify({ ...request, req_id: reqId }));
    });
  };

  const stakes = stakeLadder();
  console.log(`Scanning ${stakes.length} stakes across ${SYMBOLS.join(", ")}…`);
  console.log("DIGITDIFF, 1 tick. Expected value assumes the true 90% win rate.\n");

  interface Row {
    stake: number;
    multiple: number;
    ev: number;
    lossPerTrade: number;
  }
  const rows: Row[] = [];

  for (const stake of stakes) {
    const replies = await Promise.all(
      SYMBOLS.map((symbol) =>
        send({
          proposal: 1,
          amount: stake,
          basis: "stake",
          contract_type: "DIGITDIFF",
          currency,
          underlying_symbol: symbol,
          duration: 1,
          duration_unit: "t",
          barrier: "5",
        }),
      ),
    );
    const multiples = replies
      .filter((r): r is Reply & { proposal: NonNullable<Reply["proposal"]> } => !!r.proposal)
      .map((r) => r.proposal.payout / r.proposal.ask_price);
    if (multiples.length === 0) continue;

    const multiple = multiples.reduce((a, b) => a + b, 0) / multiples.length;
    const ev = WIN_RATE * multiple - 1;
    rows.push({ stake, multiple, ev, lossPerTrade: -ev * stake });
  }

  socket.close();

  const byEv = [...rows].sort((a, b) => b.ev - a.ev);
  const best = byEv[0];
  const worst = byEv[byEv.length - 1];

  console.log("  stake   multiple   edge/trade   loss per trade   break-even%");
  console.log("  ─────────────────────────────────────────────────────────────");
  for (const row of rows) {
    const mark = row.stake === best.stake ? "  <-- least bad" : "";
    console.log(
      `  ${row.stake.toFixed(2).padStart(5)}   ${row.multiple.toFixed(4)}   ${(row.ev * 100)
        .toFixed(2)
        .padStart(9)}%   ${row.lossPerTrade.toFixed(4).padStart(13)}   ${((1 / row.multiple) * 100)
        .toFixed(2)
        .padStart(10)}%${mark}`,
    );
  }

  console.log("\n════ RESULT ════");
  console.log(
    `  Least bad stake : ${best.stake.toFixed(2)} ${currency} · ${best.multiple.toFixed(
      4,
    )}x · ${(best.ev * 100).toFixed(2)}% per trade`,
  );
  console.log(
    `  Worst stake     : ${worst.stake.toFixed(2)} ${currency} · ${worst.multiple.toFixed(
      4,
    )}x · ${(worst.ev * 100).toFixed(2)}% per trade`,
  );
  console.log(
    `  Choosing well is worth ${((best.ev - worst.ev) * 100).toFixed(2)} points per trade.`,
  );
  console.log(
    "\n  Every row is negative. There is no stake that makes this profitable —\n" +
      "  only stakes that lose more slowly than others.",
  );
}

main().catch((error: Error) => {
  console.error(`FATAL: ${error.message}`);
  process.exit(1);
});
