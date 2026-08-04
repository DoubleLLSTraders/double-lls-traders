import { storageKey } from "../../lib/platform";

export interface AtlasJournalTrade {
  id: string;
  at: number;
  symbol: string;
  side: "buy" | "sell";
  entry: number;
  stop: number;
  target: number;
  result: "open" | "win" | "loss" | "flat";
  /** Settled result in R multiples. */
  pnlR: number;
  reason: string;
  paper: boolean;
  /** Cash risked if stop is hit (equity × risk%). */
  riskCash?: number;
  /** Approximate position notional at entry. */
  notional?: number;
  currency?: string;
  /** When the trade settled (ms). Used for chart markers. */
  settledAt?: number;
  /** Cash P/L credited to demo balance on settle (or history for live). */
  pnlCash?: number;
  /** Deriv contract id when execution is live multipliers. */
  contractId?: number;
  /** Live unrealized profit from proposal_open_contract. */
  liveProfit?: number;
}

const KEY = storageKey("atlas-journal");
/** Match other hubs — long device history, never wipe on refresh. */
const JOURNAL_LIMIT = 2000;

export function loadJournal(): AtlasJournalTrade[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AtlasJournalTrade[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveJournal(trades: AtlasJournalTrade[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(trades.slice(0, JOURNAL_LIMIT)));
  } catch {
    /* private mode / quota — caller still keeps in-memory copy */
  }
}

export function journalStats(trades: AtlasJournalTrade[]) {
  const closed = trades.filter(
    (t) => t.result === "win" || t.result === "loss" || t.result === "flat",
  );
  const wins = closed.filter((t) => t.result === "win").length;
  const losses = closed.filter((t) => t.result === "loss").length;
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const settleTime = (t: AtlasJournalTrade) => t.settledAt ?? t.at;
  /** Only booked cash — never invent from current stake. */
  const cashOf = (t: AtlasJournalTrade) =>
    Number.isFinite(t.pnlCash) ? Number(t.pnlCash) : 0;
  const dayPnl = closed
    .filter((t) => settleTime(t) >= dayStart.getTime())
    .reduce((s, t) => s + t.pnlR, 0);
  const dayCash = closed
    .filter((t) => settleTime(t) >= dayStart.getTime())
    .reduce((s, t) => s + cashOf(t), 0);
  const weekStart = dayStart.getTime() - 6 * 86_400_000;
  const weekPnl = closed
    .filter((t) => settleTime(t) >= weekStart)
    .reduce((s, t) => s + t.pnlR, 0);
  const weekCash = closed
    .filter((t) => settleTime(t) >= weekStart)
    .reduce((s, t) => s + cashOf(t), 0);
  const monthStart = new Date(dayStart.getFullYear(), dayStart.getMonth(), 1).getTime();
  const monthPnl = closed
    .filter((t) => settleTime(t) >= monthStart)
    .reduce((s, t) => s + t.pnlR, 0);
  const monthCash = closed
    .filter((t) => settleTime(t) >= monthStart)
    .reduce((s, t) => s + cashOf(t), 0);
  const lastClosed = closed
    .slice()
    .sort((a, b) => settleTime(b) - settleTime(a))[0];
  const bookedCash = closed.reduce((s, t) => s + cashOf(t), 0);
  const scored = wins + losses;
  return {
    wins,
    losses,
    closed: closed.length,
    winRate: scored ? (wins / scored) * 100 : null,
    dayPnl,
    weekPnl,
    monthPnl,
    dayCash,
    weekCash,
    monthCash,
    bookedCash,
    open: trades.filter((t) => t.result === "open").length,
    lastClosed: lastClosed ?? null,
    lastClosedCash: lastClosed ? cashOf(lastClosed) : 0,
  };
}

/** Ensure settled trades have pnlCash so earnings always show. */
export function hydrateTradeCash(
  trade: AtlasJournalTrade,
  fallbackRiskCash: number,
): AtlasJournalTrade {
  if (trade.result === "open") {
    if (trade.riskCash == null || !(trade.riskCash > 0)) {
      return { ...trade, riskCash: fallbackRiskCash };
    }
    return trade;
  }
  // Never overwrite a real settled cash amount with a new stake size.
  if (
    trade.pnlCash != null &&
    Number.isFinite(trade.pnlCash) &&
    trade.riskCash != null &&
    trade.riskCash > 0
  ) {
    return trade;
  }
  const riskCash =
    trade.riskCash != null && trade.riskCash > 0
      ? trade.riskCash
      : Math.max(fallbackRiskCash, 1);
  const pnlCash =
    trade.pnlCash != null && Number.isFinite(trade.pnlCash)
      ? trade.pnlCash
      : trade.result === "flat"
        ? 0
        : trade.pnlR * riskCash;
  return { ...trade, riskCash, pnlCash };
}

export function hydrateJournalCash(
  trades: AtlasJournalTrade[],
  fallbackRiskCash: number,
): AtlasJournalTrade[] {
  return trades.map((t) => hydrateTradeCash(t, fallbackRiskCash));
}

/** Live unrealized R for an open trade vs current price. */
export function unrealizedR(trade: AtlasJournalTrade, price: number): number {
  const risk = Math.abs(trade.entry - trade.stop);
  if (!(risk > 0) || !Number.isFinite(price)) return 0;
  if (trade.side === "buy") return (price - trade.entry) / risk;
  return (trade.entry - price) / risk;
}

export function unrealizedCash(trade: AtlasJournalTrade, price: number): number {
  const riskCash = trade.riskCash ?? 0;
  if (!(riskCash > 0) || !Number.isFinite(price)) return 0;
  const r = unrealizedR(trade, price);
  if (!Number.isFinite(r)) return 0;
  // Cap ±2.2R so a bad quote cannot flash −$1800 on a $100 stake.
  const capped = Math.max(-2.2, Math.min(2.2, r));
  return capped * riskCash;
}

/** Distance to stop/target as % of risk distance (0–100+). */
export function progressToTarget(trade: AtlasJournalTrade, price: number): {
  toStopPct: number;
  toTargetPct: number;
  status: string;
} {
  const risk = Math.abs(trade.entry - trade.stop);
  const reward = Math.abs(trade.target - trade.entry);
  if (!(risk > 0) || !(reward > 0) || !Number.isFinite(price)) {
    return { toStopPct: 0, toTargetPct: 0, status: "—" };
  }
  if (trade.side === "buy") {
    const toStop = ((price - trade.stop) / risk) * 100;
    const toTarget = ((price - trade.entry) / reward) * 100;
    return {
      toStopPct: Math.max(0, Math.min(100, toStop)),
      toTargetPct: Math.max(0, toTarget),
      status:
        price <= trade.stop
          ? "Hit stop"
          : price >= trade.target
            ? "Hit target"
            : toTarget >= 50
              ? "Moving to target"
              : toStop < 40
                ? "Near stop"
                : "In play",
    };
  }
  const toStop = ((trade.stop - price) / risk) * 100;
  const toTarget = ((trade.entry - price) / reward) * 100;
  return {
    toStopPct: Math.max(0, Math.min(100, toStop)),
    toTargetPct: Math.max(0, toTarget),
    status:
      price >= trade.stop
        ? "Hit stop"
        : price <= trade.target
          ? "Hit target"
          : toTarget >= 50
            ? "Moving to target"
            : toStop < 40
              ? "Near stop"
              : "In play",
  };
}

/** Cash P/L for a settle given R multiple and risked cash. */
export function cashFromR(
  trade: AtlasJournalTrade,
  pnlR: number,
  fallbackRiskCash = 0,
): number {
  const riskCash = trade.riskCash ?? fallbackRiskCash;
  return pnlR * riskCash;
}

/** Settle open paper trades against a live quote (stop / target hit). */
export function settleOpenAgainstPrice(
  trades: AtlasJournalTrade[],
  price: number,
  fallbackRiskCash = 0,
  /** Only settle trades on this symbol — never apply ETH ticks to AUDUSD. */
  forSymbol?: string,
): AtlasJournalTrade[] {
  if (!Number.isFinite(price)) return trades;
  return trades.map((t) => {
    if (t.result !== "open") return t;
    // Live Deriv contracts settle via sell / proposal_open_contract — not local ticks.
    if (t.paper === false && t.contractId != null) return t;
    if (forSymbol && t.symbol !== forSymbol) return t;
    const risk = Math.abs(t.entry - t.stop);
    if (!(risk > 0)) return t;
    // Reject absurd cross-market prices (e.g. 1844 on AUDUSD).
    if (!priceMatchesSymbol(t.symbol, price)) return t;
    // Absurd jump vs entry (stale quote / wrong market) — void, don't book a fake win.
    if (!priceNearEntry(t.entry, price, t.symbol)) {
      return {
        ...t,
        result: "flat" as const,
        pnlR: 0,
        pnlCash: 0,
        settledAt: Date.now(),
        reason: `${t.reason} · voided absurd price jump`,
      };
    }
    if (!levelsConsistent(t.entry, t.stop, t.target, t.symbol)) {
      return {
        ...t,
        result: "flat" as const,
        pnlR: 0,
        pnlCash: 0,
        settledAt: Date.now(),
        reason: `${t.reason} · voided bad fill levels`,
      };
    }
    const riskCash =
      t.riskCash != null && t.riskCash > 0 ? t.riskCash : fallbackRiskCash;
    if (!(riskCash > 0)) return t;
    const book = (result: "win" | "loss", pnlR: number): AtlasJournalTrade => {
      const rawR = Math.max(-1.05, Math.min(3, pnlR));
      const cash = Math.round(rawR * riskCash * 100) / 100;
      const capped = Math.max(-riskCash * 1.05, Math.min(riskCash * 2.5, cash));
      return {
        ...t,
        riskCash,
        result,
        pnlR: rawR,
        pnlCash: capped,
        settledAt: Date.now(),
      };
    };
    if (t.side === "buy") {
      if (price <= t.stop) return book("loss", -1);
      if (price >= t.target) return book("win", Math.abs(t.target - t.entry) / risk);
    } else {
      if (price >= t.stop) return book("loss", -1);
      if (price <= t.target) return book("win", Math.abs(t.entry - t.target) / risk);
    }
    return t;
  });
}

/** True when price is in a plausible band for this Deriv symbol. */
export function priceMatchesSymbol(symbol: string, price: number): boolean {
  if (!Number.isFinite(price) || price <= 0) return false;
  if (symbol.includes("XAU")) return price > 800 && price < 20_000;
  if (symbol.includes("JPY")) return price > 50 && price < 400;
  // BTC vs ETH must not overlap.
  if (symbol.startsWith("cryBTC")) return price > 12_000 && price < 500_000;
  if (symbol.startsWith("cryETH")) return price > 80 && price < 12_000;
  if (symbol.startsWith("frx")) return price > 0.05 && price < 5;
  return false;
}

/** Stop/target must sit near entry — catches cross-scale ghost fills. */
export function levelsConsistent(
  entry: number,
  stop: number,
  target: number,
  symbol: string,
): boolean {
  if (![entry, stop, target].every((n) => Number.isFinite(n) && n > 0)) {
    return false;
  }
  const maxStopPct = symbol.startsWith("cry") ? 0.08 : 0.04;
  const maxTgtPct = symbol.startsWith("cry") ? 0.12 : 0.06;
  const dStop = Math.abs(entry - stop) / entry;
  const dTgt = Math.abs(entry - target) / entry;
  if (dStop < 1e-8 || dTgt < 1e-8) return false;
  if (dStop > maxStopPct || dTgt > maxTgtPct) return false;
  return true;
}

/** Live quote vs entry — blocks settling a 4k ETH fill with an 1.8k tick. */
export function priceNearEntry(
  entry: number,
  price: number,
  symbol: string,
): boolean {
  if (!(entry > 0) || !(price > 0)) return false;
  const maxPct = symbol.startsWith("cry") ? 12 : 6;
  return (Math.abs(price - entry) / entry) * 100 <= maxPct;
}

/**
 * Quote must sit near this market's candle — blocks one-frame stale quotes
 * after a symbol switch (e.g. ETH tick on a BTC chart).
 */
export function priceAgreesWithBars(
  price: number,
  bars: Array<{ close: number }>,
  tolerancePct = 8,
): boolean {
  if (!Number.isFinite(price) || price <= 0 || bars.length === 0) return false;
  // Prefer median of last few closes so one wild tick doesn't unlock trading.
  const closes = bars
    .slice(-5)
    .map((b) => b.close)
    .filter((c) => Number.isFinite(c) && c > 0);
  if (!closes.length) return false;
  const sorted = closes.slice().sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  const pct = (Math.abs(price - mid) / mid) * 100;
  return pct <= tolerancePct;
}

/** Same-symbol entries should agree — voids 4052 when peers sit near 1844. */
export function entryAgreesWithPeers(
  trade: AtlasJournalTrade,
  peers: AtlasJournalTrade[],
): boolean {
  const others = peers.filter(
    (p) =>
      p.id !== trade.id &&
      p.symbol === trade.symbol &&
      priceMatchesSymbol(p.symbol, p.entry) &&
      levelsConsistent(p.entry, p.stop, p.target, p.symbol),
  );
  if (others.length === 0) return true;
  const sorted = others.map((p) => p.entry).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (!(median > 0)) return true;
  const pct = (Math.abs(trade.entry - median) / median) * 100;
  return pct <= 25;
}
