import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DerivClient } from "../lib/deriv/client";
import { lastDigit } from "../lib/deriv/types";
import type {
  AuthorizeResponse,
  BalanceResponse,
  ConnectionState,
  HistoryResponse,
  Tick,
  TickResponse,
} from "../lib/deriv/types";
import { config, isConfigured } from "../lib/config";

/** Ticks retained in memory; the largest analysis window must fit inside it. */
export const MAX_TICKS = 5000;

export interface DerivFeed {
  state: ConnectionState;
  error: string | null;
  account: AuthorizeResponse["authorize"] | null;
  balance: number | null;
  currency: string;
  ticks: Tick[];
  digits: number[];
  reconnect: () => void;
}

export function useDerivFeed(symbol: string, historyCount = 1000): DerivFeed {
  const clientRef = useRef<DerivClient | null>(null);
  const [state, setState] = useState<ConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<AuthorizeResponse["authorize"] | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [attempt, setAttempt] = useState(0);

  const reconnect = useCallback(() => {
    setError(null);
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!isConfigured) {
      setState("error");
      setError(config.errors.join(" "));
      return;
    }

    const client = new DerivClient({
      appId: config.appId,
      wsUrl: config.wsUrl,
      token: config.token,
    });
    clientRef.current = client;
    setTicks([]);

    let cancelled = false;
    const cleanups: Array<() => void> = [];

    cleanups.push(client.onStateChange(setState));
    cleanups.push(
      client.onError((clientError) => {
        if (!cancelled) setError(clientError.message);
      }),
    );

    cleanups.push(
      client.onStateChange((nextState) => {
        if (nextState !== "ready" || cancelled) return;
        setAccount(client.account);
        setBalance(client.account?.balance ?? null);

        void client
          .subscribe<BalanceResponse>({ balance: 1 }, (message) => {
            if (!cancelled) setBalance(message.balance.balance);
          })
          .then((stop) => cleanups.push(stop))
          .catch((subscribeError: Error) => {
            if (!cancelled) setError(subscribeError.message);
          });

        void client
          .subscribe<HistoryResponse | TickResponse>(
            {
              ticks_history: symbol,
              adjust_start_time: 1,
              count: historyCount,
              end: "latest",
              style: "ticks",
            },
            (message) => {
              if (cancelled) return;

              if (message.msg_type === "history") {
                const { prices, times } = message.history;
                const pipSize = message.pip_size;
                setTicks(
                  prices.map((quote, index) => ({
                    epoch: times[index],
                    quote,
                    pipSize,
                    digit: lastDigit(quote, pipSize),
                  })),
                );
                return;
              }

              if (message.msg_type === "tick") {
                const { epoch, quote, pip_size: pipSize } = message.tick;
                setTicks((previous) => {
                  // Deriv replays the latest tick right after the history
                  // snapshot; keep the buffer strictly increasing in time.
                  if (previous.length > 0 && previous[previous.length - 1].epoch >= epoch) {
                    return previous;
                  }
                  const next = [...previous, { epoch, quote, pipSize, digit: lastDigit(quote, pipSize) }];
                  return next.length > MAX_TICKS ? next.slice(next.length - MAX_TICKS) : next;
                });
              }
            },
          )
          .then((stop) => cleanups.push(stop))
          .catch((subscribeError: Error) => {
            if (!cancelled) setError(subscribeError.message);
          });
      }),
    );

    client.connect();

    return () => {
      cancelled = true;
      for (const cleanup of cleanups) cleanup();
      client.disconnect();
      clientRef.current = null;
    };
  }, [symbol, historyCount, attempt]);

  const digits = useMemo(() => ticks.map((tick) => tick.digit), [ticks]);

  return {
    state,
    error,
    account,
    balance,
    currency: account?.currency ?? "USD",
    ticks,
    digits,
    reconnect,
  };
}
