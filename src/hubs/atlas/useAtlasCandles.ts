import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  accountCredentials,
  getAccountKind,
  subscribeAccountKind,
} from "../../lib/accountMode";
import { config } from "../../lib/config";
import { DerivClient } from "../../lib/deriv/client";
import { resolveAccount } from "../../lib/deriv/rest";
import type { BalanceResponse, ConnectionState } from "../../lib/deriv/types";
import type { AtlasBar } from "./instruments";

interface CandleResponse {
  msg_type: string;
  candles?: Array<{
    epoch: number;
    open: number | string;
    high: number | string;
    low: number | string;
    close: number | string;
  }>;
  ohlc?: {
    open_time?: number;
    epoch?: number;
    open: number | string;
    high: number | string;
    low: number | string;
    close: number | string;
  };
  tick?: {
    epoch: number;
    quote: number | string;
  };
}

function toBars(res: CandleResponse): AtlasBar[] {
  return (res.candles ?? [])
    .map((c) => ({
      epoch: c.epoch,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
    }))
    .filter(
      (b) =>
        Number.isFinite(b.open) &&
        Number.isFinite(b.high) &&
        Number.isFinite(b.low) &&
        Number.isFinite(b.close),
    );
}

function applyTick(bars: AtlasBar[], epoch: number, quote: number, gran: number): AtlasBar[] {
  if (!Number.isFinite(quote) || bars.length === 0) return bars;
  const bucket = Math.floor(epoch / gran) * gran;
  const next = bars.slice();
  const last = next[next.length - 1];
  if (last.epoch === bucket) {
    next[next.length - 1] = {
      ...last,
      high: Math.max(last.high, quote),
      low: Math.min(last.low, quote),
      close: quote,
    };
    return next;
  }
  if (bucket > last.epoch) {
    next.push({
      epoch: bucket,
      open: quote,
      high: quote,
      low: quote,
      close: quote,
    });
    if (next.length > 800) return next.slice(-800);
    return next;
  }
  return next;
}

export function useAtlasCandles(
  symbol: string,
  granularity: number,
  count = 500,
) {
  const accountKind = useSyncExternalStore(
    subscribeAccountKind,
    getAccountKind,
    getAccountKind,
  );
  const [bars, setBars] = useState<AtlasBar[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [currency, setCurrency] = useState("USD");
  const [feedState, setFeedState] = useState<ConnectionState>("idle");
  const [lastPrice, setLastPrice] = useState<number | null>(null);
  const [lastTickAt, setLastTickAt] = useState<number | null>(null);
  const [live, setLive] = useState(false);
  const [client, setClient] = useState<DerivClient | null>(null);
  const clientRef = useRef<DerivClient | null>(null);
  const stopTickRef = useRef<(() => Promise<void>) | null>(null);
  const stopOhlcRef = useRef<(() => Promise<void>) | null>(null);
  const stopBalanceRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    let cancelled = false;
    const feedSymbol = symbol;
    setLoading(true);
    setError(null);
    setLive(false);
    setFeedState("connecting");
    setClient(null);
    // Drop previous market/account quote immediately.
    setBars([]);
    setLastPrice(null);
    setLastTickAt(null);
    setBalance(null);

    void (async () => {
      try {
        const kind = accountKind;
        const creds = accountCredentials(kind);
        const token = creds.token || config.token;
        if (!config.appId || !token) {
          throw new Error("Deriv credentials missing — configure .env");
        }
        const account = await resolveAccount(
          { appId: config.appId, restUrl: config.restUrl, token },
          kind === "real" ? "real" : "demo",
          creds.accountId || undefined,
        );
        if (cancelled) return;

        clientRef.current?.disconnect();
        const nextClient = new DerivClient({
          appId: config.appId,
          restUrl: config.restUrl,
          token,
          accountId: account.accountId,
        });
        clientRef.current = nextClient;

        const offState = nextClient.onStateChange((state) => {
          if (!cancelled) setFeedState(state);
        });

        await new Promise<void>((resolve, reject) => {
          const t = window.setTimeout(
            () => reject(new Error("Deriv connect timeout")),
            20_000,
          );
          const off = nextClient.onStateChange((state) => {
            if (state === "ready") {
              window.clearTimeout(t);
              off();
              resolve();
            }
            if (state === "error" || state === "closed") {
              window.clearTimeout(t);
              off();
              reject(new Error("Deriv connection failed"));
            }
          });
          nextClient.connect();
        });
        if (cancelled) {
          offState();
          nextClient.disconnect();
          return;
        }

        setClient(nextClient);
        setBalance(nextClient.account?.balance ?? account.balance ?? null);
        setCurrency(nextClient.account?.currency ?? account.currency ?? "USD");

        try {
          stopBalanceRef.current = await nextClient.subscribe<BalanceResponse>(
            { balance: 1, subscribe: 1 },
            (msg) => {
              if (cancelled || !msg.balance) return;
              setBalance(Number(msg.balance.balance));
              if (msg.balance.currency) setCurrency(msg.balance.currency);
            },
          );
        } catch {
          // Balance stream optional — authorize balance still shown.
        }

        const res = await nextClient.send<CandleResponse>({
          ticks_history: feedSymbol,
          adjust_start_time: 1,
          style: "candles",
          granularity,
          count,
          end: "latest",
        });
        if (cancelled) {
          offState();
          nextClient.disconnect();
          return;
        }

        const history = toBars(res);
        setBars(history);
        if (history.length) {
          setLastPrice(history[history.length - 1].close);
        }
        setLoading(false);

        stopOhlcRef.current = await nextClient.subscribe<CandleResponse>(
          {
            ticks_history: feedSymbol,
            adjust_start_time: 1,
            style: "candles",
            granularity,
            count: 1,
            end: "latest",
          },
          (msg) => {
            if (cancelled) return;
            const ohlc = msg.ohlc;
            if (!ohlc) return;
            const epoch = Number(ohlc.open_time ?? ohlc.epoch);
            const bar: AtlasBar = {
              epoch,
              open: Number(ohlc.open),
              high: Number(ohlc.high),
              low: Number(ohlc.low),
              close: Number(ohlc.close),
            };
            if (!Number.isFinite(bar.epoch) || !Number.isFinite(bar.close)) {
              return;
            }
            setLive(true);
            setLastPrice(bar.close);
            setLastTickAt(Date.now());
            setBars((prev) => {
              if (prev.length === 0) return [bar];
              const last = prev[prev.length - 1];
              if (last.epoch === bar.epoch) {
                const next = prev.slice();
                next[next.length - 1] = bar;
                return next;
              }
              if (bar.epoch > last.epoch) {
                return [...prev.slice(-799), bar];
              }
              return prev;
            });
          },
        );

        stopTickRef.current = await nextClient.subscribe<CandleResponse>(
          { ticks: feedSymbol },
          (msg) => {
            if (cancelled || !msg.tick) return;
            const quote = Number(msg.tick.quote);
            const epoch = Number(msg.tick.epoch);
            if (!Number.isFinite(quote)) return;
            setLive(true);
            setLastPrice(quote);
            setLastTickAt(Date.now());
            setBars((prev) => applyTick(prev, epoch, quote, granularity));
            if (nextClient.account?.balance != null) {
              setBalance(nextClient.account.balance);
            }
          },
        );

        if (cancelled) {
          await stopOhlcRef.current?.();
          await stopTickRef.current?.();
          await stopBalanceRef.current?.();
          offState();
          nextClient.disconnect();
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
          setFeedState("error");
          setLive(false);
          setClient(null);
        }
      }
    })();

    return () => {
      cancelled = true;
      void stopTickRef.current?.();
      void stopOhlcRef.current?.();
      void stopBalanceRef.current?.();
      stopTickRef.current = null;
      stopOhlcRef.current = null;
      stopBalanceRef.current = null;
      clientRef.current?.disconnect();
      clientRef.current = null;
      setClient(null);
    };
  }, [symbol, granularity, count, accountKind]);

  return {
    bars,
    loading,
    error,
    balance,
    currency,
    feedState,
    lastPrice,
    lastTickAt,
    live,
    client,
    accountKind,
  };
}
