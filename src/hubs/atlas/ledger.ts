/**
 * Atlas demo ledger — treat like live account books.
 * Single rule: cash balance = startBalance + sum(closed trade pnlCash).
 * UI must never invent P/L that is not written into the journal.
 */
import { storageKey } from "../../lib/platform";

export const ATLAS_DEMO_START = 10_000;

export interface AtlasLedgerTrade {
  id: string;
  at: number;
  symbol: string;
  side: "buy" | "sell";
  entry: number;
  stop: number;
  target: number;
  result: "open" | "win" | "loss" | "flat";
  pnlR: number;
  reason: string;
  paper: boolean;
  /** Cash at risk at entry — required for open & settled sizing. */
  riskCash: number;
  notional: number;
  currency: string;
  settledAt?: number;
  /** Settled cash P/L — required once result !== open. */
  pnlCash?: number;
}

export interface AtlasLedgerAccount {
  startBalance: number;
  balance: number;
  currency: string;
  updatedAt: number;
}

const JOURNAL_KEY = storageKey("atlas-journal");
const ACCOUNT_KEY = storageKey("atlas-demo-account");
const JOURNAL_LIMIT = 2000;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function sumClosedPnlCash(trades: AtlasLedgerTrade[]): number {
  return round2(
    trades
      .filter(
        (t) => t.result === "win" || t.result === "loss" || t.result === "flat",
      )
      .reduce((s, t) => s + (Number.isFinite(t.pnlCash) ? Number(t.pnlCash) : 0), 0),
  );
}

export function dayClosedPnlCash(trades: AtlasLedgerTrade[], now = Date.now()): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const t0 = start.getTime();
  return round2(
    trades
      .filter(
        (t) => t.result === "win" || t.result === "loss" || t.result === "flat",
      )
      .filter((t) => (t.settledAt ?? t.at) >= t0)
      .reduce((s, t) => s + (Number.isFinite(t.pnlCash) ? Number(t.pnlCash) : 0), 0),
  );
}

export function balanceFromTrades(
  startBalance: number,
  trades: AtlasLedgerTrade[],
): number {
  return round2(Math.max(0, startBalance + sumClosedPnlCash(trades)));
}

/** Repair legacy rows so every closed trade has concrete pnlCash/riskCash. */
export function normalizeTrade(
  raw: Partial<AtlasLedgerTrade> & {
    id: string;
    result: AtlasLedgerTrade["result"];
  },
  fallbackRisk: number,
  currency: string,
): AtlasLedgerTrade {
  const riskCash = round2(
    raw.riskCash != null && raw.riskCash > 0
      ? Number(raw.riskCash)
      : Math.max(1, fallbackRisk),
  );
  const pnlR = Number.isFinite(raw.pnlR) ? Number(raw.pnlR) : 0;
  let pnlCash = raw.pnlCash;
  if (raw.result === "win" || raw.result === "loss" || raw.result === "flat") {
    if (pnlCash == null || !Number.isFinite(pnlCash)) {
      pnlCash = round2(pnlR * riskCash);
    } else {
      pnlCash = round2(Number(pnlCash));
    }
  } else {
    pnlCash = undefined;
  }

  return {
    id: raw.id,
    at: Number(raw.at) || Date.now(),
    symbol: String(raw.symbol ?? ""),
    side: raw.side === "sell" ? "sell" : "buy",
    entry: Number(raw.entry) || 0,
    stop: Number(raw.stop) || 0,
    target: Number(raw.target) || 0,
    result: raw.result,
    pnlR,
    reason: String(raw.reason ?? ""),
    paper: raw.paper !== false,
    riskCash,
    notional: round2(Number(raw.notional) || 0),
    currency: String(raw.currency ?? currency),
    settledAt: raw.settledAt,
    pnlCash,
  };
}

export function normalizeJournal(
  trades: Partial<AtlasLedgerTrade>[],
  fallbackRisk: number,
  currency: string,
): AtlasLedgerTrade[] {
  return trades
    .filter((t) => t && t.id && t.result)
    .map((t) =>
      normalizeTrade(
        t as Partial<AtlasLedgerTrade> & {
          id: string;
          result: AtlasLedgerTrade["result"];
        },
        fallbackRisk,
        currency,
      ),
    );
}

export function loadLedgerJournal(): unknown[] {
  try {
    const raw = localStorage.getItem(JOURNAL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveLedgerJournal(trades: AtlasLedgerTrade[]): void {
  try {
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(trades.slice(0, JOURNAL_LIMIT)));
  } catch {
    /* private mode / quota */
  }
}

export function loadLedgerAccount(): AtlasLedgerAccount {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AtlasLedgerAccount> & {
        startBalance?: number;
        balance?: number;
        currency?: string;
      };
      return {
        startBalance: Number.isFinite(parsed.startBalance)
          ? Number(parsed.startBalance)
          : ATLAS_DEMO_START,
        balance: Number.isFinite(parsed.balance)
          ? Number(parsed.balance)
          : ATLAS_DEMO_START,
        currency: parsed.currency || "USD",
        updatedAt: Date.now(),
      };
    }
  } catch {
    /* ignore */
  }
  return {
    startBalance: ATLAS_DEMO_START,
    balance: ATLAS_DEMO_START,
    currency: "USD",
    updatedAt: Date.now(),
  };
}

export function saveLedgerAccount(account: AtlasLedgerAccount): void {
  try {
    localStorage.setItem(
      ACCOUNT_KEY,
      JSON.stringify({
        startBalance: account.startBalance,
        balance: account.balance,
        currency: account.currency,
        // keep shape compatible with older demoAccount readers
        lastSettle: undefined,
      }),
    );
  } catch {
    /* ignore */
  }
}

/** Full sync: normalize journal, rewrite account balance from closed P/L. */
export function syncLedger(
  rawTrades: unknown[],
  fallbackRisk: number,
  currency = "USD",
  startBalance = ATLAS_DEMO_START,
): { trades: AtlasLedgerTrade[]; account: AtlasLedgerAccount } {
  const trades = normalizeJournal(
    rawTrades as Partial<AtlasLedgerTrade>[],
    fallbackRisk,
    currency,
  );
  const account: AtlasLedgerAccount = {
    startBalance,
    balance: balanceFromTrades(startBalance, trades),
    currency,
    updatedAt: Date.now(),
  };
  saveLedgerJournal(trades);
  saveLedgerAccount(account);
  return { trades, account };
}

export function settleTradeToResult(
  trade: AtlasLedgerTrade,
  result: "win" | "loss",
  pnlR: number,
): AtlasLedgerTrade {
  const pnlCash = round2(
    result === "loss" ? -Math.abs(trade.riskCash) : pnlR * trade.riskCash,
  );
  return {
    ...trade,
    result,
    pnlR: result === "loss" ? -1 : pnlR,
    pnlCash,
    settledAt: Date.now(),
  };
}

export function openTradeCash(
  trade: AtlasLedgerTrade,
  price: number,
): number {
  const risk = Math.abs(trade.entry - trade.stop);
  if (!(risk > 0) || !Number.isFinite(price)) return 0;
  const r =
    trade.side === "buy"
      ? (price - trade.entry) / risk
      : (trade.entry - price) / risk;
  return round2(r * trade.riskCash);
}

export function lastClosedTrade(
  trades: AtlasLedgerTrade[],
): AtlasLedgerTrade | null {
  const closed = trades
    .filter(
      (t) => t.result === "win" || t.result === "loss" || t.result === "flat",
    )
    .sort((a, b) => (b.settledAt ?? b.at) - (a.settledAt ?? a.at));
  return closed[0] ?? null;
}
