import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
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
import { isClientRole } from "../lib/appRole";
import {
  accountCredentials,
  getAccountKind,
  setAccountKind,
  subscribeAccountKind,
} from "../lib/accountMode";
import {
  getSelectedOauthAccount,
  subscribeOauthSession,
} from "../lib/deriv/oauth";

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
  /** Symbol the live tick stream is currently subscribed to. */
  streamSymbol: string | null;
  /** True while a symbol switch is loading history (old ticks kept until replace). */
  switching: boolean;
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

/**
 * Live Deriv feed.
 *
 * The WebSocket stays up across market changes. Only the tick subscription is
 * swapped, so Start / market pick continues without a full page-style refresh:
 * chart and digits keep the previous stream until the new history arrives, then
 * replace in one shot and keep appending live ticks.
 *
 * Live ticks are buffered and flushed once per animation frame so a busy main
 * thread still paints digits as fast as Deriv's chart, not once per heavy
 * analyzer pass.
 */
export function useDerivFeed(symbol: string, historyCount = 1000): DerivFeed {
  const clientRef = useRef<DerivClient | null>(null);
  const tickStopRef = useRef<(() => Promise<void>) | null>(null);
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;
  /** Mutable live buffer — React state is updated from here on rAF. */
  const ticksBufRef = useRef<Tick[]>([]);
  const digitsBufRef = useRef<number[]>([]);
  const rafFlushRef = useRef<number | null>(null);
  const pendingLiveRef = useRef(false);

  const [client, setClient] = useState<DerivClient | null>(null);
  const [state, setState] = useState<ConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<OptionsAccount | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [digits, setDigits] = useState<number[]>([]);
  const [streamSymbol, setStreamSymbol] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const accountKind = useSyncExternalStore(subscribeAccountKind, getAccountKind, getAccountKind);
  const oauthLoginid = useSyncExternalStore(
    subscribeOauthSession,
    () => getSelectedOauthAccount()?.loginid ?? "",
    () => "",
  );

  const flushTicksToReact = useCallback(() => {
    rafFlushRef.current = null;
    if (!pendingLiveRef.current) return;
    pendingLiveRef.current = false;
    setTicks(ticksBufRef.current);
    setDigits(digitsBufRef.current);
  }, []);

  const scheduleTickFlush = useCallback(() => {
    pendingLiveRef.current = true;
    if (rafFlushRef.current != null) return;
    rafFlushRef.current = window.requestAnimationFrame(flushTicksToReact);
  }, [flushTicksToReact]);

  const appendLiveTick = useCallback(
    (tick: Tick) => {
      const buf = ticksBufRef.current;
      if (buf.length > 0 && buf[buf.length - 1].epoch >= tick.epoch) return;
      let nextTicks: Tick[];
      let nextDigits: number[];
      if (buf.length >= MAX_TICKS) {
        const start = buf.length - MAX_TICKS + 1;
        nextTicks = buf.slice(start);
        nextTicks.push(tick);
        nextDigits = digitsBufRef.current.slice(start);
        nextDigits.push(tick.digit);
      } else {
        nextTicks = buf.concat(tick);
        nextDigits = digitsBufRef.current.concat(tick.digit);
      }
      ticksBufRef.current = nextTicks;
      digitsBufRef.current = nextDigits;
      scheduleTickFlush();
    },
    [scheduleTickFlush],
  );

  const replaceTicks = useCallback((next: Tick[]) => {
    ticksBufRef.current = next;
    digitsBufRef.current = next.map((tick) => tick.digit);
    pendingLiveRef.current = false;
    if (rafFlushRef.current != null) {
      window.cancelAnimationFrame(rafFlushRef.current);
      rafFlushRef.current = null;
    }
    setTicks(next);
    setDigits(digitsBufRef.current);
  }, []);

  const reconnect = useCallback(() => {
    setError(null);
    setAttempt((value) => value + 1);
  }, []);

  // Connection + balance — remount only on account / manual reconnect.
  useEffect(() => {
    if (!isConfigured) {
      setState("error");
      setError(config.errors.join(" "));
      return;
    }

    let cancelled = false;
    const cleanups: Array<() => void> = [];
    setError(null);
    setState("authorizing");
    replaceTicks([]);
    setStreamSymbol(null);

    const credentials = accountCredentials(accountKind);
    const clientDesk = isClientRole();

    void (async () => {
      try {
        if (credentials.transport === "public") {
          // Visitor preview — classic WS ticks, no authorize / balance.
          const nextClient = new DerivClient({
            appId: config.appId,
            restUrl: config.restUrl,
            token: "",
            accountId: "public",
            transport: "public",
          });
          clientRef.current = nextClient;
          setClient(nextClient);
          setAccount(null);
          setBalance(null);
          cleanups.push(nextClient.onStateChange(setState));
          cleanups.push(
            nextClient.onError((clientError) => {
              if (!cancelled) setError(clientError.message);
            }),
          );
          nextClient.connect();
          await waitForReady(nextClient);
          return;
        }

        if (!credentials.token) {
          throw new Error(
            clientDesk
              ? "Log in with Deriv to connect your demo or live balance."
              : `No API token is configured for the ${accountKind} account.`,
          );
        }

        let resolvedAccountId = credentials.accountId;
        let resolvedBalance: number | null = null;
        let resolvedCurrency = "USD";
        let resolvedVirtual = accountKind === "demo";

        if (credentials.transport === "otp") {
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
          resolvedAccountId = resolved.accountId;
          resolvedBalance = resolved.balance;
          resolvedCurrency = resolved.currency;
          resolvedVirtual = resolved.isVirtual;
          setAccount(resolved);
          setBalance(resolved.balance);
        } else {
          // OAuth — account filled after classic authorize.
          if (credentials.accountId) {
            const oauth = getSelectedOauthAccount();
            if (oauth) setAccountKind(oauth.kind);
          }
          setAccount({
            accountId: resolvedAccountId,
            balance: 0,
            currency: resolvedCurrency,
            isVirtual: resolvedVirtual,
            status: "active",
          });
          setBalance(null);
        }

        const nextClient = new DerivClient({
          appId: config.appId,
          restUrl: config.restUrl,
          token: credentials.token,
          accountId: resolvedAccountId,
          transport: credentials.transport,
        });
        if (credentials.transport === "otp") {
          nextClient.account = {
            accountId: resolvedAccountId,
            balance: resolvedBalance ?? 0,
            currency: resolvedCurrency,
            isVirtual: resolvedVirtual,
            status: "active",
          };
        }
        clientRef.current = nextClient;
        setClient(nextClient);

        cleanups.push(nextClient.onStateChange(setState));
        cleanups.push(
          nextClient.onError((clientError) => {
            if (!cancelled) setError(clientError.message);
          }),
        );

        nextClient.connect();
        await waitForReady(nextClient);
        if (cancelled) return;

        if (nextClient.account) {
          setAccount(nextClient.account);
          setBalance(nextClient.account.balance);
        }

        if (credentials.transport !== "public") {
          const stopBalance = await nextClient.subscribe<BalanceResponse>(
            { balance: 1 },
            (message) => {
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
            },
          );
          cleanups.push(stopBalance);
        }
      } catch (connectError) {
        if (cancelled) return;
        setState("error");
        setError(
          connectError instanceof Error ? connectError.message : String(connectError),
        );
      }
    })();

    return () => {
      cancelled = true;
      tickStopRef.current?.();
      tickStopRef.current = null;
      if (rafFlushRef.current != null) {
        window.cancelAnimationFrame(rafFlushRef.current);
        rafFlushRef.current = null;
      }
      for (const cleanup of cleanups) cleanup();
      clientRef.current?.disconnect();
      clientRef.current = null;
      setClient(null);
    };
  }, [attempt, accountKind, oauthLoginid, replaceTicks]);

  // Hot-swap tick stream when symbol (or history size) changes — keep socket.
  useEffect(() => {
    const active = clientRef.current;
    if (!active || state !== "ready") return;

    let cancelled = false;
    setSwitching(true);

    void (async () => {
      // Wait for the old stream to be forgotten. Firing the next subscribe
      // alongside it races the forget, and Deriv answers the loser with
      // "You are already subscribed to <symbol>".
      const stopPrevious = tickStopRef.current;
      tickStopRef.current = null;
      if (stopPrevious) await stopPrevious();

      try {
        // Load a short history first so digits paint immediately, then top up.
        const bootstrapCount = Math.min(historyCount, 400);
        const stopTicks = await active.subscribe<HistoryResponse | TickResponse>(
          {
            ticks_history: symbol,
            adjust_start_time: 1,
            count: bootstrapCount,
            end: "latest",
            style: "ticks",
          },
          (message) => {
            if (cancelled || symbolRef.current !== symbol) return;

            if (message.msg_type === "history") {
              setError(null);
              const { prices, times } = message.history;
              const pipSize = message.pip_size;
              replaceTicks(
                prices.map((quote, index) => ({
                  epoch: times[index],
                  quote,
                  pipSize,
                  digit: lastDigit(quote, pipSize),
                })),
              );
              setStreamSymbol(symbol);
              setSwitching(false);
              return;
            }

            if (message.msg_type === "tick") {
              setError(null);
              const { epoch, quote, pip_size: pipSize } = message.tick;
              appendLiveTick({
                epoch,
                quote,
                pipSize,
                digit: lastDigit(quote, pipSize),
              });
              setStreamSymbol(symbol);
              setSwitching(false);
            }
          },
        );

        if (cancelled) {
          void stopTicks();
          return;
        }
        tickStopRef.current = stopTicks;

        // Background top-up to full analysis window without blocking live ticks.
        if (historyCount > bootstrapCount) {
          void active
            .send<HistoryResponse>({
              ticks_history: symbol,
              adjust_start_time: 1,
              count: historyCount,
              end: "latest",
              style: "ticks",
              subscribe: 0,
            })
            .then((message) => {
              if (cancelled || symbolRef.current !== symbol) return;
              if (message.msg_type !== "history") return;
              const { prices, times } = message.history;
              const pipSize = message.pip_size;
              const deep = prices.map((quote, index) => ({
                epoch: times[index],
                quote,
                pipSize,
                digit: lastDigit(quote, pipSize),
              }));
              // Merge: keep any live ticks newer than the history end.
              const liveTail = ticksBufRef.current.filter(
                (tick) =>
                  deep.length === 0 ||
                  tick.epoch > deep[deep.length - 1].epoch,
              );
              replaceTicks(
                liveTail.length > 0 ? deep.concat(liveTail) : deep,
              );
            })
            .catch(() => {
              /* live stream already running — deep history is optional */
            });
        }
      } catch (subError) {
        if (cancelled) return;
        setSwitching(false);
        setError(subError instanceof Error ? subError.message : String(subError));
      }
    })();

    return () => {
      cancelled = true;
      tickStopRef.current?.();
      tickStopRef.current = null;
    };
  }, [client, state, symbol, historyCount, appendLiveTick, replaceTicks]);

  return {
    state,
    error,
    account,
    balance,
    currency: account?.currency ?? "USD",
    ticks,
    digits,
    streamSymbol,
    switching,
    client,
    reconnect,
  };
}
