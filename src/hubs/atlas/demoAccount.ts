import { storageKey } from "../../lib/platform";
import {
  hydrateTradeCash,
  type AtlasJournalTrade,
} from "./journal";

const KEY = storageKey("atlas-demo-account");
export const ATLAS_DEMO_START = 10_000;

export interface AtlasDemoAccount {
  /** Starting demo cash. */
  startBalance: number;
  /** Live demo cash after settles. */
  balance: number;
  currency: string;
  /** Last settle flash for UI. */
  lastSettle?: {
    at: number;
    kind: "win" | "loss";
    profit: number;
    balanceAfter: number;
    tradeId: string;
  };
}

function defaultAccount(currency = "USD"): AtlasDemoAccount {
  return {
    startBalance: ATLAS_DEMO_START,
    balance: ATLAS_DEMO_START,
    currency,
  };
}

export function loadDemoAccount(): AtlasDemoAccount {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultAccount();
    const parsed = JSON.parse(raw) as Partial<AtlasDemoAccount>;
    return {
      ...defaultAccount(parsed.currency ?? "USD"),
      ...parsed,
      balance: Number.isFinite(parsed.balance)
        ? Number(parsed.balance)
        : ATLAS_DEMO_START,
      startBalance: Number.isFinite(parsed.startBalance)
        ? Number(parsed.startBalance)
        : ATLAS_DEMO_START,
    };
  } catch {
    return defaultAccount();
  }
}

export function saveDemoAccount(account: AtlasDemoAccount): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(account));
  } catch {
    /* ignore */
  }
}

/** Apply settled cash P/L to demo balance (paper / demo only). */
export function applyDemoSettle(
  account: AtlasDemoAccount,
  tradeId: string,
  kind: "win" | "loss",
  profit: number,
): AtlasDemoAccount {
  const balance = Math.max(0, account.balance + profit);
  return {
    ...account,
    balance,
    lastSettle: {
      at: Date.now(),
      kind,
      profit,
      balanceAfter: balance,
      tradeId,
    },
  };
}

/**
 * Journal closed trades are the source of truth.
 * Demo balance = start + sum(pnlCash). Fixes “earned +4 but balance unchanged”.
 */
export function reconcileDemoFromJournal(
  account: AtlasDemoAccount,
  trades: AtlasJournalTrade[],
  fallbackRiskCash: number,
): AtlasDemoAccount {
  const closed = trades
    .filter((t) => t.result === "win" || t.result === "loss")
    .map((t) => hydrateTradeCash(t, fallbackRiskCash))
    .sort((a, b) => (a.settledAt ?? a.at) - (b.settledAt ?? b.at));

  let sum = 0;
  for (const t of closed) {
    sum += t.pnlCash ?? 0;
  }
  const balance = Math.max(0, account.startBalance + sum);
  const last = closed[closed.length - 1];

  return {
    ...account,
    balance,
    lastSettle: last
      ? {
          at: last.settledAt ?? last.at,
          kind: last.result === "win" ? "win" : "loss",
          profit: last.pnlCash ?? 0,
          balanceAfter: balance,
          tradeId: last.id,
        }
      : undefined,
  };
}

export function resetDemoAccount(currency = "USD"): AtlasDemoAccount {
  const next = defaultAccount(currency);
  saveDemoAccount(next);
  return next;
}

/** Total P/L vs starting demo balance. */
export function demoTotalPnl(account: AtlasDemoAccount): number {
  return account.balance - account.startBalance;
}
