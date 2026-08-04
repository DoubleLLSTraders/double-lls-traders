import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { flushSync } from "react-dom";
import type { AppConfig } from "../lib/config";
import type { Tick } from "../lib/deriv/types";
import type { DerivClient } from "../lib/deriv/client";
import { buyDigitContractsBulk, waitForBasketOutcome } from "../lib/deriv/trade";
import type { MarketSignal } from "../lib/analysis/signal";
import { isOverUnderSide } from "../lib/analysis/contractSide";
import {
  contractWon,
  isArmedSignal,
  sideLabel,
} from "../lib/analysis/signal";
import type { BotSession, BotSettings, TradeJournalEntry } from "../lib/bot/types";
import { resolveAnalyzerPace } from "../lib/analysis/analyzerDirector";
import { capStake, MIN_STAKE, recoveryStake, stakeFromRisk } from "../lib/bot/gates";
import { liveSettingsForBalance, resolveLiveStake } from "../lib/bot/liveProfile";
import { appendTrade } from "../lib/bot/tradeStore";
import { playLossSound, playWinSound } from "../lib/sound";
import { isClientRole } from "../lib/appRole";
import { hasOauthSession } from "../lib/deriv/oauth";
import {
  computePerformance,
  isLowPayoutSymbol,
  payoutMultiplier,
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
  /**
   * Wall-clock end for Custom / timed sessions (ms since epoch).
   * 0 = no timer (Quick / TP mode).
   */
  sessionEndAtMs: number;
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
  /**
   * Same-tick snap from App director advance — beats React state lag so the
   * desk fires on the confirm tick, not the next frame / next tick.
   */
  analyzerSnapRef?: MutableRefObject<{
    buyNow: boolean;
    digit: number;
    side: MarketSignal["side"];
    /** Epoch when Digits last armed Trade now — same-tick fire key. */
    armedEpoch: number | null;
    /** Live analyzer phase label (Locking / Confirming / Trade now…). */
    label: string;
    detail: string;
    /** OU elite momentum gap when Digits arms Trade now. */
    entryGap?: number | null;
  }>;
  /** Increments when Digits arms Trade now — forces same-turn layout fire. */
  tradeNowWake?: number;
  /**
   * App calls this the microsecond Digits arms Trade now — runs desk tick
   * without waiting for another React frame.
   */
  executorFireRef?: MutableRefObject<(() => void) | null>;
  /**
   * Set true when the desk refuses an armed Trade now (skip-first, cool,
   * wait-drop). App clears the Digits arm so UI does not stay on Trade now
   * / In trade while nothing is bought.
   */
  executorArmCancelRef?: MutableRefObject<boolean>;
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
    analyzerSnapRef,
    tradeNowWake = 0,
    executorFireRef,
    executorArmCancelRef,
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
  const [sessionEndAtMs, setSessionEndAtMs] = useState(0);
  const [orderPending, setOrderPending] = useState(false);
  /** Real result from Deriv for the open live basket. null won = read failed. */
  const [liveOutcome, setLiveOutcome] = useState<{
    /** Buy/order epoch used to match the open basket. */
    entryEpoch: number;
    won: boolean | null;
    profit: number | null;
    exitDigit: number | null;
    exitEpoch?: number | null;
    derivEntryEpoch?: number | null;
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
  /** Wall-clock end for timed hour sessions (0 = off). */
  const sessionEndAtMsRef = useRef(0);
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
  // Prefer same-tick director snap — props lag one commit after confirm.
  const snap = analyzerSnapRef?.current;
  if (snap) {
    analyzerBuyNowRef.current = snap.buyNow;
    analyzerDigitRef.current = snap.digit;
    analyzerSideRef.current = snap.side;
  } else {
    analyzerBuyNowRef.current = analyzerBuyNow;
    analyzerDigitRef.current = analyzerDigit;
    analyzerSideRef.current = analyzerSide;
  }
  /** Wall-clock cool-down after a loss — no buys until this clears. */
  const coolUntilMsRef = useRef(0);
  /** Prevent double-fire (layout wake + tick) on the same entry epoch. */
  const firedBuyEpochRef = useRef<number | null>(null);
  /** Latest desk tick runner — App fires this on Trade now rising edge. */
  const deskTickRef = useRef<() => void>(() => {});

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
    // Cap exposure only — never rewrite the Base stake from the form.
    const resolved = resolveLiveStake(settings, balance, isVirtualRef.current);
    return {
      ...settings,
      stake: Math.max(MIN_STAKE, settings.stake),
      maxExposurePercent: resolved.maxExposurePercent,
      maxStake: Math.max(settings.maxStake, settings.stake),
    };
  };

  // Layout: halt / start session bookkeeping before the desk-tick buy layout.
  useLayoutEffect(() => {
    if (!running) {
      if (haltRef) haltRef.current = true;
      sessionEndAtMsRef.current = 0;
      setSessionEndAtMs(0);
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
    firedBuyEpochRef.current = null;
    coolUntilMsRef.current = 0;
    const hours = settings.sessionHours ?? 0;
    const endAt =
      hours > 0 ? Date.now() + Math.round(hours * 3_600_000) : 0;
    sessionEndAtMsRef.current = endAt;
    setSessionEndAtMs(endAt);
    setRunsThisStart(0);
    setPnlThisStart(0);

    const modeLabel = config.mode === "live" ? "LIVE demo buy" : "Paper";
    const limits = [
      hours > 0
        ? `${hours}h timed · stake ${settings.stake.toFixed(2)}/trade · TP does not stop`
        : null,
      hours <= 0 && settings.takeProfit > 0
        ? `TP +${settings.takeProfit}`
        : hours > 0 && settings.takeProfit > 0
          ? `TP +${settings.takeProfit} comfort only`
          : null,
      settings.stopLoss > 0 ? `SL −${settings.stopLoss}` : null,
      settings.maxRuns > 0 ? `${settings.maxRuns} runs` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    setLog((lines) =>
      pushLog(
        lines,
        `Started · ${modeLabel} · ${sideLabel(settings.side)} · ${settings.contracts}× ${settings.stake.toFixed(2)} · sample≥${settings.minSample} · buy on Trade now${limits ? ` · ${limits}` : ""}`,
      ),
    );
    setWaitReason(
      "Follow · live · wait analyzer Trade now…",
    );
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

  // useLayoutEffect: fire buy before paint so Trade now and executor share one turn.
  useLayoutEffect(() => {
    const deskTick = () => {
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
        // Form owns Base stake on demo and real — never auto-patch it.
        { lockStake: true },
      );
      if (livePatch) {
        nextSettings = { ...nextSettings, ...livePatch };
        onSettingsRef.current(livePatch);
        if (!runningRef.current) {
          setLog((lines) =>
            pushLog(
              lines,
              `Live · balance ${liveBalance.toFixed(2)} · stake ${nextSettings.stake.toFixed(2)} kept · cap ${nextSettings.maxExposurePercent}%`,
            ),
          );
        }
      }
    }

    if (nextSettings.autoFollow) {
      const patch: Partial<BotSettings> = {};
      const snapFollow = analyzerSnapRef?.current;
      // Over/Under: Digits director owns the barrier. Never yank prediction
      // from a jumping live signal during Trade now / lock (that deceived buys).
      const ouFromDigits =
        snapFollow &&
        (isOverUnderSide(snapFollow.side) ||
          isOverUnderSide(nextSettings.side));
      if (ouFromDigits && snapFollow) {
        if (snapFollow.digit !== nextSettings.prediction) {
          patch.prediction = snapFollow.digit;
        }
        if (
          nextSettings.autoSide &&
          snapFollow.side !== nextSettings.side
        ) {
          patch.side = snapFollow.side;
        }
      } else {
        if (liveSignal.digit !== nextSettings.prediction) {
          patch.prediction = liveSignal.digit;
        }
        if (
          nextSettings.autoSide &&
          liveSignal.side !== nextSettings.side
        ) {
          patch.side = liveSignal.side;
        }
      }
      if (Object.keys(patch).length > 0) {
        nextSettings = { ...nextSettings, ...patch };
        onSettingsRef.current(patch);
        const src = ouFromDigits && snapFollow ? snapFollow : liveSignal;
        const srcSide = "side" in src ? src.side : liveSignal.side;
        const srcDigit = "digit" in src ? src.digit : liveSignal.digit;
        setLog((lines) =>
          pushLog(
            lines,
            `Feed → ${sideLabel(srcSide)} ${srcDigit} (${liveSignal.confidence} · power ${liveSignal.power} · ${isArmedSignal(liveSignal) ? "armed" : "watch"})`,
          ),
        );
      }
    }

    if (nextSession.open) {
      if (!latest && nextSession.open.mode === "paper") return;
      setWaitReason(
        `In trade · ${sideLabel(nextSession.open.side)} ${nextSession.open.digit} · waiting result…`,
      );
      const open = nextSession.open;

      const settledOnTicks = () => {
        if (!latest) return null;
        // Duration-1: result is the tick immediately after Trade now / buy.
        const need = Math.max(1, open.settleAfter || 1);
        const after = ticks.filter((tick) => tick.epoch > open.entryEpoch);
        if (after.length < need) return null;
        const settleTick = after[need - 1] ?? latest;
        return {
          won: contractWon(open.side, open.digit, settleTick.digit),
          settleEpoch: settleTick.epoch,
          settleDigit: settleTick.digit,
        };
      };

      let won: boolean;
      let realised: number | undefined;
      let settleDigit: number | null = null;
      let settleEpoch: number | null = null;

      if (open.mode === "live") {
        const orderEpoch = open.orderEpoch ?? open.entryEpoch;
        const outcome =
          liveOutcome && liveOutcome.entryEpoch === orderEpoch
            ? liveOutcome
            : null;
        const local = settledOnTicks();

        if (outcome && outcome.won === null) {
          setWaitReason("Open · waiting for Deriv settlement…");
          return;
        }

        if (outcome && outcome.won !== null) {
          won = outcome.won;
          realised = outcome.profit ?? undefined;
          settleDigit = outcome.exitDigit;
          // W/L on the next tick after E (Trade now tick) — never shift E forward.
          const afterEntry = ticks.find((t) => t.epoch > open.entryEpoch);
          settleEpoch =
            local?.settleEpoch ??
            afterEntry?.epoch ??
            outcome.exitEpoch ??
            latest?.epoch ??
            open.entryEpoch;
          setLiveOutcome(null);
        } else if (local) {
          won = local.won;
          settleDigit = local.settleDigit;
          settleEpoch = local.settleEpoch;
        } else {
          if (liveOutcome && liveOutcome.entryEpoch !== orderEpoch) {
            setLiveOutcome(null);
          }
          return;
        }
      } else {
        const guess = settledOnTicks();
        if (guess === null) return;
        won = guess.won;
        settleDigit = guess.settleDigit;
        settleEpoch = guess.settleEpoch;
      }

      const exposure = open.stake * open.contracts;
      const payout =
        realised ??
        settleContractPnl(exposure, won, open.side, open.payout, open.digit);
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
            `${sideLabel(nextSettings.side)} needs ${(
              plan.exposure > 0
                ? deficit / profitRate(nextSettings.side, open.digit)
                : 0
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
        at: settleEpoch ?? latest?.epoch ?? open.entryEpoch,
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
        entryAt: open.entryEpoch,
        entrySpot: open.entrySpot,
        entryGap: open.entryGap,
        entryPercent: open.entryPercent,
        entryPower: open.entryPower,
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

      // Loss → short cool, then the session limits below still apply. This
      // must NOT return early: run count, stop loss and the daily caps are
      // checked further down, and a loss is exactly when they matter.
      if (!won) {
        const pace = resolveAnalyzerPace(nextSettings.analyzerPace);
        const ouDesk =
          nextSettings.analyzerPace === "overunder-firm" ||
          nextSettings.side === "DIGITOVER" ||
          nextSettings.side === "DIGITUNDER";
        // O/U Shield: ~1s cool so many runs stay in the clock; other desks keep pace.
        const lossCoolMs = ouDesk
          ? Math.min(pace.lossCoolMs, 1_200)
          : pace.lossCoolMs;
        coolUntilMsRef.current = Date.now() + lossCoolMs;
        setWaitReason(
          `Follow · cool ${Math.round(lossCoolMs / 1000)}s · then wait analyzer…`,
        );
        setLog((lines) =>
          pushLog(
            lines,
            `COOL · loss · pause ${Math.round(lossCoolMs / 1000)}s · follow analyzer`,
          ),
        );
        // Timed Custom / hour clock owns the stop — do not abort early on a
        // loss streak (3 thin Over 0 / Under 9 losses was killing 7m runs).
        const timedSession =
          sessionEndAtMsRef.current > 0 ||
          (nextSettings.sessionHours ?? 0) > 0;
        if (
          !timedSession &&
          nextSettings.maxConsecutiveLosses > 0 &&
          consecutiveLosses >= nextSettings.maxConsecutiveLosses
        ) {
          onStopRef.current(
            `Stopped · ${consecutiveLosses} losses in a row · cool & review.`,
          );
          setLog((lines) =>
            pushLog(
              lines,
              `STOPPED · ${consecutiveLosses} consecutive losses · session closed`,
            ),
          );
          return;
        }
        if (timedSession && consecutiveLosses >= 3) {
          // O/U: brief extra cool only — never park 8s (that felt like "cool 7s").
          coolUntilMsRef.current = Math.max(
            coolUntilMsRef.current,
            Date.now() + (ouDesk ? 2_000 : Math.max(lossCoolMs, 8_000)),
          );
          setLog((lines) =>
            pushLog(
              lines,
              `COOL · ${consecutiveLosses} losses · timed session keeps clock`,
            ),
          );
        }
      } else {
        coolUntilMsRef.current = 0;
      }

      // Bot form owns the flow: timed session → runs → take profit / stop loss.
      if (
        sessionEndAtMsRef.current > 0 &&
        Date.now() >= sessionEndAtMsRef.current
      ) {
        const hrs = nextSettings.sessionHours ?? 0;
        onStopRef.current(
          `Stopped · ${hrs || "timed"}h session complete.`,
        );
        setLog((lines) =>
          pushLog(
            lines,
            `STOPPED · session clock · ${runsDone} trades · P/L ${
              runPnl >= 0 ? "+" : ""
            }${runPnl.toFixed(2)} ${currency}`,
          ),
        );
        return;
      }
      const timedOpen =
        sessionEndAtMsRef.current > 0 || (nextSettings.sessionHours ?? 0) > 0;
      // Timed Custom / hour cards: clock owns the stop — ignore maxRuns + TP.
      if (
        !timedOpen &&
        nextSettings.maxRuns > 0 &&
        runsDone >= nextSettings.maxRuns
      ) {
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
      // Timed hour sessions ignore TP — keep staking until the clock ends.
      if (
        !timedOpen &&
        nextSettings.takeProfit > 0 &&
        runPnl >= nextSettings.takeProfit
      ) {
        onStopRef.current("Take profit hit.");
        setLog((lines) =>
          pushLog(
            lines,
            `STOPPED · take profit ${runPnl.toFixed(2)} ≥ ${nextSettings.takeProfit} ${currency}`,
          ),
        );
        return;
      }
      if (
        timedOpen &&
        nextSettings.takeProfit > 0 &&
        runPnl >= nextSettings.takeProfit
      ) {
        setLog((lines) =>
          pushLog(
            lines,
            `TP passed +${runPnl.toFixed(2)} · timed session keeps trading until clock ends`,
          ),
        );
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
        !timedOpen &&
        nextSettings.takeProfit <= 0 &&
        nextSettings.dailyProfitTarget > 0 &&
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
      const clockLeft =
        timedOpen && sessionEndAtMsRef.current > 0
          ? Math.max(
              0,
              Math.ceil((sessionEndAtMsRef.current - Date.now()) / 60_000),
            )
          : null;
      // A live loss cool-down already set the reason — leave it visible.
      if (won || Date.now() >= coolUntilMsRef.current) {
        setWaitReason(
          clockLeft !== null
            ? `Follow · timed ${clockLeft}m left · ${runsLeft} trades · wait analyzer…`
            : `Follow · ${runsLeft} done · wait analyzer Trade now…`,
        );
      }
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
        // Feed is swapping — executor stays idle and only follows analyzer.
        const snap = analyzerSnapRef?.current;
        const phase = snap?.label ?? "Watch";
        const dig = snap?.digit ?? analyzerDigitRef.current;
        const side = snap?.side ?? analyzerSideRef.current;
        setWaitReason(
          dig != null && side
            ? `Follow · ${phase} · ${sideLabel(side)} ${dig} · wait analyzer`
            : "Follow · wait analyzer · market feed catching up…",
        );
        return;
      }
      if (entriesBlocked()) return;
      if (orderInFlight.current) return;

      if (
        nextSession.lastCloseEpoch !== null &&
        latest.epoch - nextSession.lastCloseEpoch < nextSettings.cooldownTicks
      ) {
        const left =
          nextSettings.cooldownTicks -
          (latest.epoch - nextSession.lastCloseEpoch);
        setWaitReason(`Cooling · ${left} ticks after last trade…`);
        return;
      }
      if (Date.now() < coolUntilMsRef.current) {
        const sec = Math.ceil((coolUntilMsRef.current - Date.now()) / 1000);
        const armedNow =
          analyzerSnapRef?.current?.buyNow === true ||
          analyzerBuyNowRef.current === true;
        if (armedNow && executorArmCancelRef) {
          executorArmCancelRef.current = true;
        }
        setWaitReason(`Follow · cool ${sec}s · then wait analyzer…`);
        return;
      }

      const runsDone = nextSession.trades - runOriginRef.current.trades;
      const runPnl = nextSession.pnl - runOriginRef.current.pnl;
      if (
        sessionEndAtMsRef.current > 0 &&
        Date.now() >= sessionEndAtMsRef.current
      ) {
        const hrs = nextSettings.sessionHours ?? 0;
        onStopRef.current(
          `Stopped · ${hrs || "timed"}h session complete.`,
        );
        setLog((lines) =>
          pushLog(
            lines,
            `STOPPED · session clock · ${runsDone} trades · P/L ${
              runPnl >= 0 ? "+" : ""
            }${runPnl.toFixed(2)} ${currency}`,
          ),
        );
        return;
      }
      const timedOpen =
        sessionEndAtMsRef.current > 0 || (nextSettings.sessionHours ?? 0) > 0;
      // Heal clock if Start profile wiped the end time but form still has hours.
      if (
        timedOpen &&
        sessionEndAtMsRef.current <= 0 &&
        (nextSettings.sessionHours ?? 0) > 0
      ) {
        const healed =
          Date.now() +
          Math.round((nextSettings.sessionHours ?? 0) * 3_600_000);
        sessionEndAtMsRef.current = healed;
        setSessionEndAtMs(healed);
      }
      if (
        !timedOpen &&
        nextSettings.maxRuns > 0 &&
        runsDone >= nextSettings.maxRuns
      ) {
        onStopRef.current("Run count reached.");
        setLog((lines) =>
          pushLog(
            lines,
            `STOPPED · ${runsDone}/${nextSettings.maxRuns} runs complete`,
          ),
        );
        return;
      }
      if (
        !timedOpen &&
        nextSettings.takeProfit > 0 &&
        runPnl >= nextSettings.takeProfit
      ) {
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

      // Pure follower: analyzer owns digit/side/phase — executor only buys
      // when Trade now is armed. No hunting, no re-gate, no second guess.
      const snap = analyzerSnapRef?.current;
      const followDigit = snap?.digit ?? analyzerDigitRef.current ?? liveSignal.digit;
      const followSide = snap?.side ?? analyzerSideRef.current ?? liveSignal.side;
      const buyNow =
        snap?.buyNow === true || analyzerBuyNowRef.current === true;
      const followLabel = sideLabel(followSide);
      const phaseLabel = snap?.label ?? (buyNow ? "Trade now" : "Watch");

      if (!buyNow) {
        nextSession = { ...nextSession, skipped: nextSession.skipped + 1 };
        setSession(nextSession);
        setWaitReason(
          `Follow · ${phaseLabel} · ${followLabel} ${followDigit} · wait Trade now`,
        );
        return;
      }

      // Run / money / clock stops only — never re-research the analyzer call.
      if (
        sessionEndAtMsRef.current > 0 &&
        Date.now() >= sessionEndAtMsRef.current
      ) {
        const hrs = nextSettings.sessionHours ?? 0;
        onStopRef.current(
          `Stopped · ${hrs || "timed"}h session complete.`,
        );
        return;
      }
      if (
        !timedOpen &&
        nextSettings.maxRuns > 0 &&
        runsDoneNow >= nextSettings.maxRuns
      ) {
        onStopRef.current(
          `Stopped · ${runsDoneNow}/${nextSettings.maxRuns} runs complete.`,
        );
        return;
      }
      if (
        nextSettings.maxTradesPerHour > 0 &&
        hourCount >= nextSettings.maxTradesPerHour
      ) {
        setWaitReason(`Follow · max ${nextSettings.maxTradesPerHour} trades/hour`);
        return;
      }
      if (isLowPayoutSymbol(symbol)) {
        onSwitchMarketRef.current?.("Low payout · next volatility");
        return;
      }
      // INSTANT FIRE — analyzer Trade now; trust snap digit/side, no re-gate.
      if (
        snap?.buyNow !== true &&
        analyzerBuyNowRef.current !== true
      ) {
        setWaitReason("Follow · Trade now dropped · no buy");
        return;
      }
      if (firedBuyEpochRef.current === latest.epoch) {
        return;
      }
      // Barrier just printed on this tick — Differs contract would be dead.
      if (followSide === "DIGITDIFF" && latest.digit === followDigit) {
        setWaitReason(`Follow · Digits reset · ${followDigit} printed`);
        return;
      }

      stuckSkipsRef.current = 0;
      firedBuyEpochRef.current = latest.epoch;

      setWaitReason(`Buying · ${followLabel} ${followDigit} · now`);
      setLog((lines) =>
        pushLog(
          lines,
          `FIRE · follow analyzer · ${followLabel} ${followDigit} · epoch ${latest.epoch}`,
        ),
      );

      if (entriesBlocked()) {
        firedBuyEpochRef.current = null;
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
      // Client OAuth → always buy on the user's Deriv wallet (demo or live).
      const mode =
        config.mode === "live" ||
        (isClientRole() && hasOauthSession())
          ? "live"
          : "paper";
      // Exact Digits lock — realtime follow, no second guess.
      const side = followSide;
      const digit = followDigit;
      const contracts = nextSettings.contracts;
      const duration = nextSettings.duration;
      // Pin E to the Trade now tick (armedEpoch), not a later tick if the
      // desk fired a moment after the tape already advanced.
      const entryEpoch =
        typeof snap?.armedEpoch === "number" && snap.armedEpoch > 0
          ? snap.armedEpoch
          : latest.epoch;
      const entrySpot = latest.quote;
      // Shield OU: use director momentum gap (0–1 elite). Differs still uses signalGap.
      const entryGap =
        isOverUnderSide(followSide) && typeof snap?.entryGap === "number"
          ? snap.entryGap
          : liveSignal.watching.signalGap;
      const entryPercent = liveSignal.digitPercent;
      const entryPower = liveSignal.power;

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
            : risked * (payoutMultiplier(side, undefined, digit) - 1);
        // Paint open pin on the chart in the same turn as Trade now.
        flushSync(() => {
          setSession((prev) => {
            if (prev.open) return prev;
            const open = {
              side,
              digit,
              stake,
              contracts: filledCount,
              // Same tick as Trade now — never defer entry to the next market.
              entryEpoch,
              settleAfter: Math.max(1, duration),
              mode: mode as "paper" | "live",
              orderEpoch: entryEpoch,
              contractId,
              contractIds,
              payout,
              note: tradeNoteRef.current || undefined,
              entrySpot,
              entryGap,
              entryPercent,
              entryPower,
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
          setOrderPending(mode === "live");
          setWaitReason(`In trade · ${followLabel} ${digit} · bought`);
        });
        setLog((lines) =>
          pushLog(
            lines,
            `OPEN ${mode === "live" ? "LIVE " : ""}${sideLabel(side)} ${digit} · ${filledCount}× ${stake} ${currency} · risk ${risked.toFixed(
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
          firedBuyEpochRef.current = null;
          setLog((lines) => pushLog(lines, "Skip · live buy needs ready Deriv socket"));
          return;
        }
        if (entriesBlocked()) {
          firedBuyEpochRef.current = null;
          return;
        }
        // Mark busy + optimistic open NOW so Digits leaves Trade now instantly.
        orderInFlight.current = true;
        applyOpen();
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
            setSession((prev) => {
              if (!prev.open || prev.open.entryEpoch !== entryEpoch) return prev;
              const updated = {
                ...prev,
                open: {
                  ...prev.open,
                  contractId,
                  contractIds,
                  contracts: filledCount,
                  payout,
                },
              };
              sessionRef.current = updated;
              return updated;
            });
            setLog((lines) =>
              pushLog(
                lines,
                `FILLED · live ${sideLabel(side)} ${digit} · #${contractId}`,
              ),
            );

            const settleOpen = (liveClient: DerivClient, ids: number[]) => {
              void waitForBasketOutcome(liveClient, ids)
                .then(({ won, profit, exitDigit, exitEpoch, entryEpoch: derivEntry }) =>
                  setLiveOutcome({
                    entryEpoch,
                    won,
                    profit,
                    exitDigit,
                    exitEpoch,
                    derivEntryEpoch: derivEntry,
                  }),
                )
                .catch((error: unknown) => {
                  const why = error instanceof Error ? error.message : String(error);
                  setLog((lines) =>
                    pushLog(lines, `Settle read failed (${why}) · retrying from Deriv…`),
                  );
                  void waitForBasketOutcome(liveClient, ids)
                    .then(({ won, profit, exitDigit, exitEpoch, entryEpoch: derivEntry }) =>
                      setLiveOutcome({
                        entryEpoch,
                        won,
                        profit,
                        exitDigit,
                        exitEpoch,
                        derivEntryEpoch: derivEntry,
                      }),
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
            firedBuyEpochRef.current = null;
            setSession((prev) => {
              if (prev.open?.entryEpoch === entryEpoch && prev.open.contractId == null) {
                const updated = { ...prev, open: null };
                sessionRef.current = updated;
                return updated;
              }
              return prev;
            });
            const message = error instanceof Error ? error.message : String(error);
            setLog((lines) => pushLog(lines, `BUY FAIL · ${message}`));
            setWaitReason(`Buy rejected · ${message}`);
          });
        return;
      }

      if (entriesBlocked()) {
        firedBuyEpochRef.current = null;
        return;
      }

      applyOpen();
    }
    };

    deskTickRef.current = deskTick;
    if (executorFireRef) executorFireRef.current = deskTick;
    deskTick();
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
    tradeNowWake,
  ]);

  if (executorFireRef) {
    executorFireRef.current = () => deskTickRef.current();
  }

  const performance = computePerformance({
    ...session,
    payoutMultiplier: payoutMultiplier(
      settings.side,
      undefined,
      settings.prediction,
    ),
  });

  return {
    log,
    session,
    performance,
    waitReason,
    runsThisStart,
    pnlThisStart,
    sessionEndAtMs,
    orderPending,
    settling: session.open !== null || orderPending,
  };
}
