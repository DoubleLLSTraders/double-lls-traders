import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { SettingsModal, type SettingsTab } from "../../components/SettingsModal";
import { useTheme } from "../../hooks/useTheme";
import {
  getAccountKind,
  subscribeAccountKind,
} from "../../lib/accountMode";
import { getHubDisplayName, type HubId } from "../../lib/hub";
import {
  allowedMultipliersForSymbol,
  buyMultiplier,
  fetchOpenContract,
  resolveMultiplierForSymbol,
  sellMultiplier,
  watchOpenContract,
} from "../../lib/deriv/multipliers";
import logoDark from "../../assets/logo.png";
import logoLight from "../../assets/logo-light.png";
import { AtlasChart } from "./AtlasChart";
import { latestIndicators } from "./indicators";
import {
  ATLAS_INSTRUMENTS,
  ATLAS_TIMEFRAMES,
  type AtlasBar,
  type AtlasTimeframeId,
} from "./instruments";
import {
  journalStats,
  loadJournal,
  entryAgreesWithPeers,
  levelsConsistent,
  priceAgreesWithBars,
  priceMatchesSymbol,
  priceNearEntry,
  progressToTarget,
  saveJournal,
  settleOpenAgainstPrice,
  unrealizedCash,
  unrealizedR,
  type AtlasJournalTrade,
} from "./journal";
import {
  ATLAS_DEMO_START,
  loadLedgerAccount,
  syncLedger,
  type AtlasLedgerAccount,
} from "./ledger";
import {
  DEFAULT_ATLAS_RISK,
  evaluateRisk,
  loadAtlasRisk,
  resolveRiskCash,
  saveAtlasRisk,
  type AtlasBotMode,
  type AtlasRiskConfig,
} from "./risk";
import { buildAtlasSignal } from "./signal";
import {
  ATLAS_STRATEGIES,
  runAtlasBacktest,
  strategySignals,
  strategyTradeParams,
  type AtlasStrategyId,
} from "./strategies";
import {
  findBestAtlasMarket,
  rankAtlasBarCache,
  type AtlasMarketRank,
} from "./atlasScan";
import { getAtlasSession } from "./sessions";
import { useAtlasCandles } from "./useAtlasCandles";
import { playLossSound, playWinSound, unlockAudio } from "../../lib/sound";
import "./atlas.css";

function fmtPrice(price: number | null, symbol: string): string {
  if (price == null || !Number.isFinite(price)) return "—";
  if (symbol.startsWith("cry")) return price.toFixed(2);
  if (symbol.includes("XAU") || symbol.includes("JPY")) return price.toFixed(3);
  return price.toFixed(5);
}

function ageLabel(ms: number | null): string {
  if (ms == null) return "—";
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 2) return "now";
  if (sec < 60) return `${sec}s ago`;
  return `${Math.floor(sec / 60)}m ago`;
}

function clampPaperCash(pnl: number, riskCash: number): number {
  const risk = riskCash > 0 ? riskCash : 100;
  return Math.max(-risk * 1.05, Math.min(risk * 2.2, pnl));
}

function isAbsurdPaperPnl(pnl: number, riskCash: number): boolean {
  const risk = riskCash > 0 ? riskCash : 100;
  const cash = Math.abs(pnl);
  return cash > risk * 2.2 || cash >= 250;
}

/**
 * Device persistence only: drop physically impossible levels.
 * Never rewrite settled win/loss cash — refresh must keep trading history.
 */
function scrubCorruptEntries(trades: AtlasJournalTrade[]): AtlasJournalTrade[] {
  const voided = (t: AtlasJournalTrade, why: string): AtlasJournalTrade => ({
    ...t,
    result: "flat" as const,
    pnlR: 0,
    pnlCash: 0,
    reason: `${t.reason
      .replace(/\s· voided[^·]*/gi, "")
      .trim()} · ${why}`,
    settledAt: t.settledAt ?? t.at,
  });

  return trades.map((t) => {
    // Settled history is sacred — only void if entry can't belong to that market.
    if (t.result !== "open") {
      if (!priceMatchesSymbol(t.symbol, t.entry)) {
        return voided(t, "voided wrong-market entry");
      }
      return t;
    }
    const entryOk = priceMatchesSymbol(t.symbol, t.entry);
    const stopOk = priceMatchesSymbol(t.symbol, t.stop);
    const targetOk = priceMatchesSymbol(t.symbol, t.target);
    if (!entryOk || !stopOk || !targetOk) {
      return voided(t, "voided bad fill levels");
    }
    if (!levelsConsistent(t.entry, t.stop, t.target, t.symbol)) {
      return voided(t, "voided inconsistent stop/target");
    }
    if (!entryAgreesWithPeers(t, trades)) {
      return voided(t, "voided cross-scale ghost fill");
    }
    return t;
  });
}

/** At leave/settle only: kill absurd paper P/L ghosts before they hit the books. */
function voidAbsurdPaperSettles(trades: AtlasJournalTrade[]): AtlasJournalTrade[] {
  const voided = (t: AtlasJournalTrade, why: string): AtlasJournalTrade => ({
    ...t,
    result: "flat" as const,
    pnlR: 0,
    pnlCash: 0,
    reason: `${t.reason
      .replace(/\s· voided[^·]*/gi, "")
      .trim()} · ${why}`,
    settledAt: t.settledAt ?? t.at,
  });

  return trades.map((t) => {
    if (t.paper === false) return t;
    if (t.result !== "win" && t.result !== "loss") return t;
    const riskCash = t.riskCash != null && t.riskCash > 0 ? t.riskCash : 100;
    const cash = Math.abs(Number(t.pnlCash) || 0);
    if (isAbsurdPaperPnl(cash, riskCash)) {
      return voided(t, "voided absurd P/L vs stake");
    }
    if (
      t.settledAt != null &&
      t.settledAt - t.at < 15_000 &&
      cash >= 50
    ) {
      return voided(t, "voided instant oversized settle");
    }
    if (
      /auto-closed duplicate|voided bad|cross-market|absurd price|ghost fill|inconsistent stop|bad leave quote/i.test(
        t.reason,
      )
    ) {
      return voided(t, "voided bad fill");
    }
    return t;
  });
}

function bootMoney(riskCfg: AtlasRiskConfig): {
  trades: AtlasJournalTrade[];
  account: AtlasLedgerAccount;
} {
  const prior = loadLedgerAccount();
  const fallback = resolveRiskCash(riskCfg, prior.startBalance || ATLAS_DEMO_START);
  const synced = syncLedger(
    scrubCorruptEntries(loadJournal()),
    fallback,
    prior.currency || "USD",
    prior.startBalance || ATLAS_DEMO_START,
  );
  return {
    trades: synced.trades as AtlasJournalTrade[],
    account: synced.account,
  };
}

export function AtlasApp({
  onHubChange,
}: {
  onHubChange?: (hub: HubId) => void;
}) {
  const { theme, toggleTheme } = useTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("hub");
  const [hubName, setHubName] = useState(() => getHubDisplayName());
  const [symbol, setSymbol] = useState(ATLAS_INSTRUMENTS[0].symbol);
  const [tf, setTf] = useState<AtlasTimeframeId>("m5");
  const [chartMode, setChartMode] = useState<"candles" | "line">("candles");
  const [strategyId, setStrategyId] = useState<AtlasStrategyId>("pulse");
  const [risk, setRisk] = useState<AtlasRiskConfig>(() => loadAtlasRisk());
  const [scanBoard, setScanBoard] = useState<AtlasMarketRank[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanReady, setScanReady] = useState(false);
  const bootRef = useRef<ReturnType<typeof bootMoney> | null>(null);
  if (bootRef.current == null) {
    bootRef.current = bootMoney(loadAtlasRisk());
  }
  const [journal, setJournal] = useState<AtlasJournalTrade[]>(
    () => bootRef.current!.trades,
  );
  const [cashAccount, setCashAccount] = useState<AtlasLedgerAccount>(
    () => bootRef.current!.account,
  );
  const [settleBanner, setSettleBanner] = useState<{
    kind: "win" | "loss";
    profit: number;
    balance: number;
  } | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [botRunning, setBotRunning] = useState(false);
  const [botNote, setBotNote] = useState("Analyzer idle · press Start bot to follow live signals");
  const lastFireRef = useRef(0);
  const soundedRef = useRef<Set<string>>(new Set());
  const journalRef = useRef<AtlasJournalTrade[]>(bootRef.current!.trades);
  const quoteRef = useRef<number | null>(null);
  const quoteSymbolRef = useRef<string | null>(null);
  const scanLockRef = useRef(false);
  const lastScanRef = useRef(0);
  const botRunningRef = useRef(false);
  const lastManualCloseRef = useRef(0);
  const closingLockRef = useRef(false);
  const underwaterSinceRef = useRef<number | null>(null);
  const scanCacheRef = useRef<Map<string, AtlasBar[]>>(new Map());
  const scanBoardRef = useRef<AtlasMarketRank[]>([]);
  const symbolRef = useRef(symbol);
  const strategyRef = useRef(strategyId);
  const riskRef = useRef(risk);
  /** Classic: after start pick, stay locked until Stop / Bank / Scan now. */
  const classicLockRef = useRef(false);
  const liveBuyLockRef = useRef(false);
  const pocStopRef = useRef<Map<number, () => Promise<void>>>(new Map());
  /** After symbol switch, wait for stable ticks before fire/settle. */
  const feedWarmAtRef = useRef(0);
  const stableTickRef = useRef(0);
  const lastStableQuoteRef = useRef<number | null>(null);
  /** When Almost on same market too long, force next ranked market. */
  const stuckOnRef = useRef<{ key: string; since: number } | null>(null);
  const rotateExcludeRef = useRef<Set<string>>(new Set());
  symbolRef.current = symbol;
  strategyRef.current = strategyId;
  riskRef.current = risk;

  const accountKind = useSyncExternalStore(
    subscribeAccountKind,
    getAccountKind,
    getAccountKind,
  );
  /** Settings Demo = paper ledger; Settings Live = real Deriv multipliers. */
  const isLiveWallet = accountKind === "real";

  const granularity =
    ATLAS_TIMEFRAMES.find((t) => t.id === tf)?.seconds ?? 3600;
  const instrument =
    ATLAS_INSTRUMENTS.find((i) => i.symbol === symbol) ?? ATLAS_INSTRUMENTS[0];
  const {
    bars,
    loading,
    error,
    balance: derivBalance,
    currency,
    feedState,
    lastPrice,
    lastTickAt,
    live,
    client: derivClient,
    accountKind: feedAccountKind,
  } = useAtlasCandles(symbol, granularity, 500);
  void feedAccountKind;

  // Stop Atlas bot when Settings switches Demo ↔ Live (feed reconnects).
  useEffect(() => {
    if (!botRunning) return;
    setBotRunning(false);
    botRunningRef.current = false;
    classicLockRef.current = false;
    setScanReady(false);
    setBotNote(
      accountKind === "real"
        ? "Switched to Deriv Live wallet · bot stopped · Start to trade multipliers"
        : "Switched to Demo wallet · bot stopped · Start for paper trades",
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKind]);

  useEffect(() => {
    return () => {
      for (const stop of pocStopRef.current.values()) void stop();
      pocStopRef.current.clear();
    };
  }, []);

  const signal = useMemo(
    () =>
      bars.length
        ? buildAtlasSignal(bars, instrument.spread, strategyId)
        : null,
    [bars, instrument.spread, strategyId],
  );
  const indicators = useMemo(
    () => (bars.length ? latestIndicators(bars) : null),
    [bars],
  );
  const backtest = useMemo(() => {
    if (bars.length < 80) return null;
    const { atrMult, rMultiple } = strategyTradeParams(strategyId);
    return runAtlasBacktest(
      bars,
      strategySignals(strategyId, bars),
      instrument.spread,
      atrMult,
      rMultiple,
    );
  }, [bars, strategyId, instrument.spread]);
  const stats = useMemo(() => journalStats(journal), [journal]);

  /** Keep journal cash fields + account balance locked together. */
  function commitTrades(next: AtlasJournalTrade[]) {
    const fallback = resolveRiskCash(risk, cashAccount.startBalance);
    const synced = syncLedger(
      next,
      fallback,
      cashAccount.currency || currency || "USD",
      cashAccount.startBalance,
    );
    journalRef.current = synced.trades as AtlasJournalTrade[];
    setJournal(synced.trades as AtlasJournalTrade[]);
    setCashAccount(synced.account);
  }

  /** Close open trades at live P/L (even cents). Live wallet sells Deriv contracts. */
  async function closeTradesAtMarket(
    ids: string[],
    opts?: { stopBot?: boolean; note?: string },
  ) {
    if (closingLockRef.current) return;
    closingLockRef.current = true;
    const stopBot = opts?.stopBot !== false;
    try {
      unlockAudio();
      const idSet = new Set(ids);
      const fallbackRisk = resolveRiskCash(risk, walletBalance);
      const priceNow = quoteRef.current;
      const base = journalRef.current;
      const next: AtlasJournalTrade[] = [];

      for (const t of base) {
        if (t.result !== "open" || !idSet.has(t.id)) {
          next.push(t);
          continue;
        }

        // Live Deriv multiplier — sell on exchange, book returned profit.
        if (!t.paper && t.contractId != null) {
          if (!derivClient) {
            setBotNote("Close failed — Deriv not connected. Try again.");
            next.push(t);
            continue;
          }
          try {
            let profit = t.liveProfit;
            if (profit == null || !Number.isFinite(profit)) {
              try {
                const snap = await fetchOpenContract(derivClient, t.contractId);
                profit = snap.profit;
              } catch {
                profit = 0;
              }
            }
            await sellMultiplier(derivClient, t.contractId);
            const stopWatch = pocStopRef.current.get(t.contractId);
            if (stopWatch) {
              void stopWatch();
              pocStopRef.current.delete(t.contractId);
            }
            const riskCash = t.riskCash ?? fallbackRisk;
            const raw = Math.round((profit ?? 0) * 100) / 100;
            const pnlCash = raw;
            const pnlR =
              riskCash > 0 ? Math.round((pnlCash / riskCash) * 100) / 100 : 0;
            const result: "win" | "loss" | "flat" =
              Math.abs(pnlCash) < 0.005
                ? "flat"
                : pnlCash > 0
                  ? "win"
                  : "loss";
            next.push({
              ...t,
              result,
              pnlR: result === "flat" ? 0 : pnlR,
              pnlCash: result === "flat" ? 0 : pnlCash,
              riskCash,
              liveProfit: undefined,
              settledAt: Date.now(),
              reason: `${t.reason} · live sell`,
            });
          } catch (err) {
            setBotNote(
              `Live sell failed · ${
                err instanceof Error ? err.message : "error"
              }`,
            );
            next.push(t);
          }
          continue;
        }

        const riskCash = t.riskCash ?? fallbackRisk;
        const price =
          priceNow != null && Number.isFinite(priceNow) ? priceNow : t.entry;
        // Wrong-market quote → flat, never invent −$1800 ghosts.
        if (
          !priceMatchesSymbol(t.symbol, price) ||
          !priceNearEntry(t.entry, price, t.symbol)
        ) {
          next.push({
            ...t,
            result: "flat",
            pnlR: 0,
            pnlCash: 0,
            riskCash,
            settledAt: Date.now(),
            reason: `${t.reason} · voided bad leave quote`,
          });
          continue;
        }
        const liveCash = unrealizedCash({ ...t, riskCash }, price);
        const liveR = unrealizedR(t, price);
        const pnlCash = clampPaperCash(
          Math.round(liveCash * 100) / 100,
          riskCash,
        );
        const pnlR = Math.max(
          -1.05,
          Math.min(2.2, Math.round(liveR * 100) / 100),
        );
        const result: "win" | "loss" | "flat" =
          Math.abs(pnlCash) < 0.005 ? "flat" : pnlCash > 0 ? "win" : "loss";
        next.push({
          ...t,
          result,
          pnlR: result === "flat" ? 0 : pnlR,
          pnlCash: result === "flat" ? 0 : pnlCash,
          riskCash,
          settledAt: Date.now(),
        });
      }

      const stillOpen = next.some((t) => idSet.has(t.id) && t.result === "open");
      if (stillOpen) {
        journalRef.current = next;
        setJournal(next);
        if (!opts?.note) {
          setBotNote("Close failed — trade still open. Try again.");
        }
        return;
      }

      const cleaned = voidAbsurdPaperSettles(scrubCorruptEntries(next));

      // Demo ledger books P/L; Real wallet balance comes from Deriv stream.
      let balNow =
        isLiveWallet && derivBalance != null
          ? derivBalance
          : cashAccount.balance;
      if (!isLiveWallet) {
        const fallback = resolveRiskCash(risk, cashAccount.startBalance);
        const synced = syncLedger(
          cleaned,
          fallback,
          cashAccount.currency || currency || "USD",
          cashAccount.startBalance,
        );
        journalRef.current = synced.trades as AtlasJournalTrade[];
        setJournal(synced.trades as AtlasJournalTrade[]);
        setCashAccount(synced.account);
        balNow = synced.account.balance;
      } else {
        journalRef.current = cleaned;
        setJournal(cleaned);
        saveJournal(cleaned);
      }

      lastManualCloseRef.current = Date.now();
      lastFireRef.current = Date.now();

      const booked = cleaned
        .filter((t) => idSet.has(t.id) && t.result !== "open")
        .reduce((s, t) => s + (Number(t.pnlCash) || 0), 0);
      for (const id of idSet) soundedRef.current.add(id);
      const stakeGuess = resolveRiskCash(risk, walletBalance);
      const ghostPaper =
        isAbsurdPaperPnl(booked, stakeGuess) && !isLiveWallet;

      if (ghostPaper) {
        setSettleBanner(null);
      } else {
        setSettleBanner({
          kind: booked > 0.004 ? "win" : booked < -0.004 ? "loss" : "win",
          profit: booked,
          balance: balNow,
        });
        if (booked > 0.004) playWinSound();
        else if (booked < -0.004) playLossSound();
      }

      if (stopBot) {
        setBotRunning(false);
        botRunningRef.current = false;
        classicLockRef.current = false;
        setScanReady(false);
        setBotNote(
          ghostPaper
            ? `Ghost leave ignored · balance ${balNow.toFixed(2)} ${displayCurrency} · bot stopped`
            : opts?.note ??
                `Banked · booked ${booked >= 0 ? "+" : ""}${booked.toFixed(2)} ${displayCurrency} · bot stopped`,
        );
      } else {
        lastManualCloseRef.current = Date.now() - 40_000;
        setBotNote(
          ghostPaper
            ? `Ghost leave ignored · hunting next…`
            : opts?.note ??
                `Sprint banked ${booked >= 0 ? "+" : ""}${booked.toFixed(2)} ${displayCurrency} · next steady setup…`,
        );
        void runMarketPick("after-bank");
      }
    } finally {
      closingLockRef.current = false;
    }
  }

  function attachLiveWatcher(contractId: number, tradeId: string) {
    if (!derivClient) return;
    const prev = pocStopRef.current.get(contractId);
    if (prev) void prev();
    void watchOpenContract(derivClient, contractId, (snap) => {
      const cur = journalRef.current;
      const row = cur.find((t) => t.id === tradeId);
      if (!row || row.result !== "open") return;

      if (snap.isSold) {
        const riskCash = row.riskCash ?? resolveRiskCash(riskRef.current, walletBalance);
        const pnlCash = Math.round(snap.profit * 100) / 100;
        const pnlR =
          riskCash > 0 ? Math.round((pnlCash / riskCash) * 100) / 100 : 0;
        const result: "win" | "loss" | "flat" =
          Math.abs(pnlCash) < 0.005
            ? "flat"
            : pnlCash > 0
              ? "win"
              : "loss";
        const next = cur.map((t) =>
          t.id === tradeId
            ? {
                ...t,
                result,
                pnlCash: result === "flat" ? 0 : pnlCash,
                pnlR: result === "flat" ? 0 : pnlR,
                liveProfit: undefined,
                settledAt: Date.now(),
                reason: `${t.reason} · Deriv closed`,
              }
            : t,
        );
        journalRef.current = next;
        setJournal(next);
        saveJournal(next);
        const stop = pocStopRef.current.get(contractId);
        if (stop) {
          void stop();
          pocStopRef.current.delete(contractId);
        }
        soundedRef.current.add(tradeId);
        setSettleBanner({
          kind: pnlCash >= 0 ? "win" : "loss",
          profit: pnlCash,
          balance: derivBalance ?? walletBalance,
        });
        if (pnlCash > 0.004) playWinSound();
        else if (pnlCash < -0.004) playLossSound();
        return;
      }

      const next = cur.map((t) =>
        t.id === tradeId ? { ...t, liveProfit: snap.profit } : t,
      );
      journalRef.current = next;
      setJournal(next);
    }).then((stop) => {
      pocStopRef.current.set(contractId, stop);
    });
  }

  /** Keep only the newest open trade — close extras at market so twins disappear. */
  function collapseExtraOpens(trades: AtlasJournalTrade[]): AtlasJournalTrade[] {
    const opens = trades
      .filter((t) => t.result === "open")
      .sort((a, b) => b.at - a.at);
    if (opens.length <= 1) return trades;
    const keepId = opens[0].id;
    const dropIds = opens.slice(1).map((t) => t.id);
    const fallbackRisk = resolveRiskCash(risk, cashAccount.balance);
    const priceNow = quoteRef.current;
    return trades.map((t) => {
      if (t.result !== "open" || t.id === keepId || !dropIds.includes(t.id)) {
        return t;
      }
      const riskCash = t.riskCash ?? fallbackRisk;
      const price =
        priceNow != null && Number.isFinite(priceNow) ? priceNow : t.entry;
      const liveCash = unrealizedCash({ ...t, riskCash }, price);
      const liveR = unrealizedR(t, price);
      const pnlCash = clampPaperCash(Math.round(liveCash * 100) / 100, riskCash);
      const pnlR = Math.max(-1.05, Math.min(2.2, Math.round(liveR * 100) / 100));
      const flat =
        !priceMatchesSymbol(t.symbol, price) ||
        !priceNearEntry(t.entry, price, t.symbol) ||
        isAbsurdPaperPnl(pnlCash, riskCash);
      return {
        ...t,
        result: flat ? ("flat" as const) : (pnlCash >= 0 ? "win" : "loss"),
        pnlR: flat ? 0 : pnlR,
        pnlCash: flat ? 0 : pnlCash,
        riskCash,
        settledAt: Date.now(),
        reason: `${t.reason} · auto-closed duplicate open${
          flat ? " · voided bad quote" : ""
        }`,
      };
    });
  }

  useEffect(() => {
    saveAtlasRisk(risk);
  }, [risk]);

  // Lift old demo daily-trade cap so Classic can keep opening.
  useEffect(() => {
    setRisk((r) =>
      r.maxDailyTrades < 50 ? { ...r, maxDailyTrades: 200 } : r,
    );
  }, []);

  // Only fix impossible open levels — never rewrite settled history on refresh.
  useEffect(() => {
    const cleaned = scrubCorruptEntries(journalRef.current);
    const changed = cleaned.some((t, i) => {
      const prev = journalRef.current[i];
      return (
        !prev ||
        t.result !== prev.result ||
        t.pnlCash !== prev.pnlCash ||
        t.pnlR !== prev.pnlR
      );
    });
    if (changed) commitTrades(cleaned);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journal.length]);

  // Soft scrub once on mount (open ghosts only — settled wins/losses stay).
  useEffect(() => {
    const cleaned = scrubCorruptEntries(journalRef.current);
    const changed = cleaned.some((t, i) => {
      const prev = journalRef.current[i];
      return (
        !prev ||
        t.result !== prev.result ||
        t.pnlCash !== prev.pnlCash ||
        t.pnlR !== prev.pnlR
      );
    });
    if (changed) commitTrades(cleaned);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-sync if stake settings change (repairs missing pnlCash on legacy rows).
  useEffect(() => {
    commitTrades(journalRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [risk.stakeMode, risk.stakeAmount, risk.riskPerTradePct]);

  useEffect(() => {
    const onStorage = () => setHubName(getHubDisplayName());
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const sessionNow = useMemo(() => getAtlasSession(nowTick), [nowTick]);

  const displayCurrency = cashAccount.currency || currency || "USD";
  const cashBalance = cashAccount.balance;
  /** Demo → local ledger; Real → Deriv wallet balance. */
  const walletBalance =
    isLiveWallet && derivBalance != null && Number.isFinite(derivBalance)
      ? derivBalance
      : cashBalance;
  const totalDemoPnl = cashBalance - cashAccount.startBalance;
  const openTradesList = useMemo(
    () => journal.filter((t) => t.result === "open"),
    [journal],
  );
  const stakePreview = resolveRiskCash(risk, walletBalance);
  const barClose = bars.length ? bars[bars.length - 1]?.close : null;
  const barsOnSymbol =
    barClose != null && priceMatchesSymbol(symbol, barClose);
  const quote = lastPrice ?? barClose ?? null;
  const agreeTol = symbol.startsWith("cry") ? 3.5 : 2.5;
  const quoteAgrees =
    quote != null &&
    barsOnSymbol &&
    priceMatchesSymbol(symbol, quote) &&
    priceAgreesWithBars(quote, bars, agreeTol);
  // Warm feed after market switch — short, not a long wait.
  useEffect(() => {
    feedWarmAtRef.current = Date.now() + 250;
    stableTickRef.current = 0;
    lastStableQuoteRef.current = null;
  }, [symbol, accountKind]);
  useEffect(() => {
    if (!quoteAgrees || quote == null) {
      stableTickRef.current = 0;
      lastStableQuoteRef.current = null;
      return;
    }
    stableTickRef.current += 1;
    lastStableQuoteRef.current = quote;
  }, [quote, quoteAgrees, lastTickAt]);
  const feedWarmed =
    nowTick >= feedWarmAtRef.current && stableTickRef.current >= 1;
  const quoteReady =
    quote != null &&
    !loading &&
    quoteAgrees &&
    feedWarmed;
  quoteRef.current = quoteReady ? quote : null;
  quoteSymbolRef.current = quoteReady ? symbol : null;

  const unrealizedOpen = useMemo(() => {
    if (quote == null && openTradesList.every((t) => t.liveProfit == null)) {
      return 0;
    }
    return openTradesList.reduce((s, t) => {
      if (!t.paper && t.liveProfit != null && Number.isFinite(t.liveProfit)) {
        return s + t.liveProfit;
      }
      const px = t.symbol === symbol && quote != null ? quote : t.entry;
      const riskCash = t.riskCash ?? stakePreview;
      return s + unrealizedCash({ ...t, riskCash }, px);
    }, 0);
  }, [openTradesList, quote, symbol, stakePreview]);

  const equityLive = walletBalance + unrealizedOpen;
  const usedMarginOpen = useMemo(() => {
    if (isLiveWallet) {
      return openTradesList.reduce(
        (s, t) => s + (t.riskCash ?? stakePreview),
        0,
      );
    }
    const lev = Math.max(1, risk.leverage);
    return openTradesList.reduce((s, t) => {
      const notion =
        t.notional ??
        (Math.abs(t.entry - t.stop) > 0
          ? ((t.riskCash ?? stakePreview) / Math.abs(t.entry - t.stop)) *
            t.entry
          : 0);
      return s + notion / lev;
    }, 0);
  }, [openTradesList, risk.leverage, stakePreview, isLiveWallet]);

  const pendingMargin =
    botRunning &&
    scanReady &&
    !scanning &&
    openTradesList.length === 0
      ? Math.max(stakePreview, 0)
      : 0;
  const usedMargin = usedMarginOpen + pendingMargin;
  const freeMargin = Math.max(0, equityLive - usedMargin);
  const equity = equityLive;
  const dayPnlCash = stats.dayCash;

  const riskVerdict = signal
    ? evaluateRisk(
        risk,
        {
          equity: walletBalance,
          dayPnl: dayPnlCash,
          openTrades: stats.open,
          consecutiveLosses: 0,
          dayTrades: journal.filter((t) => {
            const start = new Date();
            start.setHours(0, 0, 0, 0);
            return t.at >= start.getTime();
          }).length,
          // Live Multipliers lock ~stake, not CFD notional margin.
          usedMargin: isLiveWallet
            ? openTradesList.reduce((s, t) => s + (t.riskCash ?? stakePreview), 0)
            : usedMarginOpen,
        },
        signal.stopDistance,
        lastPrice ?? bars[bars.length - 1]?.close ?? 0,
        isLiveWallet ? "stake" : "cfd",
      )
    : null;

  const prevClose =
    bars.length >= 2 ? bars[bars.length - 2].close : bars[0]?.close ?? null;
  const quoteUp = quote != null && prevClose != null ? quote >= prevClose : true;
  const derivLive =
    live && feedState === "ready" && !error && lastTickAt != null && Date.now() - lastTickAt < 15_000;

  const lastBarEpoch = bars.length ? bars[bars.length - 1].epoch : null;
  void lastBarEpoch;

  async function runMarketPick(reason: string) {
    if (scanLockRef.current) return;
    // Classic: Start/Scan/ready-hunt only — no random hops while READY is locked.
    if (
      riskRef.current.botMode === "classic" &&
      reason !== "start" &&
      reason !== "manual" &&
      reason !== "ready-hunt"
    ) {
      return;
    }
    scanLockRef.current = true;
    const blockUi = reason === "start" || reason === "manual";
    if (blockUi) setScanning(true);
    if (blockUi) {
      setBotNote(
        reason === "start"
          ? riskRef.current.botMode === "classic"
            ? "Classic · session research · high WR FX first…"
            : "Session research · peak liquidity markets first…"
          : "Manual scan — re-picking READY steady market…",
      );
    }
    try {
      const result = await Promise.race([
        findBestAtlasMarket({
          granularitySec: granularity,
          strategyId: strategyRef.current,
          preferReady: true,
        }),
        new Promise<never>((_, reject) => {
          window.setTimeout(
            () => reject(new Error("Scan timed out — using current chart")),
            18_000,
          );
        }),
      ]);
      scanCacheRef.current = result.barCache;
      setScanBoard(result.ranks);
      scanBoardRef.current = result.ranks;
      lastScanRef.current = result.scannedAt;
      setScanReady(true);
      applyScanPick(
        result.best,
        reason === "start" ||
          reason === "manual" ||
          reason === "ready-hunt",
      );
    } catch (err) {
      setScanReady(true);
      classicLockRef.current = false;
      setBotNote(
        `Scan skipped · hunting READY again · ${
          err instanceof Error ? err.message : "error"
        }`,
      );
    } finally {
      scanLockRef.current = false;
      if (blockUi) setScanning(false);
    }
  }

  function pickRankedBest(
    ranks: AtlasMarketRank[],
    excludeSym?: string | null,
  ): AtlasMarketRank | null {
    const excluded = new Set(rotateExcludeRef.current);
    if (excludeSym) excluded.add(excludeSym);
    const pool = ranks
      .filter(
        (r) =>
          !excluded.has(r.symbol) &&
          r.bias !== "neutral" &&
          !/crypto noise/i.test(r.fitLabel),
      )
      .sort((a, b) => {
        const aReady = rReady(a) ? 1 : 0;
        const bReady = rReady(b) ? 1 : 0;
        if (bReady !== aReady) return bReady - aReady;
        return b.score - a.score;
      });
    if (pool.length) return pool[0];
    // All excluded — clear and retry.
    rotateExcludeRef.current.clear();
    return (
      ranks
        .filter((r) => r.bias !== "neutral" && !/crypto noise/i.test(r.fitLabel))
        .sort((a, b) => b.score - a.score)[0] ?? null
    );
  }

  function rReady(r: AtlasMarketRank): boolean {
    return (
      r.tradeable &&
      r.bias !== "neutral" &&
      !/crypto noise|unsteady chop — skip/i.test(r.fitLabel)
    );
  }

  function applyScanPick(
    best: AtlasMarketRank | null,
    force: boolean,
  ) {
    // Never hop markets while a trade is open.
    if (journalRef.current.some((t) => t.result === "open")) {
      return;
    }

    let pick = best;
    const curSym = symbolRef.current;
    // If stuck on Almost, force a different market from the board.
    const stuck = stuckOnRef.current;
    if (
      force &&
      stuck &&
      stuck.key === `${curSym}` &&
      Date.now() - stuck.since > 6_000
    ) {
      rotateExcludeRef.current.add(curSym);
      pick = pickRankedBest(scanBoardRef.current, curSym) ?? pick;
      stuckOnRef.current = null;
    }

    if (!pick || pick.bias === "neutral") {
      if (force) {
        classicLockRef.current = false;
        setBotNote("Analyzer rotating markets · no clear lean yet…");
      }
      return;
    }

    const classic = riskRef.current.botMode === "classic";
    const curStrat = strategyRef.current;
    const curBoard = scanBoardRef.current.find((r) => r.symbol === curSym);
    const currentDead =
      !curBoard ||
      curBoard.bias === "neutral" ||
      /crypto noise|unsteady chop — skip/i.test(curBoard.fitLabel || "") ||
      (!curBoard.tradeable && !(signal?.tradeable));

    if (classic && classicLockRef.current && !force && !currentDead) {
      const stillOk =
        curBoard?.tradeable &&
        curBoard.bias !== "neutral" &&
        curBoard.strategyId === curStrat;
      if (stillOk) return;
      classicLockRef.current = false;
    }

    const curScore = curBoard?.score ?? -9999;
    const currentReady = !!(curBoard && rReady(curBoard));

    let shouldSwitch = false;
    if (force || currentDead || (classic && !classicLockRef.current)) {
      shouldSwitch =
        pick.symbol !== curSym || pick.strategyId !== curStrat;
    } else if (pick.tradeable && (pick.bias === "buy" || pick.bias === "sell")) {
      if (!currentReady) {
        shouldSwitch =
          pick.symbol !== curSym || pick.strategyId !== curStrat;
      } else {
        shouldSwitch =
          pick.score >= curScore + 60 &&
          (pick.symbol !== curSym || pick.strategyId !== curStrat);
      }
    }

    if (shouldSwitch) {
      if (pick.strategyId && pick.strategyId !== curStrat) {
        setStrategyId(pick.strategyId);
      }
      if (pick.symbol !== curSym) {
        setSymbol(pick.symbol);
        stuckOnRef.current = null;
      }
    }

    if (
      classic &&
      pick.tradeable &&
      (force || shouldSwitch || !classicLockRef.current)
    ) {
      classicLockRef.current = true;
      rotateExcludeRef.current.clear();
    } else if (!pick.tradeable) {
      classicLockRef.current = false;
    }

    setBotNote(
      shouldSwitch
        ? `Analyzer switched → ${pick.name} · ${pick.strategyName} · ${pick.bias.toUpperCase()} · ${
            pick.tradeable ? "READY" : pick.powerLabel
          }`
        : classic
          ? `Classic on ${pick.name} · ${pick.strategyName} · ${pick.bias.toUpperCase()} · ${
              pick.tradeable ? "READY · Bank or Stop" : "warming · will rotate"
            }`
          : `On ${pick.name} · ${pick.strategyName} · ${pick.bias.toUpperCase()} · ${pick.fitLabel}`,
    );
  }

  function placeTrade(_opts?: { soft?: boolean }) {
    if (!signal || signal.bias === "neutral" || !riskVerdict?.ok) {
      return;
    }
    // Hard real-market rule: never enter against EMA stack.
    if (!signal.stackAligned) {
      setBotNote(
        `Blocked · ${signal.bias.toUpperCase()} fights EMA stack — waiting with-trend setup`,
      );
      return;
    }
    // Analyzer must fully reason the tape — no Almost / late-chase fires.
    if (
      !signal.tradeable ||
      signal.confidence < 55 ||
      signal.confluence < 52 ||
      signal.gateScore < 7 ||
      /late chase|extended/i.test(signal.explanation)
    ) {
      setBotNote(
        `Analyzer holding · ${signal.powerLabel} · conf ${signal.confidence.toFixed(0)} · rotating if stuck…`,
      );
      return;
    }
    // Prime FX hours (15:00–19:00 EAT / London–NY): never auto-trade crypto.
    if (symbol.startsWith("cry") && getAtlasSession().inPrimeFx) {
      setBotNote(
        "Prime FX session · crypto blocked · hunting EUR/GBP/USD majors…",
      );
      classicLockRef.current = false;
      void runMarketPick("ready-hunt");
      return;
    }
    // Outside prime: BTC/ETH only when elite — FX/metal still preferred.
    if (
      symbol.startsWith("cry") &&
      (signal.confidence < 68 || signal.confluence < 62)
    ) {
      setBotNote(
        `Analyzer skipped crypto · conf ${signal.confidence.toFixed(0)} · hunting FX/metal instead`,
      );
      classicLockRef.current = false;
      void runMarketPick("ready-hunt");
      return;
    }
    // Real wallet never falls back to paper.
    if (isLiveWallet) {
      void placeLiveTrade();
      return;
    }
    if (quoteSymbolRef.current !== symbol) return;
    if (!barsOnSymbol || !priceAgreesWithBars(quoteRef.current ?? 0, bars, agreeTol)) {
      return;
    }
    const current = journalRef.current;
    const openCount = current.filter((t) => t.result === "open").length;
    if (openCount >= Math.max(1, risk.maxOpenTrades)) return;
    if (current.some((t) => t.result === "open")) return;
    const priceRaw = quoteRef.current;
    if (!priceRaw || !priceMatchesSymbol(symbol, priceRaw)) return;
    if (!quoteReady) return;
    const side = signal.bias === "buy" ? "buy" : "sell";
    // Honest paper fill: pay half-spread (SELL fills lower bid → often −cents at open).
    const halfSpread = instrument.spread / 2;
    const price =
      side === "buy" ? priceRaw + halfSpread : priceRaw - halfSpread;
    const stopPad = instrument.spread * 2;
    const stop =
      side === "buy"
        ? price - signal.stopDistance - stopPad
        : price + signal.stopDistance + stopPad;
    const target =
      side === "buy"
        ? price + signal.targetDistance
        : price - signal.targetDistance;
    if (!priceMatchesSymbol(symbol, stop) || !priceMatchesSymbol(symbol, target)) {
      return;
    }
    if (!levelsConsistent(price, stop, target, symbol)) return;
    const riskCash = riskVerdict.riskCash || resolveRiskCash(risk, walletBalance);
    const stopDist = Math.abs(price - stop);
    const notional =
      stopDist > 0
        ? riskVerdict.positionNotional || (riskCash / stopDist) * price
        : 0;
    const trade: AtlasJournalTrade = {
      id: `atlas-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      at: Date.now(),
      symbol,
      side,
      entry: price,
      stop,
      target,
      result: "open",
      pnlR: 0,
      reason: `${signal.strategyName} · ${signal.explanation.slice(0, 160)}`,
      paper: true,
      riskCash,
      notional,
      currency: displayCurrency,
    };
    commitTrades([trade, ...current]);
  }

  async function placeLiveTrade() {
    if (liveBuyLockRef.current) return;
    if (!signal || signal.bias === "neutral" || !riskVerdict?.ok) return;
    if (!signal.stackAligned || !signal.tradeable) {
      setBotNote("Live buy blocked · need with-trend stack + Ready signal");
      return;
    }
    if (!derivClient) {
      setBotNote("Live buy blocked · Deriv not connected");
      return;
    }
    if (quoteSymbolRef.current !== symbol) return;
    if (!barsOnSymbol || !priceAgreesWithBars(quoteRef.current ?? 0, bars, agreeTol)) {
      return;
    }
    const current = journalRef.current;
    if (current.some((t) => t.result === "open")) return;
    const price = quoteRef.current;
    if (!price || !priceMatchesSymbol(symbol, price)) return;
    if (!quoteReady) return;

    const side = signal.bias === "buy" ? "buy" : "sell";
    const stop =
      side === "buy" ? price - signal.stopDistance : price + signal.stopDistance;
    const target =
      side === "buy"
        ? price + signal.targetDistance
        : price - signal.targetDistance;
    if (!priceMatchesSymbol(symbol, stop) || !priceMatchesSymbol(symbol, target)) {
      return;
    }
    if (!levelsConsistent(price, stop, target, symbol)) return;

    const stake = riskVerdict.riskCash || resolveRiskCash(risk, walletBalance);
    const targetCash =
      stake *
      (Math.abs(target - price) / Math.max(Math.abs(price - stop), 1e-9));
    const multiplier = resolveMultiplierForSymbol(symbol, risk.leverage);

    liveBuyLockRef.current = true;
    setBotNote(
      `Live ${side.toUpperCase()} · MULT${side === "buy" ? "UP" : "DOWN"} ×${multiplier} → Deriv…`,
    );
    try {
      const bought = await buyMultiplier(derivClient, {
        symbol,
        side,
        stake,
        currency: displayCurrency,
        multiplier,
        stopLossCash: stake,
        takeProfitCash: Math.max(0.01, targetCash),
      });
      const tradeId = `atlas-live-${bought.contractId}`;
      const trade: AtlasJournalTrade = {
        id: tradeId,
        at: Date.now(),
        symbol,
        side,
        entry: price,
        stop,
        target,
        result: "open",
        pnlR: 0,
        reason: `${signal.explanation.slice(0, 140)} · live ×${multiplier} · #${bought.contractId}`,
        paper: false,
        riskCash: stake,
        notional: bought.buyPrice,
        currency: displayCurrency,
        contractId: bought.contractId,
        liveProfit: 0,
      };
      const next = [trade, ...journalRef.current];
      journalRef.current = next;
      setJournal(next);
      saveJournal(next);
      attachLiveWatcher(bought.contractId, tradeId);
      setBotNote(
        `LIVE ${side.toUpperCase()} · stake ${stake.toFixed(2)} ${displayCurrency} · contract #${bought.contractId}`,
      );
    } catch (err) {
      setBotNote(
        `Live buy failed · ${err instanceof Error ? err.message : "error"} · no paper fill`,
      );
    } finally {
      liveBuyLockRef.current = false;
    }
  }

  // Void open paper ghosts that disagree with the live tape (stuck wrong entry).
  useEffect(() => {
    if (!quoteReady || quote == null || !bars.length) return;
    const current = journalRef.current;
    let changed = false;
    const next = current.map((t) => {
      if (t.result !== "open" || t.paper === false) return t;
      if (t.symbol !== symbol) return t;
      if (
        priceNearEntry(t.entry, quote, t.symbol) &&
        priceAgreesWithBars(t.entry, bars, 8) &&
        levelsConsistent(t.entry, t.stop, t.target, t.symbol)
      ) {
        return t;
      }
      changed = true;
      return {
        ...t,
        result: "flat" as const,
        pnlR: 0,
        pnlCash: 0,
        settledAt: Date.now(),
        reason: `${t.reason} · voided open ghost vs live tape`,
      };
    });
    if (changed) {
      if (!isLiveWallet) commitTrades(next);
      else {
        journalRef.current = next;
        setJournal(next);
        saveJournal(next);
      }
      setBotNote("Voided bad open fill · waiting for a clean quote");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote, quoteReady, symbol, bars.length, lastTickAt]);

  // Paper stop/target settle only — live contracts use Deriv.
  useEffect(() => {
    if (quote == null || !quoteReady) return;
    if (closingLockRef.current) return;
    // Don't let auto-settle race overwrite a manual close.
    if (Date.now() - lastManualCloseRef.current < 1500) return;
    const fallbackRisk = resolveRiskCash(risk, cashBalance);
    const current = journalRef.current;
    const next = settleOpenAgainstPrice(
      current,
      quote,
      fallbackRisk,
      symbol,
    );
    const changed = next.some((t) => {
      const prev = current.find((p) => p.id === t.id);
      return (
        !prev ||
        t.result !== prev.result ||
        t.pnlR !== prev.pnlR ||
        t.pnlCash !== prev.pnlCash
      );
    });
    if (changed) commitTrades(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote, lastTickAt, symbol, quoteReady]);

  // Collapse twin open cards (legacy max-open=2 stacks).
  useEffect(() => {
    const opens = journalRef.current.filter((t) => t.result === "open");
    if (opens.length <= 1) return;
    commitTrades(collapseExtraOpens(journalRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journal.length, quote]);

  // Sound + banner when a trade settles.
  const prevJournalRef = useRef<AtlasJournalTrade[] | null>(null);
  useEffect(() => {
    if (prevJournalRef.current == null) {
      prevJournalRef.current = journal;
      for (const t of journal) {
        if (t.result === "win" || t.result === "loss" || t.result === "flat") {
          soundedRef.current.add(t.id);
        }
      }
      return;
    }
    const prev = prevJournalRef.current;
    for (const t of journal) {
      const old = prev.find((p) => p.id === t.id);
      const justSettled =
        old?.result === "open" &&
        (t.result === "win" || t.result === "loss" || t.result === "flat");
      if (!justSettled) continue;
      if (soundedRef.current.has(t.id)) continue;
      soundedRef.current.add(t.id);

      const profit = Number(t.pnlCash) || 0;
      const riskCash = t.riskCash ?? stakePreview;
      // Never flash absurd LOSS banners (ghost fills).
      if (
        t.result === "flat" ||
        Math.abs(profit) < 0.005 ||
        (t.paper !== false && isAbsurdPaperPnl(profit, riskCash))
      ) {
        if (t.paper !== false && isAbsurdPaperPnl(profit, riskCash)) {
          commitTrades(voidAbsurdPaperSettles(journalRef.current));
          setSettleBanner(null);
          setBotNote(
            `Ignored ghost settle (${profit.toFixed(0)} ${displayCurrency}) · balance repaired`,
          );
        } else {
          setSettleBanner({
            kind: "win",
            profit: 0,
            balance: cashBalance,
          });
          setBotNote(
            `Closed flat · +0.00 ${displayCurrency}. Balance: ${cashBalance.toFixed(2)} ${displayCurrency}`,
          );
        }
        continue;
      }
      setSettleBanner({
        kind: t.result === "win" ? "win" : "loss",
        profit,
        balance: cashBalance,
      });
      if (t.result === "win") {
        playWinSound();
        setBotNote(
          `Profit booked: +${profit.toFixed(2)} ${displayCurrency}. Balance: ${cashBalance.toFixed(2)} ${displayCurrency}`,
        );
      } else {
        playLossSound();
        setBotNote(
          `Loss booked: ${profit.toFixed(2)} ${displayCurrency}. Balance: ${cashBalance.toFixed(2)} ${displayCurrency}`,
        );
      }
    }
    prevJournalRef.current = journal;
  }, [journal, cashBalance, displayCurrency, stakePreview]);

  useEffect(() => {
    if (!settleBanner) return;
    // Hide absurd chart LOSS overlays immediately.
    if (Math.abs(settleBanner.profit) >= 250) {
      setSettleBanner(null);
      return;
    }
    const id = window.setTimeout(() => setSettleBanner(null), 8_000);
    return () => window.clearTimeout(id);
  }, [settleBanner]);

  // Bot follows analyzer: fire READY setups immediately (no Almost lock / long waits).
  useEffect(() => {
    botRunningRef.current = botRunning;
    if (!botRunning) return;
    if (!scanReady) return;
    if (loading || !quoteReady || quoteSymbolRef.current !== symbol) {
      setBotNote(`Syncing ${instrument.name} quote…`);
      return;
    }
    if (Date.now() - lastManualCloseRef.current < 1_200) {
      return;
    }
    if (!derivLive || !signal || !riskVerdict?.ok) {
      setBotNote(
        !derivLive
          ? "Bot waiting · Deriv feed not live on picked market"
          : !signal
            ? "Bot waiting · analyzer warming on picked market"
            : `Bot waiting · ${riskVerdict?.reasons.join(" · ") ?? "risk blocked"}`,
      );
      return;
    }
    const minConf = risk.botMode === "sprint" ? 52 : 55;
    const boardRow = scanBoardRef.current.find((r) => r.symbol === symbol);
    const boardDead =
      !!boardRow &&
      (/crypto noise|unsteady chop — skip/i.test(boardRow.fitLabel || "") ||
        boardRow.bias === "neutral");
    const boardSteady =
      !!boardRow &&
      !/crypto noise|unsteady chop — skip/i.test(boardRow.fitLabel || "");
    const boardReady =
      !!boardRow &&
      boardRow.tradeable &&
      boardRow.bias !== "neutral" &&
      boardRow.bias === signal.bias &&
      boardRow.confidence >= minConf &&
      boardSteady;
    const liveReady =
      signal.bias !== "neutral" &&
      signal.stackAligned &&
      signal.tradeable &&
      signal.confidence >= minConf &&
      signal.confluence >= 52 &&
      signal.gateScore >= 7;
    // Track Almost stuck so rotator leaves Gold/etc.
    if (!liveReady) {
      const key = symbol;
      if (!stuckOnRef.current || stuckOnRef.current.key !== key) {
        stuckOnRef.current = { key, since: Date.now() };
      }
    } else {
      stuckOnRef.current = null;
      rotateExcludeRef.current.clear();
    }
    if (!liveReady && !boardReady) {
      // Rotate market + strategy — don't stick on a dead chart.
      if (
        !scanLockRef.current &&
        journalRef.current.every((t) => t.result !== "open")
      ) {
        const stuckLong =
          !!stuckOnRef.current &&
          Date.now() - stuckOnRef.current.since > 5_000;
        if (
          boardDead ||
          !signal.stackAligned ||
          stuckLong ||
          Date.now() - lastScanRef.current > 5_000
        ) {
          classicLockRef.current = false;
          if (scanCacheRef.current.size > 0) {
            const ranked = rankAtlasBarCache(
              scanCacheRef.current,
              strategyRef.current,
              true,
            );
            setScanBoard(ranked.ranks);
            scanBoardRef.current = ranked.ranks;
            const next = stuckLong
              ? pickRankedBest(ranked.ranks, symbol)
              : ranked.best;
            applyScanPick(next, true);
          }
          if (Date.now() - lastScanRef.current > 10_000) {
            void runMarketPick("ready-hunt");
          }
        }
      }
      setBotNote(
        boardDead
          ? `Rotating · ${instrument.name} skipped · next market+strategy…`
          : !signal.stackAligned
            ? `Rotating · ${instrument.name} stack wrong · changing market…`
            : `On ${instrument.name} · ${signal.powerLabel} · ${
                stuckOnRef.current &&
                Date.now() - stuckOnRef.current.since > 5_000
                  ? "switching market now…"
                  : "ready when stack+timing fire"
              }`,
      );
      return;
    }
    if (stats.open >= Math.max(1, risk.maxOpenTrades)) {
      setBotNote(
        `Analyzer · ${signal.bias.toUpperCase()} · open ${stats.open} · waiting settle`,
      );
      return;
    }
    if (journalRef.current.some((t) => t.result === "open")) {
      setBotNote(`Already in a trade · Bank / Close below`);
      return;
    }
    const now = Date.now();
    if (now - lastFireRef.current < 2_500) return;
    lastFireRef.current = now;
    placeTrade({ soft: false });
    setBotNote(
      `Bot fired ${isLiveWallet ? "LIVE" : "PAPER"} ${signal.bias.toUpperCase()} · READY · ${instrument.name} @ ${fmtPrice(quote, symbol)} · conf ${signal.confidence.toFixed(0)}`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    botRunning,
    scanReady,
    scanning,
    derivLive,
    signal,
    riskVerdict?.ok,
    isLiveWallet,
    risk.botMode,
    stats.open,
    quote,
    quoteReady,
    lastTickAt,
    symbol,
    loading,
  ]);

  // Keep rotating markets + strategies until a viable setup fires.
  useEffect(() => {
    if (!botRunning) return;
    const hunt = window.setInterval(() => {
      if (!botRunningRef.current) return;
      if (journalRef.current.some((t) => t.result === "open")) return;
      if (scanLockRef.current) return;

      if (scanCacheRef.current.size > 0) {
        const ranked = rankAtlasBarCache(
          scanCacheRef.current,
          strategyRef.current,
          true,
        );
        setScanBoard(ranked.ranks);
        scanBoardRef.current = ranked.ranks;
        const row = ranked.ranks.find((r) => r.symbol === symbolRef.current);
        const lockedReady =
          !!row &&
          row.tradeable &&
          row.bias !== "neutral" &&
          !/crypto noise|unsteady chop — skip/i.test(row.fitLabel || "");
        if (!lockedReady) {
          classicLockRef.current = false;
          applyScanPick(ranked.best, true);
        }
      }

      if (Date.now() - lastScanRef.current > 12_000) {
        classicLockRef.current = false;
        void runMarketPick("ready-hunt");
      }
    }, 4_000);
    return () => window.clearInterval(hunt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botRunning, granularity, risk.botMode]);

  // Sprint: live board refresh + hops when another READY is clearly better.
  useEffect(() => {
    if (!botRunning) return;
    if (risk.botMode === "classic") return;
    let ticks = 0;

    const tick = window.setInterval(() => {
      if (!botRunningRef.current) return;
      if (riskRef.current.botMode === "classic") return;
      if (journalRef.current.some((t) => t.result === "open")) return;
      if (scanCacheRef.current.size === 0) return;
      const ranked = rankAtlasBarCache(
        scanCacheRef.current,
        strategyRef.current,
        true,
      );
      if (ranked.ranks.length) {
        setScanBoard(ranked.ranks);
        scanBoardRef.current = ranked.ranks;
        ticks += 1;
        if (ticks % 3 === 0) applyScanPick(ranked.best, false);
      }
    }, 1000);

    const refresh = window.setInterval(() => {
      if (!botRunningRef.current) return;
      if (riskRef.current.botMode === "classic") return;
      if (scanLockRef.current) return;
      if (journalRef.current.some((t) => t.result === "open")) return;
      void runMarketPick("timer");
    }, 15_000);

    return () => {
      window.clearInterval(tick);
      window.clearInterval(refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botRunning, granularity, risk.botMode]);

  // Sprint mode: bank small profits fast; wait briefly on loss; stop at session target.
  useEffect(() => {
    if (!botRunning || risk.botMode !== "sprint") return;
    if (!quoteReady || quote == null) return;

    const dayBooked = stats.dayCash;
    if (dayBooked >= risk.sessionTargetCash) {
      const opens = journalRef.current.filter((t) => t.result === "open");
      if (opens.length) {
        void closeTradesAtMarket(
          opens.map((t) => t.id),
          { stopBot: true, note: "Sprint target reached · closing & stopping" },
        );
      } else {
        setBotRunning(false);
        botRunningRef.current = false;
        classicLockRef.current = false;
        setScanReady(false);
        setBotNote(
          `Sprint target hit · day +${dayBooked.toFixed(2)} ≥ ${risk.sessionTargetCash.toFixed(2)} · bot stopped`,
        );
      }
      return;
    }

    const open = journalRef.current.filter((t) => t.result === "open");
    if (open.length === 0) {
      underwaterSinceRef.current = null;
      return;
    }

    const t = open[0];
    if (t.symbol !== symbol) return;
    const riskCash = t.riskCash ?? stakePreview;
    const live =
      !t.paper && t.liveProfit != null && Number.isFinite(t.liveProfit)
        ? t.liveProfit
        : unrealizedCash({ ...t, riskCash }, quote);

    if (live >= risk.minBankCash) {
      underwaterSinceRef.current = null;
        void closeTradesAtMarket([t.id], {
          stopBot: false,
          note: `Sprint take-profit +${live.toFixed(2)} · hunting next…`,
        });
      return;
    }

    if (live < -0.01) {
      if (underwaterSinceRef.current == null) {
        underwaterSinceRef.current = Date.now();
      } else if (
        Date.now() - underwaterSinceRef.current >=
        risk.lossPatienceSec * 1000
      ) {
        underwaterSinceRef.current = null;
        void closeTradesAtMarket([t.id], {
          stopBot: false,
          note: `Sprint left red ${live.toFixed(2)} after ${risk.lossPatienceSec}s · next market…`,
        });
      }
    } else {
      underwaterSinceRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    botRunning,
    risk.botMode,
    risk.minBankCash,
    risk.sessionTargetCash,
    risk.lossPatienceSec,
    quote,
    quoteReady,
    lastTickAt,
    symbol,
    stats.dayCash,
    journal,
  ]);

  function settlePaper(id: string, mode: "live" | "loss") {
    if (mode === "live") {
      void closeTradesAtMarket([id]);
      return;
    }
    const row = journalRef.current.find((t) => t.id === id);
    // Live full loss = sell at market (Deriv P/L), not invent −stake on ledger.
    if (row && !row.paper && row.contractId != null) {
      void closeTradesAtMarket([id], {
        stopBot: true,
        note: "Live exit · sold on Deriv · bot stopped",
      });
      return;
    }
    unlockAudio();
    const fallbackRisk = resolveRiskCash(risk, walletBalance);
    // Take full loss = book the full stake at risk, not the live −$0.xx.
    const next = journalRef.current.map((t) => {
      if (t.id !== id || t.result !== "open") return t;
      const riskCash = t.riskCash ?? fallbackRisk;
      return {
        ...t,
        result: "loss" as const,
        pnlR: -1,
        pnlCash: -Math.round(riskCash * 100) / 100,
        riskCash,
        settledAt: Date.now(),
        reason: `${t.reason} · took full stake loss`,
      };
    });
    const fallback = resolveRiskCash(risk, cashAccount.startBalance);
    const synced = syncLedger(
      next,
      fallback,
      cashAccount.currency || currency || "USD",
      cashAccount.startBalance,
    );
    journalRef.current = synced.trades as AtlasJournalTrade[];
    setJournal(synced.trades as AtlasJournalTrade[]);
    setCashAccount(synced.account);
    lastManualCloseRef.current = Date.now();
    lastFireRef.current = Date.now();
    soundedRef.current.add(id);
    setBotRunning(false);
    botRunningRef.current = false;
    classicLockRef.current = false;
    setScanReady(false);
    const booked = Number(synced.trades.find((t) => t.id === id)?.pnlCash) || 0;
    playLossSound();
    setSettleBanner({
      kind: "loss",
      profit: booked,
      balance: synced.account.balance,
    });
    setBotNote(
      `Full stake loss · booked ${booked.toFixed(2)} ${synced.account.currency} · bot stopped`,
    );
  }

  function resetDemo() {
    unlockAudio();
    const ok = window.confirm(
      "Clear ALL Atlas trading history and reset demo cash to $10,000 on this device?\n\nRefresh will NOT clear history — only this button does.",
    );
    if (!ok) return;
    soundedRef.current = new Set();
    const synced = syncLedger(
      [],
      resolveRiskCash(risk, ATLAS_DEMO_START),
      displayCurrency,
      ATLAS_DEMO_START,
    );
    setJournal(synced.trades as AtlasJournalTrade[]);
    setCashAccount(synced.account);
    setSettleBanner(null);
    setBotNote(
      `Demo cleared · history wiped · balance ${ATLAS_DEMO_START.toFixed(2)} ${displayCurrency}`,
    );
  }

  function clearHistoryOnly() {
    unlockAudio();
    const ok = window.confirm(
      "Clear Atlas trading history on this device?\n\nDemo balance will be recalculated from an empty journal (back to start cash). Refresh never clears this — only you can.",
    );
    if (!ok) return;
    soundedRef.current = new Set();
    const synced = syncLedger(
      [],
      resolveRiskCash(risk, cashAccount.startBalance || ATLAS_DEMO_START),
      displayCurrency,
      cashAccount.startBalance || ATLAS_DEMO_START,
    );
    setJournal(synced.trades as AtlasJournalTrade[]);
    setCashAccount(synced.account);
    setSettleBanner(null);
    setBotNote("Trading history cleared on this device");
  }

  function exportBacktestCsv() {
    if (!backtest) return;
    const rows = [
      "trades,wins,winRate,profitFactor,expectancyR,totalR,maxDrawdownR,sharpeApprox",
      [
        backtest.trades,
        backtest.wins,
        backtest.winRate.toFixed(2),
        backtest.profitFactor.toFixed(3),
        backtest.expectancyR.toFixed(4),
        backtest.totalR.toFixed(2),
        backtest.maxDrawdownR.toFixed(2),
        backtest.sharpeApprox.toFixed(3),
      ].join(","),
    ];
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `atlas-backtest-${symbol}-${strategyId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="atlas-app" data-theme={theme}>
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        botRunning={botRunning || stats.open > 0}
        initialTab={settingsTab}
        feedState={error ? "error" : feedState}
        feedError={error}
        tradeDesk="digits"
        onSelectDesk={() => undefined}
        onHubChange={(hub) => {
          // Always unlock leaving Atlas — stop bot and bank open paper at market.
          setBotRunning(false);
          botRunningRef.current = false;
          classicLockRef.current = false;
          const opens = journalRef.current
            .filter((t) => t.result === "open")
            .map((t) => t.id);
          if (opens.length) {
            void closeTradesAtMarket(opens, {
              stopBot: true,
              note: "Hub switch · closed open trades",
            });
          }
          setHubName(getHubDisplayName());
          onHubChange?.(hub);
        }}
        hubMode="atlas"
      />

      <header className="atlas-topbar">
        <div className="atlas-brand">
          <img
            className="atlas-brand__logo"
            src={theme === "light" ? logoLight : logoDark}
            alt=""
          />
          <div>
            <div className="atlas-brand__title">
              <strong>{hubName}</strong>
              <span className={`atlas-pill ${derivLive ? "atlas-pill--live" : "atlas-pill--off"}`}>
                {derivLive ? "Live feed" : loading ? "Connecting" : "Feed idle"}
              </span>
              <span
                className={`atlas-pill ${
                  isLiveWallet ? "atlas-pill--live" : "atlas-pill--demo"
                }`}
              >
                {isLiveWallet ? "Real wallet" : "Demo wallet"}
              </span>
            </div>
            <p className="atlas-brand__sub">
              {isLiveWallet
                ? "Wallet: Deriv real · live multipliers · Settings → Trading to switch"
                : "Wallet: Deriv demo · paper ledger · Settings → Trading for real"}
            </p>
          </div>
        </div>

        <div className="atlas-metrics" aria-label="Account metrics">
          <div className="atlas-metric atlas-metric--demo">
            <span>Equity</span>
            <strong>
              {equityLive.toFixed(2)} {displayCurrency}
            </strong>
          </div>
          <div className="atlas-metric">
            <span>Available</span>
            <strong className={freeMargin < walletBalance ? "is-down" : undefined}>
              {freeMargin.toFixed(2)} {displayCurrency}
            </strong>
          </div>
          <div className="atlas-metric">
            <span>{openTradesList.length ? "Used margin" : botRunning ? "Reserved" : "Used"}</span>
            <strong>
              {usedMargin.toFixed(2)} {displayCurrency}
            </strong>
          </div>
          <div className="atlas-metric">
            <span>Day P/L</span>
            <strong className={dayPnlCash >= 0 ? "is-up" : "is-down"}>
              {dayPnlCash >= 0 ? "+" : ""}
              {dayPnlCash.toFixed(2)} {displayCurrency}
            </strong>
          </div>
          <div className="atlas-metric">
            <span>Total P/L</span>
            <strong
              className={
                totalDemoPnl + unrealizedOpen >= 0 ? "is-up" : "is-down"
              }
            >
              {totalDemoPnl + unrealizedOpen >= 0 ? "+" : ""}
              {(totalDemoPnl + unrealizedOpen).toFixed(2)} {displayCurrency}
            </strong>
          </div>
          <div className="atlas-metric">
            <span>Record</span>
            <strong>
              {stats.wins}W/{stats.losses}L
              {stats.open ? ` · ${stats.open} open` : ""}
            </strong>
          </div>
        </div>

        <div className="atlas-topbar__actions">
          <button
            type="button"
            className="atlas-nav-btn"
            onClick={() => {
              unlockAudio();
              toggleTheme();
            }}
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          <button
            type="button"
            className="atlas-nav-btn"
            onClick={() => {
              unlockAudio();
              setSettingsTab("hub");
              setSettingsOpen(true);
            }}
          >
            Settings
          </button>
        </div>
      </header>

      {settleBanner ? (
        <div
          className={`atlas-settle-banner ${
            settleBanner.kind === "win" ? "is-win" : "is-loss"
          }`}
          role="status"
        >
          {settleBanner.kind === "win" && settleBanner.profit > 0.004 ? (
            <>
              <strong>Well done — this is your profit</strong>
              <span>
                +{settleBanner.profit.toFixed(2)} {displayCurrency}
              </span>
              <em>
                Balance now {settleBanner.balance.toFixed(2)}{" "}
                {displayCurrency}
              </em>
            </>
          ) : settleBanner.kind === "loss" ? (
            <>
              <strong>Loss taken on demo</strong>
              <span>
                {settleBanner.profit.toFixed(2)} {displayCurrency}
              </span>
              <em>
                Balance now {settleBanner.balance.toFixed(2)}{" "}
                {displayCurrency}
              </em>
            </>
          ) : (
            <>
              <strong>Trade closed</strong>
              <span>
                {settleBanner.profit >= 0 ? "+" : ""}
                {settleBanner.profit.toFixed(2)} {displayCurrency} booked
              </span>
              <em>
                Balance now {settleBanner.balance.toFixed(2)}{" "}
                {displayCurrency}
              </em>
            </>
          )}
        </div>
      ) : null}

      <div className="atlas-strip">
        <div className="atlas-strip__quote">
          <span>{instrument.name}</span>
          <strong className={quoteUp ? "is-up" : "is-down"}>
            {fmtPrice(quote, symbol)}
          </strong>
        </div>
        <span className="atlas-strip__dot">·</span>
        <span>{ATLAS_TIMEFRAMES.find((t) => t.id === tf)?.label} candles</span>
        <span className="atlas-strip__dot">·</span>
        <span>{bars.length} bars</span>
        <span className="atlas-strip__dot">·</span>
        <span>Tick {ageLabel(lastTickAt)}</span>
        <span className="atlas-strip__dot">·</span>
        <span>Spread ~{instrument.spread}</span>
        <span className="atlas-strip__dot">·</span>
        <span>
          Research only · paper default · risk gates before any auto order
        </span>
      </div>

      <div className="atlas-layout">
        <aside className="atlas-side">
          <p className="atlas-side__label">Workspace</p>
          <div className="atlas-side__group">
            <label className="atlas-field">
              Market
              <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
                {ATLAS_INSTRUMENTS.map((inst) => (
                  <option key={inst.symbol} value={inst.symbol}>
                    {inst.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="atlas-field">
              Timeframe
              <select
                value={tf}
                onChange={(e) => setTf(e.target.value as AtlasTimeframeId)}
              >
                {ATLAS_TIMEFRAMES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="atlas-field">
              Chart
              <select
                value={chartMode}
                onChange={(e) =>
                  setChartMode(e.target.value as "candles" | "line")
                }
              >
                <option value="candles">Candles</option>
                <option value="line">Line</option>
              </select>
            </label>
            <label className="atlas-field">
              Strategy
              <select
                value={strategyId}
                onChange={(e) =>
                  setStrategyId(e.target.value as AtlasStrategyId)
                }
              >
                {ATLAS_STRATEGIES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="atlas-muted">
            {ATLAS_STRATEGIES.find((s) => s.id === strategyId)?.description}
          </p>
        </aside>

        <main className="atlas-main">
          <section className="atlas-command">
            <div className="atlas-command__analyzer">
              <div className="atlas-command__label">
                Analyzer · {signal?.strategyName ?? "Apex Confluence"}
              </div>
              {signal ? (
                <>
                  <div className="atlas-command__bias-row">
                    <div className={`atlas-bias is-${signal.bias}`}>
                      {signal.bias.toUpperCase()}
                    </div>
                    <span
                      className={`atlas-pill ${signal.tradeable ? "atlas-pill--live" : "atlas-pill--off"}`}
                    >
                      {signal.tradeable ? "Can fire" : "Building"}
                    </span>
                    <span className="atlas-pill">
                      Confluence {signal.confluence.toFixed(0)}%
                    </span>
                    <span
                      className={`atlas-pill ${
                        signal.tradeable ? "atlas-pill--live" : ""
                      }`}
                    >
                      {signal.powerLabel}
                    </span>
                    {signal.bias !== "neutral" && signal.confidence >= 46 ? (
                      <span className="atlas-pill atlas-pill--live">
                        No candle wait · {signal.bias.toUpperCase()}
                      </span>
                    ) : (
                      <span className="atlas-pill">Tape mixed</span>
                    )}
                  </div>
                  <div className="atlas-command__meters">
                    <span>
                      Buy <em>{signal.buyProbability.toFixed(0)}%</em>
                    </span>
                    <span>
                      Sell <em>{signal.sellProbability.toFixed(0)}%</em>
                    </span>
                    <span>
                      Conf <em>{signal.confidence.toFixed(0)}</em>
                    </span>
                    <span>
                      Risk <em>{signal.riskScore}</em>
                    </span>
                    <span>
                      Target <em>{signal.expectedRR.toFixed(1)}R</em>
                    </span>
                  </div>
                  <div className="atlas-factors">
                    {signal.factors
                      .filter((f) => f.hit)
                      .slice(0, 10)
                      .map((f) => (
                        <span
                          key={f.id}
                          className={`atlas-factor is-${f.side}`}
                          title={`weight ${f.weight}`}
                        >
                          {f.label}
                        </span>
                      ))}
                  </div>
                  <p className="atlas-command__explain">{signal.explanation}</p>
                </>
              ) : (
                <p className="atlas-muted">Waiting for live bars from Deriv…</p>
              )}
            </div>
            <div className="atlas-command__bot">
              <div className="atlas-command__label">Bot · order ticket</div>
              <form
                className="atlas-bot-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  unlockAudio();
                  if (!botRunning) {
                    classicLockRef.current = false;
                    setScanReady(false);
                    setBotRunning(true);
                    void runMarketPick("start");
                  }
                }}
              >
                <div className="atlas-bot-form__row">
                  <label className="atlas-field atlas-field--wide">
                    Bot mode
                    <select
                      value={risk.botMode}
                      disabled={botRunning}
                      onChange={(e) =>
                        setRisk((r) => ({
                          ...r,
                          botMode: e.target.value as AtlasBotMode,
                        }))
                      }
                    >
                      <option value="classic">
                        Classic — wait for setup, bank stops bot
                      </option>
                      <option value="sprint">
                        Sprint — bank small profits fast, hunt to session target
                      </option>
                    </select>
                  </label>
                </div>
                {risk.botMode === "sprint" ? (
                  <div className="atlas-bot-form__row">
                    <label className="atlas-field">
                      Min bank $
                      <input
                        type="number"
                        min={0.01}
                        max={50}
                        step={0.01}
                        value={risk.minBankCash}
                        disabled={botRunning}
                        onChange={(e) =>
                          setRisk((r) => ({
                            ...r,
                            minBankCash: Math.max(
                              0.01,
                              Number(e.target.value) || 0.05,
                            ),
                          }))
                        }
                      />
                    </label>
                    <label className="atlas-field">
                      Session target $
                      <input
                        type="number"
                        min={0.5}
                        max={500}
                        step={0.5}
                        value={risk.sessionTargetCash}
                        disabled={botRunning}
                        onChange={(e) =>
                          setRisk((r) => ({
                            ...r,
                            sessionTargetCash: Math.max(
                              0.5,
                              Number(e.target.value) || 5,
                            ),
                          }))
                        }
                      />
                    </label>
                    <label className="atlas-field">
                      Loss wait (s)
                      <input
                        type="number"
                        min={15}
                        max={300}
                        step={5}
                        value={risk.lossPatienceSec}
                        disabled={botRunning}
                        onChange={(e) =>
                          setRisk((r) => ({
                            ...r,
                            lossPatienceSec: Math.max(
                              15,
                              Number(e.target.value) || 90,
                            ),
                          }))
                        }
                      />
                    </label>
                  </div>
                ) : null}
                <p className="atlas-bot-mode-hint">
                  {risk.botMode === "sprint"
                    ? `Sprint banks from +$${risk.minBankCash.toFixed(2)}, leaves red after ${risk.lossPatienceSec}s, hops markets, stops at +$${risk.sessionTargetCash.toFixed(2)} day profit.`
                    : "Classic uses the analyzer to pick market + strategy, rotates when stuck, locks only when READY."}
                </p>
                <div className="atlas-bot-form__row">
                  <label className="atlas-field">
                    Stake mode
                    <select
                      value={risk.stakeMode}
                      onChange={(e) =>
                        setRisk((r) => ({
                          ...r,
                          stakeMode: e.target.value as "fixed" | "percent",
                        }))
                      }
                    >
                      <option value="fixed">Fixed stake ($)</option>
                      <option value="percent">% of balance</option>
                    </select>
                  </label>
                  {risk.stakeMode === "fixed" ? (
                    <label className="atlas-field">
                      Stake amount
                      <input
                        type="number"
                        min={1}
                        max={Math.max(1, equity)}
                        step={1}
                        value={risk.stakeAmount}
                        onChange={(e) =>
                          setRisk((r) => ({
                            ...r,
                            stakeAmount: Math.max(1, Number(e.target.value) || 1),
                          }))
                        }
                      />
                    </label>
                  ) : (
                    <label className="atlas-field">
                      Risk %
                      <input
                        type="number"
                        min={0.1}
                        max={5}
                        step={0.1}
                        value={risk.riskPerTradePct}
                        onChange={(e) =>
                          setRisk((r) => ({
                            ...r,
                            riskPerTradePct: Number(e.target.value) || 1,
                          }))
                        }
                      />
                    </label>
                  )}
                </div>
                <div className="atlas-bot-form__row">
                  <label className="atlas-field">
                    {isLiveWallet ? "Multiplier" : "Leverage"}
                    <select
                      value={
                        isLiveWallet
                          ? resolveMultiplierForSymbol(symbol, risk.leverage)
                          : risk.leverage
                      }
                      onChange={(e) =>
                        setRisk((r) => ({
                          ...r,
                          leverage: Number(e.target.value) || 100,
                        }))
                      }
                    >
                      {(isLiveWallet
                        ? allowedMultipliersForSymbol(symbol)
                        : [10, 20, 50, 100, 200]
                      ).map((n) => (
                        <option key={n} value={n}>
                          {isLiveWallet ? `×${n}` : `1:${n}`}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="atlas-field">
                    Max open
                    <input
                      type="number"
                      min={1}
                      max={1}
                      step={1}
                      value={1}
                      readOnly
                      title="Atlas demo allows one open trade so cards do not twin"
                    />
                  </label>
                  <label className="atlas-field">
                    Day loss %
                    <input
                      type="number"
                      min={0.5}
                      max={20}
                      step={0.5}
                      value={risk.dailyLossLimitPct}
                      onChange={(e) =>
                        setRisk((r) => ({
                          ...r,
                          dailyLossLimitPct: Number(e.target.value) || 3,
                        }))
                      }
                    />
                  </label>
                </div>
                <div className="atlas-bot-preview">
                  <div>
                    <span>Stake / risk</span>
                    <strong>
                      {stakePreview.toFixed(2)} {displayCurrency}
                    </strong>
                  </div>
                  <div>
                    <span>{isLiveWallet ? "Stake needed" : "Est. margin"}</span>
                    <strong>
                      {(riskVerdict?.marginRequired ?? 0).toFixed(2)}{" "}
                      {displayCurrency}
                    </strong>
                  </div>
                  <div>
                    <span>{isLiveWallet ? "Deriv free" : "Free margin"}</span>
                    <strong>
                      {freeMargin.toFixed(2)} {displayCurrency}
                    </strong>
                  </div>
                  <div>
                    <span>Notional</span>
                    <strong>
                      {(riskVerdict?.positionNotional ?? 0).toFixed(0)}{" "}
                      {displayCurrency}
                    </strong>
                  </div>
                </div>
                <div className="atlas-bot-form__actions">
                  <button
                    type="button"
                    className={`atlas-start ${botRunning ? "is-stop" : "is-start"}`}
                    disabled={scanning}
                    onClick={() => {
                      unlockAudio();
                      if (botRunning) {
                        setBotRunning(false);
                        classicLockRef.current = false;
                        setScanReady(false);
                        setScanning(false);
                        scanLockRef.current = false;
                        setBotNote("Bot stopped · analyzer still live");
                        return;
                      }
                      // Keep history — only drop impossible open levels.
                      commitTrades(scrubCorruptEntries(journalRef.current));
                      setSettleBanner(null);
                      classicLockRef.current = false;
                      setScanReady(false);
                      setScanning(false);
                      scanLockRef.current = false;
                      setBotRunning(true);
                      botRunningRef.current = true;
                      void runMarketPick("start");
                      if (!derivLive) {
                        setBotNote("Bot on · waiting for Deriv feed…");
                      }
                    }}
                  >
                    {scanning
                      ? "Scanning…"
                      : botRunning
                        ? "Stop bot"
                        : "Start bot"}
                  </button>
                  <button
                    type="button"
                    className="atlas-settle atlas-settle--win"
                    disabled={
                      scanning ||
                      !signal ||
                      !signal.tradeable ||
                      !signal.stackAligned ||
                      signal.bias === "neutral" ||
                      !riskVerdict?.ok ||
                      !derivLive ||
                      !quoteReady
                    }
                    onClick={() => {
                      unlockAudio();
                      placeTrade({ soft: false });
                      setBotNote(
                        `Manual ${isLiveWallet ? "LIVE" : "DEMO"} ${signal?.bias.toUpperCase()} · stack OK · stake ${stakePreview.toFixed(2)} ${displayCurrency} @ ${fmtPrice(quote, symbol)}`,
                      );
                    }}
                  >
                    Trade once
                  </button>
                </div>
              </form>
              <p className={`atlas-command__note ${botRunning ? "is-live" : ""}`}>
                {scanning
                  ? risk.botMode === "classic"
                    ? "Classic · locking one market + strategy…"
                    : "Sprint · ranking markets…"
                  : botNote}
              </p>
              {scanBoard.length > 0 ? (
                <div className="atlas-scan-board" aria-label="Market scan ranks">
                  <div className="atlas-scan-board__head">
                    <span>Best market · session research</span>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      disabled={scanning}
                      onClick={() => {
                        classicLockRef.current = false;
                        void runMarketPick("manual");
                      }}
                    >
                      {scanning ? "Scanning…" : "Scan now"}
                    </button>
                  </div>
                  <p
                    className={`atlas-muted ${
                      sessionNow.inPrimeFx ? "atlas-ok" : ""
                    }`}
                    style={{ margin: "0.35rem 0 0.55rem", fontSize: "0.82rem" }}
                  >
                    <strong>{sessionNow.label}</strong>
                    {" · "}
                    {sessionNow.eatLabel}
                    <br />
                    {sessionNow.tip}
                    {!sessionNow.inPrimeFx ? (
                      <>
                        <br />
                        Peak EUR/USD window:{" "}
                        <strong>15:00–19:00 EAT</strong> (desk) /{" "}
                        <strong>16:00–20:00 EAT</strong> (London–NY overlap).
                      </>
                    ) : null}
                  </p>
                  <ul>
                    {scanBoard.slice(0, 7).map((row, idx) => (
                      <li
                        key={row.symbol}
                        className={
                          row.symbol === symbol ? "is-active" : undefined
                        }
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setSymbol(row.symbol);
                            if (row.strategyId) setStrategyId(row.strategyId);
                          }}
                          title={row.explanation}
                        >
                          <em>#{idx + 1}</em>
                          <strong>{row.name}</strong>
                          <span
                            className={`atlas-scan-bias is-${row.bias}`}
                          >
                            {row.bias.toUpperCase()}
                          </span>
                          <span>
                            {row.strategyName} ·{" "}
                            {row.tradeable ? "READY" : row.powerLabel} · WR{" "}
                            {row.sampleTrades > 0
                              ? `${row.winRate.toFixed(0)}%`
                              : "—"}{" "}
                            · expect {row.expectancyR >= 0 ? "+" : ""}
                            {row.expectancyR.toFixed(2)}R · {row.fitLabel}
                            {row.sessionLabel
                              ? ` · ${row.sessionLabel}`
                              : ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {stats.winRate == null ? (
                <p className="atlas-muted">
                  {isLiveWallet
                    ? "Deriv wallet · live multipliers. Win rate after first settle."
                    : "Demo margin · paper ledger. Win rate after first settle."}{" "}
                  Open: {stats.open} · Closed: {stats.closed}
                </p>
              ) : (
                <p className="atlas-muted">
                  Win rate {stats.winRate.toFixed(0)}% · {stats.wins}W /{" "}
                  {stats.losses}L · {stats.closed} closed
                </p>
              )}
            </div>
          </section>

          <section className="atlas-panel atlas-panel--status">
            <h3>How it&apos;s going · your money</h3>
            {(() => {
              const openTrades = journal.filter((t) => t.result === "open");
              const riskCashDefault = stakePreview;
              const earnedToday = dayPnlCash;
              const last = stats.lastClosed;
              const lastCash = stats.lastClosedCash;
              const riskBlocked = botRunning && !riskVerdict?.ok;
              const statusLabel = openTrades.length
                ? "IN TRADE"
                : botRunning
                  ? riskBlocked
                    ? "BLOCKED"
                    : signal?.tradeable
                      ? "FIRING"
                      : "ROTATING"
                  : "BOT STOPPED";
              const statusClass = openTrades.length
                ? "is-trade"
                : botRunning
                  ? riskBlocked
                    ? "is-stop"
                    : signal?.tradeable
                      ? "is-trade"
                      : "is-wait"
                  : "is-stop";

              return (
                <div className="atlas-session">
                  <div className={`atlas-session__status ${statusClass}`}>
                    <strong>{statusLabel}</strong>
                    <span>
                      {openTrades.length
                        ? "Watch live P/L — Bank / Close stops the bot after booking"
                        : botRunning
                          ? riskBlocked
                            ? riskVerdict?.reasons.join(" · ") ?? "Risk blocked"
                            : scanning
                              ? "Picking market + strategy…"
                              : signal?.tradeable
                                ? `READY on ${instrument.name} · entering now`
                                : `Analyzer changing market/strategy · not stuck on one chart`
                          : "Press Start bot — picks a READY market then trades"}
                    </span>
                  </div>

                  <div className="atlas-status-kpis atlas-status-kpis--money">
                    <div>
                      <span>You earned today</span>
                      <strong
                        className={earnedToday >= 0 ? "is-up" : "is-down"}
                      >
                        {earnedToday >= 0 ? "+" : ""}
                        {earnedToday.toFixed(2)} {displayCurrency}
                      </strong>
                      <em>
                        {stats.wins}W / {stats.losses}L settled
                      </em>
                    </div>
                    <div>
                      <span>{isLiveWallet ? "Deriv balance" : "Demo balance"}</span>
                      <strong>
                        {walletBalance.toFixed(2)} {displayCurrency}
                      </strong>
                      <em>
                        {isLiveWallet
                          ? `Real wallet · multipliers · open P/L ${unrealizedOpen >= 0 ? "+" : ""}${unrealizedOpen.toFixed(2)}`
                          : `Cash ${cashBalance.toFixed(2)} · start ${cashAccount.startBalance.toFixed(0)} · booked P/L ${totalDemoPnl >= 0 ? "+" : ""}${totalDemoPnl.toFixed(2)}`}
                      </em>
                    </div>
                    <div>
                      <span>Last trade</span>
                      <strong
                        className={
                          last?.result === "loss" || lastCash < 0
                            ? "is-down"
                            : last?.result === "flat" || Math.abs(lastCash) < 0.005
                              ? undefined
                              : "is-up"
                        }
                      >
                        {last
                          ? `${
                              last.result === "flat" || Math.abs(lastCash) < 0.005
                                ? "CLOSED"
                                : last.result.toUpperCase()
                            } ${lastCash >= 0 ? "+" : ""}${lastCash.toFixed(2)} ${displayCurrency}`
                          : "—"}
                      </strong>
                      <em>
                        {last
                          ? `${last.side.toUpperCase()} ${last.symbol}`
                          : "No settle yet"}
                      </em>
                    </div>
                    <div>
                      <span>Next stake</span>
                      <strong>
                        {riskCashDefault.toFixed(2)} {displayCurrency}
                      </strong>
                      <em>
                        {risk.stakeMode === "fixed"
                          ? "Fixed stake"
                          : `${risk.riskPerTradePct}% of balance`}
                      </em>
                    </div>
                  </div>

                  {openTrades.length === 0 ? (
                    <p className="atlas-muted atlas-session__hint">
                      No open trade right now. When a trade opens, live P/L and{" "}
                      <strong>Bank win / Take loss</strong> buttons appear here.
                    </p>
                  ) : (
                    <div className="atlas-open-list">
                      {openTrades.length > 1 ? (
                        <button
                          type="button"
                          className="atlas-settle atlas-settle--win"
                          style={{ width: "100%", marginBottom: "0.5rem" }}
                          onClick={() =>
                            void closeTradesAtMarket(openTrades.map((t) => t.id))
                          }
                        >
                          Close all at market ({openTrades.length})
                        </button>
                      ) : null}
                      {openTrades.map((t) => {
                        const price =
                          t.symbol === symbol && quote != null
                            ? quote
                            : t.entry;
                        const riskCash = t.riskCash ?? riskCashDefault;
                        const rawCash =
                          !t.paper &&
                          t.liveProfit != null &&
                          Number.isFinite(t.liveProfit)
                            ? t.liveProfit
                            : unrealizedCash({ ...t, riskCash }, price);
                        const uCash =
                          t.paper === false
                            ? rawCash
                            : clampPaperCash(rawCash, riskCash);
                        const uR =
                          !t.paper &&
                          t.liveProfit != null &&
                          riskCash > 0
                            ? t.liveProfit / riskCash
                            : Math.max(-2.2, Math.min(2.2, unrealizedR(t, price)));
                        const prog = progressToTarget(t, price);
                        const notional =
                          t.notional ??
                          (Math.abs(t.entry - t.stop) > 0
                            ? (riskCash / Math.abs(t.entry - t.stop)) * t.entry
                            : 0);
                        const targetCash =
                          riskCash *
                          (Math.abs(t.target - t.entry) /
                            Math.max(Math.abs(t.entry - t.stop), 1e-9));
                        return (
                          <div key={t.id} className="atlas-open-card">
                            <div className="atlas-open-card__head">
                              <strong>
                                OPEN {t.side.toUpperCase()} {t.symbol}
                              </strong>
                              <span
                                className={`atlas-pill ${
                                  uR >= 0
                                    ? "atlas-pill--live"
                                    : "atlas-pill--off"
                                }`}
                              >
                                {prog.status}
                              </span>
                            </div>
                            <p className="atlas-muted" style={{ margin: "0.25rem 0 0.5rem" }}>
                              Strategy:{" "}
                              <strong>
                                {t.reason.split(" · ")[0] || "—"}
                              </strong>
                              {getAtlasSession().inPrimeFx &&
                              t.symbol.startsWith("cry")
                                ? " · note: opened outside current prime-FX rule (now blocked)"
                                : ""}
                            </p>
                            <div className="atlas-open-pl">
                              <span>Right now you are</span>
                              <strong
                                className={uCash >= 0 ? "is-up" : "is-down"}
                              >
                                {uCash >= 0 ? "UP" : "DOWN"}{" "}
                                {uCash >= 0 ? "+" : ""}
                                {uCash.toFixed(2)} {displayCurrency}
                              </strong>
                              <em>
                                ({uR >= 0 ? "+" : ""}
                                {uR.toFixed(2)}R)
                              </em>
                            </div>
                            <p
                              className={`atlas-open-coach is-${t.side}`}
                              aria-live="polite"
                            >
                              {t.side === "sell" ? (
                                <>
                                  <strong>SELL</strong> — you win when candles
                                  go <em>down</em> (price under Entry toward
                                  Target). You lose if candles go{" "}
                                  <em>up</em> toward Stop.
                                </>
                              ) : (
                                <>
                                  <strong>BUY</strong> — you win when candles
                                  go <em>up</em> (price over Entry toward
                                  Target). You lose if candles go{" "}
                                  <em>down</em> toward Stop.
                                </>
                              )}
                            </p>
                            <p className="atlas-muted atlas-settle-help">
                              {t.paper === false
                                ? `Leave now sells the Deriv contract at live P/L (${uCash >= 0 ? "+" : ""}${uCash.toFixed(2)}). Stop/target also close on Deriv.`
                                : `Leave now → books the live number (${uCash >= 0 ? "+" : ""}${uCash.toFixed(2)} ${displayCurrency}). Take full loss → books your whole stake (−${riskCash.toFixed(2)}). Auto-stop at Stop still takes −${riskCash.toFixed(2)}.`}
                            </p>
                            <div className="atlas-open-grid">
                              <div>
                                <span>Stake at risk</span>
                                <strong>
                                  {riskCash.toFixed(2)}{" "}
                                  {t.currency ?? displayCurrency}
                                </strong>
                              </div>
                              <div>
                                <span>If target hits</span>
                                <strong className="is-up">
                                  +{targetCash.toFixed(2)}{" "}
                                  {t.currency ?? displayCurrency}
                                </strong>
                              </div>
                              <div>
                                <span>Entry</span>
                                <strong>{fmtPrice(t.entry, t.symbol)}</strong>
                              </div>
                              <div>
                                <span>Now</span>
                                <strong>{fmtPrice(price, t.symbol)}</strong>
                              </div>
                              <div>
                                <span>Stop</span>
                                <strong className="is-down">
                                  {fmtPrice(t.stop, t.symbol)}
                                </strong>
                              </div>
                              <div>
                                <span>Target</span>
                                <strong className="is-up">
                                  {fmtPrice(t.target, t.symbol)}
                                </strong>
                              </div>
                              <div>
                                <span>Position ~</span>
                                <strong>
                                  {notional.toFixed(0)}{" "}
                                  {t.currency ?? displayCurrency}
                                </strong>
                              </div>
                              <div>
                                <span>Progress</span>
                                <strong>
                                  {Math.min(100, prog.toTargetPct).toFixed(0)}%
                                </strong>
                              </div>
                            </div>
                            <div className="atlas-progress">
                              <div className="atlas-progress__bar">
                                <i
                                  style={{
                                    width: `${Math.min(
                                      100,
                                      Math.max(2, prog.toTargetPct),
                                    )}%`,
                                  }}
                                />
                              </div>
                            </div>
                            <div className="atlas-actions-row atlas-actions-row--settle">
                              <button
                                type="button"
                                className={`atlas-settle ${
                                  uCash >= 0
                                    ? "atlas-settle--win"
                                    : "atlas-settle--loss"
                                }`}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  void closeTradesAtMarket([t.id]);
                                }}
                              >
                                {uCash >= 0.005
                                  ? `Leave now · bank +${uCash.toFixed(2)}`
                                  : uCash <= -0.005
                                    ? `Leave now · lose ${Math.abs(uCash).toFixed(2)} only`
                                    : "Leave now · flat ±0.00"}
                              </button>
                              <button
                                type="button"
                                className="atlas-settle atlas-settle--loss"
                                onClick={() => settlePaper(t.id, "loss")}
                              >
                                {t.paper === false
                                  ? `Sell on Deriv (live P/L)`
                                  : `Take full stake loss (−${riskCash.toFixed(2)})`}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}
          </section>

          <section className="atlas-panel atlas-panel--chart">
            <div className="atlas-chart-head">
              <span className={`atlas-pill ${derivLive ? "atlas-pill--live" : "atlas-pill--off"}`}>
                {derivLive ? "Streaming" : "History"}
              </span>
              <span className="atlas-pill">EMA20 · EMA50</span>
              <span className="atlas-pill">Scroll to pan · wheel zoom</span>
            </div>
            {loading ? (
              <div className="atlas-empty">Syncing {instrument.name} from Deriv…</div>
            ) : error ? (
              <div className="atlas-empty atlas-empty--err">{error}</div>
            ) : (
              <AtlasChart
                bars={bars}
                mode={chartMode}
                trades={journal}
                symbol={symbol}
                theme={theme}
                openSide={
                  journal.find(
                    (t) => t.result === "open" && t.symbol === symbol,
                  )?.side ?? null
                }
                settlePopup={
                  settleBanner
                    ? {
                        kind: settleBanner.kind,
                        profit: settleBanner.profit,
                        currency: displayCurrency,
                        balance: settleBanner.balance,
                      }
                    : null
                }
              />
            )}
          </section>

          <section className="atlas-grid atlas-grid--desk">
            <div className="atlas-panel">
              <h3>Live indicators</h3>
              {indicators ? (
                <ul className="atlas-ind">
                  <li>
                    <span>EMA20</span>
                    <strong>{indicators.ema20.toFixed(5)}</strong>
                  </li>
                  <li>
                    <span>EMA50</span>
                    <strong>{indicators.ema50.toFixed(5)}</strong>
                  </li>
                  <li>
                    <span>SMA200</span>
                    <strong>
                      {indicators.sma200 != null
                        ? indicators.sma200.toFixed(5)
                        : "—"}
                    </strong>
                  </li>
                  <li>
                    <span>RSI</span>
                    <strong>{indicators.rsi14.toFixed(1)}</strong>
                  </li>
                  <li>
                    <span>MACD</span>
                    <strong>{indicators.macdHist.toFixed(5)}</strong>
                  </li>
                  <li>
                    <span>ATR</span>
                    <strong>{indicators.atr14.toFixed(5)}</strong>
                  </li>
                  <li>
                    <span>ADX</span>
                    <strong>{indicators.adx14.toFixed(1)}</strong>
                  </li>
                  <li>
                    <span>BB</span>
                    <strong>
                      {indicators.bbLower.toFixed(2)}–{indicators.bbUpper.toFixed(2)}
                    </strong>
                  </li>
                </ul>
              ) : (
                <p className="atlas-muted">Warming indicators on live tape…</p>
              )}
            </div>

            <div className="atlas-panel">
              <h3>{isLiveWallet ? "Deriv wallet" : "Demo account"}</h3>
              <p className="atlas-muted">
                {isLiveWallet
                  ? "Real money. Atlas buys MULTUP/MULTDOWN on your Deriv wallet. Switch back in Settings → Trading."
                  : "Practice ledger. Switch to Live in Settings → Trading (2FA) to use your real Deriv balance."}
              </p>
              <div className="atlas-demo-stats">
                <div>
                  <span>{isLiveWallet ? "Deriv balance" : "Cash balance"}</span>
                  <strong>
                    {walletBalance.toFixed(2)} {displayCurrency}
                  </strong>
                </div>
                <div>
                  <span>Equity (live)</span>
                  <strong>
                    {equityLive.toFixed(2)} {displayCurrency}
                  </strong>
                </div>
                <div>
                  <span>Available</span>
                  <strong className={freeMargin < walletBalance ? "is-down" : undefined}>
                    {freeMargin.toFixed(2)} {displayCurrency}
                  </strong>
                </div>
              </div>
              <p className="atlas-muted">
                Wallet mode follows Settings → Trading (
                {isLiveWallet ? "Live / real" : "Demo"}). Digits and Atlas share that switch.
              </p>
              <label className="atlas-check">
                <input
                  type="checkbox"
                  checked={risk.paused}
                  onChange={(e) =>
                    setRisk((r) => ({ ...r, paused: e.target.checked }))
                  }
                />
                Pause trading
              </label>
              <label className="atlas-field">
                Risk / trade %
                <input
                  type="number"
                  min={0.1}
                  max={5}
                  step={0.1}
                  value={risk.riskPerTradePct}
                  onChange={(e) =>
                    setRisk((r) => ({
                      ...r,
                      riskPerTradePct: Number(e.target.value) || 1,
                    }))
                  }
                />
              </label>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={resetDemo}
              >
                Reset demo + clear history
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={clearHistoryOnly}
              >
                Clear trading history
              </button>
              <p className="atlas-muted" style={{ margin: "0.35rem 0 0" }}>
                Wins/losses stay on this device after refresh. Only these
                buttons clear them.
              </p>
              <label className="atlas-field">
                Max trades / day
                <input
                  type="number"
                  min={10}
                  max={500}
                  step={10}
                  value={risk.maxDailyTrades}
                  onChange={(e) =>
                    setRisk((r) => ({
                      ...r,
                      maxDailyTrades: Math.max(
                        10,
                        Number(e.target.value) || 200,
                      ),
                    }))
                  }
                />
              </label>
              <label className="atlas-field">
                Daily loss limit %
                <input
                  type="number"
                  min={0.5}
                  max={20}
                  step={0.5}
                  value={risk.dailyLossLimitPct}
                  onChange={(e) =>
                    setRisk((r) => ({
                      ...r,
                      dailyLossLimitPct: Number(e.target.value) || 3,
                    }))
                  }
                />
              </label>
              {riskVerdict ? (
                <p className={riskVerdict.ok ? "atlas-ok" : "atlas-bad"}>
                  {riskVerdict.ok
                    ? `Risk OK · notional ~${riskVerdict.positionNotional.toFixed(2)} ${displayCurrency}`
                    : riskVerdict.reasons.join(" · ")}
                </p>
              ) : null}
              <div className="atlas-actions-row">
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setRisk({ ...DEFAULT_ATLAS_RISK })}
                >
                  Reset risk
                </button>
              </div>
            </div>

            <div className="atlas-panel">
              <h3>
                Backtest ·{" "}
                {ATLAS_STRATEGIES.find((s) => s.id === strategyId)?.name ??
                  strategyId}
              </h3>
              {backtest && backtest.trades > 0 ? (
                <>
                  <ul className="atlas-ind">
                    <li>
                      <span>Trades</span>
                      <strong>{backtest.trades}</strong>
                    </li>
                    <li>
                      <span>Win</span>
                      <strong
                        className={
                          backtest.winRate >= 45 ? "is-up" : "is-down"
                        }
                      >
                        {backtest.winRate.toFixed(1)}%
                      </strong>
                    </li>
                    <li>
                      <span>PF</span>
                      <strong
                        className={
                          backtest.profitFactor >= 1 ? "is-up" : "is-down"
                        }
                      >
                        {backtest.profitFactor.toFixed(2)}
                      </strong>
                    </li>
                    <li>
                      <span>Exp</span>
                      <strong
                        className={
                          backtest.expectancyR >= 0 ? "is-up" : "is-down"
                        }
                      >
                        {backtest.expectancyR.toFixed(3)}R
                      </strong>
                    </li>
                    <li>
                      <span>Total</span>
                      <strong>{backtest.totalR.toFixed(1)}R</strong>
                    </li>
                    <li>
                      <span>Max DD</span>
                      <strong>{backtest.maxDrawdownR.toFixed(1)}R</strong>
                    </li>
                    <li>
                      <span>Sharpe~</span>
                      <strong>{backtest.sharpeApprox.toFixed(2)}</strong>
                    </li>
                  </ul>
                  {backtest.expectancyR < 0 ? (
                    <p className="atlas-bad">
                      Negative expectancy on this window — Apex waits for
                      confluence; weak history does not force trades.
                    </p>
                  ) : (
                    <p className="atlas-ok">
                      Positive expectancy on this sample — still not a guarantee
                      forward.
                    </p>
                  )}
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={exportBacktestCsv}
                  >
                    Export CSV
                  </button>
                </>
              ) : (
                <p className="atlas-muted">
                  Apex is selective — few or no historical signals on this
                  window. That is intentional.
                </p>
              )}
            </div>
          </section>

          <section className="atlas-panel">
            <h3>Journal · saved on this device</h3>
            {journal.length === 0 ? (
              <p className="atlas-muted">
                No trades yet. Closed trades stay here after refresh (same as
                other hubs).
              </p>
            ) : (
              <>
                <p className="atlas-muted" style={{ marginTop: 0 }}>
                  {journal.filter((t) => t.result !== "open").length} closed ·{" "}
                  {stats.wins}W / {stats.losses}L · refresh keeps this list
                </p>
              <table className="atlas-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th>Entry</th>
                    <th>Result</th>
                    <th>P/L</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {journal.slice(0, 40).map((t) => {
                    const cash =
                      t.result === "open"
                        ? null
                        : Number.isFinite(t.pnlCash)
                          ? Number(t.pnlCash)
                          : 0;
                    return (
                      <tr key={t.id}>
                        <td>{new Date(t.at).toLocaleString()}</td>
                        <td>{t.symbol}</td>
                        <td>{t.side}</td>
                        <td>{t.entry.toFixed(5)}</td>
                        <td>
                          {t.result === "flat"
                            ? "closed"
                            : t.result}
                          {t.result !== "open"
                            ? ` ${t.pnlR >= 0 ? "+" : ""}${t.pnlR.toFixed(1)}R`
                            : ""}
                        </td>
                        <td
                          className={
                            cash == null
                              ? undefined
                              : cash > 0.004
                                ? "is-up"
                                : cash < -0.004
                                  ? "is-down"
                                  : undefined
                          }
                        >
                          {cash == null
                            ? "—"
                            : `${cash >= 0 ? "+" : ""}${cash.toFixed(2)} ${
                                t.currency ?? displayCurrency
                              }`}
                        </td>
                        <td>
                          {t.result === "open" ? (
                            <div className="atlas-actions-row atlas-actions-row--settle">
                              <button
                                type="button"
                                className="atlas-settle atlas-settle--win"
                                onClick={() => void closeTradesAtMarket([t.id])}
                              >
                                Bank / Close
                              </button>
                              <button
                                type="button"
                                className="atlas-settle atlas-settle--loss"
                                onClick={() => settlePaper(t.id, "loss")}
                              >
                                Full loss
                              </button>
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
