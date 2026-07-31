import type { TradeJournalEntry } from "./types";

const KEY = "mrnyc.trades.v1";
/** Keeps localStorage well under quota while still holding a long history. */
const LIMIT = 2000;

export interface StoredTrade extends TradeJournalEntry {
  symbol: string;
  currency: string;
}

let cache: StoredTrade[] | null = null;
const listeners = new Set<() => void>();

function read(): StoredTrade[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed) ? (parsed as StoredTrade[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(next: StoredTrade[]): void {
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Quota or private-mode failure: keep the in-memory copy so the session
    // ledger still renders.
  }
  for (const listener of listeners) listener();
}

export function getTrades(): StoredTrade[] {
  return read();
}

export function appendTrade(trade: StoredTrade): void {
  const current = read();
  if (current.some((item) => item.id === trade.id && item.at === trade.at)) return;
  write([trade, ...current].slice(0, LIMIT));
}

export function clearTrades(): void {
  write([]);
}

export function subscribeTrades(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
