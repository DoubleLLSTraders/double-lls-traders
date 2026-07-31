import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DerivClient } from "../lib/deriv/client";
import { resolveAccount } from "../lib/deriv/rest";
import { lastDigit } from "../lib/deriv/types";
import type {
  BalanceResponse,
  ConnectionState,
  HistoryResponse,
  OptionsAccount,
  Tick,
  TickResponse,
} from "../lib/deriv/types";
import { config, isConfigured } from "../lib/config";
import {
  accountCredentials,
  getAccountKind,
  subscribeAccountKind,
} from "../lib/accountMode";

/** Ticks retained in memory; the largest analysis window must fit inside it. */
export const MAX_TICKS = 5000;

export interface DerivFeed {
  state: ConnectionState;
  error: string | null;
  account: OptionsAccount | null;
  balance: number | null;
  currency: string;
  ticks: Tick[];
  digits: number[];
  client: DerivClient | null;
  reconnect: () => void;
}

function waitForReady(client: DerivClient): Promise<void> {
  if (client.getState() === "ready") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const stopState = client.onStateChange((state) => {
      if (state === "ready") {
        stopState();
        stopError();
        resolve();
      }
      if (state === "error" || state === "closed") {
        stopState();
        stopError();
        reject(new Error(`Connection ended in state: ${state}`));
      }
    });
    const stopError = client.onError((error) => {
      stopState();
      stopError();
      reject(error);
    });
  });
}

export function useDerivFeed(symbol: string, historyCount = 1000): DerivFeed {
  const clientRef = useRef<DerivClient | null>(null);
  const [client, setClient] = useState<DerivClient | null>(null);
  const [state, setState] = useState<ConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<OptionsAccount | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [attempt, setAttempt] = useState(0);
  const accountKind = useSyncExternalStore(subscribeAccountKind, getAccountKind, getAccountKind);

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

    let cancelled = false;
    const cleanups: Array<() => void> = [];
    setTicks([]);
    setError(null);
    setState("authorizing");

    const credentials = accountCredentials(accountKind);

    void (async () => {
      try {
        if (!credentials.token) {
          throw new Error(
            `No API token is configured for the ${accountKind} account.`,
          );
        }

        const resolved = await resolveAccount(
          {
            appId: config.appId,
            restUrl: config.restUrl,
            token: credentials.token,
          },
          accountKind,
          credentials.accountId || undefined,
        );
        if (cancelled) return;

        setAccount(resolved);
        setBalance(resolved.balance);

        const client = new DerivClient({
          appId: config.appId,
          restUrl: config.restUrl,
          token: credentials.token,
          accountId: resolved.accountId,
        });
        client.account = resolved;
        clientRef.current = client;
        setClient(client);

        cleanups.push(client.onStateChange(setState));
        cleanups.push(
          client.onError((clientError) => {
            if (!cancelled) setError(clientError.message);
          }),
        );

        client.connect();
        await waitForReady(client);
        if (cancelled) return;

        // Subscribe once. The client restores these on reconnect — do not
        // re-subscribe on every "ready" or Deriv returns AlreadySubscribed.
        const stopBalance = await client.subscribe<BalanceResponse>({ balance: 1 }, (message) => {
          if (cancelled) return;
          setError(null);
          setBalance(message.balance.balance);
          setAccount((previous) =>
            previous
              ? {
                  ...previous,
                  balance: message.balance.balance,
                  currency: message.balance.currency,
                  accountId: message.balance.loginid || previous.accountId,
                }
              : previous,
          );
        });
        cleanups.push(stopBalance);

        const stopTicks = await client.subscribe<HistoryResponse | TickResponse>(
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
              setError(null);
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
              setError(null);
              const { epoch, quote, pip_size: pipSize } = message.tick;
              setTicks((previous) => {
                if (previous.length > 0 && previous[previous.length - 1].epoch >= epoch) {
                  return previous;
                }
                const next = [
                  ...previous,
                  { epoch, quote, pipSize, digit: lastDigit(quote, pipSize) },
                ];
                return next.length > MAX_TICKS ? next.slice(next.length - MAX_TICKS) : next;
              });
            }
          },
        );
        cleanups.push(stopTicks);
      } catch (connectError) {
        if (cancelled) return;
        setState("error");
        setError(connectError instanceof Error ? connectError.message : String(connectError));
      }
    })();

    return () => {
      cancelled = true;
      for (const cleanup of cleanups) cleanup();
      clientRef.current?.disconnect();
      clientRef.current = null;
      setClient(null);
    };
  }, [symbol, historyCount, attempt, accountKind]);

  const digits = useMemo(() => ticks.map((tick) => tick.digit), [ticks]);

  return {
    state,
    error,
    account,
    balance,
    currency: account?.currency ?? "USD",
    ticks,
    digits,
    client,
    reconnect,
  };
}
