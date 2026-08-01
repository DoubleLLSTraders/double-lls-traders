import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { AppConfig } from "../lib/config";
import type { Tick } from "../lib/deriv/types";
import type { DerivClient } from "../lib/deriv/client";
import { buyDigitContractsBulk, waitForBasketOutcome } from "../lib/deriv/trade";
import type { MarketSignal } from "../lib/analysis/signal";
import { isArmedSignal } from "../lib/analysis/signal";
import type { BotSession, BotSettings, TradeJournalEntry } from "../lib/bot/types";
import { isAnalyzerGood } from "../lib/analysis/analyzerGate";
import { capStake, recoveryStake, stakeFromRisk } from "../lib/bot/gates";
import { liveSettingsForBalance, resolveLiveStake } from "../lib/bot/liveProfile";
import { appendTrade } from "../lib/bot/tradeStore";
import { playLossSound, playWinSound } from "../lib/sound";
import {
  DIFF_PAYOUT_MULTIPLIER,
  MATCH_PAYOUT_MULTIPLIER,
  computePerformance,
  isLowPayoutSymbol,
  profitRate,
  settleContractPnl,
  type PerformanceStats,
} from "../lib/bot/performance";

export type { BotSession };

export interface PaperBotState {
  log: string[];
  session: BotSession;
  performance: PerformanceStats;
  /** Latest skip / wait reason while hunting for an entry. */
  waitReason: string | null;
  /** Baskets settled since the current Start click. */
  runsThisStart: number;
  /** Session P/L accrued since the current Start click. */
  pnlThisStart: number;
  /** Live buy sent but not yet recorded as open. */
  orderPending: boolean;
  /** Open contract still settling — Stop is blocked until this clears. */
  settling: boolean;
}

function pushLog(lines: string[], line: string): string[] {
  return [line, ...lines].slice(0, 80);
}

function emptySession(stake: number): BotSession {
  return {
    trades: 0,
    wins: 0,
    losses: 0,
    pnl: 0,
    consecutiveLosses: 0,
    currentStake: stake,
    grossWins: 0,
    grossLosses: 0,
    peakPnl: 0,
    maxDrawdown: 0,
    lastCloseEpoch: null,
    lastEntryDigit: null,
    lastEntryEpoch: null,
    coolBarrierDigit: null,
    skipped: 0,
    openEpochs: [],
    journal: [],
    martingaleSteps: 0,
    open: null,
  };
}

function tradesLastHour(openEpochs: number[], nowEpoch: number): number {
  const cutoff = nowEpoch - 3600;
  return openEpochs.filter((epoch) => epoch >= cutoff).length;
}

export function usePaperBot(options: {
  running: boolean;
  settings: BotSettings;
  signal: MarketSignal;
  ticks: Tick[];
  config: AppConfig;
  currency: string;
  balance: number | null;
  symbol: string;
  client: DerivClient | null;
  /** Digits director locked — buy this digit on this tick. */
  analyzerBuyNow?: boolean;
  analyzerDigit?: number;
  analyzerSide?: MarketSignal["side"];
  onSettings: (next: Partial<BotSettings>) => void;
  onStop: (reason: string) => void;
  /**
   * Ask the UI to abandon this market and pick another. Fired when cold-gap
   * waits forever on a dead setup, or right after a Differs loss so we do not
   * keep re-asking the same index.
   */
  onSwitchMarket?: (reason: string) => void;
  /** Set true synchronously on Stop — blocks new entries before React re-renders. */
  haltRef?: MutableRefObject<boolean>;
  /**
   * Mid-run market analysis latch. While true the bot must not open — the
   * scanner is still ranking markets or the new feed has not finished loading.
   */
  switchHoldRef?: MutableRefObject<boolean>;
  isVirtual?: boolean;
  tradeNote?: string | null;
}): PaperBotState {
  const {
    running,
    settings,
    signal,
    ticks,
    config,
    currency,
    balance,
    symbol,
    client,
    analyzerBuyNow = false,
    analyzerDigit,
    analyzerSide,
    onSettings,
    onStop,
    onSwitchMarket,
    haltRef,
    switchHoldRef,
    tradeNote = null,
    isVirtual = true,
  } = options;
  const [log, setLog] = useState<string[]>([
    "Bot idle. Filters + risk stops manage behavior — digits stay near-fair.",
  ]);
  const [session, setSession] = useState<BotSession>(() => emptySession(settings.stake));
  const [waitReason, setWaitReason] = useState<string | null>(null);
  const [runsThisStart, setRunsThisStart] = useState(0);
  const [pnlThisStart, setPnlThisStart] = useState(0);
  const [orderPending, setOrderPending] = useState(false);
  /** Real result from Deriv for the open live basket. null won = read failed. */
  const [liveOutcome, setLiveOutcome] = useState<{
    entryEpoch: number;
    won: boolean | null;
    profit: number | null;
    exitDigit: number | null;
  } | null>(null);

  const settingsRef = useRef(settings);
  const signalRef = useRef(signal);
  const sessionRef = useRef(session);
  const balanceRef = useRef(balance);
  const clientRef = useRef(client);
  const handledEpoch = useRef<number | null>(null);
  const orderInFlight = useRef(false);
  /** Snapshot of session counters at the moment Start was pressed. */
  const runOriginRef = useRef<{ trades: number; pnl: number }>({ trades: 0, pnl: 0 });
  const runsThisStartRef = useRef(0);
  const pnlThisStartRef = useRef(0);
  /**
   * The caller passes these as inline arrows, so they get a new identity on
   * every render. Held in refs and kept out of the tick effect's dependencies,
   * because depending on them made that effect fire on every render.
   */
  const onSettingsRef = useRef(onSettings);
  const onStopRef = useRef(onStop);
  const onSwitchMarketRef = useRef(onSwitchMarket);
  const tradeNoteRef = useRef(tradeNote);
  const isVirtualRef = useRef(isVirtual);
  isVirtualRef.current = isVirtual;
  const runningRef = useRef(running);
  runningRef.current = running;
  /** Consecutive cold-gap / cool-barrier skips on the current market. */
  const stuckSkipsRef = useRef(0);
  const lastSwitchEpochRef = useRef(0);
  const symbolRef = useRef(symbol);
  const analyzerBuyNowRef = useRef(analyzerBuyNow);
  const analyzerDigitRef = useRef(analyzerDigit);
  const analyzerSideRef = useRef(analyzerSide);
  analyzerBuyNowRef.current = analyzerBuyNow;
  analyzerDigitRef.current = analyzerDigit;
  analyzerSideRef.current = analyzerSide;
  /**
   * After Start: skip the first Digits Trade now streak, buy on the second.
   * Keeps the desk synced instead of chasing a signal that was already live.
   */
  const syncPhaseRef = useRef<"await-first" | "skip-first" | "live">("await-first");

  const entriesBlocked = () =>
    !runningRef.current ||
    haltRef?.current === true ||
    switchHoldRef?.current === true;

  settingsRef.current = settings;
  signalRef.current = signal;
  sessionRef.current = session;
  balanceRef.current = balance;
  clientRef.current = client;
  onSettingsRef.current = onSettings;
  onStopRef.current = onStop;
  onSwitchMarketRef.current = onSwitchMarket;
  tradeNoteRef.current = tradeNote;

  // Fresh market: drop cooled barrier, stuck skips, and tick cursor so the
  // bot picks up the new stream without needing a page refresh.
  useEffect(() => {
    if (symbolRef.current === symbol) return;
    symbolRef.current = symbol;
    stuckSkipsRef.current = 0;
    handledEpoch.current = null;
    setSession((prev) => {
      if (prev.coolBarrierDigit === null) return prev;
      const next = { ...prev, coolBarrierDigit: null };
      sessionRef.current = next;
      return next;
    });
  }, [symbol]);

  const sizingSettings = (
    settings: BotSettings,
    balance: number | null,
  ): BotSettings => {
    if (config.mode !== "live" || balance === null) return settings;
    const resolved = resolveLiveStake(settings, balance, isVirtualRef.current);
    return {
      ...settings,
      stake: resolved.stake,
      maxExposurePercent: resolved.maxExposurePercent,
      maxStake: Math.max(settings.maxStake, resolved.stake),
    };
  };

  useEffect(() => {
    if (!running) {
      if (haltRef) haltRef.current = true;
      if (sessionRef.current.open) {
        setWaitReason(
          sessionRef.current.open.mode === "live"
            ? "Stopped · waiting for Deriv to settle open contract…"
            : "Stopped · settling open contract…",
        );
      } else if (!orderInFlight.current) {
        setWaitReason(null);
        setSession((prev) => ({
          ...prev,
          currentStake: stakeFromRisk(settings, balanceRef.current, settings.maxStake),
          martingaleSteps: 0,
        }));
        handledEpoch.current = null;
      }
      return;
    }

    if (haltRef) haltRef.current = false;

    // Every Start is its own session.
    // ladder left over from the previous run all go back to zero, so a stake
    // that escalated before Stop cannot carry into the next run. The permanent
    // record is unaffected: the Trades panel reads it from storage.
    const fresh = emptySession(
      stakeFromRisk(
        sizingSettings(settingsRef.current, balanceRef.current),
        balanceRef.current,
        settingsRef.current.maxStake,
      ),
    );
    sessionRef.current = fresh;
    setSession(fresh);

    runOriginRef.current = { trades: 0, pnl: 0 };
    runsThisStartRef.current = 0;
    pnlThisStartRef.current = 0;
    stuckSkipsRef.current = 0;
    lastSwitchEpochRef.current = 0;
    syncPhaseRef.current = "await-first";
    setRunsThisStart(0);
    setPnlThisStart(0);

    const modeLabel = config.mode === "live" ? "LIVE demo buy" : "Paper";
    const limits = [
      settings.takeProfit > 0 ? `TP +${settings.takeProfit}` : null,
      settings.stopLoss > 0 ? `SL −${settings.stopLoss}` : null,
      settings.maxRuns > 0 ? `${settings.maxRuns} runs` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    setLog((lines) =>
      pushLog(
        lines,
        `Started · ${modeLabel} · ${settings.side === "DIGITMATCH" ? "Matches" : "Differs"} · ${settings.contracts}× ${settings.stake.toFixed(2)} · sample≥${settings.minSample} · skip 1st Trade now${
          limits ? ` · ${limits}` : ""
        }`,
      ),
    );
    setWaitReason("Follow · sync · will skip first Trade now…");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  // Keep "next stake" in sync when the user edits base stake / risk while idle.
  useEffect(() => {
    if (running) return;
    setSession((prev) => {
      if (prev.open || prev.martingaleSteps > 0) return prev;
      const next = capStake(
        stakeFromRisk(
          sizingSettings(settings, balanceRef.current),
          balanceRef.current,
          settings.maxStake,
        ),
        sizingSettings(settings, balanceRef.current),
        balanceRef.current,
      );
      if (prev.currentStake === next) return prev;
      return { ...prev, currentStake: next };
    });
  }, [
    running,
    settings.stake,
    settings.maxStake,
    settings.riskPercent,
    settings.maxExposurePercent,
    settings.contracts,
    balance,
  ]);

  useEffect(() => {
    const latest = ticks[ticks.length - 1];
    const hasOpen = sessionRef.current.open !== null;

    if (!running && !hasOpen && !liveOutcome && !orderInFlight.current) return;
    if (!latest && !liveOutcome && !hasOpen) return;

    // An outcome with no basket left to apply it to is stale, usually a reply
    // that landed after Stop. It has to be dropped here: while it sits set,
    // the same-epoch guard below cannot short-circuit and this effect runs on
    // every render instead of once per tick.
    if (liveOutcome && !sessionRef.current.open) {
      setLiveOutcome(null);
      return;
    }

    // Same tick already processed — still continue when Digits flips to Trade now
    // (director can arm after the first pass of this epoch).
    const digitsBuyNow = analyzerBuyNowRef.current === true;
    if (
      latest &&
      handledEpoch.current === latest.epoch &&
      !liveOutcome &&
      !hasOpen &&
      !digitsBuyNow
    ) {
      return;
    }
    if (latest) handledEpoch.current = latest.epoch;

    let nextSettings = settingsRef.current;
    let nextSession = sessionRef.current;
    const liveSignal = signalRef.current;
    const liveBalance = balanceRef.current;

    if (config.mode === "live" && liveBalance !== null) {
      const livePatch = liveSettingsForBalance(
        nextSettings,
        liveBalance,
        isVirtualRef.current,
        { lockStake: runningRef.current },
      );
      if (livePatch) {
        nextSettings = { ...nextSettings, ...livePatch };
        onSettingsRef.current(livePatch);
        if (!runningRef.current) {
          setLog((lines) =>
            pushLog(
              lines,
              `Live · balance ${liveBalance.toFixed(2)} → stake ${nextSettings.stake.toFixed(2)} · cap ${nextSettings.maxExposurePercent}%`,
            ),
          );
        }
      }
    }

    if (nextSettings.autoFollow) {
      const patch: Partial<BotSettings> = {};
      if (liveSignal.digit !== nextSettings.prediction) {
        patch.prediction = liveSignal.digit;
      }
      if (liveSignal.side !== nextSettings.side) {
        patch.side = liveSignal.side;
      }
      if (Object.keys(patch).length > 0) {
        nextSettings = { ...nextSettings, ...patch };
        onSettingsRef.current(patch);
        setLog((lines) =>
          pushLog(
            lines,
            `Feed → ${liveSignal.label} (${liveSignal.confidence} · power ${liveSignal.power} · ${isArmedSignal(liveSignal) ? "armed" : "watch"})`,
          ),
        );
      }
    }

    if (nextSession.open) {
      if (!latest && nextSession.open.mode === "paper") return;
      setWaitReason(
        `Open · ${nextSession.open.side === "DIGITMATCH" ? "Matches" : "Differs"} ${nextSession.open.digit} · settling…`,
      );
      const open = nextSession.open;
      const settledOnTicks = () => {
        if (!latest) return null;
        const age = ticks.filter((tick) => tick.epoch > open.entryEpoch).length;
        if (age < open.settleAfter) return null;
        return open.side === "DIGITMATCH"
          ? latest.digit === open.digit
          : latest.digit !== open.digit;
      };

      let won: boolean;
      let realised: number | undefined;
      // The tick the contract was judged on. Live trades take it from Deriv;
      // the newest local tick is a different tick by the time the reply lands,
      // which is why the ledger used to show losses on non-barrier digits.
      let settleDigit: number | null = null;

      if (open.mode === "live") {
        // Deriv is the only reliable source: the contract starts on the tick it
        // picks when the order lands, not on the last tick this client saw.
        if (!liveOutcome) return;
        if (liveOutcome.entryEpoch !== open.entryEpoch) {
          // Belongs to an older basket; drop it so the guard above re-arms.
          setLiveOutcome(null);
          return;
        }
        if (liveOutcome.won === null) {
          setWaitReason("Open · waiting for Deriv settlement…");
          return;
        }
        won = liveOutcome.won;
        realised = liveOutcome.profit ?? undefined;
        settleDigit = liveOutcome.exitDigit;
        setLiveOutcome(null);
      } else {
        const guess = settledOnTicks();
        if (guess === null) return;
        won = guess;
        settleDigit = latest?.digit ?? null;
      }

      const exposure = open.stake * open.contracts;
      const payout =
        realised ?? settleContractPnl(exposure, won, open.side, open.payout);
      const consecutiveLosses = won ? 0 : nextSession.consecutiveLosses + 1;
      let currentStake = stakeFromRisk(nextSettings, liveBalance, nextSettings.maxStake);
      let martingaleSteps = 0;

      if (!won && nextSettings.martingale) {
        const cap = Math.max(
          1,
          nextSettings.maxMartingaleSteps || nextSettings.maxConsecutiveLosses,
        );
        const nextStep = nextSession.martingaleSteps + 1;
        const deficit = Math.abs(Math.min(0, nextSession.pnl + payout));
        const plan = recoveryStake(
          deficit,
          nextSettings.side,
          nextSettings.contracts,
          nextSettings.stake,
          nextSettings.maxStake,
        );
        // Room left before the next basket would trip the daily loss cap.
        const budget = nextSettings.dailyLossLimit - deficit;

        const reset = (why: string) => {
          martingaleSteps = 0;
          currentStake = stakeFromRisk(nextSettings, liveBalance, nextSettings.maxStake);
          setLog((lines) => pushLog(lines, `Martingale reset · ${why}`));
        };

        if (nextStep > cap) {
          reset("step cap hit");
        } else if (!plan.enough) {
          reset(
            `${nextSettings.side === "DIGITMATCH" ? "Matches" : "Differs"} needs ${(
              plan.exposure > 0 ? deficit / profitRate(nextSettings.side) : 0
            ).toFixed(2)} exposure · over max stake`,
          );
        } else if (plan.exposure > budget) {
          reset(`recovery ${plan.exposure.toFixed(2)} > daily room ${budget.toFixed(2)}`);
        } else {
          martingaleSteps = nextStep;
          currentStake = plan.stake;
          setLog((lines) =>
            pushLog(
              lines,
              `Recover step ${nextStep} · ${plan.stake} × ${nextSettings.contracts} = ${plan.exposure} to clear ${deficit.toFixed(2)}`,
            ),
          );
        }
      }

      // The ladder above sizes for recovery; this puts the account first.
      currentStake = capStake(currentStake, nextSettings, liveBalance);

      const pnl = nextSession.pnl + payout;
      const peakPnl = Math.max(nextSession.peakPnl, pnl);
      const maxDrawdown = Math.max(nextSession.maxDrawdown, peakPnl - pnl);

      const entry: TradeJournalEntry = {
        id: `${open.entryEpoch}-${nextSession.trades + 1}`,
        at: latest?.epoch ?? open.entryEpoch,
        side: open.side,
        digit: open.digit,
        stake: open.stake,
        contracts: open.contracts,
        won,
        pnl: payout,
        settleDigit,
        mode: open.mode,
        contractId: open.contractId,
        note: open.note || tradeNoteRef.current || undefined,
      };

      nextSession = {
        trades: nextSession.trades + 1,
        wins: nextSession.wins + (won ? 1 : 0),
        losses: nextSession.losses + (won ? 0 : 1),
        pnl,
        consecutiveLosses,
        currentStake,
        grossWins: nextSession.grossWins + (won ? payout : 0),
        grossLosses: nextSession.grossLosses + (won ? 0 : Math.abs(payout)),
        peakPnl,
        maxDrawdown,
        lastCloseEpoch: latest.epoch,
        // Keep the barrier after a Differs win: that digit never printed, so
        // re-backing it is the same unresolved bet. Deep analysis needs this.
        lastEntryDigit: nextSession.lastEntryDigit,
        lastEntryEpoch: nextSession.lastEntryEpoch,
        coolBarrierDigit:
          !won && open.side === "DIGITDIFF"
            ? open.digit
            : won && open.side === "DIGITDIFF"
              ? null
              : nextSession.coolBarrierDigit,
        skipped: nextSession.skipped,
        openEpochs: nextSession.openEpochs,
        journal: [entry, ...nextSession.journal].slice(0, 100),
        martingaleSteps,
        open: null,
      };
      setSession(nextSession);
      appendTrade({ ...entry, symbol, currency });

      const runsDone = nextSession.trades - runOriginRef.current.trades;
      const runPnl = nextSession.pnl - runOriginRef.current.pnl;
      runsThisStartRef.current = runsDone;
      pnlThisStartRef.current = runPnl;
      setRunsThisStart(runsDone);
      setPnlThisStart(runPnl);

      if (won) playWinSound();
      else playLossSound();

      setLog((lines) =>
        pushLog(
          lines,
          `${won ? "WIN" : "LOSS"} · ${settleDigit ?? "?"} · ${payout >= 0 ? "+" : ""}${payout.toFixed(2)} · run ${runsDone}${
            nextSettings.maxRuns > 0 ? `/${nextSettings.maxRuns}` : ""
          } · run P/L ${runPnl >= 0 ? "+" : ""}${runPnl.toFixed(2)}`,
        ),
      );

      // A loss is itself doubt — stop now.
      if (!won) {
        onStopRef.current("Stopped · loss · will not risk the next trade.");
        setLog((lines) =>
          pushLog(lines, "STOPPED · loss · session closed regardless of take-profit / runs"),
        );
        return;
      }

      // Bot form owns the flow: Number of runs → Take profit / Stop loss.
      if (nextSettings.maxRuns > 0 && runsDone >= nextSettings.maxRuns) {
        onStopRef.current(
          `Stopped · ${runsDone}/${nextSettings.maxRuns} runs complete.`,
        );
        setLog((lines) =>
          pushLog(
            lines,
            `STOPPED · ${runsDone}/${nextSettings.maxRuns} runs complete · P/L ${
              runPnl >= 0 ? "+" : ""
            }${runPnl.toFixed(2)} ${currency}`,
          ),
        );
        return;
      }
      if (nextSettings.takeProfit > 0 && runPnl >= nextSettings.takeProfit) {
        onStopRef.current("Take profit hit.");
        setLog((lines) =>
          pushLog(
            lines,
            `STOPPED · take profit ${runPnl.toFixed(2)} ≥ ${nextSettings.takeProfit} ${currency}`,
          ),
        );
        return;
      }
      if (nextSettings.stopLoss > 0 && runPnl <= -nextSettings.stopLoss) {
        onStopRef.current("Stop loss hit.");
        setLog((lines) =>
          pushLog(
            lines,
            `STOPPED · stop loss ${runPnl.toFixed(2)} ≤ -${nextSettings.stopLoss} ${currency}`,
          ),
        );
        return;
      }
      if (pnl <= -nextSettings.dailyLossLimit) {
        onStopRef.current("Daily loss cap.");
        setLog((lines) => pushLog(lines, "STOPPED · daily loss cap"));
        return;
      }
      if (
        nextSettings.takeProfit <= 0 &&
        pnl >= nextSettings.dailyProfitTarget
      ) {
        onStopRef.current("Profit target.");
        setLog((lines) => pushLog(lines, "STOPPED · profit target"));
        return;
      }
      if (nextSession.trades >= nextSettings.maxTradesPerDay) {
        onStopRef.current("Max trades / day.");
        setLog((lines) => pushLog(lines, "STOPPED · max trades / day"));
        return;
      }

      // More runs left — keep hunting Digits Good (form Number of runs).
      const runsLeft =
        nextSettings.maxRuns > 0
          ? `${runsDone}/${nextSettings.maxRuns}`
          : `${runsDone}`;
      setWaitReason(`Run ${runsLeft} won · hunting next Good…`);
      setLog((lines) =>
        pushLog(
          lines,
          `NEXT · run ${runsLeft} done · continuing for remaining runs`,
        ),
      );
      sessionRef.current = nextSession;
      return;
    }

    if (!nextSession.open) {
      if (switchHoldRef?.current) {
        setWaitReason("Analyzing markets before next trade…");
        return;
      }
      if (entriesBlocked()) return;
      if (orderInFlight.current) return;

      if (
        nextSession.lastCloseEpoch !== null &&
        latest.epoch - nextSession.lastCloseEpoch < nextSettings.cooldownTicks
      ) {
        return;
      }

      const runsDone = nextSession.trades - runOriginRef.current.trades;
      const runPnl = nextSession.pnl - runOriginRef.current.pnl;
      if (nextSettings.maxRuns > 0 && runsDone >= nextSettings.maxRuns) {
        onStopRef.current("Run count reached.");
        setLog((lines) =>
          pushLog(
            lines,
            `STOPPED · ${runsDone}/${nextSettings.maxRuns} runs complete`,
          ),
        );
        return;
      }
      if (nextSettings.takeProfit > 0 && runPnl >= nextSettings.takeProfit) {
        onStopRef.current("Take profit hit.");
        setLog((lines) =>
          pushLog(
            lines,
            `STOPPED · take profit ${runPnl.toFixed(2)} ≥ ${nextSettings.takeProfit} ${currency}`,
          ),
        );
        return;
      }
      if (nextSettings.stopLoss > 0 && runPnl <= -nextSettings.stopLoss) {
        onStopRef.current("Stop loss hit.");
        return;
      }

      const hourCount = tradesLastHour(nextSession.openEpochs, latest.epoch);
      const runsDoneNow = nextSession.trades - runOriginRef.current.trades;

      // Pure follower: Digits Trade now owns digit/side — no desk research.
      const followDigit = analyzerDigitRef.current ?? liveSignal.digit;
      const followSide = analyzerSideRef.current ?? liveSignal.side;
      const buyNow = analyzerBuyNowRef.current === true;
      const sideLabel =
        followSide === "DIGITMATCH" ? "Matches" : "Differs";

      // Start sync: ignore the first Trade now streak; buy on the next one.
      if (syncPhaseRef.current === "await-first") {
        if (buyNow) {
          syncPhaseRef.current = "skip-first";
          setWaitReason(
            `Follow · sync · skip 1st Trade now · ${sideLabel} ${followDigit}`,
          );
          setLog((lines) =>
            pushLog(
              lines,
              `SYNC · skip first Trade now · ${sideLabel} ${followDigit} · wait next`,
            ),
          );
          return;
        }
        setWaitReason(
          `Follow · sync · waiting first Trade now · ${sideLabel} ${followDigit}`,
        );
        return;
      }
      if (syncPhaseRef.current === "skip-first") {
        if (!buyNow) {
          syncPhaseRef.current = "live";
          setWaitReason(
            `Follow · synced · waiting next Trade now · ${sideLabel} ${followDigit}`,
          );
          setLog((lines) =>
            pushLog(lines, "SYNC · first Trade now cleared · next one buys"),
          );
          return;
        }
        setWaitReason(
          `Follow · sync · skip 1st Trade now · ${sideLabel} ${followDigit}`,
        );
        return;
      }

      if (!buyNow) {
        nextSession = { ...nextSession, skipped: nextSession.skipped + 1 };
        setSession(nextSession);
        setWaitReason(
          `Follow · waiting Digits Trade now · ${sideLabel} ${followDigit}`,
        );
        if (!isAnalyzerGood(liveSignal, nextSettings)) {
          stuckSkipsRef.current += 1;
          if (stuckSkipsRef.current >= 20 && onSwitchMarketRef.current) {
            stuckSkipsRef.current = 0;
            setWaitReason("Analyzer · tape dead · next market…");
            setLog((lines) =>
              pushLog(lines, "ROTATE · analyzer hunting better market"),
            );
            onSwitchMarketRef.current("Hunting · next volatility");
          }
        } else {
          stuckSkipsRef.current = 0;
        }
        return;
      }

      // Run / money stops only — never re-back waits or deep research.
      if (nextSettings.maxRuns > 0 && runsDoneNow >= nextSettings.maxRuns) {
        onStopRef.current(
          `Stopped · ${runsDoneNow}/${nextSettings.maxRuns} runs complete.`,
        );
        return;
      }
      if (
        nextSettings.maxTradesPerHour > 0 &&
        hourCount >= nextSettings.maxTradesPerHour
      ) {
        setWaitReason(`Skip · max ${nextSettings.maxTradesPerHour} trades/hour`);
        return;
      }
      if (isLowPayoutSymbol(symbol)) {
        onSwitchMarketRef.current?.("Low payout · next volatility");
        return;
      }
      // Same tick the barrier prints — Digits drops Trade now; do not buy late.
      if (followSide === "DIGITDIFF" && latest.digit === followDigit) {
        setWaitReason(`Follow · Digits reset · ${followDigit} printed`);
        return;
      }

      stuckSkipsRef.current = 0;

      setWaitReason(
        `Opening · Digits Trade now · ${followSide === "DIGITMATCH" ? "Matches" : "Differs"} ${followDigit}`,
      );

      if (entriesBlocked()) {
        setWaitReason("Stopped · no new entries");
        return;
      }

      const sized = sizingSettings(nextSettings, liveBalance);
      const baseStake = stakeFromRisk(sized, liveBalance, sized.maxStake);
      // Applied last so it overrides both the base sizing and any martingale
      // rung: the ceiling is the one number a losing streak cannot argue with.
      const stake = capStake(
        nextSession.martingaleSteps > 0 ? nextSession.currentStake : baseStake,
        sized,
        liveBalance,
      );
      const mode = config.mode === "live" ? "live" : "paper";
      // Exact Digits lock — realtime follow, no second guess.
      const side = followSide;
      const digit = followDigit;
      const contracts = nextSettings.contracts;
      const duration = nextSettings.duration;
      const entryEpoch = latest.epoch;

      const applyOpen = (
        contractId?: number,
        filledCount = contracts,
        payout?: number,
        contractIds?: number[],
      ) => {
        const risked = stake * filledCount;
        const upside =
          payout !== undefined
            ? payout - risked
            : risked *
              ((side === "DIGITMATCH" ? MATCH_PAYOUT_MULTIPLIER : DIFF_PAYOUT_MULTIPLIER) - 1);
        setSession((prev) => {
          if (prev.open) return prev;
          const open = {
            side,
            digit,
            stake,
            contracts: filledCount,
            entryEpoch,
            settleAfter: duration,
            mode: mode as "paper" | "live",
            contractId,
            contractIds,
            payout,
            note: tradeNoteRef.current || undefined,
          };
          const updated: BotSession = {
            ...prev,
            open,
            openEpochs: [...prev.openEpochs, entryEpoch].slice(-200),
            lastEntryDigit: digit,
            lastEntryEpoch: entryEpoch,
            currentStake: stake,
          };
          sessionRef.current = updated;
          return updated;
        });
        setLog((lines) =>
          pushLog(
            lines,
            `OPEN ${mode === "live" ? "LIVE " : ""}${side === "DIGITMATCH" ? "Matches" : "Differs"} ${digit} · ${filledCount}× ${stake} ${currency} · risk ${risked.toFixed(
              2,
            )} / win +${upside.toFixed(2)}${
              filledCount > 1
                ? nextSettings.parallelExecution && mode === "live"
                  ? " · bulk parallel"
                  : " · bulk"
                : ""
            }${contractId ? ` · #${contractId}` : ""}`,
          ),
        );
      };

      if (mode === "live") {
        const liveClient = clientRef.current;
        if (!liveClient || liveClient.getState() !== "ready") {
          setLog((lines) => pushLog(lines, "Skip · live buy needs ready Deriv socket"));
          return;
        }
        if (entriesBlocked()) return;
        orderInFlight.current = true;
        setOrderPending(true);
        const order = {
          symbol,
          side,
          digit,
          stake,
          currency,
          duration,
        };

        // Bulk always means `contracts` separate contracts at the bot's stake —
        // the parallel switch only decides whether they fire together.
        if (contracts > 1 && !nextSettings.parallelExecution) {
          // The basket is settled off one tick, so legs that slip past the
          // entry tick are scored against a digit they did not actually run on.
          setLog((lines) =>
            pushLog(lines, `Bulk sequential · ${contracts} legs may span ticks`),
          );
        }

        void buyDigitContractsBulk(liveClient, order, contracts, {
          parallel: nextSettings.parallelExecution,
        })
          .then(async (bulk) => {
            if (bulk.filled.length === 0 && nextSettings.parallelExecution && contracts > 1) {
              setLog((lines) =>
                pushLog(
                  lines,
                  `Bulk refused (${bulk.reasons[0] ?? "unknown"}) · retrying one by one`,
                ),
              );
              return buyDigitContractsBulk(liveClient, order, contracts, {
                parallel: false,
              });
            }
            return bulk;
          })
          .then(({ filled, failed, reasons }) => {
            if (filled.length === 0) {
              throw new Error(reasons[0] ?? `all ${contracts} contracts refused`);
            }
            if (failed > 0) {
              setLog((lines) =>
                pushLog(
                  lines,
                  `PARTIAL · ${filled.length}/${contracts} filled · ${reasons[0] ?? ""}`,
                ),
              );
            }
            return {
              contractId: filled[0].contractId,
              contractIds: filled.map((leg) => leg.contractId),
              filledCount: filled.length,
              payout: filled.reduce((sum, leg) => sum + leg.payout, 0),
            };
          })
          .then(({ contractId, contractIds, filledCount, payout }) => {
            orderInFlight.current = false;
            setOrderPending(false);
            applyOpen(contractId, filledCount, payout, contractIds);

            const settleOpen = (liveClient: DerivClient, ids: number[]) => {
              void waitForBasketOutcome(liveClient, ids)
                .then(({ won, profit, exitDigit }) =>
                  setLiveOutcome({ entryEpoch, won, profit, exitDigit }),
                )
                .catch((error: unknown) => {
                  const why = error instanceof Error ? error.message : String(error);
                  setLog((lines) =>
                    pushLog(lines, `Settle read failed (${why}) · retrying from Deriv…`),
                  );
                  void waitForBasketOutcome(liveClient, ids)
                    .then(({ won, profit, exitDigit }) =>
                      setLiveOutcome({ entryEpoch, won, profit, exitDigit }),
                    )
                    .catch((retryError: unknown) => {
                      const retryWhy =
                        retryError instanceof Error ? retryError.message : String(retryError);
                      setLog((lines) =>
                        pushLog(
                          lines,
                          `Settle still unreadable (${retryWhy}) · check Deriv dashboard for open contract`,
                        ),
                      );
                      setWaitReason(
                        `Settle pending on Deriv · contract #${ids[0] ?? "?"} · do not switch account`,
                      );
                    });
                });
            };
            settleOpen(liveClient, contractIds);
          })
          .catch((error: unknown) => {
            orderInFlight.current = false;
            setOrderPending(false);
            const message = error instanceof Error ? error.message : String(error);
            setLog((lines) => pushLog(lines, `BUY FAIL · ${message}`));
            setWaitReason(`Buy rejected · ${message}`);
          });
        return;
      }

      if (entriesBlocked()) return;

      applyOpen();
    }
    // analyzerBuyNow must be a dep: Digits Trade now often arms on the same
    // tick after the first effect pass — without it the desk stays on "waiting".
    // onSettings/onStop are intentionally absent: they are read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    running,
    ticks,
    liveOutcome,
    currency,
    config,
    symbol,
    analyzerBuyNow,
    analyzerDigit,
    analyzerSide,
  ]);

  const performance = computePerformance({
    ...session,
    payoutMultiplier:
      settings.side === "DIGITMATCH" ? MATCH_PAYOUT_MULTIPLIER : DIFF_PAYOUT_MULTIPLIER,
  });

  return {
    log,
    session,
    performance,
    waitReason,
    runsThisStart,
    pnlThisStart,
    orderPending,
    settling: session.open !== null || orderPending,
  };
}
