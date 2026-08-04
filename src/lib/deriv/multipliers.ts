/**
 * Deriv Multiplier helpers for Atlas live wallet (MULTUP / MULTDOWN).
 * Digits stay on digit contracts; Atlas FX/Gold/Crypto use this path on Real.
 */
import type { DerivClient } from "./client";
import type { BaseResponse } from "./types";

export type MultiplierSide = "buy" | "sell";

export interface MultiplierBuyInput {
  symbol: string;
  side: MultiplierSide;
  stake: number;
  currency: string;
  /** Deriv multiplier (e.g. 50–100). Clamped defensively. */
  multiplier: number;
  /** Cash stop-loss amount (positive). */
  stopLossCash?: number;
  /** Cash take-profit amount (positive). */
  takeProfitCash?: number;
}

export interface MultiplierBuyResult {
  contractId: number;
  buyPrice: number;
  payout: number;
  spot: number | null;
}

export interface MultiplierOpenSnapshot {
  contractId: number;
  isSold: boolean;
  profit: number;
  status: string;
  entrySpot: number | null;
  currentSpot: number | null;
  sellPrice: number | null;
}

interface BuyResponse extends BaseResponse {
  msg_type: "buy";
  buy: {
    contract_id: number;
    buy_price: number;
    payout: number;
  };
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

interface SellResponse extends BaseResponse {
  msg_type: "sell";
  sell: {
    contract_id: number;
    sold_for: number;
    transaction_id?: number;
  };
}

interface OpenContractResponse extends BaseResponse {
  msg_type: "proposal_open_contract";
  proposal_open_contract: {
    contract_id: number;
    is_sold: 0 | 1;
    profit: number | string;
    status: string;
    entry_spot?: number | string;
    current_spot?: number | string;
    sell_price?: number | string;
    bid_price?: number | string;
  };
}

function contractType(side: MultiplierSide): "MULTUP" | "MULTDOWN" {
  return side === "buy" ? "MULTUP" : "MULTDOWN";
}

/** Crypto Mults on Deriv (BTC/ETH) — 50 is rejected. */
const CRYPTO_MULTIPLIERS = [100, 200, 300, 500, 800] as const;
/** FX / metals Mults — common Deriv set. */
const FX_METAL_MULTIPLIERS = [20, 30, 50, 100, 150, 200, 300] as const;

export function allowedMultipliersForSymbol(symbol: string): readonly number[] {
  if (symbol.startsWith("cry")) return CRYPTO_MULTIPLIERS;
  return FX_METAL_MULTIPLIERS;
}

/** Snap UI leverage / request to a Deriv-accepted multiplier for this market. */
export function resolveMultiplierForSymbol(
  symbol: string,
  requested: number,
): number {
  const allowed = allowedMultipliersForSymbol(symbol);
  const want = Number.isFinite(requested) ? requested : allowed[0];
  let best = allowed[0];
  let bestDist = Math.abs(want - best);
  for (const n of allowed) {
    const d = Math.abs(want - n);
    if (d < bestDist) {
      best = n;
      bestDist = d;
    }
  }
  return best;
}

function clampMultiplier(symbol: string, n: number): number {
  return resolveMultiplierForSymbol(symbol, n);
}

function buildParameters(input: MultiplierBuyInput): Record<string, unknown> {
  const limitOrder: Record<string, number> = {};
  if (input.stopLossCash != null && input.stopLossCash > 0) {
    limitOrder.stop_loss = Math.round(input.stopLossCash * 100) / 100;
  }
  if (input.takeProfitCash != null && input.takeProfitCash > 0) {
    limitOrder.take_profit = Math.round(input.takeProfitCash * 100) / 100;
  }

  const parameters: Record<string, unknown> = {
    amount: input.stake,
    basis: "stake",
    contract_type: contractType(input.side),
    currency: input.currency,
    underlying_symbol: input.symbol,
    multiplier: clampMultiplier(input.symbol, input.multiplier),
  };
  if (Object.keys(limitOrder).length) {
    parameters.limit_order = limitOrder;
  }
  return parameters;
}

/** Price quote before buy (optional; buy uses inline parameters). */
export async function proposeMultiplier(
  client: DerivClient,
  input: MultiplierBuyInput,
): Promise<{ id: string; askPrice: number; payout: number; spot: number | null }> {
  const response = await client.send<ProposalResponse>({
    proposal: 1,
    ...buildParameters(input),
  });
  return {
    id: response.proposal.id,
    askPrice: response.proposal.ask_price,
    payout: response.proposal.payout,
    spot:
      response.proposal.spot != null && Number.isFinite(response.proposal.spot)
        ? Number(response.proposal.spot)
        : null,
  };
}

/**
 * Buy MULTUP (buy) or MULTDOWN (sell) with inline parameters.
 * Prefer this over proposal→buy to avoid consumed proposal ids.
 */
export async function buyMultiplier(
  client: DerivClient,
  input: MultiplierBuyInput,
): Promise<MultiplierBuyResult> {
  if (!(input.stake > 0)) {
    throw new Error("Stake must be greater than zero");
  }
  const parameters = buildParameters(input);
  const response = await client.send<BuyResponse>({
    buy: 1,
    price: input.stake,
    parameters,
  });
  return {
    contractId: response.buy.contract_id,
    buyPrice: response.buy.buy_price,
    payout: response.buy.payout,
    spot: null,
  };
}

/** Market-sell an open multiplier contract. Returns cash sold_for (not profit). */
export async function sellMultiplier(
  client: DerivClient,
  contractId: number,
): Promise<{ contractId: number; soldFor: number }> {
  const response = await client.send<SellResponse>({
    sell: contractId,
    price: 0,
  });
  return {
    contractId: response.sell.contract_id,
    soldFor: Number(response.sell.sold_for),
  };
}

function snapshotFrom(
  poc: OpenContractResponse["proposal_open_contract"],
): MultiplierOpenSnapshot {
  const entry =
    poc.entry_spot != null && Number.isFinite(Number(poc.entry_spot))
      ? Number(poc.entry_spot)
      : null;
  const spot =
    poc.current_spot != null && Number.isFinite(Number(poc.current_spot))
      ? Number(poc.current_spot)
      : null;
  const sell =
    poc.sell_price != null && Number.isFinite(Number(poc.sell_price))
      ? Number(poc.sell_price)
      : poc.bid_price != null && Number.isFinite(Number(poc.bid_price))
        ? Number(poc.bid_price)
        : null;
  return {
    contractId: poc.contract_id,
    isSold: poc.is_sold === 1,
    profit: Number(poc.profit) || 0,
    status: String(poc.status ?? ""),
    entrySpot: entry,
    currentSpot: spot,
    sellPrice: sell,
  };
}

/** One-shot open-contract read. */
export async function fetchOpenContract(
  client: DerivClient,
  contractId: number,
): Promise<MultiplierOpenSnapshot> {
  const response = await client.send<OpenContractResponse>({
    proposal_open_contract: 1,
    contract_id: contractId,
  });
  return snapshotFrom(response.proposal_open_contract);
}

/**
 * Subscribe to open-contract updates. Caller must unsubscribe.
 * Fires on each update; when sold, still fires once with isSold true.
 */
export async function watchOpenContract(
  client: DerivClient,
  contractId: number,
  onUpdate: (snap: MultiplierOpenSnapshot) => void,
): Promise<() => Promise<void>> {
  return client.subscribe<OpenContractResponse>(
    { proposal_open_contract: 1, contract_id: contractId, subscribe: 1 },
    (message) => {
      if (!message.proposal_open_contract) return;
      onUpdate(snapshotFrom(message.proposal_open_contract));
    },
  );
}
