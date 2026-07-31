import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { DerivClient } from "../lib/deriv/client";
import type { MarketSignal } from "../lib/analysis/signal";
import { confirmScore } from "../lib/analysis/signal";
import { findBestMarket } from "../lib/analysis/bestMarket";
import { evaluateEntry } from "../lib/bot/gates";
import type { BotSession, BotSettings } from "../lib/bot/types";
import {
  getAiBankroll,
  patchAiBankroll,
  pocketMath,
  pushAiLog,
  restartAiFresh,
  subscribeAiBankroll,
  survivalStopReason,
  type AiBankrollState,
} from "../lib/ai/bankroll";

/** After a loss, stop the bot and skip that digit until the hot pick changes. */
const DEFAULT_DEMO_POCKET = 50;
const AI_STAKE = 0.35;
/** EV + timing + windows — fewer spam losses on a sticky hot digit. */
const MIN_ENTRY_SCORE = 3;

const AI_ENTRY_PATCH: Partial<BotSettings> = {
  side: "DIGITMATCH",
  martingale: false,
  contracts: 1,
  stake: AI_STAKE,
  riskPercent: 0,
  autoFollow: true,
  autoSide: false,
  sidePreference: "matches",
  skipLowConfidence: false,
  requireFullConfirm: false,
  requireMultiWindow: true,
  requireWindowsEv: false,
  requireTiming: true,
  requireUneven: false,
  minSample: 865,
  minEdgePercent: 0,
  cooldownTicks: 20,
  maxTradesPerHour: 10,
  maxRuns: 0,
  pauseIfExpectancyNegativeAfter: 15,
  pauseIfBelowBreakEvenAfter: 0,
};

function operatorEntryReady(signal: MarketSignal): boolean {
  return (
    signal.side === "DIGITMATCH" &&
    signal.barrierAligned &&
    signal.evOk &&
    signal.timingOk &&
    signal.windowsAgree &&
    signal.separationOk &&
    confirmScore(signal) >= MIN_ENTRY_SCORE
  );
}

export interface UseAiOperatorOptions {
  /** Live Matches signal — Operator ignores Differs. */
  matchSignal: MarketSignal;
  session: BotSession;
  bot: BotSettings;
  symbol: string;
  client: DerivClient | null;
  feedReady: boolean;
  latestEpoch: number | null;
  setBot: (updater: (current: BotSettings) => BotSettings) => void;
  setSymbol: (symbol: string) => void;
  startBot: () => void | Promise<void>;
  stopBot: () => void;
}

export interface AiOperatorApi {
  state: AiBankrollState;
  pocket: ReturnType<typeof pocketMath>;
  arm: () => void;
  disarm: (reason?: string) => void;
  restart: (budget?: number) => void;
  updateConfig: (patch: Partial<AiBankrollState>) => void;
  resetPnl: () => void;
}

function snapshot(): AiBankrollState {
  return getAiBankroll();
}

export function useAiOperator(options: UseAiOperatorOptions): AiOperatorApi {
  const {
    matchSignal,
    session,
    bot,
    symbol,
    client,
    feedReady,
    latestEpoch,
    setBot,
    setSymbol,
    startBot,
    stopBot,
  } = options;

  const state = useSyncExternalStore(subscribeAiBankroll, snapshot, snapshot);
  const pocket = pocketMath(state);

  const scanningRef = useRef(false);
  const lastScanAt = useRef(0);
  const lastEpochHandled = useRef<number | null>(null);
  const startRequestedRef = useRef(false);
  const lastSkipLog = useRef(0);
  const lastTradeAt = useRef(0);
  const seenJournalId = useRef<string | null>(null);
  /** After losses on a digit, skip until the hot pick changes. */
  const coolDigitRef = useRef<number | null>(null);
  const lossStreakRef = useRef(0);
  const botRef = useRef(bot);
  const matchRef = useRef(matchSignal);
  const sessionRef = useRef(session);
  botRef.current = bot;
  matchRef.current = matchSignal;
  sessionRef.current = session;

  const applySurvivalSettings = useCallback(() => {
    const bank = getAiBankroll();
    const live = matchRef.current;
    setBot((current) => {
      if (
        current.side === "DIGITMATCH" &&
        current.autoSide === false &&
        current.stake === AI_STAKE &&
        current.martingale === false &&
        current.requireFullConfirm === false &&
        current.cooldownTicks === 20 &&
        current.maxTradesPerHour === 10 &&
        current.requireMultiWindow === true &&
        current.sidePreference === "matches" &&
        current.prediction === live.digit
      ) {
        return current;
      }
      return {
        ...current,
        ...AI_ENTRY_PATCH,
        stake: AI_STAKE,
        maxStake: Math.max(AI_STAKE, bank.maxStakePerTrade),
        prediction: live.digit,
        martingale: false,
      };
    });
    return AI_STAKE;
  }, [setBot]);

  const disarm = useCallback(
    (reason?: string) => {
      stopBot();
      const msg = reason ?? "Operator stopped";
      patchAiBankroll({
        armed: false,
        status: "stopped",
        lastStopReason: msg,
        startedAt: null,
      });
      pushAiLog(msg);
    },
    [stopBot],
  );

  const restart = useCallback(
    (budget = DEFAULT_DEMO_POCKET) => {
      stopBot();
      startRequestedRef.current = false;
      scanningRef.current = false;
      lastTradeAt.current = 0;
      lastScanAt.current = 0;
      coolDigitRef.current = null;
      lossStreakRef.current = 0;
      restartAiFresh(budget);
      setBot((current) => ({
        ...current,
        ...AI_ENTRY_PATCH,
        running: false,
        stake: AI_STAKE,
        maxStake: AI_STAKE,
        martingale: false,
      }));
    },
    [setBot, stopBot],
  );

  const arm = useCallback(() => {
    const bank = getAiBankroll();
    const math = pocketMath(bank);
    if (math.usable < 0.35) {
      pushAiLog("Cannot arm · usable pocket below min stake. Raise allocation.");
      return;
    }
    if (!bank.runStartedAt) {
      patchAiBankroll({ runStartedAt: Math.floor(Date.now() / 1000) });
    }
    applySurvivalSettings();
    patchAiBankroll({
      armed: true,
      status: "scanning",
      lastStopReason: null,
      startedAt: Date.now(),
      cooldownUntil: null,
    });
    pushAiLog(
      `Armed · Matches-only · stake ${AI_STAKE} · no timed pause · aim +${(math.takeProfitAt ?? 0).toFixed(0)}`,
    );
  }, [applySurvivalSettings]);

  const updateConfig = useCallback((patch: Partial<AiBankrollState>) => {
    patchAiBankroll(patch);
  }, []);

  const resetPnl = useCallback(() => {
    patchAiBankroll({ aiPnl: 0, lastStopReason: null });
    pushAiLog("Pocket PnL reset to 0");
  }, []);

  useEffect(() => {
    if (!state.armed) return;
    const newest = session.journal[0];
    if (!newest || newest.note !== "ai-operator") return;
    if (seenJournalId.current === newest.id) return;
    seenJournalId.current = newest.id;
    lastTradeAt.current = Date.now();
    startRequestedRef.current = false;

    if (!newest.won) {
      lossStreakRef.current += 1;
      coolDigitRef.current = newest.digit;
      // Must stop — if bot stays running it re-fires the same digit and ignores cool-off.
      stopBot();
      patchAiBankroll({ status: "hunting", cooldownUntil: null });
      pushAiLog(
        `LOSS · stop · skip Matches ${newest.digit} until hot digit changes`,
      );
      return;
    }
    lossStreakRef.current = 0;
    coolDigitRef.current = null;
    patchAiBankroll({ status: "hunting", cooldownUntil: null });
    pushAiLog(`WIN +${newest.pnl.toFixed(2)} · keep hunting`);
  }, [state.armed, session.journal, stopBot]);

  useEffect(() => {
    if (!state.armed) return;
    if (latestEpoch === null) return;
    if (lastEpochHandled.current === latestEpoch) return;
    lastEpochHandled.current = latestEpoch;

    const bank = getAiBankroll();
    if (!bank.armed) return;

    const stop = survivalStopReason(bank);
    if (stop) {
      disarm(stop);
      return;
    }

    if (bank.cooldownUntil) {
      patchAiBankroll({ cooldownUntil: null, status: "hunting" });
    }

    applySurvivalSettings();

    const live = matchRef.current;
    if (coolDigitRef.current !== null && live.digit === coolDigitRef.current) {
      if (botRef.current.running) stopBot();
      if (Date.now() - lastSkipLog.current > 12_000) {
        lastSkipLog.current = Date.now();
        pushAiLog(
          `Skip · Matches ${live.digit} lost last time · wait for a new hot digit`,
        );
        patchAiBankroll({ status: "hunting" });
      }
      return;
    }
    if (coolDigitRef.current !== null && live.digit !== coolDigitRef.current) {
      coolDigitRef.current = null;
      pushAiLog(`Hot digit moved → Matches ${live.digit} · hunting again`);
    }

    const settings = {
      ...botRef.current,
      ...AI_ENTRY_PATCH,
      side: "DIGITMATCH" as const,
      prediction: live.digit,
      requireFullConfirm: false,
      requireMultiWindow: true,
      requireTiming: true,
    };

    const score = confirmScore(live);
    if (!operatorEntryReady(live)) {
      if (Date.now() - lastSkipLog.current > 8_000) {
        lastSkipLog.current = Date.now();
        const bits = [
          live.barrierAligned ? "hot✓" : "hot✗",
          live.evOk ? "EV✓" : "EV✗",
          live.timingOk ? "timing✓" : "timing✗",
          live.windowsAgree ? "windows✓" : "windows✗",
          live.separationOk ? "lead✓" : "lead✗",
          `${score}/5`,
        ].join(" · ");
        pushAiLog(`Wait · Matches ${live.digit} · ${bits}`);
        patchAiBankroll({ status: "hunting" });
      }
      return;
    }

    const gate = evaluateEntry(settings, live, { symbol });
    if (!gate.ok) {
      if (Date.now() - lastSkipLog.current > 8_000) {
        lastSkipLog.current = Date.now();
        pushAiLog(gate.reason);
      }
      return;
    }

    if (botRef.current.running) {
      startRequestedRef.current = false;
      return;
    }

    if (startRequestedRef.current) {
      startRequestedRef.current = false;
    }

    const math = pocketMath(getAiBankroll());
    if (math.usable < 0.35) {
      disarm("Usable pocket exhausted");
      return;
    }

    startRequestedRef.current = true;
    pushAiLog(
      `Entry · Matches ${live.digit} · EV+timing+windows · stake ${AI_STAKE}`,
    );
    patchAiBankroll({ status: "hunting" });
    void startBot();
  }, [
    state.armed,
    latestEpoch,
    disarm,
    applySurvivalSettings,
    startBot,
    stopBot,
    symbol,
  ]);

  useEffect(() => {
    if (!state.armed) return;

    const runScan = async () => {
      if (scanningRef.current) return;
      if (!client || !feedReady) return;
      const intervalMs = Math.max(1, getAiBankroll().scanIntervalMinutes) * 60_000;
      if (Date.now() - lastScanAt.current < intervalMs && lastScanAt.current > 0) {
        return;
      }

      scanningRef.current = true;
      lastScanAt.current = Date.now();
      patchAiBankroll({ status: "scanning" });
      pushAiLog("Scanning for best Matches market…");

      try {
        const scanSettings = {
          ...botRef.current,
          sidePreference: "matches" as const,
        };
        const best = await findBestMarket(client, scanSettings, symbol);
        if (!getAiBankroll().armed) return;
        const digit =
          best.signal.side === "DIGITMATCH" ? best.signal.digit : matchRef.current.digit;
        setBot((current) => ({
          ...current,
          ...AI_ENTRY_PATCH,
          side: "DIGITMATCH",
          prediction: digit,
          stake: AI_STAKE,
          martingale: false,
        }));
        if (best.symbol !== symbol) {
          setSymbol(best.symbol);
          pushAiLog(`Switch · ${best.name} · Matches ${digit}`);
        } else {
          pushAiLog(`Scan · keep ${best.name} · Matches ${digit}`);
        }
        patchAiBankroll({ status: "hunting" });
      } catch {
        if (getAiBankroll().armed) {
          pushAiLog("Scan failed · staying on current symbol");
          patchAiBankroll({ status: "hunting" });
        }
      } finally {
        scanningRef.current = false;
      }
    };

    void runScan();
    const id = window.setInterval(() => void runScan(), 30_000);
    return () => window.clearInterval(id);
  }, [state.armed, client, feedReady, symbol, setBot, setSymbol]);

  useEffect(() => {
    if (!state.armed) {
      scanningRef.current = false;
      startRequestedRef.current = false;
    }
  }, [state.armed]);

  return {
    state,
    pocket,
    arm,
    disarm,
    restart,
    updateConfig,
    resetPnl,
  };
}
