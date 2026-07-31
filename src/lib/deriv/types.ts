/** Subset of the Deriv WebSocket API v3 we actually use. */

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

export interface AuthorizeResponse extends BaseResponse {
  msg_type: "authorize";
  authorize: {
    loginid: string;
    balance: number;
    currency: string;
    is_virtual: 0 | 1;
    email?: string;
    fullname?: string;
  };
}

export interface BalanceResponse extends BaseResponse {
  msg_type: "balance";
  balance: {
    balance: number;
    currency: string;
    loginid: string;
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
