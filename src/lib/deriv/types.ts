/** Subset of the Deriv Options WebSocket protocol we use. */

export interface DerivError {
  code: string;
  message: string;
}

export interface BaseResponse {
  msg_type: string;
  req_id?: number;
  echo_req?: Record<string, unknown>;
  error?: DerivError;
  subscription?: { id: string };
}

export interface OptionsAccount {
  accountId: string;
  balance: number;
  currency: string;
  isVirtual: boolean;
  status: string;
}

export interface BalanceResponse extends BaseResponse {
  msg_type: "balance";
  balance: {
    balance: number;
    currency: string;
    loginid: string;
    id?: string;
  };
}

export interface HistoryResponse extends BaseResponse {
  msg_type: "history";
  pip_size: number;
  history: {
    prices: number[];
    times: number[];
  };
}

export interface TickResponse extends BaseResponse {
  msg_type: "tick";
  tick: {
    symbol: string;
    epoch: number;
    quote: number;
    pip_size: number;
    id?: string;
    ask?: number;
    bid?: number;
  };
}

export interface PingResponse extends BaseResponse {
  msg_type: "ping";
  ping: "pong";
}

export interface ForgetResponse extends BaseResponse {
  msg_type: "forget";
  forget: 0 | 1;
}

export interface ProposalResponse extends BaseResponse {
  msg_type: "proposal";
  proposal: {
    id: string;
    ask_price: number;
    payout: number;
    spot?: number;
  };
}

export interface BuyResponse extends BaseResponse {
  msg_type: "buy";
  buy: {
    contract_id: number;
    buy_price: number;
    payout: number;
  };
}

/** A single price observation, normalised for our own use. */
export interface Tick {
  epoch: number;
  quote: number;
  pipSize: number;
  digit: number;
}

export type ConnectionState =
  | "idle"
  | "connecting"
  | "authorizing"
  | "ready"
  | "reconnecting"
  | "error"
  | "closed";

/**
 * Deriv quotes are decimal strings truncated to `pip_size` places. Deriving the
 * digit arithmetically (quote * 100 % 10) hits floating point error, so format
 * to the declared precision and read the final character instead.
 */
export function lastDigit(quote: number, pipSize: number): number {
  const text = quote.toFixed(pipSize);
  return Number(text[text.length - 1]);
}
