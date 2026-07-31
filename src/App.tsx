import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ResizableSplit } from "./components/ResizableSplit";
import { AnalyzerPopup } from "./components/AnalyzerPopup";
import { BotPanel, type BotSettings } from "./components/BotPanel";
import { DigitBars } from "./components/DigitBars";
import { DigitStrip } from "./components/DigitStrip";
import { MarketSelect } from "./components/MarketSelect";
import { StatsPanel } from "./components/StatsPanel";
import { BrandStamp } from "./components/BrandStamp";
import { SettingsModal } from "./components/SettingsModal";
import { StatusBar } from "./components/StatusBar";
import { TickChart } from "./components/TickChart";
import { AiPanel } from "./components/AiPanel";
import { AuthSignOutButton } from "./components/AuthGate";
import { LiveTradingBanner } from "./components/LiveTradingBanner";
import { TradesPanel } from "./components/TradesPanel";
import { recoveryRequirements } from "./lib/bot/gates";
import { isLowPayoutSymbol } from "./lib/bot/performance";
import { useArmTimer } from "./hooks/useArmTimer";
import { useAiOperator } from "./hooks/useAiOperator";
import { useDerivFeed } from "./hooks/useDerivFeed";
import { usePaperBot } from "./hooks/usePaperBot";
import { useTheme } from "./hooks/useTheme";
import { summarise } from "./lib/analysis/digits";
import {
  buildMarketSignal,
  pickBetterSignal,
  type ContractSide,
} from "./lib/analysis/signal";
import { findBestMarket } from "./lib/analysis/bestMarket";
import {
  applyDiffersFastProfile,
  createDiffersFastBotSettings,
  DIFFERS_FAST_SYMBOL,
  isDiffersFastProfile,
} from "./lib/bot/differsProfile";
import {
  applyLiveTradingProfile,
  isLiveTradingProfile,
  liveSettingsForBalance,
  planLiveStake,
} from "./lib/bot/liveProfile";
import { storageKey } from "./lib/platform";
import { config, isConfigured } from "./lib/config";
import logoDark from "./assets/logo.png";
import logoLight from "./assets/logo-light.png";
import { APP_NAME } from "./lib/brand";
import {
  AI_TRADE_NOTE,
  applyAiTradePnl,
  getAiBankroll,
  pushAiLog,
  subscribeAiBankroll,
} from "./lib/ai/bankroll";

const WINDOW_SIZES = [250, 500, 1000, 2000] as const;
/**
 * Windows used for multi-window agreement on the bot signal.
 *
 * Telling a genuine 12% digit from 10% noise needs ~865 samples at 95%
 * confidence, so anything shorter mostly confirms randomness.
 */
const AGREEMENT_WINDOWS = [1500, 2000, 2500] as const;
const BOT_SETTINGS_KEY = storageKey("bot-settings");
const BOT_SETTINGS_VERSION = 29;

/** Wait for the feed to reload after switching volatility index. */
async function waitForSymbolFeed(
  targetSymbol: string,
  minTicks: number,
  readSnapshot: () => { symbol: string; state: string; tickCount: number },
  cancelled: () => boolean,
  timeoutMs = 20000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cancelled()) return false;
    const snap = readSnapshot();
    if (
      snap.symbol === targetSymbol &&
      snap.state === "ready" &&
      snap.tickCount >= minTicks
    ) {
      return true;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 150));
  }
  return false;
}

type AppMenu = "market" | "bot" | "trades" | "ai";

/**
 * Entry filters.
 *
 * scripts/find-edge.ts checked 400k ticks and found the digits uniform,
 * serially independent, and flat in their step distribution. No gate can lift
 * the win rate above a fair 90%, so these layers control how often the bot
 * trades, not how well. Every trade is worth about -1.26% either way; trading
 * more loses more.
 *
 * Only the layers that behave consistently across indices are left on.
 * scripts/diagnose-gate.ts replayed 70k ticks through this exact chain:
 *
 *   layer              pass rate   spread across indices
 *   EV vs break-even      72.3%    59.7% – 80.8%
 *   cold-gap timing       59.2%    58.4% – 59.9%   <- stable
 *   window agreement      18.9%    10.9% – 26.7%
 *   multi-window EV       15.6%     6.1% – 31.4%
 *   chi-square uneven      6.3%     0.3% – 11.4%   <- worst
 *
 * Stacking all five opened the gate on 1.1% of ticks and on 1HZ25V and 1HZ75V
 * never opened at all in 10,000 ticks; a live 15-minute run on 1HZ25V placed
 * zero orders. The three low layers also swing by 5-10x between indices, so
 * the bot's behaviour depended on which market the scanner happened to pick.
 * EV plus timing passes on 43% of ticks with almost no spread, which
 * maxTradesPerHour then caps at one trade a minute.
 */
// `satisfies` rather than a Partial annotation: an annotation would make every
// key optional at the spread site, which forced defaultBotSettings to cast and
// hid missing fields from the compiler.
/**
 * Entry filters for the Differs fast profile.
 * Full definition: src/lib/bot/differsProfile.ts
 */
function defaultBotSettings(): BotSettings {
  return createDiffersFastBotSettings(config.risk);
}

/**
 * Raise the caps until a one-rung recovery actually fits, so the form fills
 * itself instead of parking on "recovery impossible". Returns the same object
 * when nothing needs changing, which keeps the auto-fill effect from looping.
 */
function withWorkableRecovery(settings: BotSettings): BotSettings {
  if (!settings.martingale) return settings;
  const needs = recoveryRequirements(settings);
  const risked = settings.stake * settings.contracts;
  const capOk = settings.dailyLossLimit - risked >= needs.exposure;
  // Only raise martingale money caps. Take profit / stop loss stay exactly
  // what the user typed — rewriting them was making the form unusable.
  if (settings.maxStake >= needs.maxStake && capOk) return settings;
  return {
    ...settings,
    maxStake: Math.max(settings.maxStake, needs.maxStake),
    dailyLossLimit: Math.max(settings.dailyLossLimit, needs.dailyLossLimit),
  };
}

/**
 * Version the live settings were actually migrated at, which is not always the
 * compiled one. A hot reload swaps in new module code while React keeps the
 * old state, so stamping BOT_SETTINGS_VERSION on save would write
 * pre-migration settings back to storage marked as current — the migration
 * would then be skipped forever and new defaults would never take effect.
 */
let loadedVersion: number | null = null;

function loadBotSettings(): BotSettings {
  const defaults = defaultBotSettings();
  // Reached the migration, so anything saved from here on is genuinely current.
  loadedVersion = BOT_SETTINGS_VERSION;
  try {
    const raw = localStorage.getItem(BOT_SETTINGS_KEY);
    if (!raw) return withWorkableRecovery(defaults);
    const parsed = JSON.parse(raw) as Partial<BotSettings> & { _v?: number };

    // A version bump is a one-time migration onto the new defaults. Only the
    // money limits carry over — everything else is what the migration is for.
    if (parsed._v !== BOT_SETTINGS_VERSION) {
      return withWorkableRecovery({
        ...defaults,
        stake: parsed.stake ?? defaults.stake,
        dailyProfitTarget: parsed.dailyProfitTarget ?? defaults.dailyProfitTarget,
        takeProfit: parsed.takeProfit ?? defaults.takeProfit,
        stopLoss: parsed.stopLoss ?? defaults.stopLoss,
        maxRuns: parsed.maxRuns ?? defaults.maxRuns,
        maxConsecutiveLosses: parsed.maxConsecutiveLosses ?? defaults.maxConsecutiveLosses,
        maxTradesPerDay: parsed.maxTradesPerDay ?? defaults.maxTradesPerDay,
        running: false,
      });
    }

    // Same version: the Bot form is the source of truth, so load it verbatim.
    const merged = { ...defaults, ...parsed, running: false };
    merged.maxStake = Math.max(merged.maxStake, merged.stake);
    return withWorkableRecovery(merged);
  } catch {
    return withWorkableRecovery(defaults);
  }
}

function saveBotSettings(settings: BotSettings) {
  const { running: _running, ...persist } = settings;
  localStorage.setItem(
    BOT_SETTINGS_KEY,
    // 0 when this state never went through loadBotSettings, which marks it
    // stale so the next page load migrates it properly.
    JSON.stringify({ ...persist, _v: loadedVersion ?? 0 }),
  );
}

function BrandMark() {
  const { theme } = useTheme();
  return (
    <div className="topbar__brand">
      <img
        src={theme === "light" ? logoLight : logoDark}
        alt=""
        className="topbar__logo"
      />
      <div className="topbar__brand-copy">
        <strong>{APP_NAME}</strong>
        <small>Matches · Differs · Secured desk</small>
      </div>
    </div>
  );
}

function SetupNotice() {
  return (
    <div className="app app--setup">
      <header className="topbar">
        <BrandMark />
      </header>
      <main className="stage">
        <h1>Setup needed</h1>
        <p>
          Fill these in inside <code>.env</code>, then restart the dev server:
        </p>
        <ul className="setup__list">
          {config.errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      </main>
    </div>
  );
}

export default function App() {
  const { theme, toggleTheme } = useTheme();
  const [menu, setMenu] = useState<AppMenu>("market");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [symbol, setSymbol] = useState(() =>
    isLowPayoutSymbol(config.symbol) ? DIFFERS_FAST_SYMBOL : config.symbol,
  );
  const [windowSize, setWindowSize] = useState<number>(1000);
  const [selectedDigit, setSelectedDigit] = useState<number | null>(null);
  const [bot, setBot] = useState<BotSettings>(() => loadBotSettings());
  const [timerNote, setTimerNote] = useState<string | null>(null);
  const [scanningMarket, setScanningMarket] = useState(false);
  const startSignalRef = useRef<{
    side: BotSettings["side"];
    digit: number;
    label: string;
  } | null>(null);
  const scanActiveRef = useRef(false);
  /** Synchronous Stop latch — blocks new entries before React re-renders running=false. */
  const botHaltRef = useRef(true);
  /**
   * Mid-run market switch latch. While true the bot must not open new trades —
   * the analyzer is still scanning, or the new feed has not loaded yet.
   */
  const switchHoldRef = useRef(false);

  useEffect(() => {
    saveBotSettings(bot);
  }, [bot]);

  // Keep the caps in step with stake/basket edits so recovery stays reachable.
  useEffect(() => {
    if (bot.running) return;
    setBot(withWorkableRecovery);
  }, [bot.stake, bot.contracts, bot.side, bot.martingale, bot.running]);

  // Preload more than the largest window so signals are valid immediately.
  const feed = useDerivFeed(symbol, 2500);
  const stats = useMemo(
    () => summarise(feed.digits.slice(-windowSize)),
    [feed.digits, windowSize],
  );
  const agreementStats = useMemo(
    () => AGREEMENT_WINDOWS.map((size) => summarise(feed.digits.slice(-size))),
    [feed.digits],
  );
  const signalOptions = useMemo(
    () => ({
      windowStats: agreementStats,
      windowSizes: [...AGREEMENT_WINDOWS],
      minEdgePercent: bot.minEdgePercent,
      maxMomentumGap: bot.maxMomentumGap,
      minColdGap: bot.minColdGap,
      symbol,
    }),
    [agreementStats, bot.minEdgePercent, bot.maxMomentumGap, bot.minColdGap, symbol],
  );

  const matchSignal = useMemo(
    () => buildMarketSignal(stats, "DIGITMATCH", bot.prediction, signalOptions),
    [stats, bot.prediction, signalOptions],
  );
  const diffSignal = useMemo(
    () => buildMarketSignal(stats, "DIGITDIFF", bot.prediction, signalOptions),
    [stats, bot.prediction, signalOptions],
  );
  const signal = useMemo(() => {
    if (bot.autoSide) {
      return pickBetterSignal(matchSignal, diffSignal, bot.sidePreference);
    }
    return bot.side === "DIGITMATCH" ? matchSignal : diffSignal;
  }, [bot.autoSide, bot.side, bot.sidePreference, matchSignal, diffSignal]);

  // Keep Mode cards + prediction locked to the live market pick when auto-side is on.
  useEffect(() => {
    if (!bot.autoSide) return;
    setBot((current) => {
      if (
        current.side === signal.side &&
        current.prediction === signal.digit
      ) {
        return current;
      }
      return {
        ...current,
        side: signal.side,
        prediction: signal.digit,
      };
    });
  }, [bot.autoSide, signal.side, signal.digit]);

  const signalRef = useRef(signal);
  signalRef.current = signal;
  const feedSnapshotRef = useRef({
    symbol,
    state: feed.state,
    tickCount: feed.ticks.length,
  });
  feedSnapshotRef.current = {
    symbol,
    state: feed.state,
    tickCount: feed.ticks.length,
  };
  const latest = feed.ticks[feed.ticks.length - 1];

  const applyManualSide = useCallback(
    (side: ContractSide) => {
      const digit = side === "DIGITMATCH" ? matchSignal.digit : diffSignal.digit;
      setBot((current) => ({
        ...current,
        side,
        autoSide: false,
        autoFollow: true,
        prediction: digit,
      }));
    },
    [matchSignal.digit, diffSignal.digit],
  );

  const marketSwitchBusy = useRef(false);

  const scanBotSettings = useCallback((): BotSettings => {
    if (bot.autoSide) return bot;
    return {
      ...bot,
      sidePreference:
        bot.side === "DIGITDIFF" ? ("differs" as const) : ("matches" as const),
    };
  }, [bot]);

  /** Pick the best payout-tier market for the current side preference. */
  const autoPickMarket = useCallback(
    async (note?: string, opts?: { excludeCurrent?: boolean; preferReady?: boolean }) => {
      if (!feed.client || feed.state !== "ready") return null;
      if (marketSwitchBusy.current) return null;
      marketSwitchBusy.current = true;
      try {
        const best = await findBestMarket(
          feed.client,
          scanBotSettings(),
          symbol,
          {
            excludeSymbols: opts?.excludeCurrent ? [symbol] : undefined,
            preferReady: opts?.preferReady ?? false,
          },
        );
        if (best.symbol !== symbol) {
          setSymbol(best.symbol);
          setBot((current) => ({
            ...current,
            side: current.autoSide ? best.signal.side : current.side,
            prediction: best.signal.digit,
            autoFollow: true,
          }));
          setTimerNote(
            note ?? `Auto · ${best.name} · ${best.signal.label}`,
          );
        } else if (note) {
          setTimerNote(note);
        }
        return best;
      } finally {
        marketSwitchBusy.current = false;
      }
    },
    [feed.client, feed.state, scanBotSettings, symbol],
  );

  /**
   * Mid-run switch after a loss or a stuck cold-gap wait.
   *
   * Analyzes every index first, only accepts a market that is already
   * trade-ready, waits for the live feed to load, then re-checks the live
   * signal. If nothing qualifies — or the live feed still looks bad — the
   * run stops instead of jumping onto a blind pick.
   */
  const switchToAnalyzedMarket = useCallback(
    async (reason: string) => {
      if (!feed.client || feed.state !== "ready") {
        botHaltRef.current = true;
        setBot((current) => ({ ...current, running: false }));
        setTimerNote(`${reason} · feed not ready · stopped`);
        return;
      }
      if (marketSwitchBusy.current) return;
      marketSwitchBusy.current = true;
      switchHoldRef.current = true;
      setScanningMarket(true);
      setTimerNote(`${reason} · analyzing all markets…`);

      try {
        const best = await findBestMarket(
          feed.client,
          scanBotSettings(),
          symbol,
          {
            excludeSymbols: [symbol],
            requireReady: true,
          },
        );

        if (!best) {
          botHaltRef.current = true;
          setBot((current) => ({ ...current, running: false }));
          setTimerNote(
            `${reason} · no ready market · stopped (nothing cleared cold gap + barrier)`,
          );
          return;
        }

        setTimerNote(
          `Analyzed · ${best.name} · ${best.signal.label} · loading ticks…`,
        );
        setSymbol(best.symbol);
        setBot((current) => ({
          ...current,
          side: current.autoSide ? best.signal.side : current.side,
          prediction: best.signal.digit,
          autoFollow: true,
        }));

        const feedReady = await waitForSymbolFeed(
          best.symbol,
          Math.max(500, bot.minSample),
          () => feedSnapshotRef.current,
          () => botHaltRef.current,
          25000,
        );

        if (botHaltRef.current) return;

        if (!feedReady) {
          botHaltRef.current = true;
          setBot((current) => ({ ...current, running: false }));
          setTimerNote(
            `${best.name} · feed did not load in time · stopped`,
          );
          return;
        }

        // Re-read the live analyzer on the new feed. Scan history and the
        // live stream can disagree by a few ticks — if the live setup is no
        // longer ready, stop rather than trade blind.
        const live = signalRef.current;
        const prefs = scanBotSettings().sidePreference;
        const liveReady =
          live.timingOk &&
          live.barrierAligned &&
          (prefs === "matches"
            ? live.side === "DIGITMATCH"
            : prefs === "differs" || prefs === "winrate"
              ? live.side === "DIGITDIFF" && live.coldMarginOk
              : true);

        if (!liveReady) {
          botHaltRef.current = true;
          setBot((current) => ({ ...current, running: false }));
          setTimerNote(
            `${best.name} · live setup went cold after load · stopped`,
          );
          return;
        }

        setBot((current) => ({
          ...current,
          side: current.autoSide ? live.side : current.side,
          prediction: live.digit,
          autoFollow: true,
        }));
        setTimerNote(
          `Ready · ${best.name} · ${live.label} · trading resumes`,
        );
      } catch {
        botHaltRef.current = true;
        setBot((current) => ({ ...current, running: false }));
        setTimerNote(`${reason} · market scan failed · stopped`);
      } finally {
        switchHoldRef.current = false;
        setScanningMarket(false);
        marketSwitchBusy.current = false;
      }
    },
    [feed.client, feed.state, scanBotSettings, symbol, bot.minSample],
  );

  const enterTradeFromSignal = useCallback(() => {
    const pending = startSignalRef.current;
    const live = signalRef.current;
    const operatorArmed = getAiBankroll().armed;
    startSignalRef.current = null;
    botHaltRef.current = false;
    setBot((current) => {
      const side = operatorArmed
        ? ("DIGITMATCH" as const)
        : current.autoSide
          ? ((pending?.side ?? live.side) as typeof current.side)
          : current.side;
      const digit = pending?.digit ?? live.digit;
      const label = pending?.label ?? live.label;
      setTimerNote(`Fed ${label} · trading started · ${current.contracts}× ${current.stake.toFixed(2)}`);
      return {
        ...current,
        side,
        prediction: digit,
        autoFollow: true,
        autoSide: operatorArmed ? false : current.autoSide,
        running: true,
        ...(operatorArmed
          ? {
              sidePreference: "matches" as const,
              martingale: false,
              requireTiming: true,
              requireMultiWindow: false,
              requireFullConfirm: false,
              stake: Math.min(current.stake, 0.35),
              contracts: 1,
            }
          : {}),
      };
    });
  }, []);

  const feedAnalyzerToBot = useCallback(() => {
    const live = signalRef.current;
    const operatorArmed = getAiBankroll().armed;
    setBot((current) => ({
      ...current,
      side: operatorArmed ? "DIGITMATCH" : current.autoSide ? live.side : current.side,
      prediction: live.digit,
      autoFollow: true,
      autoSide: operatorArmed ? false : current.autoSide,
    }));
  }, []);

  const arm = useArmTimer(enterTradeFromSignal);

  const aiBankroll = useSyncExternalStore(
    subscribeAiBankroll,
    getAiBankroll,
    getAiBankroll,
  );

  const isVirtualAccount = feed.account?.isVirtual ?? true;
  const wasVirtualRef = useRef(isVirtualAccount);

  const paper = usePaperBot({
    running: bot.running,
    settings: bot,
    signal,
    ticks: feed.ticks,
    config,
    currency: feed.currency,
    balance: feed.balance,
    symbol,
    client: feed.client,
    onSettings: (next) => setBot((current) => ({ ...current, ...next })),
    onStop: (reason) => {
      botHaltRef.current = true;
      switchHoldRef.current = false;
      setBot((current) => ({ ...current, running: false }));
      arm.cancel();
      setTimerNote(reason);
    },
    onSwitchMarket: (reason) => {
      void switchToAnalyzedMarket(reason);
    },
    haltRef: botHaltRef,
    switchHoldRef,
    isVirtual: isVirtualAccount,
    tradeNote: aiBankroll.armed ? AI_TRADE_NOTE : null,
  });

  // While the bot runs on a cheap-payout index, switch automatically.
  useEffect(() => {
    if (!bot.running || !isLowPayoutSymbol(symbol)) return;
    if (!feed.client || feed.state !== "ready") return;
    void autoPickMarket(`${symbol} low payout · auto-switching market…`);
  }, [bot.running, symbol, feed.client, feed.state, autoPickMarket]);

  const displayBalance =
    feed.balance === null
      ? null
      : config.mode === "paper"
        ? feed.balance + paper.session.pnl
        : feed.balance;

  // Keep live stake/cap aligned with balance while idle (never mid-run).
  useEffect(() => {
    if (config.mode !== "live" || feed.balance === null || bot.running) return;
    const patch = liveSettingsForBalance(bot, feed.balance, isVirtualAccount);
    if (!patch) return;
    setBot((current) => ({ ...current, ...patch }));
  }, [config.mode, feed.balance, isVirtualAccount, bot.stake, bot.maxExposurePercent, bot.contracts, bot.maxRuns, bot.running]);

  // Reset to demo take-profit profile when switching back to virtual account.
  useEffect(() => {
    const wasVirtual = wasVirtualRef.current;
    wasVirtualRef.current = isVirtualAccount;
    if (!isVirtualAccount || config.mode !== "live") return;
    if (wasVirtual) return;
    setBot((current) => applyLiveTradingProfile(current, feed.balance, true));
    setTimerNote("Demo account · take-profit run profile applied");
  }, [isVirtualAccount, config.mode, feed.balance]);

  const restoreDiffersFast = useCallback(() => {
    setBot((current) => applyDiffersFastProfile(current));
    if (isLowPayoutSymbol(symbol)) {
      setSymbol(DIFFERS_FAST_SYMBOL);
    }
    setTimerNote("Differs fast profile restored");
  }, [symbol]);

  const applyLiveSettings = useCallback(() => {
    const plan = planLiveStake(feed.balance, 1, isVirtualAccount);
    setBot((current) =>
      applyLiveTradingProfile(current, feed.balance, isVirtualAccount),
    );
    if (isLowPayoutSymbol(symbol)) {
      setSymbol(DIFFERS_FAST_SYMBOL);
    }
    setTimerNote(`Live settings applied · ${plan.note}`);
  }, [feed.balance, isVirtualAccount, symbol]);

  const handleStopTrade = useCallback(() => {
    const hadOpen = paper.session.open !== null;
    const hadPending = paper.orderPending;
    botHaltRef.current = true;
    scanActiveRef.current = false;
    setBot((current) => ({ ...current, running: false }));
    arm.cancel();
    startSignalRef.current = null;
    setScanningMarket(false);
    if (hadPending) {
      setTimerNote("Stopped · buy still in flight — will track if it fills");
    } else if (hadOpen) {
      setTimerNote("Stopped · open contract still settling on Deriv…");
    } else {
      setTimerNote(null);
    }
  }, [arm, paper.orderPending, paper.session.open]);

  const handleBotToggle = useCallback(async (opts?: { fromOperator?: boolean }) => {
    const fromOperator = opts?.fromOperator === true;
    if (getAiBankroll().armed && !bot.running && !fromOperator) {
      setTimerNote("AI Operator is armed · stop it from the AI tab first");
      return;
    }

    if (bot.running) {
      handleStopTrade();
      return;
    }

    if (arm.arming || scanningMarket) {
      handleStopTrade();
      setTimerNote("Start cancelled");
      return;
    }

    botHaltRef.current = false;

    const botForStart =
      !fromOperator && bot.side === "DIGITDIFF"
        ? config.mode === "live"
          ? applyLiveTradingProfile(
              applyDiffersFastProfile(bot),
              feed.balance,
              isVirtualAccount,
              { preserveStake: true },
            )
          : applyDiffersFastProfile(bot)
        : bot;
    const armSeconds = botForStart.armSeconds;
    scanActiveRef.current = true;
    if (!fromOperator) setMenu("market");

    setScanningMarket(true);
    setTimerNote(
      fromOperator
        ? "AI Operator · scanning markets…"
        : "Scanning markets for best setup…",
    );

    try {
      if (feed.client && feed.state === "ready") {
        const scanBot = fromOperator
          ? { ...botForStart, sidePreference: "matches" as const }
          : {
              ...botForStart,
              sidePreference:
                botForStart.side === "DIGITDIFF"
                  ? ("differs" as const)
                  : ("matches" as const),
            };
        const best = await findBestMarket(feed.client, scanBot, symbol);
        if (!scanActiveRef.current) return;
        const side = fromOperator
          ? ("DIGITMATCH" as const)
          : bot.autoSide
            ? best.signal.side
            : botForStart.side;
        const digit =
          fromOperator && best.signal.side !== "DIGITMATCH"
            ? bot.prediction
            : best.signal.digit;
        startSignalRef.current = {
          side,
          digit,
          label: fromOperator ? `Matches ${digit}` : best.signal.label,
        };
        setBot((current) => ({
          ...current,
          ...botForStart,
          side,
          prediction: digit,
          autoFollow: true,
          autoSide: fromOperator ? false : current.autoSide,
          ...(fromOperator
            ? {
                sidePreference: "matches" as const,
                martingale: false,
                requireFullConfirm: false,
                requireMultiWindow: false,
                requireWindowsEv: false,
                requireUneven: false,
                requireTiming: true,
                stake: Math.min(current.stake, 0.35),
                contracts: 1,
                cooldownTicks: Math.max(current.cooldownTicks, 8),
                maxTradesPerHour: Math.min(current.maxTradesPerHour || 60, 20),
                minSample: Math.min(current.minSample, 500),
              }
            : {}),
        }));
        const pickedSymbol = best.symbol;
        if (pickedSymbol !== symbol) {
          setSymbol(pickedSymbol);
          setTimerNote(`Switching to ${best.name} · loading ticks…`);
          const feedReady = await waitForSymbolFeed(
            pickedSymbol,
            botForStart.minSample,
            () => feedSnapshotRef.current,
            () => !scanActiveRef.current,
          );
          if (!scanActiveRef.current) return;
          if (!feedReady) {
            setTimerNote(`${best.name} · feed slow · using scan pick`);
          }
        }
        setTimerNote(
          fromOperator
            ? `AI · ${best.name} · Matches ${digit}`
            : `Best · ${best.name} · ${best.signal.label}`,
        );
      } else if (scanActiveRef.current) {
        feedAnalyzerToBot();
        setTimerNote("Using current market · feed not ready for full scan");
      }
    } catch {
      if (!scanActiveRef.current) return;
      feedAnalyzerToBot();
      setTimerNote("Market scan skipped · using current symbol");
    } finally {
      setScanningMarket(false);
    }

    if (!scanActiveRef.current) return;

    if (armSeconds <= 0) {
      enterTradeFromSignal();
      return;
    }

    setTimerNote((note) =>
      note
        ? `${note} · arming ${armSeconds}s`
        : `Timer started · ${armSeconds}s · will feed signal and enter`,
    );
    arm.start(armSeconds);
  }, [
    arm,
    bot,
    enterTradeFromSignal,
    feed.client,
    feed.state,
    feedAnalyzerToBot,
    handleStopTrade,
    scanningMarket,
    symbol,
  ]);

  const aiOperator = useAiOperator({
    matchSignal,
    session: paper.session,
    bot,
    symbol,
    client: feed.client,
    feedReady: feed.state === "ready",
    latestEpoch: latest?.epoch ?? null,
    setBot,
    setSymbol,
    startBot: () => {
      void handleBotToggle({ fromOperator: true });
    },
    stopBot: handleStopTrade,
  });

  const attributedTradeIds = useRef(new Set<string>());
  useEffect(() => {
    const newest = paper.session.journal[0];
    if (!newest) return;
    if (attributedTradeIds.current.has(newest.id)) return;
    attributedTradeIds.current.add(newest.id);
    if (newest.note !== AI_TRADE_NOTE) return;
    applyAiTradePnl(newest.pnl);
    pushAiLog(
      `Trade settled · ${newest.won ? "WIN" : "LOSS"} ${newest.pnl >= 0 ? "+" : ""}${newest.pnl.toFixed(2)}`,
    );
  }, [paper.session.journal]);

  const armingLog = [
    ...(scanningMarket ? ["Scanning volatility markets for best setup…"] : []),
    ...(arm.arming && arm.remaining !== null
      ? [`${arm.remaining}s left · ${signal.label} · trade enters at 0`]
      : []),
    ...(timerNote ? [timerNote] : []),
    ...paper.log,
  ];

  if (!isConfigured) return <SetupNotice />;

  return (
    <div className="app">
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        botRunning={bot.running || paper.settling}
      />
      <header className="topbar">
        <BrandMark />

        <nav className="topbar__nav" aria-label="Main sections">
          <button
            type="button"
            className={menu === "market" ? "is-active" : ""}
            onClick={() => setMenu("market")}
          >
            Market
          </button>
          <button
            type="button"
            className={menu === "bot" ? "is-active" : ""}
            onClick={() => setMenu("bot")}
          >
            Bot
          </button>
          <button
            type="button"
            className={menu === "trades" ? "is-active" : ""}
            onClick={() => setMenu("trades")}
          >
            Trades
            {paper.session.trades > 0 ? (
              <em className="topbar__count">{paper.session.trades}</em>
            ) : null}
          </button>
          <button
            type="button"
            className={menu === "ai" ? "is-active" : ""}
            onClick={() => setMenu("ai")}
          >
            AI
            {aiOperator.state.armed ? <em className="topbar__count">ON</em> : null}
          </button>
        </nav>

        <div className="topbar__right">
          <StatusBar
            state={feed.state}
            symbol={symbol}
            loginId={feed.account?.accountId ?? null}
            isVirtual={feed.account?.isVirtual ?? true}
            balance={displayBalance}
            currency={feed.currency}
            mode={config.mode}
            onReconnect={feed.reconnect}
          />
          <button
            type="button"
            className="topbar__theme"
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          <button
            type="button"
            className="topbar__theme"
            onClick={() => setSettingsOpen(true)}
            aria-label="Open settings"
          >
            {feed.account?.isVirtual === false ? "Live" : "Demo"}
          </button>
          <AuthSignOutButton />
        </div>
      </header>

      <main className="stage">
        {feed.error ? <p className="alert">{feed.error}</p> : null}

        <LiveTradingBanner
          mode={config.mode}
          isVirtual={feed.account?.isVirtual ?? true}
          connectionState={feed.state}
          balance={feed.balance}
          currency={feed.currency}
          symbol={symbol}
          botSettings={bot}
        />

        {menu === "trades" ? (
          <TradesPanel
            session={paper.session}
            performance={paper.performance}
            currency={feed.currency}
            symbol={symbol}
          />
        ) : null}

        {menu === "ai" ? (
          <AiPanel
            operator={aiOperator}
            currency={feed.currency}
            mode={config.mode}
            botRunning={bot.running || paper.settling}
          />
        ) : null}

        {menu === "market" ? (
          <section className="workspace workspace--market">
            <header className="workspace__bar">
              <div className="workspace__quote">
                <div>
                  <span>Last</span>
                  <b key={latest?.epoch ?? "q"}>
                    {latest ? latest.quote.toFixed(latest.pipSize) : "—"}
                  </b>
                </div>
                <div className="workspace__digit">
                  <span>Digit</span>
                  <b key={latest?.epoch ?? "d"}>{latest ? latest.digit : "—"}</b>
                </div>
              </div>
              <div className="workspace__controls">
                <MarketSelect value={symbol} onChange={setSymbol} />
                <label className="control window-control">
                  <span>Window</span>
                  <select
                    value={windowSize}
                    onChange={(event) => setWindowSize(Number(event.target.value))}
                  >
                    {WINDOW_SIZES.map((size) => (
                      <option key={size} value={size}>
                        last {size}
                      </option>
                    ))}
                  </select>
                </label>
                {aiOperator.state.armed ? (
                  <>
                    <div className="workspace__ai" aria-live="polite">
                      <em
                        className={`workspace__ai-pill workspace__ai-pill--${aiOperator.state.status}`}
                      >
                        AI · {aiOperator.state.status}
                      </em>
                      <span>
                        Matches <b>{bot.prediction}</b>
                      </span>
                      <span
                        className={
                          aiOperator.pocket.aiPnl >= 0 ? "is-up" : "is-down"
                        }
                      >
                        {aiOperator.pocket.aiPnl >= 0 ? "+" : ""}
                        {aiOperator.pocket.aiPnl.toFixed(2)} {feed.currency}
                      </span>
                      {paper.session.open ? (
                        <em className="workspace__wait is-live">
                          In trade · Matches {paper.session.open.digit}
                        </em>
                      ) : (() => {
                        const lastAi = paper.session.journal.find(
                          (entry) => entry.note === AI_TRADE_NOTE,
                        );
                        if (!lastAi) {
                          return (
                            <em className="workspace__wait">
                              {paper.waitReason ||
                                timerNote ||
                                "Hunting on this market…"}
                            </em>
                          );
                        }
                        return (
                          <em
                            className={`workspace__wait ${
                              lastAi.won ? "is-up" : "is-down"
                            }`}
                          >
                            Last {lastAi.won ? "WIN" : "LOSS"} · Matches{" "}
                            {lastAi.digit} · {lastAi.pnl >= 0 ? "+" : ""}
                            {lastAi.pnl.toFixed(2)}
                          </em>
                        );
                      })()}
                    </div>
                    <button
                      type="button"
                      className="workspace__stop"
                      onClick={() => aiOperator.disarm("Stopped from Market")}
                    >
                      Stop AI
                    </button>
                    <button
                      type="button"
                      className="workspace__cta workspace__cta--ghost"
                      onClick={() => setMenu("ai")}
                    >
                      AI panel
                    </button>
                  </>
                ) : bot.running || arm.arming || scanningMarket ? (
                  <>
                    <div className="workspace__session" aria-live="polite">
                      <span>
                        {paper.session.wins}W / {paper.session.losses}L
                      </span>
                      <span
                        className={
                          paper.session.pnl >= 0 ? "is-up" : "is-down"
                        }
                      >
                        {paper.session.pnl >= 0 ? "+" : ""}
                        {paper.session.pnl.toFixed(2)} {feed.currency}
                      </span>
                      {paper.session.open ? (
                        <em className="workspace__wait is-live">
                          Open ·{" "}
                          {paper.session.open.side === "DIGITMATCH"
                            ? "Matches"
                            : "Differs"}{" "}
                          {paper.session.open.digit} · settling…
                        </em>
                      ) : paper.waitReason ? (
                        <em className="workspace__wait">{paper.waitReason}</em>
                      ) : (
                        <em className="workspace__wait">
                          Hunting ·{" "}
                          {bot.side === "DIGITMATCH" ? "Matches" : "Differs"}{" "}
                          {bot.prediction}
                        </em>
                      )}
                    </div>
                    <button
                      type="button"
                      className="workspace__stop"
                      onClick={handleStopTrade}
                    >
                      {scanningMarket
                        ? "Cancel scan"
                        : arm.arming
                          ? `Stop · ${arm.remaining}s`
                          : paper.settling
                            ? "Stop · settling"
                            : "Stop trade"}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="workspace__cta"
                    onClick={() => {
                      if (config.mode === "live" && feed.state !== "ready") {
                        setTimerNote("Live trading needs Connected socket — wait or Reconnect");
                        return;
                      }
                      setMenu("bot");
                    }}
                  >
                    {config.mode === "live"
                      ? feed.state === "ready"
                        ? "Open bot · live ready"
                        : "Live · connect first"
                      : selectedDigit === null
                        ? "Open bot"
                        : `Send ${selectedDigit}`}
                  </button>
                )}
              </div>
            </header>

            <div className="workspace__body">
              <div className="workspace__chart">
                <TickChart
                  ticks={feed.ticks}
                  symbol={symbol}
                  tradeMarkers={paper.session.journal
                    .filter(
                      (entry) =>
                        !aiOperator.state.armed || entry.note === AI_TRADE_NOTE,
                    )
                    .map((entry) => ({
                      epoch: entry.at,
                      won: entry.won,
                      pnl: entry.pnl,
                    }))}
                />
                <DigitStrip digits={feed.digits} />
              </div>
              <aside className="workspace__side">
                <DigitBars
                  stats={stats}
                  selectedDigit={
                    aiOperator.state.armed ? bot.prediction : selectedDigit
                  }
                  onSelectDigit={(digit) =>
                    setSelectedDigit(digit === selectedDigit ? null : digit)
                  }
                />
                <StatsPanel
                  stats={stats}
                  selectedDigit={
                    aiOperator.state.armed ? bot.prediction : selectedDigit
                  }
                />
                <BrandStamp />
              </aside>
            </div>
          </section>
        ) : menu === "bot" ? (
          <section className="workspace workspace--bot">
            <header className="workspace__bar">
              <div className="workspace__quote">
                <div className="workspace__digit">
                  <span>Live digit</span>
                  <b>{latest ? latest.digit : "—"}</b>
                </div>
                <div>
                  <span>Symbol</span>
                  <b className="workspace__symbol">{symbol}</b>
                </div>
                {bot.running ? <em className="workspace__flag">Trading</em> : null}
                {arm.arming ? (
                  <em className="workspace__flag">Arming {arm.remaining}s</em>
                ) : null}
              </div>
            </header>

            <div className="workspace__bot">
              <ResizableSplit
                left={
                  <AnalyzerPopup
                    stats={stats}
                    signal={signal}
                    matchSignal={matchSignal}
                    diffSignal={diffSignal}
                    bot={bot}
                    latest={latest}
                    symbol={symbol}
                    disabled={bot.running || arm.arming}
                    onApply={(next) => setBot((current) => ({ ...current, ...next }))}
                    onSelectSide={applyManualSide}
                    onOpenMarket={() => setMenu("market")}
                  />
                }
                right={
                  <BotPanel
                    config={config}
                    selectedDigit={selectedDigit}
                    currency={feed.currency}
                    balance={displayBalance}
                    connectionReady={feed.state === "ready"}
                    settings={bot}
                    session={paper.session}
                    performance={paper.performance}
                    runsThisStart={paper.runsThisStart}
                    pnlThisStart={paper.pnlThisStart}
                    log={armingLog}
                    countdown={arm.remaining}
                    armProgress={arm.progress}
                    signalLabel={signal.label}
                    scanning={scanningMarket}
                    operatorControlled={aiOperator.state.armed}
                    differsFastActive={isDiffersFastProfile(bot)}
                    liveProfileActive={
                      config.mode === "live" &&
                      isLiveTradingProfile(bot, feed.balance, isVirtualAccount)
                    }
                    isVirtual={isVirtualAccount}
                    tradingMode={config.mode}
                    onApplyLiveSettings={
                      config.mode === "live" ? applyLiveSettings : undefined
                    }
                    settling={paper.settling}
                    onChange={setBot}
                    onSelectSide={applyManualSide}
                    onRestoreDiffersFast={restoreDiffersFast}
                    onToggle={() => {
                      void handleBotToggle();
                    }}
                  />
                }
              />
            </div>
          </section>
        ) : null}
      </main>
    </div>
  );
}
