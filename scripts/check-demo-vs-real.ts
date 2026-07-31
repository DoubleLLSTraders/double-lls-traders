/**
 * Answers "is the demo the same as the live account?" with measurements.
 *
 *   npm run check-demo-vs-real
 *
 * Compares, for identical digit contracts:
 *   1. the tick feed each account sees, and
 *   2. the payout Deriv quotes.
 *
 * PROPOSALS AND TICK HISTORY ONLY. This script never sends a `buy`, so it
 * cannot place an order on the real account.
 */
const REST_URL = (process.env.VITE_DERIV_REST_URL ?? "https://api.derivws.com").replace(/\/$/, "");
const APP_ID = process.env.VITE_DERIV_APP_ID?.trim() ?? "";
const DEMO_TOKEN = process.env.VITE_DERIV_TOKEN_DEMO?.trim() ?? "";
const REAL_TOKEN = process.env.VITE_DERIV_TOKEN_REAL?.trim() ?? "";

const SYMBOLS = ["R_10", "R_25", "R_50", "R_75", "R_100", "1HZ50V"];
const STAKES = [0.35, 1, 1.75, 5];
const TICK_SAMPLE = 500;

interface Reply {
  req_id?: number;
  error?: { code: string; message: string };
  proposal?: { ask_price: number; payout: number };
  history?: { prices: number[]; times: number[] };
  pip_size?: number;
}

interface Session {
  kind: "demo" | "real";
  accountId: string;
  currency: string;
  socket: WebSocket;
  send: (request: Record<string, unknown>) => Promise<Reply>;
}

async function openSession(kind: "demo" | "real", token: string): Promise<Session | null> {
  if (!token) {
    console.log(`  ${kind}: no token in .env — skipped`);
    return null;
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    "Deriv-App-ID": APP_ID,
    Accept: "application/json",
  };

  const res = await fetch(`${REST_URL}/trading/v1/options/accounts`, { headers });
  const body = (await res.json()) as {
    data?: Array<{ account_id: string; account_type: string; currency: string; balance: string }>;
    message?: string;
  };
  if (!res.ok) {
    console.log(`  ${kind}: accounts lookup failed — ${body.message ?? "unknown"}`);
    return null;
  }
  const wanted = kind === "demo" ? "demo" : "real";
  const account = body.data?.find((a) => a.account_type === wanted);
  if (!account) {
    console.log(`  ${kind}: no ${wanted} account visible to this token — skipped`);
    return null;
  }

  const otpRes = await fetch(
    `${REST_URL}/trading/v1/options/accounts/${encodeURIComponent(account.account_id)}/otp`,
    { method: "POST", headers },
  );
  const otp = (await otpRes.json()) as { data?: { url?: string }; message?: string };
  if (!otp.data?.url) {
    console.log(`  ${kind}: OTP failed — ${otp.message ?? "unknown"}`);
    return null;
  }

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
    if ("buy" in request) throw new Error("refusing to send a buy from this script");
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

  console.log(
    `  ${kind}: ${account.account_id} · ${account.balance} ${account.currency || "USD"}`,
  );
  return {
    kind,
    accountId: account.account_id,
    currency: account.currency || "USD",
    socket,
    send,
  };
}

function lastDigitOf(quote: number, pipSize: number): number {
  return Number(quote.toFixed(pipSize).slice(-1));
}

async function main() {
  console.log("Opening both accounts (read-only)…\n");
  const demo = await openSession("demo", DEMO_TOKEN);
  const real = await openSession("real", REAL_TOKEN);

  if (!demo || !real) {
    console.log("\nNeed both a demo and a real account to compare. Stopping.");
    process.exit(1);
  }

  // ── 1. Same tick feed? ───────────────────────────────────────────────
  console.log("\n════ 1. TICK FEED ════");
  console.log("  Do both accounts see identical prices for the same index?\n");
  console.log("  symbol    ticks  identical  demo last digits   real last digits");
  console.log("  ──────────────────────────────────────────────────────────────────");

  let feedsMatch = true;
  for (const symbol of SYMBOLS) {
    const request = {
      ticks_history: symbol,
      adjust_start_time: 1,
      count: TICK_SAMPLE,
      end: "latest",
      style: "ticks",
    };
    const [a, b] = await Promise.all([demo.send(request), real.send(request)]);
    if (!a.history || !b.history) {
      console.log(`  ${symbol.padEnd(9)} history unavailable`);
      continue;
    }

    // Compare only the overlapping timestamps: the two sockets are sampled a
    // moment apart, so the newest tick can legitimately differ by one.
    const byTime = new Map(a.history.times.map((t, i) => [t, a.history!.prices[i]]));
    let compared = 0;
    let same = 0;
    b.history.times.forEach((t, i) => {
      const mine = byTime.get(t);
      if (mine === undefined) return;
      compared += 1;
      if (mine === b.history!.prices[i]) same += 1;
    });

    const identical = compared > 0 && same === compared;
    if (!identical) feedsMatch = false;
    const pip = a.pip_size ?? 2;
    const demoTail = a.history.prices.slice(-6).map((q) => lastDigitOf(q, pip)).join("");
    const realTail = b.history.prices.slice(-6).map((q) => lastDigitOf(q, b.pip_size ?? pip)).join("");

    console.log(
      `  ${symbol.padEnd(9)} ${String(compared).padStart(5)}  ${(identical
        ? "YES"
        : `${same}/${compared}`
      ).padStart(9)}  ${demoTail.padStart(16)}   ${realTail.padStart(16)}`,
    );
  }

  // ── 2. Same payout? ──────────────────────────────────────────────────
  console.log("\n════ 2. DIGITDIFF PAYOUT ════");
  console.log("  Multiple paid per unit staked, and the win rate it demands.\n");
  console.log("  symbol    stake     demo      real   diff   demo BE%   real BE%");
  console.log("  ──────────────────────────────────────────────────────────────────");

  let worstGap = 0;
  for (const symbol of SYMBOLS) {
    for (const stake of STAKES) {
      const request = {
        proposal: 1,
        amount: stake,
        basis: "stake",
        contract_type: "DIGITDIFF",
        currency: demo.currency,
        underlying_symbol: symbol,
        duration: 1,
        duration_unit: "t",
        barrier: "5",
      };
      const [a, b] = await Promise.all([
        demo.send(request),
        real.send({ ...request, currency: real.currency }),
      ]);
      if (!a.proposal || !b.proposal) {
        const why = a.error?.message ?? b.error?.message ?? "no proposal";
        console.log(`  ${symbol.padEnd(9)} ${String(stake).padEnd(6)} ${why}`);
        continue;
      }
      const dm = a.proposal.payout / a.proposal.ask_price;
      const rm = b.proposal.payout / b.proposal.ask_price;
      const gap = rm - dm;
      if (Math.abs(gap) > Math.abs(worstGap)) worstGap = gap;

      console.log(
        `  ${symbol.padEnd(9)} ${String(stake).padEnd(6)}${dm.toFixed(4).padStart(8)}${rm
          .toFixed(4)
          .padStart(10)} ${(gap >= 0 ? "+" : "") + gap.toFixed(4)}   ${((1 / dm) * 100)
          .toFixed(2)
          .padStart(7)}    ${((1 / rm) * 100).toFixed(2).padStart(7)}`,
      );
    }
  }

  console.log("\n════ VERDICT ════");
  console.log(
    feedsMatch
      ? "  Tick feed  : IDENTICAL — the same generated prices reach both accounts."
      : "  Tick feed  : DIFFERS — investigate before trusting demo results.",
  );
  console.log(
    Math.abs(worstGap) < 0.0005
      ? "  Payout     : IDENTICAL — demo pays exactly what real pays."
      : `  Payout     : DIFFERS by up to ${worstGap.toFixed(4)}x — real is ${
          worstGap < 0 ? "WORSE" : "better"
        } than demo.`,
  );
  console.log(
    "\n  Same prices and same payout means demo results carry over to real money\n" +
      "  one for one. The only thing that changes is whose money it is.",
  );

  demo.socket.close();
  real.socket.close();
}

main().catch((error: Error) => {
  console.error(`FATAL: ${error.message}`);
  process.exit(1);
});
