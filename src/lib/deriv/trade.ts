import type { ContractSide } from "../analysis/signal";
import type { DerivClient } from "./client";
import type { BaseResponse } from "./types";

export interface DigitProposal {
  id: string;
  askPrice: number;
  payout: number;
  spot?: number;
}

export interface DigitBuyResult {
  contractId: number;
  buyPrice: number;
  payout: number;
  proposalId: string;
}

interface ProposalResponse extends BaseResponse {
  msg_type: "proposal";
  proposal: {
    id: string;
    ask_price: number;
    payout: number;
    spot?: number;
  };
}

interface BuyResponse extends BaseResponse {
  msg_type: "buy";
  buy: {
    contract_id: number;
    buy_price: number;
    payout: number;
  };
}

export async function proposeDigitContract(
  client: DerivClient,
  input: {
    symbol: string;
    side: ContractSide;
    digit: number;
    stake: number;
    currency: string;
    duration: number;
  },
): Promise<DigitProposal> {
  const response = await client.send<ProposalResponse>({
    proposal: 1,
    amount: input.stake,
    basis: "stake",
    contract_type: input.side,
    currency: input.currency,
    // Classic OAuth WS uses `symbol`; Options OTP path accepts `underlying_symbol`.
    symbol: input.symbol,
    underlying_symbol: input.symbol,
    duration: input.duration,
    duration_unit: "t",
    barrier: String(input.digit),
  });

  return {
    id: response.proposal.id,
    askPrice: response.proposal.ask_price,
    payout: response.proposal.payout,
    spot: response.proposal.spot,
  };
}

/**
 * Buy with inline parameters rather than a proposal id.
 *
 * Deriv returns the *same* proposal id for identical parameters, so a
 * proposal→buy pair cannot be run more than once concurrently: the first buy
 * consumes the id and the rest fail with "Unknown contract proposal". Passing
 * the parameters straight to `buy` is one round-trip and always yields a
 * distinct contract.
 */
export async function buyDigitContract(
  client: DerivClient,
  input: {
    symbol: string;
    side: ContractSide;
    digit: number;
    stake: number;
    currency: string;
    duration: number;
  },
): Promise<DigitBuyResult> {
  const response = await client.send<BuyResponse>({
    buy: 1,
    price: input.stake,
    parameters: {
      amount: input.stake,
      basis: "stake",
      contract_type: input.side,
      currency: input.currency,
      symbol: input.symbol,
      underlying_symbol: input.symbol,
      duration: input.duration,
      duration_unit: "t",
      barrier: String(input.digit),
    },
  });

  return {
    contractId: response.buy.contract_id,
    buyPrice: response.buy.buy_price,
    payout: response.buy.payout,
    proposalId: String(response.buy.contract_id),
  };
}

interface OpenContractResponse extends BaseResponse {
  msg_type: "proposal_open_contract";
  proposal_open_contract: {
    contract_id: number;
    is_sold: 0 | 1;
    profit: number | string;
    status: string;
    /** Quote of the tick that decided the contract, already at pip precision. */
    exit_spot?: string;
    entry_spot?: number | string;
    entry_tick?: number | string;
    exit_tick?: number | string;
    /** Unix epoch seconds for entry / exit ticks when present. */
    entry_tick_time?: number;
    exit_tick_time?: number;
    date_start?: number;
    purchase_time?: number;
  };
}

export interface ContractOutcome {
  profit: number;
  /** Last digit of Deriv's exit tick — the digit the contract was judged on. */
  exitDigit: number | null;
  /** Exit tick time (unix seconds) when Deriv reports it. */
  exitEpoch: number | null;
  /** Entry tick time (unix seconds) when Deriv reports it. */
  entryEpoch: number | null;
}

/** Deriv already formats the quote to pip size, so the tail is the digit. */
function digitOfQuote(display: string | number | undefined): number | null {
  if (display === undefined || display === null) return null;
  const last = String(display).trim().slice(-1);
  return /[0-9]/.test(last) ? Number(last) : null;
}

/**
 * Resolves once Deriv marks the contract sold, with its realised profit.
 *
 * 1-tick digit contracts settle in ~1–2s on 1s indices. Poll fast so the
 * chart W/L is not stuck 2+ ticks behind waiting on a 4s timer.
 */
export function waitForContractOutcome(
  client: DerivClient,
  contractId: number,
  timeoutMs = 45_000,
  pollMs = 400,
): Promise<ContractOutcome> {
  return new Promise<ContractOutcome>((resolve, reject) => {
    let done = false;
    let stop: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout>;
    let poll: ReturnType<typeof setInterval>;

    const finish = (action: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      stop?.();
      action();
    };

    const settle = (contract: OpenContractResponse["proposal_open_contract"]) => {
      if (!contract || contract.is_sold !== 1) return;
      finish(() =>
        resolve({
          profit: Number(contract.profit),
          exitDigit:
            digitOfQuote(contract.exit_spot) ??
            digitOfQuote(contract.exit_tick),
          exitEpoch:
            typeof contract.exit_tick_time === "number"
              ? contract.exit_tick_time
              : null,
          entryEpoch:
            typeof contract.entry_tick_time === "number"
              ? contract.entry_tick_time
              : typeof contract.date_start === "number"
                ? contract.date_start
                : typeof contract.purchase_time === "number"
                  ? contract.purchase_time
                  : null,
        }),
      );
    };

    timer = setTimeout(
      () => finish(() => reject(new Error(`Contract ${contractId} did not settle in time.`))),
      timeoutMs,
    );

    const pollOnce = () => {
      if (done) return;
      client
        .send<OpenContractResponse>({ proposal_open_contract: 1, contract_id: contractId })
        .then((message) => settle(message.proposal_open_contract))
        .catch(() => {
          // Transient; the stream or the next poll still has a chance.
        });
    };

    pollOnce();
    poll = setInterval(pollOnce, pollMs);

    client
      .subscribe<OpenContractResponse>(
        { proposal_open_contract: 1, contract_id: contractId },
        (message) => settle(message.proposal_open_contract),
      )
      .then((unsubscribe) => {
        stop = unsubscribe;
        if (done) unsubscribe();
      })
      .catch(() => {
        // Not fatal: the poll is the second path, and the overall timeout
        // still rejects if neither ever produces a sold contract.
      });
  });
}

/**
 * Wait for a whole bulk basket to settle and report what Deriv actually paid.
 *
 * Digit outcomes cannot be read reliably from the local tick stream: the
 * contract starts on the tick Deriv picks when the order lands, which is often
 * one tick later than the last tick the UI has seen. Asking Deriv removes the
 * guess entirely.
 */
export async function waitForBasketOutcome(
  client: DerivClient,
  contractIds: number[],
): Promise<{
  won: boolean;
  profit: number;
  exitDigit: number | null;
  exitEpoch: number | null;
  entryEpoch: number | null;
}> {
  const outcomes = await Promise.all(
    contractIds.map((id) => waitForContractOutcome(client, id)),
  );
  const profit = Number(
    outcomes.reduce((sum, outcome) => sum + outcome.profit, 0).toFixed(2),
  );
  // Every leg of a basket rides the same tick, so the first exit is the basket's.
  const exitDigit = outcomes.find((o) => o.exitDigit !== null)?.exitDigit ?? null;
  const exitEpoch = outcomes.find((o) => o.exitEpoch !== null)?.exitEpoch ?? null;
  const entryEpoch = outcomes.find((o) => o.entryEpoch !== null)?.entryEpoch ?? null;
  return { won: profit > 0, profit, exitDigit, exitEpoch, entryEpoch };
}

export interface BulkBuyResult {
  filled: DigitBuyResult[];
  failed: number;
  /** Distinct rejection messages, so the UI can name why Deriv refused. */
  reasons: string[];
}

interface DigitOrderInput {
  symbol: string;
  side: ContractSide;
  digit: number;
  stake: number;
  currency: string;
  duration: number;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Buy `count` separate contracts of the same digit bet.
 *
 * Parallel fires them together so every leg lands on the same tick, which is
 * what bulk is for. Sequential is the fallback: it is slower and late legs can
 * slip to the next tick, but it survives cases where a burst is refused.
 * Partial fills are kept — a basket that only half fills is still a position.
 */
export async function buyDigitContractsBulk(
  client: DerivClient,
  input: DigitOrderInput,
  count: number,
  options: { parallel: boolean },
): Promise<BulkBuyResult> {
  const n = Math.max(1, Math.min(20, Math.floor(count)));
  const filled: DigitBuyResult[] = [];
  const reasons: string[] = [];
  let failed = 0;

  const note = (error: unknown) => {
    failed += 1;
    const message = reasonOf(error);
    if (!reasons.includes(message)) reasons.push(message);
  };

  if (options.parallel) {
    const results = await Promise.allSettled(
      Array.from({ length: n }, () => buyDigitContract(client, input)),
    );
    for (const result of results) {
      if (result.status === "fulfilled") filled.push(result.value);
      else note(result.reason);
    }
    return { filled, failed, reasons };
  }

  for (let i = 0; i < n; i += 1) {
    try {
      filled.push(await buyDigitContract(client, input));
    } catch (error) {
      note(error);
      // A second straight rejection means the basket is refused, not flaky —
      // keep firing and we just bleed latency into the next tick.
      if (filled.length === 0 && failed >= 2) break;
    }
  }
  return { filled, failed, reasons };
}
