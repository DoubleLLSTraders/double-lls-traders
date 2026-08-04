import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ResizableSplit } from "./components/ResizableSplit";
import { AnalyzerPopup } from "./components/AnalyzerPopup";
import { BotPanel, type BotSettings } from "./components/BotPanel";
import { DigitBars } from "./components/DigitBars";
import { DigitStrip } from "./components/DigitStrip";
import { MARKETS, MarketSelect, isOneSecondMarket, volatilityTag } from "./components/MarketSelect";
import { StatsPanel } from "./components/StatsPanel";
import { BrandStamp } from "./components/BrandStamp";
import {
  DeskChangeDialog,
  type DeskChangeState,
} from "./components/DeskChangeDialog";
import { SettingsModal, type SettingsTab } from "./components/SettingsModal";
import { StatusBar } from "./components/StatusBar";
import { TickChart } from "./components/TickChart";
import { AiPanel } from "./components/AiPanel";
import { AuthSignOutButton } from "./components/AuthGate";
import { TradesPanel } from "./components/TradesPanel";
import { useOptionalAppAuth } from "./context/AuthContext";
import {
  clearOauthSession,
  getSelectedOauthAccount,
  readOauthSession,
  selectOauthAccount,
} from "./lib/deriv/oauth";
import { isClientRole } from "./lib/appRole";
import { recoveryRequirements } from "./lib/bot/gates";
import { isLowPayoutSymbol } from "./lib/bot/performance";
import { useArmTimer } from "./hooks/useArmTimer";
import { useAiOperator } from "./hooks/useAiOperator";
import { useDerivFeed } from "./hooks/useDerivFeed";
import { useMarketSweep } from "./hooks/useMarketSweep";
import { usePaperBot } from "./hooks/usePaperBot";
import { useTheme } from "./hooks/useTheme";
import { summarise } from "./lib/analysis/digits";
import {
  deskOf,
  isOverUnderSide,
  sideLabel,
  type TradeDesk,
} from "./lib/analysis/contractSide";
import {
  buildOverUnderSignal,
  isMomentumHoldable,
  MOMENTUM_COMMIT_MAX_LOSSES,
  MOMENTUM_COMMIT_RUNS,
  MOMENTUM_MIN_CHANCE_EDGE_PP,
  MOMENTUM_MIN_DEEP_EDGE_PP,
  MOMENTUM_MIN_EDGE_PP,
  MOMENTUM_MIN_MICRO_EDGE_PP,
  MOMENTUM_MIN_STREAK,
  MOMENTUM_MIN_TILT_PP,
  MOMENTUM_RECOVERY_MIN_STREAK,
  pickBetterOverUnder,
  rankMomentumBoard,
  rankSafePairByChance,
  type OuEntryMode,
  type OverUnderSide,
} from "./lib/analysis/overUnder";
import {
  buildMarketSignal,
  pickBetterSignal,
  type ContractSide,
} from "./lib/analysis/signal";
import { findBestMarket } from "./lib/analysis/bestMarket";
import type { MarketSweep } from "./lib/analysis/marketSweep";
import { proposeDigitContract } from "./lib/deriv/trade";
import {
  advanceAnalyzerDirector,
  DEAD_MARKET_MS,
  emptyTapeTemper,
  isPromisingSetup,
  resolveAnalyzerPace,
  shouldHoldMarket,
  shouldHuntOtherMarket,
  type AnalyzerDirective,
  type AnalyzerHold,
  type TapeTemper,
} from "./lib/analysis/analyzerDirector";
import {
  applyDiffersFastProfile,
  createDiffersFastBotSettings,
  DIFFERS_FAST_SYMBOL,
  isDeskTradeReady,
  isDiffersFastProfile,
} from "./lib/bot/differsProfile";
import {
  applyMatchesFirmProfile,
  isMatchesFirmProfile,
  MATCHES_FIRM_SYMBOL,
} from "./lib/bot/matchesProfile";
import {
  applyOverUnderProfile,
  isOverUnderProfile,
  OVER_UNDER_SYMBOL,
} from "./lib/bot/overUnderProfile";
import {
  applyLiveTradingProfile,
  isLiveTradingProfile,
  liveSettingsForBalance,
  planLiveStake,
  withContractMoneyLimits,
} from "./lib/bot/liveProfile";
import { BOT_SETTINGS_VERSION } from "./lib/bot/version";
import { storageKey } from "./lib/platform";
import { resumeAudioIfNeeded, unlockAudio } from "./lib/sound";
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

const WINDOW_SIZES = [500, 1000, 1500, 2000] as const;
/**
 * Windows used for multi-window agreement on the bot signal.
 *
 * Telling a genuine 12% digit from 10% noise needs ~865 samples at 95%
 * confidence, so anything shorter mostly confirms randomness.
 */
const AGREEMENT_WINDOWS = [500, 1000, 1500] as const;
const BOT_SETTINGS_KEY = storageKey("bot-settings");
/** Survives bot-settings version migrations — user desk choice must stick. */
const TRADE_DESK_KEY = storageKey("trade-desk");

/** Volatility carousel — 1s indices only (skip slow R_* and cheap payout). */
const VOL_CYCLE = MARKETS.filter(
  (m) => m.oneSecond && !isLowPayoutSymbol(m.symbol),
).map((m) => m.symbol);

function nextVolatilitySymbol(current: string): string {
  const idx = VOL_CYCLE.indexOf(current as (typeof VOL_CYCLE)[number]);
  if (idx < 0) return VOL_CYCLE[0] ?? "1HZ75V";
  return VOL_CYCLE[(idx + 1) % VOL_CYCLE.length] ?? VOL_CYCLE[0] ?? "1HZ75V";
}

/** Wait for the feed to reload after switching volatility index. */
async function waitForSymbolFeed(
  targetSymbol: string,
  minTicks: number,
  readSnapshot: () => {
    symbol: string;
    streamSymbol: string | null;
    state: string;
    tickCount: number;
    switching: boolean;
  },
  cancelled: () => boolean,
  timeoutMs = 20000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cancelled()) return false;
    const snap = readSnapshot();
    // Wait until the live stream is on the target symbol (not just React state).
    if (
      snap.streamSymbol === targetSymbol &&
      snap.state === "ready" &&
      !snap.switching &&
      snap.tickCount >= minTicks
    ) {
      return true;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 120));
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

function loadTradeDesk(): TradeDesk | null {
  try {
    const value = localStorage.getItem(TRADE_DESK_KEY);
    if (value === "overunder" || value === "digits") return value;
  } catch {
    /* ignore */
  }
  return null;
}

function saveTradeDesk(desk: TradeDesk) {
  try {
    localStorage.setItem(TRADE_DESK_KEY, desk);
  } catch {
    /* ignore */
  }
}

function deskFromStoredSide(
  side: BotSettings["side"] | undefined,
): TradeDesk | null {
  if (!side) return null;
  return deskOf(side);
}

/** Re-apply the user's desk after a settings schema migration. */
function applyPreservedDesk(
  base: BotSettings,
  side: BotSettings["side"] | undefined,
  desk: TradeDesk | null,
  /** Saved auto-side. undefined lets the desk profile choose. */
  savedAutoSide?: boolean,
): BotSettings {
  const wantOu =
    desk === "overunder" ||
    side === "DIGITOVER" ||
    side === "DIGITUNDER";
  if (wantOu) {
    const next = applyOverUnderProfile(base);
    return {
      ...next,
      side: side === "DIGITUNDER" ? "DIGITUNDER" : next.side,
      prediction:
        side === "DIGITOVER" || side === "DIGITUNDER"
          ? (base.prediction ?? next.prediction)
          : next.prediction,
      autoSide: savedAutoSide ?? next.autoSide,
    };
  }
  if (side === "DIGITMATCH") {
    return {
      ...applyMatchesFirmProfile(base),
      side: "DIGITMATCH",
      autoSide: false,
    };
  }
  if (desk === "digits" || side === "DIGITDIFF") {
    return {
      ...applyDiffersFastProfile(base),
      side: "DIGITDIFF",
    };
  }
  return base;
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
  const savedDesk = loadTradeDesk();
  try {
    const raw = localStorage.getItem(BOT_SETTINGS_KEY);
    if (!raw) {
      if (savedDesk === "overunder") {
        const ou = withWorkableRecovery(applyOverUnderProfile(defaults));
        saveTradeDesk("overunder");
        return ou;
      }
      saveTradeDesk("digits");
      return withWorkableRecovery(defaults);
    }
    const parsed = JSON.parse(raw) as Partial<BotSettings> & { _v?: number };
    const preservedSide = parsed.side;
    const deskHint = savedDesk ?? deskFromStoredSide(preservedSide);

    // A version bump migrates gates/defaults but MUST keep the user's desk.
    if (parsed._v !== BOT_SETTINGS_VERSION) {
      const money = {
        stake: parsed.stake ?? defaults.stake,
        dailyProfitTarget:
          parsed.dailyProfitTarget ?? defaults.dailyProfitTarget,
        takeProfit: parsed.takeProfit ?? defaults.takeProfit,
        stopLoss: parsed.stopLoss ?? defaults.stopLoss,
        maxRuns: parsed.maxRuns ?? defaults.maxRuns,
        maxConsecutiveLosses:
          parsed.maxConsecutiveLosses ?? defaults.maxConsecutiveLosses,
        maxTradesPerDay: parsed.maxTradesPerDay ?? defaults.maxTradesPerDay,
        maxStake: parsed.maxStake ?? defaults.maxStake,
        prediction: parsed.prediction ?? defaults.prediction,
        running: false as const,
      };
      const migrated = withWorkableRecovery(
        applyPreservedDesk(
          { ...defaults, ...money },
          preservedSide,
          deskHint,
          parsed.autoSide,
        ),
      );
      saveTradeDesk(deskOf(migrated.side));
      return migrated;
    }

    // Same version: the Bot form is the source of truth, so load it verbatim.
    let merged = { ...defaults, ...parsed, running: false };
    merged.maxStake = Math.max(merged.maxStake, merged.stake);

    // Desk key wins if settings were corrupted back to Differs while user
    // last chose Over/Under (or the reverse).
    if (deskHint === "overunder" && deskOf(merged.side) !== "overunder") {
      merged = applyPreservedDesk(merged, preservedSide, "overunder");
    } else if (deskHint === "digits" && deskOf(merged.side) === "overunder") {
      // Bot side is OU but desk key says digits — trust the more recent bot.side
      // and fix the desk key below.
    }

    const ready = withWorkableRecovery(merged);
    saveTradeDesk(deskOf(ready.side));
    return ready;
  } catch {
    if (savedDesk === "overunder") {
      return withWorkableRecovery(applyOverUnderProfile(defaults));
    }
    return withWorkableRecovery(defaults);
  }
}

function saveBotSettings(settings: BotSettings) {
  const { running: _running, ...persist } = settings;
  saveTradeDesk(deskOf(settings.side));
  localStorage.setItem(
    BOT_SETTINGS_KEY,
    // 0 when this state never went through loadBotSettings, which marks it
    // stale so the next page load migrates it properly.
    JSON.stringify({ ...persist, _v: loadedVersion ?? 0 }),
  );
}

/** Live H:MM:SS (or M:SS) countdown for Custom / timed bulk sessions. */
function formatSessionLeft(msLeft: number): string {
  const totalSec = Math.max(0, Math.ceil(msLeft / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function SessionCountdown({ endAtMs }: { endAtMs: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endAtMs <= 0) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [endAtMs]);
  if (endAtMs <= 0) return null;
  const left = Math.max(0, endAtMs - now);
  return (
    <strong className="workspace__clock" title="Timed session remaining">
      <span className="workspace__clock-label">Left</span>
      {formatSessionLeft(left)}
    </strong>
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
        <small>Digits · Over/Under · Secured desk</small>
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

function AccountKindPill({
  isVirtual,
  accounts,
  selected,
  onSelect,
}: {
  isVirtual: boolean;
  accounts: Array<{ loginid: string; kind: "demo" | "real"; currency: string }>;
  selected: string | null;
  onSelect: (loginid: string) => void;
}) {
  if (accounts.length > 1) {
    return (
      <label className="topbar__account-pill">
        <span className="sr-only">Account</span>
        <select
          value={selected ?? accounts[0]?.loginid ?? ""}
          onChange={(e) => onSelect(e.target.value)}
          aria-label="Demo or Live account"
        >
          {accounts.map((a) => (
            <option key={a.loginid} value={a.loginid}>
              {a.kind === "demo" ? "Demo" : "Live"} · {a.loginid}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <span className="topbar__theme" title={isVirtual ? "Demo balance" : "Live balance"}>
      {isVirtual ? "Demo" : "Live"}
    </span>
  );
}

export default function App({
  onHubChange,
  clientMode = false,
  tradingLocked = false,
  onClientSignOut,
}: {
  onHubChange?: (hub: import("./lib/hub").HubId) => void;
  /** Public Over/Under-only desk (no admin menus). */
  clientMode?: boolean;
  /** True until Deriv OAuth session is ready. */
  tradingLocked?: boolean;
  onClientSignOut?: () => void;
} = {}) {
  const { theme, toggleTheme } = useTheme();
  const [menu, setMenu] = useState<AppMenu>("market");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("profile");
  const auth = useOptionalAppAuth();
  const clientDesk = clientMode || isClientRole();
  const [symbol, setSymbol] = useState(() =>
    clientDesk
      ? OVER_UNDER_SYMBOL
      : isLowPayoutSymbol(config.symbol)
        ? DIFFERS_FAST_SYMBOL
        : config.symbol,
  );
  const [windowSize, setWindowSize] = useState<number>(500);
  const [selectedDigit, setSelectedDigit] = useState<number | null>(null);
  const [bot, setBot] = useState<BotSettings>(() => loadBotSettings());
  const [timerNote, setTimerNote] = useState<string | null>(null);
  const [deskChange, setDeskChange] = useState<DeskChangeState | null>(null);
  const deskChangeCancelRef = useRef(false);
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

  // Persist desk choice whenever side changes (survives refresh + migrations).
  useEffect(() => {
    saveTradeDesk(deskOf(bot.side));
  }, [bot.side]);

  // Preload more than the largest window so signals are valid immediately.
  const feed = useDerivFeed(symbol, 2500);

  // Heal stale Over/Under gates + fake TP floor (was MIN_STAKE 0.35 → 12 runs).
  useEffect(() => {
    if (deskOf(bot.side) !== "overunder") return;
    if (bot.running) return;
    const staleSample = bot.minSample > 80;
    const staleGap = bot.maxMomentumGap > 1;
    const stalePace = bot.analyzerPace !== "overunder-firm";
    const staleMoney =
      bot.takeProfitManual !== true &&
      bot.maxRunsManual !== true &&
      (bot.maxRuns > 3 || bot.takeProfit >= bot.stake - 0.001);
    if (!staleSample && !staleGap && !stalePace && !staleMoney) return;
    setBot((current) => {
      const next = applyOverUnderProfile(current);
      const sided = {
        ...next,
        side:
          current.side === "DIGITUNDER" || current.side === "DIGITOVER"
            ? current.side
            : next.side,
        prediction: current.prediction,
        takeProfitManual: false,
        maxRunsManual: current.maxRunsManual === true,
      };
      return withContractMoneyLimits(
        sided,
        feed.account?.isVirtual ?? true,
      );
    });
    setTimerNote("Over/Under · TP = one barrier win · payout synced");
  }, [
    bot.side,
    bot.minSample,
    bot.maxMomentumGap,
    bot.analyzerPace,
    bot.running,
    bot.takeProfitManual,
    bot.maxRunsManual,
    bot.maxRuns,
    bot.takeProfit,
    bot.stake,
    bot.prediction,
    feed.account?.isVirtual,
  ]);

  // Bot + Digits use ≥ minSample ticks (desk floor, not a hard 1500).
  const tradeWindow = Math.max(windowSize, bot.minSample);
  const tradeStats = useMemo(
    () => summarise(feed.digits.slice(-tradeWindow)),
    [feed.digits, tradeWindow],
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
      minSampleForHigh: bot.minSample,
      symbol,
    }),
    [
      agreementStats,
      bot.minEdgePercent,
      bot.maxMomentumGap,
      bot.minColdGap,
      bot.minSample,
      symbol,
    ],
  );

  const tradeDesk = deskOf(bot.side);
  const tradeDigits = useMemo(
    () => feed.digits.slice(-tradeWindow),
    [feed.digits, tradeWindow],
  );

  const matchSignal = useMemo(
    () =>
      buildMarketSignal(tradeStats, "DIGITMATCH", bot.prediction, signalOptions),
    [tradeStats, bot.prediction, signalOptions],
  );
  const diffSignal = useMemo(
    () =>
      buildMarketSignal(tradeStats, "DIGITDIFF", bot.prediction, signalOptions),
    [tradeStats, bot.prediction, signalOptions],
  );
  const overSignal = useMemo(
    () =>
      buildOverUnderSignal(
        tradeDigits,
        tradeStats,
        "DIGITOVER",
        bot.prediction,
        signalOptions,
      ),
    [tradeDigits, tradeStats, bot.prediction, signalOptions],
  );
  const underSignal = useMemo(
    () =>
      buildOverUnderSignal(
        tradeDigits,
        tradeStats,
        "DIGITUNDER",
        bot.prediction,
        signalOptions,
      ),
    [tradeDigits, tradeStats, bot.prediction, signalOptions],
  );
  const signal = useMemo(() => {
    if (tradeDesk === "overunder") {
      if (bot.autoSide) return pickBetterOverUnder(overSignal, underSignal);
      return bot.side === "DIGITUNDER" ? underSignal : overSignal;
    }
    if (bot.autoSide) {
      return pickBetterSignal(matchSignal, diffSignal, bot.sidePreference);
    }
    return bot.side === "DIGITMATCH" ? matchSignal : diffSignal;
  }, [
    tradeDesk,
    bot.autoSide,
    bot.side,
    bot.sidePreference,
    matchSignal,
    diffSignal,
    overSignal,
    underSignal,
  ]);

  // Analyzer director — advanced during render so Digits + desk share one tick.
  const analyzerHoldRef = useRef<AnalyzerHold | null>(null);
  const tapeTemperRef = useRef<TapeTemper>(emptyTapeTemper());
  const analyzerEpochRef = useRef<number | null>(null);
  const [analyzerDirective, setAnalyzerDirective] =
    useState<AnalyzerDirective | null>(null);
  /** Queued during render; flushed in layout so ticks paint before Digits UI. */
  const pendingDirectiveRef = useRef<AnalyzerDirective | null>(null);
  const analyzerBuyNowRef = useRef(false);
  /** Synced in the same render as director advance — executor reads this, not lagged state. */
  const analyzerSnapRef = useRef<{
    buyNow: boolean;
    digit: number;
    side: ContractSide;
    armedEpoch: number | null;
    label: string;
    detail: string;
    /** Momentum outcome gap for OU Trade now (not Differs cold gap). */
    entryGap: number | null;
  }>({
    buyNow: false,
    digit: 0,
    side: "DIGITDIFF",
    armedEpoch: null,
    label: "Watch",
    detail: "",
    entryGap: null,
  });
  /** Bumps when Trade now arms — forces executor layout pass same turn. */
  const [tradeNowWake, setTradeNowWake] = useState(0);
  /** Instant fire — usePaperBot assigns; called on Trade now rising edge. */
  const executorFireRef = useRef<(() => void) | null>(null);
  /**
   * Updated after usePaperBot each render. Director (earlier in render) reads
   * the previous tick's busy flag — enough to clear a sticky Trade now arm.
   */
  const executorBusyRef = useRef(false);
  /**
   * This Start's P/L — Shield recovery mode when underwater (Over 0 / Under 9).
   * Updated after usePaperBot; director reads the previous frame's value.
   */
  const sessionPnlRef = useRef(0);
  /**
   * Executor sets this when it refuses an armed Trade now (skip-first, cool,
   * wait-drop). Digits must drop the arm immediately — otherwise UI says
   * Trade now / In trade while the bot only waits.
   */
  const executorArmCancelRef = useRef(false);
  const latestTick = feed.ticks[feed.ticks.length - 1] ?? null;
  const deskGate = {
    minColdGap: bot.minColdGap,
    minSample: bot.minSample,
    maxMomentumGap: bot.maxMomentumGap,
    // Auto-side: gate against the live signal so Over↔Under / Match↔Diff can flip.
    side: bot.autoSide ? signal.side : bot.side,
  };

  const tradeNowStayUntilRef = useRef(0);
  const deadSinceRef = useRef<number | null>(null);
  const marketArriveRef = useRef(Date.now());
  /** While bot runs: force market scan if no Trade now / open trade for too long. */
  const idleSinceTradeRef = useRef(Date.now());
  const wasBotRunningRef = useRef(false);
  /**
   * Armed pick lock. Once Confirming / Trade now names a barrier, that call is
   * final for its window — the analyzer may never swap barrier or side under a
   * bot that already acted on it. A moved pick stands the call down instead.
   */
  const pickLatchRef = useRef<{
    side: ContractSide;
    digit: number;
    untilMs: number;
  } | null>(null);
  /** No re-arm right after a stand-down — stops instant flip-flop calls. */
  const standDownUntilRef = useRef(0);
  /**
   * Over/Under entry mode.
   *
   * One run (default): reads the history the moment Start is pressed, buys
   * the barrier most likely to land among the paying barriers, and stops
   * when that single contract settles. One trade per Start, no hopping.
   *
   * Momentum: keeps scanning number after number on the tape and fires
   * within seconds of each pick. Measured over 80k ticks the expectancy is
   * the ~2pp house edge, so stop-loss / session limits are the protection.
   *
   * Proven only: Trade now requires the search-corrected lower bound to clear
   * payout break-even. Statistically honest; may not trade for hours.
   */
  // v2 key: the old key only stored momentum/proven, so a stale value would
  // pin every existing desk out of One run.
  const [entryMode, setEntryModeState] = useState<OuEntryMode>(() => {
    try {
      const saved = localStorage.getItem(storageKey("ou-entry-mode-v2"));
      if (saved === "proven" || saved === "momentum" || saved === "oneRun") {
        return saved;
      }
      return "oneRun";
    } catch {
      return "oneRun";
    }
  });
  const oneRunMode = entryMode === "oneRun";
  /** Both non-proven modes share the fast plan machinery. */
  const momentumMode = entryMode !== "proven";
  /** The one-run buy already went out for this Start — stay quiet. */
  const oneRunFiredRef = useRef(false);
  /**
   * Confirm window after Start: the history pick must repeat on consecutive
   * ticks before the buy goes out, so the desk sees how the tape is moving
   * instead of firing off a single frozen read.
   */
  const oneRunConfirmRef = useRef<{
    side: OverUnderSide;
    barrier: number;
    count: number;
    startedMs: number;
  } | null>(null);
  /**
   * The number this run actually bought. Held until the next Start so the
   * card, the bot prediction and the contract can never drift apart — the
   * raw blitz signal keeps its own favourite and used to take the display
   * back over the moment the buy went out.
   */
  const oneRunPickRef = useRef<{
    side: OverUnderSide;
    barrier: number;
  } | null>(null);
  /** When this Start began waiting — drives the confirm ceiling only. */
  const oneRunStartMsRef = useRef(0);
  /** When the buy was armed — the arm is held until the executor fills it. */
  const oneRunArmedMsRef = useRef(0);
  const ONE_RUN_CONFIRM_TICKS = 2;
  /**
   * Over 0 / Under 9 both sit near 90%. Anything under this means the live
   * window is still warming — wait, don't fire a cold read.
   */
  const ONE_RUN_MIN_CHANCE = 85;
  /** How long Start waits for the pick to settle before firing anyway. */
  const ONE_RUN_MAX_CONFIRM_MS = 8_000;
  /** Keep the call armed this long waiting for a fill (executor cool-downs). */
  const ONE_RUN_ARM_MAX_MS = 15_000;
  const setEntryMode = useCallback((mode: OuEntryMode) => {
    setEntryModeState(mode);
    ouStudyRef.current = null;
    ouPlanRef.current = null;
    ouPendingFireRef.current = null;
    ouCommittedRef.current = null;
    ouPlansOnMarketRef.current = 0;
    ouRotateRef.current = false;
    ouNoEdgeSinceRef.current = null;
    ouRecentPicksRef.current = [];
    oneRunFiredRef.current = false;
    oneRunConfirmRef.current = null;
    oneRunPickRef.current = null;
    try {
      localStorage.setItem(storageKey("ou-entry-mode-v2"), mode);
    } catch {
      /* ignore */
    }
  }, []);
  /**
   * Plan cycle for momentum mode: study the tape (~10–15s), commit to the
   * barrier in best form, trade that one barrier steadily, re-study when
   * the plan expires. After OU_PLANS_PER_MARKET plans (or a flat tape)
   * the planner rotates to the sweep's steadiest market.
   */
  const ouStudyRef = useRef<{
    side: OverUnderSide;
    barrier: number;
    count: number;
    sinceMs: number;
    /** Soft misses while locking — one tick miss does not restart. */
    misses: number;
  } | null>(null);
  const ouPlanRef = useRef<{
    side: OverUnderSide;
    barrier: number;
    longPct: number;
    recentPct: number;
    netPp: number;
    expiresAtMs: number;
    /** Consecutive still-clean ticks after the plan arms — must prove before Trade now. */
    confirmCount: number;
    /** Buys taken on this pick — one and done, then rotate. */
    fires: number;
  } | null>(null);
  const momentumCoolUntilRef = useRef(0);
  /** Plans completed on this market — rotation counter. */
  const ouPlansOnMarketRef = useRef(0);
  /** When the current no-edge stretch began — drives the rotate timer. */
  const ouNoEdgeSinceRef = useRef<number | null>(null);
  /** Planner verdict: this market is flat / done — move to a steadier one. */
  const ouRotateRef = useRef(false);
  const marketSwitchBusy = useRef(false);
  /** When hop/switch started — watchdog clears a stuck busy flag. */
  const marketSwitchStartedRef = useRef(0);
  const ouHopQueuedRef = useRef(false);
  /** Prevent hop spam / stuck Rotating when switch never finishes. */
  const lastOuHopAtRef = useRef(0);
  const hopNextVolatilityRef = useRef<
    (
      reason: string,
      force?: boolean,
      opts?: { ignoreStay?: boolean },
    ) => Promise<void>
  >(async () => {});
  /** Latest deep-sweep snapshot for fast OU hops (declared early for hop closure). */
  const sweepRef = useRef<MarketSweep | null>(null);
  /**
   * Last few momentum picks — excluded from the next scan so Momentum cannot
   * lock onto one barrier (Under 9 was the usual freeze).
   */
  const ouRecentPicksRef = useRef<
    Array<{ side: OverUnderSide; barrier: number }>
  >([]);
  /** After a lock/fire/abandon, skip that barrier for a few later picks. */
  const OU_RECENT_SKIP = 3;
  /**
   * Shield study: short lock — do not park minutes on one barrier.
   */
  /** Clean → buy on the next tick (many runs, no long Lock parks). */
  const OU_STUDY_TICKS_RECOVERY = 1;
  const OU_STUDY_MIN_MS_RECOVERY = 50;
  const OU_STUDY_TICKS_GROWTH = 1;
  const OU_STUDY_MIN_MS_GROWTH = 80;
  /** Misses allowed during Locking before the study restarts. */
  const OU_STUDY_MAX_MISSES = 1;
  /** Cool after a fill arms — keep short. */
  const OU_FIRE_COOL_MS = 200;
  /** Between elite commit runs — keep the stake on that tape. */
  const OU_COMMIT_FIRE_COOL_MS = 80;
  /** After loss: brief cool, ban that barrier, hop market. */
  const OU_LOSS_COOL_MS_GROWTH = 1_200;
  const OU_LOSS_COOL_MS_RECOVERY = 800;
  const lastSessionPnlRef = useRef(0);
  /** Hold Trade now until fill so the executor cannot miss the arm. */
  const OU_FIRE_ARM_MS = 5_000;
  /**
   * Momentum fire latched until paper orderPending/open — same pattern as
   * one-run arm. Prevents cool/hunt from clearing buyNow before the buy.
   */
  const ouPendingFireRef = useRef<{
    side: OverUnderSide;
    digit: number;
    untilMs: number;
  } | null>(null);
  /**
   * Barrier locked for Trade now / open contract / post-settle hold.
   * Digits must not hunt a different number until holdUntilMs.
   */
  const ouCommittedRef = useRef<{
    side: OverUnderSide;
    digit: number;
    /** Keep UI frozen until this time (covers in-trade + short after-settle). */
    holdUntilMs: number;
    /** True only after a real buy (pending/open) — not a skipped Trade now. */
    filled: boolean;
  } | null>(null);
  /**
   * Elite commit — once a top steady setup is found, stake that barrier on
   * this market up to 7 fast runs (breaks after 2 losses or tape goes cold).
   */
  const ouEliteCommitRef = useRef<{
    side: OverUnderSide;
    barrier: number;
    symbol: string;
    runsLeft: number;
    losses: number;
  } | null>(null);
  /** After a fill settles, brief digit freeze only (not a fake In trade). */
  const OU_POST_TRADE_HOLD_MS = 800;
  const OU_PICKS_PER_MARKET = 8;
  /**
   * After Start or a market hop: brief tape glance only (a few seconds).
   * Cleared when either the clock OR tick count is met — never both required
   * (tick counting was leaving Settling stuck for minutes at "0s · N ticks").
   */
  const OU_MARKET_SETTLE_MS = 1_500;
  const OU_MARKET_SETTLE_TICKS = 3;
  /** Recovery: almost no settle — quality gate is live ≥ BE. */
  const OU_MARKET_SETTLE_MS_RECOVERY = 300;
  const OU_MARKET_SETTLE_TICKS_RECOVERY = 1;
  /** Brief settle on a new tape, then free to leave if still dry. */
  const OU_MIN_MARKET_DWELL_MS = 3_000;
  /** Hop fast when dry so runs keep coming on hotter markets. */
  const OU_NO_EDGE_ROTATE_MS_RECOVERY = 2_500;
  const OU_NO_EDGE_ROTATE_MS_GROWTH = 3_000;
  const OU_MAX_MARKET_DWELL_MS_RECOVERY = 6_000;
  const OU_MAX_MARKET_DWELL_MS_GROWTH = 7_000;
  /** Ticks seen on the current symbol since arrive / Start. */
  const marketTicksRef = useRef(0);
  const marketTickEpochRef = useRef<number | null>(null);
  /**
   * Re-locks on this market. A tape that cannot keep one barrier is not
   * tradable — each restart refreshes the lock hold, so churn must force a hop.
   */
  const lockChurnRef = useRef(0);

  // Drop a refused Trade now on any render (not only a new tick) so Digits
  // cannot sit on FIRE / In trade while the bot is only waiting.
  if (executorArmCancelRef.current && momentumMode) {
    executorArmCancelRef.current = false;
    const skipped = ouPendingFireRef.current;
    if (skipped) {
      ouRecentPicksRef.current = [
        { side: skipped.side, barrier: skipped.digit },
        ...ouRecentPicksRef.current,
      ].slice(0, OU_RECENT_SKIP);
    }
    ouPendingFireRef.current = null;
    if (!ouCommittedRef.current?.filled) {
      ouCommittedRef.current = null;
    }
    momentumCoolUntilRef.current = Math.max(
      momentumCoolUntilRef.current,
      Date.now() + 400,
    );
    if (analyzerBuyNowRef.current || analyzerSnapRef.current.buyNow) {
      analyzerBuyNowRef.current = false;
      analyzerSnapRef.current = {
        ...analyzerSnapRef.current,
        buyNow: false,
        armedEpoch: null,
        label: "Watch",
        detail: skipped
          ? `Skipped ${sideLabel(skipped.side)} ${skipped.digit} · next cycle`
          : "Skipped Trade now · next cycle",
      };
      pendingDirectiveRef.current = {
        gate:
          pendingDirectiveRef.current?.gate ??
          analyzerDirective?.gate ?? { ok: false, reason: "arm cancelled" },
        digit: analyzerSnapRef.current.digit,
        side: analyzerSnapRef.current.side,
        buyNow: false,
        hold: null,
        temper: tapeTemperRef.current,
        label: analyzerSnapRef.current.label,
        detail: analyzerSnapRef.current.detail,
      };
    }
  }

  if (
    latestTick &&
    analyzerEpochRef.current !== latestTick.epoch
  ) {
    analyzerEpochRef.current = latestTick.epoch;
    const pace = resolveAnalyzerPace(bot.analyzerPace);
    const nowMs = Date.now();
    const raw = advanceAnalyzerDirector(
      analyzerHoldRef.current,
      symbol,
      signal,
      deskGate,
      tapeTemperRef.current,
      pace,
    );

    const latch = pickLatchRef.current;
    const latchLive = latch !== null && nowMs < latch.untilMs;
    const movedOffLatch =
      latchLive &&
      latch !== null &&
      (raw.digit !== latch.digit || raw.side !== latch.side);

    let next = raw;
    // Momentum / One run own OU — strip proven-director Trade now so a live
    // signal flip cannot arm a different barrier in the same second.
    if (
      (momentumMode || oneRunMode) &&
      isOverUnderSide(deskGate.side)
    ) {
      next = {
        ...raw,
        buyNow: false,
        hold: null,
        label:
          raw.label === "Trade now" || raw.label === "Confirming"
            ? "Watch"
            : raw.label,
      };
    }
    if (movedOffLatch && latch && !momentumMode && !oneRunMode) {
      // Analyzer wandered off its own armed call — stand down, do not switch.
      pickLatchRef.current = null;
      standDownUntilRef.current = nowMs + 4_000;
      lockChurnRef.current += 2;
      analyzerHoldRef.current = null;
      next = {
        ...raw,
        buyNow: false,
        hold: null,
        label: "Watch",
        detail: `Stood down · call was ${sideLabel(latch.side)} ${latch.digit} · re-reading tape`,
        digit: latch.digit,
        side: latch.side,
      };
    } else if (
      !momentumMode &&
      !oneRunMode &&
      raw.buyNow &&
      nowMs < standDownUntilRef.current
    ) {
      // Cooling off a flip — prove again before another Trade now.
      next = {
        ...raw,
        buyNow: false,
        label: "Confirming",
        detail: `${sideLabel(raw.side)} ${raw.digit} · settle after flip · re-proving`,
      };
    }

    // One run — only Over 0 vs Under 9. Both land ~90%; pick the hotter of
    // the two, confirm, buy once, stop. No other barriers enter the race.
    if (oneRunMode && isOverUnderSide(deskGate.side)) {
      const board = rankSafePairByChance(feed.digits);
      const pick = board[0] ?? null;
      const rival = board[1];
      const runnersUp = rival
        ? `${sideLabel(rival.side)} ${rival.barrier} ${rival.chancePercent.toFixed(1)}%`
        : "";
      // Steadiness is tracked all the time, Start or no Start: the number is
      // only "settled" once the same one comes back tick after tick.
      if (pick) {
        const held = oneRunConfirmRef.current;
        if (held && held.side === pick.side && held.barrier === pick.barrier) {
          held.count += 1;
        } else {
          oneRunConfirmRef.current = {
            side: pick.side,
            barrier: pick.barrier,
            count: 1,
            startedMs: nowMs,
          };
        }
      }
      const confirm = oneRunConfirmRef.current;
      const steadyTicks = confirm?.count ?? 0;
      const settled = pick != null && steadyTicks >= ONE_RUN_CONFIRM_TICKS;

      if (oneRunFiredRef.current) {
        // Locked to the contract that went out — never hand the display back
        // to the blitz signal while the run is settling.
        const locked = oneRunPickRef.current;
        next = {
          ...next,
          buyNow: false,
          hold: null,
          digit: locked?.barrier ?? next.digit,
          side: locked?.side ?? next.side,
          label: "Run done",
          detail: locked
            ? `Traded ${sideLabel(locked.side)} ${locked.barrier} · press Start for another`
            : "One run traded · press Start for another",
        };
      } else if (oneRunPickRef.current) {
        // Armed and waiting for the fill. The call is held on the locked
        // number so an executor cool-down cannot lose the run, and cannot
        // fill a different barrier than the one on screen.
        const locked = oneRunPickRef.current;
        const armedMs = nowMs - oneRunArmedMsRef.current;
        if (armedMs >= ONE_RUN_ARM_MAX_MS) {
          oneRunPickRef.current = null;
          next = {
            ...next,
            buyNow: false,
            hold: null,
            digit: locked.barrier,
            side: locked.side,
            label: "Studying",
            detail: `${sideLabel(locked.side)} ${locked.barrier} never filled · reading history again`,
          };
        } else {
          next = {
            ...next,
            buyNow: true,
            hold: null,
            digit: locked.barrier,
            side: locked.side,
            label: "Trade now",
            detail: `ONE RUN · ${sideLabel(locked.side)} ${locked.barrier} · locked · buying`,
          };
        }
      } else if (!pick) {
        next = {
          ...next,
          buyNow: false,
          hold: null,
          label: "Reading history",
          detail: `${feed.digits.length} ticks · need 40`,
        };
      } else {
        const confident = pick.chancePercent >= ONE_RUN_MIN_CHANCE;
        const answerReady = confident && settled;
        const tiltLine = `${pick.tilt >= 0 ? "+" : ""}${pick.tilt.toFixed(1)}pp`;
        const pickLine = `${sideLabel(pick.side)} ${pick.barrier} ×${pick.payout.toFixed(2)} · ${pick.chancePercent.toFixed(1)}% chance · live ${pick.livePercent.toFixed(1)}% (${tiltLine}) · EV ${pick.evPercent >= 0 ? "+" : ""}${pick.evPercent.toFixed(1)}%`;
        if (!bot.running) {
          next = {
            ...next,
            buyNow: false,
            hold: null,
            digit: pick.barrier,
            side: pick.side,
            label: answerReady ? "Answer ready" : "0 vs 9",
            detail: answerReady
              ? `${pickLine} · steady ${steadyTicks} ticks · Start to fire`
              : `Over 0 / Under 9 only · ${pickLine} · needs ${ONE_RUN_MIN_CHANCE}%${runnersUp ? ` · rival ${runnersUp}` : ""}`,
          };
        } else {
          // Running: fire the settled answer. The pick can move between the
          // top barriers as the tape leans, so a flip resets steadiness —
          // the wait ceiling stops that from stalling the run forever.
          const waitedMs = nowMs - (oneRunStartMsRef.current || nowMs);
          const easeOff = waitedMs >= ONE_RUN_MAX_CONFIRM_MS && confident;
          if (answerReady || easeOff) {
            oneRunPickRef.current = { side: pick.side, barrier: pick.barrier };
            oneRunArmedMsRef.current = nowMs;
            oneRunConfirmRef.current = null;
            next = {
              ...next,
              buyNow: true,
              hold: null,
              digit: pick.barrier,
              side: pick.side,
              label: "Trade now",
              detail: `ONE RUN · ${pickLine} · buy`,
            };
          } else {
            next = {
              ...next,
              buyNow: false,
              hold: null,
              digit: pick.barrier,
              side: pick.side,
              label: "Confirming",
              detail: `${pickLine} · ${confident ? `steady ${steadyTicks}/${ONE_RUN_CONFIRM_TICKS}` : `needs ${ONE_RUN_MIN_CHANCE}%`}${runnersUp ? ` · rival ${runnersUp}` : ""}`,
            };
          }
        }
      }
    } else if (momentumMode && isOverUnderSide(deskGate.side)) {
      // Once Trade now / in trade locks a barrier, Digits must not hunt another.
      const pending = ouPendingFireRef.current;
      const fireLatched =
        pending !== null &&
        nowMs < pending.untilMs &&
        !executorBusyRef.current;

      // Stretch hold while the contract is open (busy can lag one frame).
      if (ouCommittedRef.current && executorBusyRef.current) {
        const held = ouCommittedRef.current.holdUntilMs || 0;
        ouCommittedRef.current = {
          ...ouCommittedRef.current,
          filled: true,
          holdUntilMs: Math.max(held, nowMs + OU_POST_TRADE_HOLD_MS),
        };
      }

      // Release only after busy is clear AND post-settle hold expired (filled only).
      if (
        ouCommittedRef.current &&
        !executorBusyRef.current &&
        !ouPendingFireRef.current &&
        (!ouCommittedRef.current.filled ||
          nowMs >= ouCommittedRef.current.holdUntilMs)
      ) {
        const done = ouCommittedRef.current;
        if (done.filled) {
          ouRecentPicksRef.current = [
            { side: done.side, barrier: done.digit },
            ...ouRecentPicksRef.current,
          ].slice(0, OU_RECENT_SKIP);
        }
        ouCommittedRef.current = null;
      }

      const frozen =
        ouCommittedRef.current ??
        (ouPendingFireRef.current
          ? {
              side: ouPendingFireRef.current.side,
              digit: ouPendingFireRef.current.digit,
              holdUntilMs: ouPendingFireRef.current.untilMs,
              filled: false,
            }
          : null);
      const pendingArm = ouPendingFireRef.current;
      const freezeUi =
        frozen !== null &&
        (executorBusyRef.current ||
          pendingArm !== null ||
          (ouCommittedRef.current?.filled === true &&
            nowMs < ouCommittedRef.current.holdUntilMs));

      if (freezeUi && frozen) {
        const busy = executorBusyRef.current;
        const stillFiring =
          pendingArm !== null &&
          nowMs < pendingArm.untilMs &&
          !busy;
        next = {
          ...next,
          buyNow: stillFiring,
          hold: null,
          digit: frozen.digit,
          side: frozen.side,
          label: busy
            ? "In trade"
            : stillFiring
              ? "Trade now"
              : "Holding",
          detail: busy
            ? `LOCKED ${sideLabel(frozen.side)} ${frozen.digit} · in trade · no switch`
            : stillFiring
              ? `FIRE ${sideLabel(frozen.side)} ${frozen.digit} · executor buying · no switch`
              : `LOCKED ${sideLabel(frozen.side)} ${frozen.digit} · hold after trade · no switch`,
        };
      } else if (
        !fireLatched &&
        ouPlanRef.current &&
        nowMs >= ouPlanRef.current.expiresAtMs
      ) {
        ouPlanRef.current = null;
        pickLatchRef.current = null;
        ouPlansOnMarketRef.current += 1;
      }

      if (!freezeUi) {
      if (ouRotateRef.current || marketSwitchBusy.current) {
        const hopping = marketSwitchBusy.current;
        next = {
          ...next,
          buyNow: false,
          hold: null,
          label: hopping ? "Rotating" : "Hunting",
          detail: hopping
            ? `Hop → next market…`
            : "No elite here · switching market…",
        };
        // Kick hop after this turn — never sit behind proving/interval gates.
        // Do not require !executorBusy — a stale busy flag was freezing hops.
        if (!hopping && !ouHopQueuedRef.current) {
          ouStudyRef.current = null;
          ouPlanRef.current = null;
          ouPendingFireRef.current = null;
          analyzerHoldRef.current = null;
          analyzerBuyNowRef.current = false;
          ouHopQueuedRef.current = true;
          queueMicrotask(() => {
            ouHopQueuedRef.current = false;
            void hopNextVolatilityRef.current(
              "Hunt elite · next market",
              true,
              { ignoreStay: true },
            );
          });
        }
      } else if (!ouPlanRef.current) {
        // Shield: Over 0 / Under 9 — settle market first, then clean only.
        const recovery = sessionPnlRef.current < -0.001;
        const studyTicks = recovery
          ? OU_STUDY_TICKS_RECOVERY
          : OU_STUDY_TICKS_GROWTH;
        const studyMinMs = recovery
          ? OU_STUDY_MIN_MS_RECOVERY
          : OU_STUDY_MIN_MS_GROWTH;
        const noEdgeRotateMs = recovery
          ? OU_NO_EDGE_ROTATE_MS_RECOVERY
          : OU_NO_EDGE_ROTATE_MS_GROWTH;
        const maxMarketDwellMs = recovery
          ? OU_MAX_MARKET_DWELL_MS_RECOVERY
          : OU_MAX_MARKET_DWELL_MS_GROWTH;
        const marketAge = nowMs - marketArriveRef.current;
        const latestEpoch = feed.ticks[feed.ticks.length - 1]?.epoch ?? null;
        if (
          latestEpoch !== null &&
          latestEpoch !== marketTickEpochRef.current
        ) {
          marketTickEpochRef.current = latestEpoch;
          marketTicksRef.current += 1;
        }
        const settleMs = recovery
          ? OU_MARKET_SETTLE_MS_RECOVERY
          : OU_MARKET_SETTLE_MS;
        const settleTicks = recovery
          ? OU_MARKET_SETTLE_TICKS_RECOVERY
          : OU_MARKET_SETTLE_TICKS;
        const marketSettled =
          marketAge >= settleMs ||
          marketTicksRef.current >= settleTicks;
        if (!marketSettled) {
          // Do not lock or fire while the new tape is still warming.
          ouStudyRef.current = null;
          const secLeft = Math.max(
            0,
            Math.ceil((settleMs - marketAge) / 1000),
          );
          next = {
            ...next,
            buyNow: false,
            hold: null,
            label: "Settling",
            detail: `Settle ${secLeft}s · hunt elite Over 1–2 / Under 7–8`,
          };
        } else {
        const commit = ouEliteCommitRef.current;
        const commitLive =
          commit !== null &&
          commit.symbol === symbol &&
          commit.runsLeft > 0 &&
          commit.losses < MOMENTUM_COMMIT_MAX_LOSSES;
        // During elite commit, do not exclude the committed barrier.
        const board = rankMomentumBoard(feed.digits, {
          exclude: commitLive ? [] : ouRecentPicksRef.current,
          recovery,
        });
        const studyHold = ouStudyRef.current;
        const studyPick =
          studyHold == null
            ? null
            : (board.find(
                (entry) =>
                  entry.side === studyHold.side &&
                  entry.barrier === studyHold.barrier,
              ) ?? null);
        const commitPick =
          commitLive && commit
            ? (board.find(
                (entry) =>
                  entry.side === commit.side &&
                  entry.barrier === commit.barrier,
              ) ?? null)
            : null;
        const studyHoldable =
          studyPick !== null &&
          (studyPick.elite ||
            (commitLive && isMomentumHoldable(studyPick)));
        const eliteBoard =
          board.find((entry) => entry.elite) ?? null;
        // Commit sticks to its barrier; otherwise only elite may start a lock.
        const focus =
          commitLive && commitPick
            ? commitPick
            : studyHold && studyPick
              ? studyPick
              : studyHold
                ? null
                : eliteBoard;
        // Broken commit tape (under BE) → leave; soft study misses do not.
        if (
          commitLive &&
          commitPick &&
          commitPick.livePercent < commitPick.breakEven
        ) {
          ouEliteCommitRef.current = null;
          ouStudyRef.current = null;
          ouRotateRef.current = true;
        } else if (studyHold && !studyHoldable) {
          studyHold.misses += 1;
          if (studyHold.misses > OU_STUDY_MAX_MISSES) {
            if (!commitLive) {
              ouRecentPicksRef.current = [
                { side: studyHold.side, barrier: studyHold.barrier },
                ...ouRecentPicksRef.current,
              ].slice(0, OU_RECENT_SKIP);
            }
            ouStudyRef.current = null;
          }
        } else if (studyHold && studyHoldable) {
          studyHold.misses = 0;
        }
        const closest = board[0] ?? null;
        const runners = board
          .filter((entry) => entry.elite || entry.clean)
          .slice(0, 3)
          .map(
            (entry) =>
              `${sideLabel(entry.side)} ${entry.barrier} +${entry.edgePp.toFixed(0)}pp s${entry.streak}${entry.elite ? "★" : ""}`,
          )
          .join(" · ");
        const lockingActive = ouStudyRef.current !== null;
        if (focus || lockingActive || commitLive) {
          ouNoEdgeSinceRef.current = null;
        } else if (ouNoEdgeSinceRef.current === null) {
          ouNoEdgeSinceRef.current = nowMs;
        }
        const dryMs =
          ouNoEdgeSinceRef.current === null
            ? 0
            : nowMs - ouNoEdgeSinceRef.current;
        const dwelled = marketAge >= OU_MIN_MARKET_DWELL_MS;
        const dryTooLong = dryMs >= noEdgeRotateMs;
        const stuckWaiting =
          marketAge >= maxMarketDwellMs &&
          !focus &&
          ouStudyRef.current === null &&
          !commitLive;
        const workedOut =
          ouPlansOnMarketRef.current >= OU_PICKS_PER_MARKET;
        // Never rotate away from an active elite commit.
        if (
          !commitLive &&
          dwelled &&
          (workedOut || dryTooLong || stuckWaiting)
        ) {
          // Flag hop — UI stays "Hunting" (Rotating only while switch is in flight).
          ouRotateRef.current = true;
          ouNoEdgeSinceRef.current = null;
          ouStudyRef.current = null;
          ouPlanRef.current = null;
          ouRecentPicksRef.current = [];
          next = {
            ...next,
            buyNow: false,
            hold: null,
            label: marketSwitchBusy.current ? "Rotating" : "Hunting",
            detail: stuckWaiting
              ? `No elite tape ${Math.round(marketAge / 1000)}s · next market`
              : dryTooLong
                ? `No elite ${Math.round(dryMs / 1000)}s · next market`
                : `${ouPlansOnMarketRef.current} picks · next market`,
          };
          if (!marketSwitchBusy.current && !ouHopQueuedRef.current) {
            ouHopQueuedRef.current = true;
            queueMicrotask(() => {
              ouHopQueuedRef.current = false;
              void hopNextVolatilityRef.current(
                "Hunt elite · next market",
                true,
                { ignoreStay: true },
              );
            });
          }
        } else if (!closest) {
          if (ouRecentPicksRef.current.length > 0) {
            ouRecentPicksRef.current = [];
          }
          next = {
            ...next,
            buyNow: false,
            hold: null,
            label: "Studying",
            detail: `Hunt elite Over 1–2 / Under 7–8 · ${feed.digits.length} ticks`,
          };
        } else if (!focus && !ouStudyRef.current) {
          const streakNeed = MOMENTUM_MIN_STREAK;
          const deepNeed = MOMENTUM_MIN_DEEP_EDGE_PP;
          const microNeed = MOMENTUM_MIN_MICRO_EDGE_PP;
          const need =
            closest.edgePp < closest.edgeNeed
              ? `needs +${(closest.edgeNeed - closest.edgePp).toFixed(1)}pp over BE (have ${closest.edgePp >= 0 ? "+" : ""}${closest.edgePp.toFixed(1)})`
              : closest.deepEdgePp < deepNeed
                ? `needs deep elite (deep ${closest.deepPercent.toFixed(0)}% vs BE ${closest.breakEven.toFixed(1)}%)`
                : closest.microEdgePp < microNeed
                  ? `needs micro elite (µ ${closest.microPercent.toFixed(0)}%)`
                  : closest.streak < streakNeed
                    ? `needs streak ${streakNeed} (now ${closest.streak})`
                    : closest.gap !== null && closest.gap > 1
                      ? `needs recent win (gap ${closest.gap})`
                      : `warming · +${closest.edgePp.toFixed(1)}pp · µ ${closest.microPercent.toFixed(0)}%`;
          next = {
            ...next,
            buyNow: false,
            hold: null,
            digit: closest.barrier,
            side: closest.side,
            label: "Waiting clean",
            detail: `Elite hunt ${sideLabel(closest.side)} ${closest.barrier} · live ${closest.livePercent.toFixed(1)}% · µ${closest.microPercent.toFixed(0)}% · deep ${closest.deepPercent.toFixed(0)}% · BE ${closest.breakEven.toFixed(1)}% · ${need}`,
          };
        } else if (nowMs < momentumCoolUntilRef.current && focus) {
          const coolLeft = Math.max(
            0,
            Math.ceil((momentumCoolUntilRef.current - nowMs) / 1000),
          );
          const commitTag = commitLive
            ? ` · commit ${commit!.runsLeft}/${MOMENTUM_COMMIT_RUNS}`
            : "";
          next = {
            ...next,
            buyNow: false,
            hold: null,
            digit: focus.barrier,
            side: focus.side,
            label: "Next pick",
            detail: `HOLD ${sideLabel(focus.side)} ${focus.barrier} · +${focus.edgePp.toFixed(1)}pp · cool ${coolLeft}s${commitTag}${runners ? ` · ${runners}` : ""}`,
          };
        } else if (focus || ouStudyRef.current) {
          const study = ouStudyRef.current;
          const locked =
            study && studyPick
              ? studyPick
              : focus ?? studyPick;
          if (
            locked &&
            study &&
            study.side === locked.side &&
            study.barrier === locked.barrier &&
            studyHoldable
          ) {
            study.count += 1;
          } else if (locked && !study) {
            ouStudyRef.current = {
              side: locked.side,
              barrier: locked.barrier,
              count: 1,
              sinceMs: nowMs,
              misses: 0,
            };
          } else if (
            study &&
            !studyHoldable &&
            study.misses <= OU_STUDY_MAX_MISSES
          ) {
            next = {
              ...next,
              buyNow: false,
              hold: null,
              digit: study.barrier,
              side: study.side,
              label: "Locking",
              detail: `ELITE ${sideLabel(study.side)} ${study.barrier} · soft miss · ${study.count}/${studyTicks}`,
            };
          }
          const confirmed = ouStudyRef.current;
          const heldMs = confirmed ? nowMs - confirmed.sinceMs : 0;
          // Elite only to open; committed runs may continue while holdable.
          const readyToFire =
            locked != null &&
            (locked.elite ||
              (commitLive &&
                isMomentumHoldable(locked) &&
                locked.livePercent >= locked.breakEven));
          const steadyEnough =
            confirmed !== null &&
            locked != null &&
            readyToFire &&
            confirmed.count >= studyTicks &&
            heldMs >= studyMinMs &&
            nowMs >= momentumCoolUntilRef.current &&
            ouPendingFireRef.current === null;
          if (steadyEnough && confirmed && locked) {
            if (!ouEliteCommitRef.current) {
              ouEliteCommitRef.current = {
                side: confirmed.side,
                barrier: confirmed.barrier,
                symbol,
                runsLeft: MOMENTUM_COMMIT_RUNS,
                losses: 0,
              };
            }
            const c = ouEliteCommitRef.current;
            const runNo = MOMENTUM_COMMIT_RUNS - c.runsLeft + 1;
            c.runsLeft = Math.max(0, c.runsLeft - 1);
            ouPendingFireRef.current = {
              side: confirmed.side,
              digit: confirmed.barrier,
              untilMs: nowMs + OU_FIRE_ARM_MS,
            };
            ouCommittedRef.current = {
              side: confirmed.side,
              digit: confirmed.barrier,
              holdUntilMs: nowMs + OU_FIRE_ARM_MS,
              filled: false,
            };
            ouStudyRef.current = null;
            ouPlanRef.current = null;
            ouPlansOnMarketRef.current += 1;
            next = {
              ...next,
              buyNow: true,
              hold: null,
              digit: confirmed.barrier,
              side: confirmed.side,
              label: "Trade now",
              detail: `ELITE COMMIT ${sideLabel(confirmed.side)} ${confirmed.barrier} · gap ${locked.gap ?? "—"} · +${locked.edgePp.toFixed(1)}pp · run ${runNo}/${MOMENTUM_COMMIT_RUNS} · buy`,
            };
            // Stash momentum gap for trade history (not Differs cold gap).
            analyzerSnapRef.current = {
              ...analyzerSnapRef.current,
              entryGap:
                typeof locked.gap === "number" ? locked.gap : null,
            };
          } else if (locked && confirmed) {
            const c = ouEliteCommitRef.current;
            const commitTag = c
              ? ` · commit ${c.runsLeft} left`
              : "";
            next = {
              ...next,
              buyNow: false,
              hold: null,
              digit: locked.barrier,
              side: locked.side,
              label: "Locking",
              detail: `ELITE ${sideLabel(locked.side)} ${locked.barrier} ×${locked.payout.toFixed(2)} · live ${locked.livePercent.toFixed(1)}% · deep ${locked.deepPercent.toFixed(0)}% · +${locked.edgePp.toFixed(1)}pp · s${locked.streak} · ${confirmed.count}/${studyTicks}${commitTag}`,
            };
          }
        }
        } // end marketSettled
      }
      } // end !freezeUi
    }

    // Sticky Trade now until executor takes the order (or arm times out / skip).
    if (ouPendingFireRef.current) {
      const arm = ouPendingFireRef.current;
      if (executorBusyRef.current) {
        const commitCool =
          ouEliteCommitRef.current !== null &&
          ouEliteCommitRef.current.symbol === symbol &&
          ouEliteCommitRef.current.runsLeft > 0;
        momentumCoolUntilRef.current =
          nowMs + (commitCool ? OU_COMMIT_FIRE_COOL_MS : OU_FIRE_COOL_MS);
        ouCommittedRef.current = {
          side: arm.side,
          digit: arm.digit,
          holdUntilMs: nowMs + OU_POST_TRADE_HOLD_MS,
          filled: true,
        };
        ouPendingFireRef.current = null;
        next = {
          ...next,
          buyNow: false,
          hold: null,
          digit: arm.digit,
          side: arm.side,
          label: "In trade",
          detail: `LOCKED ${sideLabel(arm.side)} ${arm.digit} · in trade · no switch`,
        };
      } else if (nowMs >= arm.untilMs) {
        // No fill — drop arm and restore the burned commit run.
        const c = ouEliteCommitRef.current;
        if (c && c.symbol === symbol) {
          c.runsLeft = Math.min(MOMENTUM_COMMIT_RUNS, c.runsLeft + 1);
        }
        ouRecentPicksRef.current = [
          { side: arm.side, barrier: arm.digit },
          ...ouRecentPicksRef.current,
        ].slice(0, OU_RECENT_SKIP);
        ouPendingFireRef.current = null;
        if (!ouCommittedRef.current?.filled) {
          ouCommittedRef.current = null;
        }
      } else {
        ouCommittedRef.current = {
          side: arm.side,
          digit: arm.digit,
          holdUntilMs: arm.untilMs,
          filled: false,
        };
        next = {
          ...next,
          buyNow: true,
          hold: null,
          digit: arm.digit,
          side: arm.side,
          label: "Trade now",
          detail:
            next.buyNow && next.label === "Trade now"
              ? next.detail
              : `FIRE ${sideLabel(arm.side)} ${arm.digit} · executor buying · no switch`,
        };
      }
    } else if (ouCommittedRef.current?.filled && executorBusyRef.current) {
      const held = ouCommittedRef.current;
      ouCommittedRef.current = {
        ...held,
        holdUntilMs: Math.max(
          held.holdUntilMs || 0,
          nowMs + OU_POST_TRADE_HOLD_MS,
        ),
      };
      next = {
        ...next,
        buyNow: false,
        hold: null,
        digit: held.digit,
        side: held.side,
        label: "In trade",
        detail: `LOCKED ${sideLabel(held.side)} ${held.digit} · in trade · no switch`,
      };
    }

    const prevHoldKey = analyzerHoldRef.current?.key ?? null;
    if (next.hold && prevHoldKey && next.hold.key !== prevHoldKey) {
      lockChurnRef.current += 1;
    }
    analyzerHoldRef.current = next.hold;
    tapeTemperRef.current = next.temper;
    const wasBuyNow = analyzerBuyNowRef.current;
    analyzerBuyNowRef.current = next.buyNow;
    analyzerSnapRef.current = {
      buyNow: next.buyNow,
      digit: next.digit,
      side: next.side,
      armedEpoch: next.buyNow ? latestTick.epoch : null,
      label: next.label,
      detail: next.detail,
      entryGap: next.buyNow
        ? analyzerSnapRef.current.entryGap
        : null,
    };
    // Glue market through Confirm → Trade now → buy. Do not hop mid-fire.
    // Lock / confirm extensions are capped so one tape cannot pin the hunt.
    const stayCeiling =
      marketArriveRef.current + pace.maxMarketDwellMs + 4_000;
    if (next.buyNow) {
      pickLatchRef.current = {
        side: next.side,
        digit: next.digit,
        untilMs: nowMs + 12_000,
      };
      tradeNowStayUntilRef.current = nowMs + 15_000;
      // Rising edge — fire executor this turn (sync + microtask + layout wake).
      if (!wasBuyNow) {
        executorFireRef.current?.();
        queueMicrotask(() => {
          executorFireRef.current?.();
          setTradeNowWake((n) => n + 1);
        });
      }
    } else if (next.hold?.phase === "confirm") {
      pickLatchRef.current = {
        side: next.side,
        digit: next.digit,
        untilMs: nowMs + 8_000,
      };
      tradeNowStayUntilRef.current = Math.min(
        stayCeiling,
        Math.max(tradeNowStayUntilRef.current, nowMs + 8_000),
      );
    } else if (next.hold?.phase === "lock" && next.hold.count >= 2) {
      tradeNowStayUntilRef.current = Math.min(
        stayCeiling,
        Math.max(tradeNowStayUntilRef.current, nowMs + 3_000),
      );
    }
    // Snap is live for the executor this turn; Digits UI updates after paint.
    pendingDirectiveRef.current = next;
  }

  useLayoutEffect(() => {
    const pending = pendingDirectiveRef.current;
    if (!pending) return;
    pendingDirectiveRef.current = null;
    setAnalyzerDirective(pending);
  });

  // Keep prediction + OU take-profit glued to the live analyzer barrier.
  useEffect(() => {
    if (!analyzerDirective) return;
    const digit = analyzerDirective.digit;
    const dirSide = analyzerDirective.side;
    setBot((current) => {
      const nextSide = current.autoSide ? dirSide : current.side;
      const samePick =
        current.prediction === digit &&
        current.autoFollow &&
        current.side === nextSide;
      // Timed hour OU: keep full-clock session (TP comfort only). Quick: resync TP.
      const timedHours = (current.sessionHours ?? 0) > 0;
      const oneRunOu = oneRunMode && isOverUnderSide(nextSide);
      const next: BotSettings = {
        ...current,
        prediction: digit,
        autoFollow: true,
        side: nextSide,
        // One run: hold the single-contract limit against the auto-sizer.
        maxRuns: oneRunOu ? 1 : current.maxRuns,
        maxRunsManual: oneRunOu || timedHours ? true : false,
        sessionHours: oneRunOu ? 0 : (current.sessionHours ?? 0),
        takeProfitManual: timedHours ? true : current.takeProfitManual,
      };
      if (!isOverUnderSide(next.side)) {
        return samePick ? current : { ...next, maxRunsManual: current.maxRunsManual };
      }
      const money = withContractMoneyLimits(
        next,
        feed.account?.isVirtual ?? true,
      );
      if (
        samePick &&
        Math.abs(money.takeProfit - current.takeProfit) < 0.005 &&
        money.maxRuns === current.maxRuns &&
        Math.abs(money.stopLoss - current.stopLoss) < 0.005
      ) {
        return current;
      }
      return money;
    });
  }, [
    analyzerDirective?.digit,
    analyzerDirective?.side,
    analyzerDirective?.buyNow,
    feed.account?.isVirtual,
    oneRunMode,
  ]);

  useEffect(() => {
    analyzerHoldRef.current = null;
    analyzerEpochRef.current = null;
    tapeTemperRef.current = emptyTapeTemper();
    analyzerBuyNowRef.current = false;
    ouPendingFireRef.current = null;
    ouCommittedRef.current = null;
    analyzerSnapRef.current = {
      buyNow: false,
      digit: signal.digit,
      side: signal.side,
      armedEpoch: null,
      label: "Watch",
      detail: "",
    };
    setAnalyzerDirective(null);
  }, [symbol]);

  // Production browsers mute until a gesture — prime on first tap, resume on tab focus.
  useEffect(() => {
    const onGesture = () => {
      unlockAudio();
      window.removeEventListener("pointerdown", onGesture, true);
      window.removeEventListener("keydown", onGesture, true);
    };
    window.addEventListener("pointerdown", onGesture, true);
    window.addEventListener("keydown", onGesture, true);
    const onVis = () => {
      if (document.visibilityState === "visible") resumeAudioIfNeeded();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pointerdown", onGesture, true);
      window.removeEventListener("keydown", onGesture, true);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // Keep Mode cards + prediction locked to the live market pick when auto-side
  // is on — except Momentum / One run OU, where Digits director owns the
  // barrier so a live signal flip cannot yank BOT mid Trade now.
  useEffect(() => {
    if (!bot.autoSide) return;
    if (
      isOverUnderSide(signal.side) &&
      (momentumMode || oneRunMode) &&
      analyzerDirective
    ) {
      return;
    }
    setBot((current) => {
      const next: BotSettings = {
        ...current,
        side: signal.side,
        prediction: signal.digit,
        autoFollow: true,
      };
      const samePick =
        current.side === signal.side &&
        current.prediction === signal.digit &&
        current.autoFollow;
      if (!isOverUnderSide(signal.side)) {
        return samePick ? current : next;
      }
      const money = withContractMoneyLimits(
        next,
        feed.account?.isVirtual ?? true,
      );
      if (
        samePick &&
        Math.abs(money.takeProfit - current.takeProfit) < 0.005 &&
        money.maxRuns === current.maxRuns
      ) {
        return current;
      }
      return money;
    });
  }, [
    bot.autoSide,
    signal.side,
    signal.digit,
    feed.account?.isVirtual,
    momentumMode,
    oneRunMode,
    analyzerDirective,
  ]);

  const signalRef = useRef(signal);
  signalRef.current = signal;
  const feedSnapshotRef = useRef({
    symbol,
    streamSymbol: feed.streamSymbol,
    state: feed.state,
    tickCount: feed.ticks.length,
    switching: feed.switching,
  });
  feedSnapshotRef.current = {
    symbol,
    streamSymbol: feed.streamSymbol,
    state: feed.state,
    tickCount: feed.ticks.length,
    switching: feed.switching,
  };
  const latest = feed.ticks[feed.ticks.length - 1];

  const applyManualSide = useCallback(
    (side: ContractSide) => {
      // Drop proving hold so Digits / executor follow the new side immediately.
      analyzerHoldRef.current = null;
      analyzerEpochRef.current = null;
      analyzerBuyNowRef.current = false;
      tapeTemperRef.current = emptyTapeTemper();
      const digit =
        side === "DIGITMATCH"
          ? matchSignal.digit
          : side === "DIGITDIFF"
            ? diffSignal.digit
            : side === "DIGITUNDER"
              ? underSignal.digit
              : overSignal.digit;
      analyzerSnapRef.current = {
        buyNow: false,
        digit,
        side,
        armedEpoch: null,
        label: "Watch",
        detail: "",
      };
      setAnalyzerDirective(null);

      setBot((current) => {
        const withDigit = {
          ...current,
          prediction: digit,
          autoSide: false,
          autoFollow: true,
          side,
        };
        if (side === "DIGITMATCH") {
          return {
            ...applyMatchesFirmProfile(withDigit),
            prediction: digit,
            // Keep the run alive if already hunting — only flip the desk side.
            running: current.running,
          };
        }
        if (side === "DIGITOVER" || side === "DIGITUNDER") {
          const profiled = {
            ...applyOverUnderProfile(withDigit),
            side,
            prediction: digit,
            autoSide: false,
            running: current.running,
          };
          return withContractMoneyLimits(
            profiled,
            feed.account?.isVirtual ?? true,
          );
        }
        return {
          ...applyDiffersFastProfile(withDigit),
          prediction: digit,
          running: current.running,
        };
      });
      if (side === "DIGITMATCH" && isLowPayoutSymbol(symbol)) {
        setSymbol(MATCHES_FIRM_SYMBOL);
      } else if (side === "DIGITDIFF" && isLowPayoutSymbol(symbol)) {
        setSymbol(DIFFERS_FAST_SYMBOL);
      } else if (isOverUnderSide(side) && isLowPayoutSymbol(symbol)) {
        setSymbol(OVER_UNDER_SYMBOL);
      }
      setTimerNote(`Mode · ${sideLabel(side)} selected`);
    },
    [
      matchSignal.digit,
      diffSignal.digit,
      overSignal.digit,
      underSignal.digit,
      symbol,
      feed.account?.isVirtual,
    ],
  );

  /** Clear OU latches and hop now — never sit on "Rotating" for minutes. */
  const requestOuMarketHop = useCallback((reason: string) => {
    ouRotateRef.current = true;
    ouStudyRef.current = null;
    ouPlanRef.current = null;
    ouPendingFireRef.current = null;
    ouNoEdgeSinceRef.current = null;
    analyzerHoldRef.current = null;
    analyzerBuyNowRef.current = false;
    // Unstick ghost busy (set without a start stamp, or hung >3s).
    if (marketSwitchBusy.current) {
      const started = marketSwitchStartedRef.current;
      const hung =
        started === 0 || Date.now() - started > 3_000;
      if (hung) {
        marketSwitchBusy.current = false;
        marketSwitchStartedRef.current = 0;
        switchHoldRef.current = false;
      } else {
        return;
      }
    }
    void hopNextVolatilityRef.current(reason, true, { ignoreStay: true });
  }, []);

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
      marketSwitchStartedRef.current = Date.now();
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
          // Hold bot while the tick stream hot-swaps — no full reconnect.
          switchHoldRef.current = true;
          setSymbol(best.symbol);
          setBot((current) => ({
            ...current,
            side: current.autoSide ? best.signal.side : current.side,
            prediction: best.signal.digit,
            autoFollow: true,
          }));
          setTimerNote(
            note ?? `Auto · ${best.name} · loading live ticks…`,
          );
          const ready = await waitForSymbolFeed(
            best.symbol,
            Math.max(500, bot.minSample),
            () => feedSnapshotRef.current,
            () => botHaltRef.current,
            20000,
          );
          switchHoldRef.current = false;
          if (!ready) {
            setTimerNote(`${best.name} · feed slow after switch`);
          } else {
            setTimerNote(
              note ?? `Auto · ${best.name} · ${best.signal.label}`,
            );
          }
        } else if (note) {
          setTimerNote(note);
        }
        return best;
      } finally {
        switchHoldRef.current = false;
        marketSwitchBusy.current = false;
        marketSwitchStartedRef.current = 0;
      }
    },
    [feed.client, feed.state, scanBotSettings, symbol, bot.minSample],
  );

  const symbolHopRef = useRef(symbol);
  symbolHopRef.current = symbol;
  const botGateRef = useRef({
    minColdGap: bot.minColdGap,
    minSample: bot.minSample,
    maxMomentumGap: bot.maxMomentumGap,
    side: bot.side,
    running: bot.running,
    analyzerPace: bot.analyzerPace,
  });
  botGateRef.current = {
    minColdGap: bot.minColdGap,
    minSample: bot.minSample,
    maxMomentumGap: bot.maxMomentumGap,
    side: bot.side,
    running: bot.running,
    analyzerPace: bot.analyzerPace,
  };

  /**
   * Hunt next volatility for a steadier tape.
   * force=true leaves soft Almost / stalled Locking; never cuts Confirming / Trade now.
   */
  const hopNextVolatility = useCallback(
    async (
      reason: string,
      force = false,
      opts?: { ignoreStay?: boolean },
    ) => {
      if (!feed.client || feed.state !== "ready") return;
      const now = Date.now();
      // Stuck busy — free the desk (also when start stamp was never set).
      if (marketSwitchBusy.current) {
        const started = marketSwitchStartedRef.current;
        if (started === 0 || now - started > 3_000) {
          marketSwitchBusy.current = false;
          switchHoldRef.current = false;
          marketSwitchStartedRef.current = 0;
        } else {
          return;
        }
      }
      const hold = analyzerHoldRef.current;
      const buyNow = analyzerBuyNowRef.current === true;
      const pace = resolveAnalyzerPace(botGateRef.current.analyzerPace);
      const gateNow = botGateRef.current;
      const ouHunt =
        isOverUnderSide(gateNow.side) ||
        deskOf(gateNow.side) === "overunder";
      // OU rotate must leave even if a stale Trade now / lock is stuck.
      if (ouHunt && (ouRotateRef.current || opts?.ignoreStay)) {
        analyzerHoldRef.current = null;
        analyzerBuyNowRef.current = false;
      } else {
        // Never change market while Confirming, Trade now, or buy park window.
        if (buyNow || hold?.phase === "confirm") return;
        if (!opts?.ignoreStay && now < tradeNowStayUntilRef.current) return;
        if (!force) {
          if (shouldHoldMarket(hold, buyNow, now, pace.lockMs)) return;
          if (
            isPromisingSetup(signalRef.current, {
              minColdGap: botGateRef.current.minColdGap,
              minSample: botGateRef.current.minSample,
              maxMomentumGap: botGateRef.current.maxMomentumGap,
              side: botGateRef.current.side,
            })
          ) {
            return;
          }
        } else if (
          !opts?.ignoreStay &&
          shouldHoldMarket(hold, buyNow, now, pace.lockMs)
        ) {
          return;
        }
      }
      // Drop stalled lock so the next market starts clean.
      analyzerHoldRef.current = null;
      analyzerBuyNowRef.current = false;
      ouRotateRef.current = false;
      ouStudyRef.current = null;
      ouPlanRef.current = null;
      ouPendingFireRef.current = null;
      // Pure carousel — always a different 1s market (no sweep sticky target).
      const from = symbolHopRef.current;
      let next = nextVolatilitySymbol(from);
      if (next === from) {
        next =
          VOL_CYCLE.find((symbol) => symbol !== from) ??
          nextVolatilitySymbol(from);
      }
      lastOuHopAtRef.current = now;
      analyzerSnapRef.current = {
        buyNow: false,
        digit: analyzerSnapRef.current.digit,
        side: analyzerSnapRef.current.side,
        armedEpoch: null,
        label: "Rotating",
        detail: `Hop → ${volatilityTag(next)}…`,
        entryGap: null,
      };
      marketSwitchBusy.current = true;
      marketSwitchStartedRef.current = now;
      deadSinceRef.current = null;
      // Don't park the bot behind a long feed wait — switch stream, hunt next.
      switchHoldRef.current = false;
      setTimerNote(`${reason} · ${volatilityTag(next)}`);
      setSymbol(next);
      try {
        const feedReady = await waitForSymbolFeed(
          next,
          ouHunt ? 3 : 40,
          () => feedSnapshotRef.current,
          () => botHaltRef.current,
          ouHunt ? 800 : 5000,
        );
        if (botHaltRef.current) return;
        const live = signalRef.current;
        const gate = botGateRef.current;
        setBot((current) => ({
          ...current,
          side: current.autoSide ? live.side : current.side,
          prediction: live.digit,
          autoFollow: true,
        }));
        setTimerNote(
          isPromisingSetup(live, gate)
            ? `Stay · ${volatilityTag(next)} · ${live.label}`
            : feedReady
              ? `Hunt · ${volatilityTag(next)} · ${live.label}`
              : `Hunt · ${volatilityTag(next)} · feed catching up`,
        );
      } finally {
        switchHoldRef.current = false;
        marketSwitchBusy.current = false;
        marketSwitchStartedRef.current = 0;
        ouRotateRef.current = false;
      }
    },
    [feed.client, feed.state],
  );
  hopNextVolatilityRef.current = hopNextVolatility;

  const switchToAnalyzedMarket = useCallback(
    async (reason: string) => {
      await hopNextVolatility(reason, true);
    },
    [hopNextVolatility],
  );

  const enterTradeFromSignal = useCallback(() => {
    if (tradingLocked) {
      setTimerNote("Log in with Deriv to start trading");
      return;
    }
    const pending = startSignalRef.current;
    const live = signalRef.current;
    const operatorArmed = !clientDesk && getAiBankroll().armed;
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
  }, [tradingLocked, clientDesk]);

  // Client desk is Over/Under only — never leave the Shield profile.
  useEffect(() => {
    if (!clientDesk) return;
    saveTradeDesk("overunder");
    setBot((current) => {
      if (deskOf(current.side) === "overunder") return current;
      return withWorkableRecovery(applyOverUnderProfile(current));
    });
    setSymbol((s) => (isOneSecondMarket(s) ? s : OVER_UNDER_SYMBOL));
    if (menu === "trades" || menu === "ai") setMenu("market");
  }, [clientDesk, menu]);

  const feedAnalyzerToBot = useCallback(() => {
    const live = signalRef.current;
    const operatorArmed = !clientDesk && getAiBankroll().armed;
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
  /** Live open OU contract — pins barrier while settling. */
  const openContractRef = useRef<{
    side: OverUnderSide;
    digit: number;
  } | null>(null);

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
    analyzerBuyNow: analyzerDirective?.buyNow ?? false,
    analyzerDigit: analyzerDirective?.digit ?? signal.digit,
    analyzerSide: analyzerDirective?.side ?? signal.side,
    analyzerSnapRef,
    tradeNowWake,
    executorFireRef,
    executorArmCancelRef,
    onSettings: (next) =>
      setBot((current) => {
        const open = openContractRef.current;
        // Never let autoFollow yank prediction off the live contract barrier.
        if (
          open &&
          isOverUnderSide(open.side) &&
          (next.prediction !== undefined || next.side !== undefined)
        ) {
          return withContractMoneyLimits(
            {
              ...current,
              ...next,
              prediction: open.digit,
              side: current.autoSide ? open.side : current.side,
            },
            isVirtualAccount,
          );
        }
        const merged = { ...current, ...next };
        // Paper bot autoFollow only patches digit/side — resync OU TP to barrier payout.
        if (
          isOverUnderSide(merged.side) &&
          (next.prediction !== undefined || next.side !== undefined)
        ) {
          return withContractMoneyLimits(merged, isVirtualAccount);
        }
        return merged;
      }),
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

  // Shield recovery reads this on the next tick advance.
  sessionPnlRef.current = paper.pnlThisStart;
  // Settle result → update elite commit (stay for up to 7 runs on top tape).
  if (paper.pnlThisStart < lastSessionPnlRef.current - 0.001) {
    const lossCool =
      paper.pnlThisStart < -0.001
        ? OU_LOSS_COOL_MS_RECOVERY
        : OU_LOSS_COOL_MS_GROWTH;
    momentumCoolUntilRef.current = Math.max(
      momentumCoolUntilRef.current,
      Date.now() + lossCool,
    );
    const c = ouEliteCommitRef.current;
    if (c && c.symbol === symbol) {
      c.losses += 1;
      ouStudyRef.current = null;
      ouPendingFireRef.current = null;
      if (c.losses >= MOMENTUM_COMMIT_MAX_LOSSES || c.runsLeft <= 0) {
        ouRecentPicksRef.current = [
          { side: c.side, barrier: c.barrier },
          ...ouRecentPicksRef.current,
        ].slice(0, OU_RECENT_SKIP);
        ouEliteCommitRef.current = null;
        ouRotateRef.current = true;
      }
    } else {
      ouRotateRef.current = true;
    }
  } else if (paper.pnlThisStart > lastSessionPnlRef.current + 0.001) {
    const c = ouEliteCommitRef.current;
    if (c && c.symbol === symbol && c.runsLeft <= 0) {
      ouEliteCommitRef.current = null;
    }
  }
  lastSessionPnlRef.current = paper.pnlThisStart;

  // Pin analyzer + bot to the open contract digit until settle + hold.
  openContractRef.current =
    paper.session.open && isOverUnderSide(paper.session.open.side)
      ? {
          side: paper.session.open.side,
          digit: paper.session.open.digit,
        }
      : null;
  if (openContractRef.current) {
    const open = openContractRef.current;
    const holdMs = Date.now() + OU_POST_TRADE_HOLD_MS;
    ouCommittedRef.current = {
      side: open.side,
      digit: open.digit,
      filled: true,
      holdUntilMs: Math.max(
        ouCommittedRef.current?.holdUntilMs || 0,
        holdMs,
      ),
    };
    executorBusyRef.current = true;
  } else {
    executorBusyRef.current = !!(
      paper.session.open || paper.orderPending
    );
  }

  const requestDeskChange = useCallback(
    (desk: TradeDesk) => {
      if (desk === tradeDesk) return;
      if (bot.running || paper.settling) {
        setTimerNote("Stop the bot before switching desks");
        return;
      }
      deskChangeCancelRef.current = false;
      setDeskChange({
        target: desk,
        phase: "confirm",
        detail:
          desk === "overunder"
            ? "Will load live ticks and verify Over/Under contracts on Deriv."
            : "Will load live ticks and verify Matches/Differs contracts on Deriv.",
      });
    },
    [tradeDesk, bot.running, paper.settling],
  );

  const cancelDeskChange = useCallback(() => {
    deskChangeCancelRef.current = true;
    setDeskChange(null);
  }, []);

  const confirmDeskChange = useCallback(async () => {
    if (!deskChange) return;
    const desk = deskChange.target;
    deskChangeCancelRef.current = false;

    const setPhase = (phase: DeskChangeState["phase"], detail: string) => {
      setDeskChange({ target: desk, phase, detail });
    };

    setPhase("syncing", "Preparing desk profile…");

    try {
      const targetSymbol =
        desk === "overunder"
          ? isLowPayoutSymbol(symbol)
            ? OVER_UNDER_SYMBOL
            : symbol
          : isLowPayoutSymbol(symbol)
            ? DIFFERS_FAST_SYMBOL
            : symbol;

      const alreadyLive =
        feed.streamSymbol === targetSymbol &&
        feed.state === "ready" &&
        !feed.switching &&
        feed.ticks.length >= 80;

      if (!alreadyLive) {
        setPhase(
          "syncing",
          targetSymbol !== symbol
            ? `Switching market to ${volatilityTag(targetSymbol)} for live sync…`
            : `Waiting for live ticks on ${volatilityTag(targetSymbol)}…`,
        );
        if (targetSymbol !== symbol) setSymbol(targetSymbol);
        const feedReady = await waitForSymbolFeed(
          targetSymbol,
          80,
          () => feedSnapshotRef.current,
          () => deskChangeCancelRef.current,
          12_000,
        );
        if (deskChangeCancelRef.current) return;
        if (!feedReady) {
          throw new Error(
            "Live tick stream not ready — check Deriv connection and try again.",
          );
        }
      } else {
        setPhase(
          "syncing",
          `Live ticks on ${volatilityTag(targetSymbol)} · verifying contract…`,
        );
        if (targetSymbol !== symbol) setSymbol(targetSymbol);
      }

      if (!feed.client || feed.state !== "ready") {
        throw new Error(
          "Deriv client not ready — reconnect and try again.",
        );
      }

      setPhase(
        "syncing",
        desk === "overunder"
          ? "Verifying DIGITOVER on Deriv (same market as DTrader)…"
          : "Verifying DIGITDIFF on Deriv…",
      );

      // Prove the contract type is live on this index — same wire path as a buy.
      const overProposal =
        desk === "overunder"
          ? await proposeDigitContract(feed.client, {
              symbol: targetSymbol,
              side: "DIGITOVER",
              digit: 4,
              stake: Math.max(0.35, bot.stake || 1),
              currency: feed.currency,
              duration: 1,
            })
          : null;
      const underProposal =
        desk === "overunder"
          ? await proposeDigitContract(feed.client, {
              symbol: targetSymbol,
              side: "DIGITUNDER",
              digit: 5,
              stake: Math.max(0.35, bot.stake || 1),
              currency: feed.currency,
              duration: 1,
            })
          : null;
      const digitsProposal =
        desk === "digits"
          ? await proposeDigitContract(feed.client, {
              symbol: targetSymbol,
              side: "DIGITDIFF",
              digit: 0,
              stake: Math.max(0.35, bot.stake || 1),
              currency: feed.currency,
              duration: 1,
            })
          : null;
      if (deskChangeCancelRef.current) return;

      const proposal = overProposal ?? digitsProposal;
      if (!proposal) {
        throw new Error("Deriv returned no proposal for this desk.");
      }

      const spotLabel =
        proposal.spot !== undefined ? proposal.spot.toFixed(2) : "—";
      setPhase(
        "syncing",
        desk === "overunder" && underProposal
          ? `Deriv live · Over payout ${overProposal!.payout.toFixed(2)} · Under ${underProposal.payout.toFixed(2)} · spot ${spotLabel}`
          : `Deriv live · spot ${spotLabel} · payout ${proposal.payout.toFixed(2)} · activating…`,
      );

      analyzerHoldRef.current = null;
      analyzerEpochRef.current = null;
      analyzerBuyNowRef.current = false;
      tapeTemperRef.current = emptyTapeTemper();
      setAnalyzerDirective(null);

      if (desk === "overunder") {
        const pick = pickBetterOverUnder(overSignal, underSignal);
        analyzerSnapRef.current = {
          buyNow: false,
          digit: pick.digit,
          side: pick.side,
          armedEpoch: null,
          label: "Watch",
          detail: "",
        };
        setBot((current) =>
          withContractMoneyLimits(
            {
              ...applyOverUnderProfile(current),
              prediction: pick.digit,
              side: pick.side,
              autoSide: true,
              running: false,
            },
            isVirtualAccount,
          ),
        );
        setTimerNote(
          `Desk · Over/Under live · ${volatilityTag(targetSymbol)} · Deriv spot ${spotLabel} · analyzer picks barrier`,
        );
      } else {
        const pick = pickBetterSignal(matchSignal, diffSignal, "differs");
        analyzerSnapRef.current = {
          buyNow: false,
          digit: pick.digit,
          side: pick.side,
          armedEpoch: null,
          label: "Watch",
          detail: "",
        };
        setBot((current) => ({
          ...applyDiffersFastProfile(current),
          prediction: pick.digit,
          side: pick.side,
          autoSide: true,
          running: false,
        }));
        setTimerNote(
          `Desk · Digits live · ${volatilityTag(targetSymbol)} · Deriv spot ${spotLabel}`,
        );
      }

      await new Promise((resolve) => window.setTimeout(resolve, 500));
      if (deskChangeCancelRef.current) return;
      setDeskChange(null);
    } catch (error) {
      if (deskChangeCancelRef.current) return;
      const message =
        error instanceof Error ? error.message : String(error);
      setPhase("error", message);
      setTimerNote(`Desk switch failed · ${message}`);
    }
  }, [
    deskChange,
    symbol,
    bot.stake,
    feed.client,
    feed.state,
    feed.currency,
    feed.streamSymbol,
    feed.switching,
    feed.ticks.length,
    overSignal,
    underSignal,
    matchSignal,
    diffSignal,
  ]);

  // While the bot runs on a cheap-payout or slow (non-1s) index, switch.
  useEffect(() => {
    if (!bot.running || !feed.client || feed.state !== "ready") return;
    if (isLowPayoutSymbol(symbol)) {
      void autoPickMarket(`${symbol} low payout · auto-switching market…`);
      return;
    }
    if (!isOneSecondMarket(symbol)) {
      void hopNextVolatility(
        `${volatilityTag(symbol)} slow · moving to 1s volatility`,
        true,
        { ignoreStay: true },
      );
    }
  }, [
    bot.running,
    symbol,
    feed.client,
    feed.state,
    autoPickMarket,
    hopNextVolatility,
  ]);

  // Hunt actively: stay only for Confirming / Trade now / one clean Lock.
  // Busy flag is kept in sync above from open / orderPending.

  // One run counts as fired only once the desk really takes the order, so a
  // cool-down that swallows the armed tick cannot end the run without a trade.
  useEffect(() => {
    if (!oneRunMode || !oneRunPickRef.current) return;
    if (paper.orderPending || paper.session.open) {
      oneRunFiredRef.current = true;
    }
  }, [oneRunMode, paper.orderPending, paper.session.open]);

  // Deep all-market sweep — idle desk only (never while bot is hopping).
  const ouDeskActive = deskOf(bot.side) === "overunder";
  const marketSweep = useMarketSweep(
    feed.client,
    ouDeskActive && feed.state === "ready" && !bot.running,
  );
  // Latest sweep for interval callbacks — planner rotation reads it to pick
  // the steadiest board instead of hopping blind.
  sweepRef.current = marketSweep.sweep;

  // A proven barrier anywhere on the board outranks whatever tape we sit on —
  // jump straight to it (never mid-buy, never over a Confirming call).
  useEffect(() => {
    const proven = marketSweep.sweep?.proven ?? null;
    // One run never leaves the market the user is looking at.
    if (!proven || !ouDeskActive || oneRunMode) return;
    if (symbol === proven.symbol) return;
    if (executorBusyRef.current || marketSwitchBusy.current) return;
    if (
      analyzerBuyNowRef.current ||
      analyzerHoldRef.current?.phase === "confirm"
    ) {
      return;
    }
    setTimerNote(
      `Sweep · PROVEN edge · ${volatilityTag(proven.symbol)} · ${sideLabel(proven.side)} ${proven.barrier}`,
    );
    setBot((current) => ({
      ...current,
      side: current.autoSide ? proven.side : current.side,
      prediction: proven.barrier,
      autoFollow: true,
    }));
    setSymbol(proven.symbol);
  }, [marketSweep.sweep, ouDeskActive, oneRunMode, symbol]);
  /**
   * Cap on parking a market that looks close but never proves. There is no
   * "must trade by" deadline: measured over 80k ticks, every Over/Under
   * barrier pays ~2pp under fair, so forcing an entry only pays the rake.
   */
  const OU_PROMISING_MAX_MS = 14_000;

  useEffect(() => {
    deadSinceRef.current = null;
    marketArriveRef.current = Date.now();
    marketTicksRef.current = 0;
    marketTickEpochRef.current = null;
    analyzerHoldRef.current = null;
    analyzerBuyNowRef.current = false;
    pickLatchRef.current = null;
    standDownUntilRef.current = 0;
    lockChurnRef.current = 0;
    ouStudyRef.current = null;
    ouPlanRef.current = null;
    ouPendingFireRef.current = null;
    ouCommittedRef.current = null;
    ouEliteCommitRef.current = null;
    ouPlansOnMarketRef.current = 0;
    ouRotateRef.current = false;
    ouNoEdgeSinceRef.current = null;
    ouRecentPicksRef.current = [];
    oneRunConfirmRef.current = null;
    oneRunPickRef.current = null;
    momentumCoolUntilRef.current = 0;
    tapeTemperRef.current = emptyTapeTemper();
    analyzerSnapRef.current = {
      buyNow: false,
      digit: analyzerSnapRef.current.digit,
      side: analyzerSnapRef.current.side,
      armedEpoch: null,
      label: "Settling",
      detail: "Relax on market · reading tape…",
    };
  }, [symbol]);

  useEffect(() => {
    if (bot.running && !wasBotRunningRef.current) {
      idleSinceTradeRef.current = Date.now();
      // Fresh Start: settle this market before any Lock / Trade now.
      marketArriveRef.current = Date.now();
      marketTicksRef.current = 0;
      marketTickEpochRef.current = null;
      ouPendingFireRef.current = null;
      ouCommittedRef.current = null;
      ouPlanRef.current = null;
      ouStudyRef.current = null;
      ouRecentPicksRef.current = [];
      ouNoEdgeSinceRef.current = null;
      oneRunPickRef.current = null;
      oneRunConfirmRef.current = null;
      oneRunArmedMsRef.current = 0;
      oneRunFiredRef.current = false;
      pickLatchRef.current = null;
      analyzerBuyNowRef.current = false;
      analyzerHoldRef.current = null;
      analyzerSnapRef.current = {
        ...analyzerSnapRef.current,
        buyNow: false,
        armedEpoch: null,
        label: "Settling",
        detail: "Relax on market · reading tape…",
      };
      setAnalyzerDirective((prev) =>
        prev
          ? {
              ...prev,
              buyNow: false,
              hold: null,
              label: "Settling",
              detail: "Relax on market · reading tape…",
            }
          : prev,
      );
    }
    wasBotRunningRef.current = bot.running;
  }, [bot.running]);

  useEffect(() => {
    if (scanningMarket || arm.arming) return;
    if (!feed.client || feed.state !== "ready") return;
    if (menu !== "market" && !bot.running) return;

    const id = window.setInterval(() => {
      const now = Date.now();
      // Unstick a hung market switch (including busy with no start stamp).
      if (marketSwitchBusy.current) {
        const started = marketSwitchStartedRef.current;
        if (started === 0 || now - started > 3_000) {
          marketSwitchBusy.current = false;
          switchHoldRef.current = false;
          marketSwitchStartedRef.current = 0;
        } else {
          return;
        }
      }

      const gate = botGateRef.current;
      const ouDesk =
        isOverUnderSide(gate.side) || deskOf(gate.side) === "overunder";

      // Rotate flag wins — never block behind study/plan/pending for minutes.
      if (momentumMode && ouDesk && ouRotateRef.current) {
        // If hop requests pile up with no switch, force carousel every 1.5s.
        if (now - lastOuHopAtRef.current >= 1_500) {
          requestOuMarketHop("Hunt elite · next market");
        }
        return;
      }

      if (executorBusyRef.current) {
        idleSinceTradeRef.current = Date.now();
        lockChurnRef.current = 0;
        return;
      }
      const hold = analyzerHoldRef.current;
      const buyNow = analyzerBuyNowRef.current === true;
      const pace = resolveAnalyzerPace(botGateRef.current.analyzerPace);

      const live = signalRef.current;
      const desk = {
        minColdGap: gate.minColdGap,
        minSample: gate.minSample,
        maxMomentumGap: gate.maxMomentumGap,
        side: gate.side,
      };

      // Momentum OU: stay only while Locking / Confirming / Trade now.
      // No steady entry → hop to a better market (do not sit for minutes).
      if (momentumMode && ouDesk) {
        deadSinceRef.current = null;
        const pendingFire = ouPendingFireRef.current !== null;
        const proving =
          pendingFire ||
          ouPlanRef.current !== null ||
          ouStudyRef.current !== null;
        const marketAge = now - marketArriveRef.current;
        const dryMs =
          ouNoEdgeSinceRef.current === null
            ? 0
            : now - ouNoEdgeSinceRef.current;
        const recoveryHop = sessionPnlRef.current < -0.001;
        const noEdgeRotateMs = recoveryHop
          ? OU_NO_EDGE_ROTATE_MS_RECOVERY
          : OU_NO_EDGE_ROTATE_MS_GROWTH;
        const maxMarketDwellMs = recoveryHop
          ? OU_MAX_MARKET_DWELL_MS_RECOVERY
          : OU_MAX_MARKET_DWELL_MS_GROWTH;
        // Interval safety net if the render path missed the rotate flag.
        if (
          !buyNow &&
          !proving &&
          marketAge >= OU_MIN_MARKET_DWELL_MS &&
          (dryMs >= noEdgeRotateMs || marketAge >= maxMarketDwellMs)
        ) {
          requestOuMarketHop("No elite entry · hunt better market");
        }
        return;
      }

      // Never cut a proving entry.
      if (buyNow || hold?.phase === "confirm") {
        deadSinceRef.current = null;
        if (buyNow) idleSinceTradeRef.current = Date.now();
        return;
      }

      // Barrier keeps moving here — unstable tape, leave instead of guessing.
      if (lockChurnRef.current >= 3) {
        lockChurnRef.current = 0;
        deadSinceRef.current = null;
        void hopNextVolatility("Hunting · tape unsteady · next market", true, {
          ignoreStay: true,
        });
        return;
      }

      if (shouldHoldMarket(hold, buyNow, now, pace.lockMs)) {
        deadSinceRef.current = null;
        return;
      }
      if (now < tradeNowStayUntilRef.current) {
        deadSinceRef.current = null;
        return;
      }

      const marketAge = now - marketArriveRef.current;
      const promising = isPromisingSetup(live, desk);
      const huntAway = shouldHuntOtherMarket(live, desk);
      const temper = tapeTemperRef.current;
      const coldAge = now - temper.coldSinceMs;
      // Let a new cold settle — do not hop mid-Cooling settle window.
      if (
        temper.flips < 3 &&
        coldAge < pace.coldSettleMs + 1_500 &&
        (live.watching.signalGap ?? 0) >= 3
      ) {
        deadSinceRef.current = null;
        return;
      }

      // Hard cap — never sit forever on one volatility.
      if (marketAge >= pace.maxMarketDwellMs) {
        void hopNextVolatility(
          gate.running
            ? "Hunting · search next steady"
            : "Analyze · search next steady",
          true,
        );
        return;
      }

      // Pack-cold / leave-alone Almost — rotate fast across volatilities.
      if (huntAway) {
        if (deadSinceRef.current === null) {
          deadSinceRef.current = now;
          return;
        }
        if (now - deadSinceRef.current < pace.stuckAlmostMs) return;
        void hopNextVolatility(
          gate.running
            ? "Hunting · next volatility"
            : "Analyze · next volatility",
          true,
        );
        return;
      }

      // Promising but not firm — don't park past ~16s on OU.
      if (promising) {
        if (ouRunning && marketAge >= OU_PROMISING_MAX_MS) {
          void hopNextVolatility("Hunting · Almost stalled · next market", true);
          return;
        }
        deadSinceRef.current = null;
        return;
      }
      if (deadSinceRef.current === null) {
        deadSinceRef.current = now;
        return;
      }
      if (now - deadSinceRef.current < DEAD_MARKET_MS) return;
      void hopNextVolatility(
        gate.running
          ? "Hunting · next volatility"
          : "Live analyze · next volatility",
        true,
      );
    }, isOverUnderSide(bot.side) ? 400 : 800);

    return () => window.clearInterval(id);
  }, [
    bot.running,
    bot.side,
    scanningMarket,
    arm.arming,
    feed.client,
    feed.state,
    hopNextVolatility,
    requestOuMarketHop,
    menu,
    momentumMode,
  ]);

  // Timer note when Digits locks Trade now (sound lives in DigitBars only).
  const goodNoteRef = useRef("");
  useEffect(() => {
    if (!analyzerDirective?.buyNow) return;
    const key = `${symbol}|${analyzerDirective.digit}`;
    if (goodNoteRef.current === key) return;
    goodNoteRef.current = key;
    setTimerNote(
      `Trade now · ${volatilityTag(symbol)} · ${analyzerDirective.detail}`,
    );
  }, [analyzerDirective?.buyNow, analyzerDirective?.digit, analyzerDirective?.detail, symbol]);

  const displayBalance =
    feed.balance === null
      ? null
      : config.mode === "paper"
        ? feed.balance + paper.session.pnl
        : feed.balance;

  // Keep live TP/SL/runs aligned with balance while idle — never rewrite stake.
  useEffect(() => {
    if (config.mode !== "live" || feed.balance === null || bot.running) return;
    const patch = liveSettingsForBalance(bot, feed.balance, isVirtualAccount, {
      lockStake: true,
    });
    if (!patch) return;
    setBot((current) => ({ ...current, ...patch }));
  }, [config.mode, feed.balance, isVirtualAccount, bot.stake, bot.maxExposurePercent, bot.contracts, bot.maxRuns, bot.running]);

  // Reset to demo take-profit profile when switching back to virtual account.
  useEffect(() => {
    const wasVirtual = wasVirtualRef.current;
    wasVirtualRef.current = isVirtualAccount;
    if (!isVirtualAccount || config.mode !== "live") return;
    if (wasVirtual) return;
    setBot((current) =>
      applyLiveTradingProfile(current, feed.balance, true, {
        preserveStake: true,
      }),
    );
    setTimerNote("Demo account · take-profit run profile applied");
  }, [isVirtualAccount, config.mode, feed.balance]);

  const restoreDiffersFast = useCallback(() => {
    setBot((current) => applyDiffersFastProfile(current));
    if (isLowPayoutSymbol(symbol)) {
      setSymbol(DIFFERS_FAST_SYMBOL);
    }
    setTimerNote("Differs fast profile restored");
  }, [symbol]);

  const restoreMatchesFirm = useCallback(() => {
    setBot((current) => applyMatchesFirmProfile(current));
    if (isLowPayoutSymbol(symbol)) {
      setSymbol(MATCHES_FIRM_SYMBOL);
    }
    setTimerNote("Matches firm · hunt best hot restored");
  }, [symbol]);

  const restoreOverUnder = useCallback(() => {
    setBot((current) =>
      withContractMoneyLimits(applyOverUnderProfile(current), isVirtualAccount),
    );
    if (isLowPayoutSymbol(symbol)) {
      setSymbol(OVER_UNDER_SYMBOL);
    }
    setTimerNote("Over/Under · edge payout limits restored");
  }, [symbol, isVirtualAccount]);

  const applyLiveSettings = useCallback(() => {
    const plan = planLiveStake(feed.balance, 1, isVirtualAccount);
    setBot((current) =>
      applyLiveTradingProfile(current, feed.balance, isVirtualAccount, {
        // Keep the Base stake the user typed (do not snap to 1.75).
        preserveStake: true,
      }),
    );
    if (isLowPayoutSymbol(symbol) && bot.side === "DIGITDIFF") {
      setSymbol(DIFFERS_FAST_SYMBOL);
    }
    setTimerNote(
      `Live settings applied · stake ${bot.stake.toFixed(2)} kept · ${plan.note}`,
    );
  }, [feed.balance, isVirtualAccount, symbol, bot.side, bot.stake]);

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
    if (tradingLocked && !bot.running) {
      setTimerNote("Log in with Deriv to start trading");
      return;
    }
    if (!clientDesk && getAiBankroll().armed && !bot.running && !fromOperator) {
      setTimerNote("AI Operator is armed · stop it from the AI tab first");
      return;
    }

    if (bot.running) {
      handleStopTrade();
      return;
    }

    // Arm countdown: second Start cancels. Market scan: ignore duplicate
    // Start so the hunt is not aborted mid-flight (felt like "click twice").
    if (arm.arming) {
      handleStopTrade();
      setTimerNote("Start cancelled");
      return;
    }
    if (scanningMarket) {
      return;
    }

    // Browser only allows audio after a click — unlock on Start / Open bot.
    unlockAudio();
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
        : !fromOperator && bot.side === "DIGITMATCH"
          ? applyMatchesFirmProfile(bot)
          : !fromOperator && isOverUnderSide(bot.side)
            ? applyOverUnderProfile(bot)
            : bot;
    const armSeconds = botForStart.armSeconds;
    scanActiveRef.current = true;
    if (!fromOperator) setMenu("market");

    // If Digits already shows Good on this volatility, Start uses that live
    // state — do not scan away from a desk-ready setup.
    const liveNow = signalRef.current;
    const useLiveGood =
      !fromOperator &&
      feed.state === "ready" &&
      isDeskTradeReady(liveNow, botForStart) &&
      (botForStart.side === "DIGITDIFF"
        ? liveNow.side === "DIGITDIFF"
        : botForStart.autoSide || liveNow.side === botForStart.side);

    if (useLiveGood) {
      const side = bot.autoSide ? liveNow.side : botForStart.side;
      const digit = liveNow.digit;
      startSignalRef.current = {
        side,
        digit,
        label: liveNow.label,
      };
      setBot((current) => ({
        ...current,
        ...botForStart,
        side,
        prediction: digit,
        autoFollow: true,
        autoSide: current.autoSide,
      }));
      setScanningMarket(false);
      scanActiveRef.current = true;
      setTimerNote(
        `Using live good · ${volatilityTag(symbol)} · ${liveNow.label} · gap ${liveNow.watching.signalGap ?? "—"}`,
      );
    } else if (
      (fromOperator || botForStart.side === "DIGITMATCH") &&
      !isOverUnderSide(botForStart.side) &&
      feed.client &&
      feed.state === "ready"
    ) {
      // Matches (and AI Digits): scan best market first, then prove/fire.
      // Over/Under starts instantly on the live desk (hunt while running).
      setScanningMarket(true);
      setTimerNote(
        fromOperator
          ? "AI Operator · scanning markets…"
          : "Matches firm · scanning best hot market…",
      );
      try {
        const best = await findBestMarket(
          feed.client,
          { ...botForStart, sidePreference: "matches" as const },
          symbol,
          { preferReady: true },
        );
        if (!scanActiveRef.current) return;
        const digit = best.signal.digit;
        const side = "DIGITMATCH" as const;
        startSignalRef.current = {
          side,
          digit,
          label: `${sideLabel(side)} ${digit}`,
        };
        setBot((current) => ({
          ...current,
          ...botForStart,
          side,
          prediction: digit,
          autoFollow: true,
          autoSide: false,
          sidePreference: "matches",
          ...(fromOperator
            ? {
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
        if (best.symbol !== symbol) {
          setSymbol(best.symbol);
          await waitForSymbolFeed(
            best.symbol,
            80,
            () => feedSnapshotRef.current,
            () => !scanActiveRef.current,
            8000,
          );
        }
        setTimerNote(
          fromOperator
            ? `AI · ${best.name} · ${sideLabel(side)} ${digit}`
            : `Matches firm · ${best.name} · hot ${digit} · proving…`,
        );
      } catch {
        const digit = liveNow.digit;
        const side = "DIGITMATCH" as const;
        startSignalRef.current = {
          side,
          digit,
          label: `${sideLabel(side)} ${digit}`,
        };
        setBot((current) => ({
          ...current,
          ...botForStart,
          side,
          prediction: digit,
          autoFollow: true,
          autoSide: false,
          sidePreference: "matches",
        }));
        setTimerNote(
          fromOperator
            ? "AI scan skipped · current symbol"
            : `Matches firm · hunt on ${volatilityTag(symbol)}`,
        );
      } finally {
        setScanningMarket(false);
      }
    } else if (isOverUnderSide(botForStart.side)) {
      // Instant Start — no pre-scan. Any plan or armed call chosen BEFORE
      // this click is discarded: the bot only buys a call it watched being
      // built, so a fresh study starts now and the next plan is the one
      // that fires.
      ouStudyRef.current = null;
      ouPlanRef.current = null;
      ouPendingFireRef.current = null;
      ouCommittedRef.current = null;
      ouEliteCommitRef.current = null;
      ouPlansOnMarketRef.current = 0;
      ouRotateRef.current = false;
      ouNoEdgeSinceRef.current = null;
      ouRecentPicksRef.current = [];
      pickLatchRef.current = null;
      analyzerBuyNowRef.current = false;
      analyzerSnapRef.current = {
        ...analyzerSnapRef.current,
        buyNow: false,
        armedEpoch: null,
        entryGap: null,
        label: "Studying",
        detail: "Fresh elite hunt after Start · commit up to 7 when found",
      };
      momentumCoolUntilRef.current = Date.now() + 1_000;
      oneRunFiredRef.current = false;
      oneRunPickRef.current = null;
      oneRunStartMsRef.current = Date.now();
      // Keep the steadiness already earned before Start — that pre-study is
      // exactly what lets the buy go out on the first tick.
      // One run: read the history now and buy that number on this Start.
      const onePick = oneRunMode
        ? (rankSafePairByChance(feed.digits)[0] ?? null)
        : null;
      const side = onePick
        ? onePick.side
        : bot.autoSide && isOverUnderSide(liveNow.side)
          ? liveNow.side
          : botForStart.side;
      const digit = onePick ? onePick.barrier : liveNow.digit;
      startSignalRef.current = {
        side,
        digit,
        label: `${sideLabel(side)} ${digit}`,
      };
      setBot((current) => ({
        ...current,
        ...botForStart,
        side,
        prediction: digit,
        autoFollow: true,
        autoSide: true,
        sidePreference: "edge",
        // One run means exactly one contract, so the clock never owns the stop.
        ...(oneRunMode
          ? {
              maxRuns: 1,
              maxRunsManual: true,
              sessionHours: 0,
              martingale: false,
              // A single run has nothing to cool off from — Start must buy
              // as soon as the answer confirms, not N ticks later.
              cooldownTicks: 0,
            }
          : {}),
      }));
      setScanningMarket(false);
      setTimerNote(
        oneRunMode
          ? onePick
            ? `One run · ${volatilityTag(symbol)} · ${sideLabel(side)} ${digit} lands ${onePick.chancePercent.toFixed(1)}% · live ${onePick.livePercent.toFixed(1)}% of ${onePick.sampleSize} · confirming…`
            : `One run · ${volatilityTag(symbol)} · reading history…`
          : `Over/Under · live · ${volatilityTag(symbol)} · fresh study, next plan fires`,
      );
    } else {
      // Differs desk: start hunting immediately and carousel volatilities —
      // no 30s full-market scan that freezes the UI on one index.
      const side = bot.autoSide ? liveNow.side : botForStart.side;
      const digit = liveNow.digit;
      startSignalRef.current = {
        side,
        digit,
        label: liveNow.label,
      };
      setBot((current) => ({
        ...current,
        ...botForStart,
        side,
        prediction: digit,
        autoFollow: true,
        autoSide: current.autoSide,
      }));
      setScanningMarket(false);
      setTimerNote(
        `Hunting · cycling volatilities for Digits Good · now ${volatilityTag(symbol)}`,
      );
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
    feed.digits,
    feed.state,
    feedAnalyzerToBot,
    handleStopTrade,
    oneRunMode,
    scanningMarket,
    symbol,
    isVirtualAccount,
    tradingLocked,
    clientDesk,
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
        botRunning={bot.running || paper.settling || deskChange !== null}
        initialTab={settingsTab}
        feedState={feed.state}
        feedError={feed.error}
        tradeDesk={tradeDesk}
        onSelectDesk={clientDesk ? undefined : requestDeskChange}
        onHubChange={clientDesk ? undefined : onHubChange}
        hubMode="digits"
        clientMode={clientDesk}
      />
      {!clientDesk && deskChange ? (
        <DeskChangeDialog
          state={deskChange}
          onConfirm={() => {
            void confirmDeskChange();
          }}
          onCancel={cancelDeskChange}
        />
      ) : null}
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
          {!clientDesk ? (
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
          ) : null}
          {!clientDesk ? (
            <button
              type="button"
              className={menu === "ai" ? "is-active" : ""}
              onClick={() => setMenu("ai")}
            >
              AI
              {aiOperator.state.armed ? <em className="topbar__count">ON</em> : null}
            </button>
          ) : null}
          <button
            type="button"
            className={`topbar__nav-settings ${settingsOpen ? "is-active" : ""}`}
            aria-label="Account and settings"
            onClick={() => {
              setSettingsTab(clientDesk ? "trading" : "profile");
              setSettingsOpen(true);
            }}
          >
            {!clientDesk && auth?.session?.picture ? (
              <img
                className="topbar__nav-avatar"
                src={auth.session.picture}
                alt=""
                referrerPolicy="no-referrer"
              />
            ) : (
              <span className="topbar__nav-avatar topbar__nav-avatar--fallback" aria-hidden>
                {(clientDesk
                  ? (feed.account?.accountId ?? "U")
                  : (auth?.session?.name ?? "U")
                )
                  .slice(0, 1)
                  .toUpperCase()}
              </span>
            )}
            Settings
          </button>
        </nav>

        <div className="topbar__right">
          <StatusBar
            state={feed.state}
            symbol={symbol}
            loginId={feed.account?.accountId ?? null}
            balance={displayBalance}
            currency={feed.currency}
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
          {clientDesk ? (
            <>
              <AccountKindPill
                isVirtual={feed.account?.isVirtual !== false}
                accounts={readOauthSession()?.accounts ?? []}
                selected={getSelectedOauthAccount()?.loginid ?? null}
                onSelect={(loginid) => {
                  selectOauthAccount(loginid);
                  feed.reconnect();
                }}
              />
              <button
                type="button"
                className="topbar__theme"
                onClick={() => {
                  clearOauthSession();
                  onClientSignOut?.();
                }}
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="topbar__theme"
                onClick={() => {
                  setSettingsTab("trading");
                  setSettingsOpen(true);
                }}
                aria-label="Open account settings"
              >
                {feed.account?.isVirtual === false ? "True live" : "Live"}
              </button>
              <AuthSignOutButton />
            </>
          )}
        </div>
      </header>

      <main className="stage">
        {feed.error ? <p className="alert">{feed.error}</p> : null}

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
                        {size < bot.minSample ? " · display" : ""}
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
                      {bot.running && paper.sessionEndAtMs > 0 ? (
                        <SessionCountdown endAtMs={paper.sessionEndAtMs} />
                      ) : null}
                      {paper.orderPending && !paper.session.open ? (
                        <em className="workspace__wait is-live">
                          Buying · {sideLabel(analyzerSnapRef.current.side)}{" "}
                          {analyzerSnapRef.current.digit} · now
                        </em>
                      ) : paper.session.open ? (
                        <em className="workspace__wait is-live">
                          In trade · {sideLabel(paper.session.open.side)}{" "}
                          {paper.session.open.digit} · waiting result…
                        </em>
                      ) : paper.waitReason ? (
                        <em className="workspace__wait">{paper.waitReason}</em>
                      ) : (
                        <em className="workspace__wait">
                          Hunting · {sideLabel(bot.side)} {bot.prediction}
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
                          : paper.orderPending && !paper.session.open
                            ? "Stop · buying"
                            : paper.session.open
                              ? "Stop · in trade"
                              : "Stop trade"}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="workspace__cta"
                    onClick={() => {
                      if (tradingLocked) {
                        setTimerNote("Log in with Deriv to open the bot");
                        return;
                      }
                      if (config.mode === "live" && feed.state !== "ready") {
                        setTimerNote("Live trading needs Connected socket — wait or Reconnect");
                        return;
                      }
                      setMenu("bot");
                    }}
                    disabled={tradingLocked}
                  >
                    {tradingLocked
                      ? "Log in to trade"
                      : config.mode === "live"
                        ? feed.state === "ready"
                          ? clientDesk
                            ? "Open bot · ready"
                            : "Open bot · live ready"
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
                  syncing={feed.switching || feed.streamSymbol !== symbol}
                  tradeMarkers={[
                    ...(paper.session.open
                      ? [
                          {
                            epoch: paper.session.open.entryEpoch,
                            won: false,
                            pending: true as const,
                            kind: "open" as const,
                          },
                        ]
                      : paper.orderPending ||
                          (bot.running &&
                            (analyzerDirective?.buyNow === true ||
                              analyzerSnapRef.current.buyNow))
                        ? [
                            {
                              epoch:
                                analyzerSnapRef.current.armedEpoch ??
                                latest?.epoch ??
                                0,
                              won: false,
                              pending: true as const,
                              kind: "open" as const,
                            },
                          ]
                        : []),
                    ...paper.session.journal
                      .filter(
                        (entry) =>
                          !aiOperator.state.armed ||
                          entry.note === AI_TRADE_NOTE,
                      )
                      .flatMap((entry) => {
                        const entryEpoch = entry.entryAt ?? entry.at;
                        const settleEpoch = entry.at;
                        return [
                          // Keep entry pin forever — never replace it with W/L.
                          {
                            epoch: entryEpoch,
                            won: false,
                            pending: true as const,
                            kind: "entry" as const,
                          },
                          // Next tick (settle) shows W or L.
                          {
                            epoch: settleEpoch,
                            won: entry.won,
                            pnl: entry.pnl,
                            kind: "result" as const,
                          },
                        ];
                      }),
                  ]}
                />
                <DigitStrip ticks={feed.ticks} />
              </div>
              <aside className="workspace__side">
                <DigitBars
                  stats={tradeStats}
                  digits={feed.digits}
                  latestDigit={latest?.digit ?? null}
                  signal={signal}
                  director={analyzerDirective}
                  symbol={symbol}
                  deskBusy={
                    paper.session.open
                      ? "open"
                      : paper.orderPending
                        ? "buying"
                        : null
                  }
                  deskBusyDigit={
                    paper.session.open?.digit ??
                    analyzerSnapRef.current.digit
                  }
                  deskBusySide={
                    paper.session.open?.side ??
                    analyzerSnapRef.current.side
                  }
                  executorWait={bot.running ? paper.waitReason : null}
                  botBarrier={
                    deskOf(bot.side) === "overunder"
                      ? (paper.session.open?.digit ??
                        (paper.orderPending
                          ? analyzerSnapRef.current.digit
                          : bot.prediction))
                      : null
                  }
                  botTakeProfit={
                    deskOf(bot.side) === "overunder" ? bot.takeProfit : null
                  }
                  stake={bot.stake}
                  contracts={bot.contracts}
                  sweep={
                    deskOf(bot.side) === "overunder"
                      ? marketSweep.sweep
                      : null
                  }
                  sweepScanning={marketSweep.scanning}
                  entryMode={entryMode}
                  onEntryModeChange={setEntryMode}
                  requirements={{
                    minColdGap: bot.minColdGap,
                    minSample: bot.minSample,
                    maxMomentumGap: bot.maxMomentumGap,
                    side: signal.side,
                    volatilityLabel: volatilityTag(symbol),
                    analyzerPace: bot.analyzerPace,
                    momentumMode,
                  }}
                  onAnalyzerPaceChange={(paceId) => {
                    const pace = resolveAnalyzerPace(paceId);
                    setBot((current) => ({
                      ...current,
                      analyzerPace: paceId,
                      cooldownTicks: pace.cooldownTicks,
                    }));
                  }}
                  selectedDigit={
                    aiOperator.state.armed ? bot.prediction : selectedDigit
                  }
                  onSelectDigit={(digit) =>
                    setSelectedDigit(digit === selectedDigit ? null : digit)
                  }
                />
                <StatsPanel
                  stats={tradeStats}
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
                    stats={tradeStats}
                    signal={signal}
                    matchSignal={matchSignal}
                    diffSignal={diffSignal}
                    overSignal={overSignal}
                    underSignal={underSignal}
                    bot={bot}
                    latest={latest}
                    symbol={symbol}
                    disabled={paper.settling || deskChange !== null}
                    onApply={(next) => setBot((current) => ({ ...current, ...next }))}
                    onSelectSide={applyManualSide}
                    onSelectDesk={requestDeskChange}
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
                    matchesFirmActive={isMatchesFirmProfile(bot)}
                    overUnderActive={isOverUnderProfile(bot)}
                    liveProfileActive={
                      config.mode === "live" &&
                      isLiveTradingProfile(bot, feed.balance, isVirtualAccount)
                    }
                    isVirtual={isVirtualAccount}
                    tradingMode={config.mode}
                    onApplyLiveSettings={
                      config.mode === "live" ? applyLiveSettings : undefined
                    }
                    settling={paper.settling || deskChange !== null}
                    onChange={setBot}
                    onSelectSide={applyManualSide}
                    onSelectDesk={requestDeskChange}
                    onRestoreDiffersFast={restoreDiffersFast}
                    onRestoreMatchesFirm={restoreMatchesFirm}
                    onRestoreOverUnder={restoreOverUnder}
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
