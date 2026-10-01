import { useEffect, useRef, useState } from "react";
import { CONTRACT_NAMES, MAX_BALANCE, MIN_BALANCE, MODES, PROFILES, profileOf, settingsForBalance, type BotSettings, type ContractType } from "./bot";
import { runBacktest, type BacktestResult } from "./backtest";
import { AccountButton } from "./AccountButton";
import { Assistant } from "./Assistant";
import { BotAvatar } from "./BotAvatar";
import { MAX_SPEED, MIN_SPEED, REAL_SYMBOLS, SPEEDS, useSimulation } from "./engine";
import { LiveChart } from "./LiveChart";
import { Loader } from "./Loader";
import { AUTO_SYMBOL, MARKET_NAME, symbolName, symbolShort } from "./market";
import { MarketRadar } from "./MarketRadar";
import { History } from "./History";
import { InfoTip } from "./InfoTip";
import { newSessionId, saveSession, todayPnl } from "./sessionStore";
import { SURVIVAL_SESSIONS, SURVIVAL_TICKS, runSurvival, type SurvivalReport } from "./survival";
import { sendPresence, track } from "./siteClient";
import { Sparkline } from "./Sparkline";
import { SessionSummary, type SessionResult } from "./SessionSummary";
import { DigitBars, NEGATIVE, POSITIVE, Quote, Scanner, Stat, money, pct, setupDigits, signedUsd, usd } from "./ui";

const LOAD_MS = 2200;
const BACKTEST_TICKS = 30_000;
const SAVE_EVERY_MS = 2000;
const SWITCH_MS = 1300;
const PRESENCE_MS = 5000;
const BALANCE_PRESETS = [1, 10, 100, 1_000, 10_000];
const compactUsd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 });

type NumericKey = Exclude<
  keyof BotSettings,
  "symbol" | "mode" | "martingale" | "autoMartingale" | "strictStats" | "stackStakes" | "turbo" | "kellySizing" | "randomnessFilter" | "regimeGuard"
>;
const MANUAL_RECOVERY_KEYS: NumericKey[] = ["maxMartingaleSteps", "maxStakePercent"];

const SETTING_FIELDS: { key: NumericKey; label: string; step: number; min: number }[] = [
  { key: "stake", label: "Stake (USD)", step: 1, min: 0.35 },
  { key: "takeProfit", label: "Take profit (0 = off)", step: 50, min: 0 },
  { key: "stopLoss", label: "Stop loss (0 = off)", step: 50, min: 0 },
  { key: "minConfidence", label: "Min confidence (σ)", step: 0.25, min: 0 },
  { key: "minWinRate", label: "Min win rate (%)", step: 5, min: 0 },
  { key: "window", label: "Scan window (ticks)", step: 50, min: 50 },
  { key: "confirmWindow", label: "Confirm window (ticks)", step: 10, min: 10 },
  { key: "maxConsecutiveLosses", label: "Max loss streak", step: 1, min: 0 },
  { key: "cooldownTicks", label: "Cooldown (ticks)", step: 1, min: 0 },
  { key: "persistTicks", label: "Edge must hold (ticks)", step: 1, min: 0 },
  { key: "lossCooldown", label: "Pause after a loss (ticks)", step: 1, min: 0 },
  { key: "maxStack", label: "Max stake units", step: 1, min: 1 },
  { key: "maxMartingaleSteps", label: "Recovery steps", step: 1, min: 1 },
  { key: "maxStakePercent", label: "Max stake (% of balance)", step: 1, min: 1 },
  { key: "kellyFraction", label: "Kelly fraction (0–1)", step: 0.05, min: 0.01 },
  { key: "drawdownBrake", label: "Drawdown brake (%, 0 = off)", step: 1, min: 0 },
  { key: "dailyLossLimit", label: "Daily loss limit (0 = off)", step: 50, min: 0 },
];

interface TestDriveProps {
  settings: BotSettings;
  onSettings: (next: BotSettings) => void;
  onBack: () => void;
  onBuy: () => void;
}

export function TestDrive({ settings, onSettings, onBack, onBuy }: TestDriveProps) {
  const { engine, frame, speed, setSpeed, paused, setPaused, refresh, source, setSource, feedStatus } = useSimulation(settings);
  const real = source === "real";
  const autoMarket = real && settings.symbol === AUTO_SYMBOL;
  const focusMarket = engine.bot.focus;
  const realName = autoMarket ? (focusMarket ? symbolName(focusMarket) : "All volatility indices") : symbolName(settings.symbol);
  const marketName = real ? realName : MARKET_NAME;
  const profile = profileOf(settings);
  const [loaded, setLoaded] = useState(false);
  const [backtest, setBacktest] = useState<BacktestResult[] | null>(null);
  const [survival, setSurvival] = useState<SurvivalReport | null>(null);
  const [survivalDone, setSurvivalDone] = useState<number | null>(null);
  const survivalRun = useRef({ cancelled: false });
  useEffect(() => () => { survivalRun.current.cancelled = true; }, []);
  const session = useRef({ id: newSessionId(), startedAt: Date.now() });
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const lastSave = useRef(0);
  const [customSpeed, setCustomSpeed] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const prevMode = useRef(settings.mode);

  useEffect(() => {
    if (prevMode.current === settings.mode) return;
    prevMode.current = settings.mode;
    setSwitching(MODES.find((m) => m.id === settings.mode)?.label ?? settings.mode);
    const id = setTimeout(() => setSwitching(null), SWITCH_MS);
    return () => clearTimeout(id);
  }, [settings.mode]);

  const [editingBalance, setEditingBalance] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    const id = setTimeout(() => setLoaded(true), LOAD_MS);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    const st = engine.bot.state;
    const now = Date.now();
    if (st.trades === 0 || now - lastSave.current < SAVE_EVERY_MS) return;
    lastSave.current = now;
    saveSession(session.current.id, session.current.startedAt, st, settingsRef.current);
  }, [engine, frame]);

  const [summary, setSummary] = useState<SessionResult | null>(null);
  const wasRunning = useRef(false);
  useEffect(() => {
    const st = engine.bot.state;
    if (wasRunning.current && !st.running && st.trades > 0) {
      setSummary({
        pnl: st.pnl,
        startBalance: st.startBalance,
        balance: st.balance,
        trades: st.trades,
        wins: st.wins,
        losses: st.losses,
        maxDrawdown: st.maxDrawdown,
        durationMs: Date.now() - session.current.startedAt,
        reason: st.stopReason,
      });
    }
    wasRunning.current = st.running;
  }, [engine, frame]);

  const speedRef = useRef(speed);
  speedRef.current = speed;
  useEffect(() => {
    const beat = () => {
      const st = engine.bot.state;
      sendPresence("test", {
        running: st.running,
        balance: st.balance,
        startBalance: st.startBalance,
        pnl: st.pnl,
        trades: st.trades,
        winRate: st.trades ? (st.wins / st.trades) * 100 : 0,
        mode: settingsRef.current.mode,
        speed: speedRef.current,
      });
    };
    beat();
    const id = setInterval(beat, PRESENCE_MS);
    return () => clearInterval(id);
  }, [engine]);

  useEffect(() => {
    const flush = () => saveSession(session.current.id, session.current.startedAt, { ...engine.bot.state, running: false }, settingsRef.current);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [engine]);

  const { bot, ticks } = engine;
  const s = bot.state;
  const winRate = s.trades ? (s.wins / s.trades) * 100 : 0;
  const best = bot.scan.best;
  const status = s.running
    ? settings.turbo
      ? `Turbo · ${s.positions.length} open`
      : s.open || best
      ? autoMarket && focusMarket ? `Trading ${symbolShort(focusMarket)}` : "Trading for you"
      : autoMarket ? `Scanning ${REAL_SYMBOLS.length} markets` : "Scanning the market"
    : "Idle";
  const where = autoMarket && focusMarket ? ` on ${symbolShort(focusMarket)}` : "";
  const focus = s.open ? bot.scan.candidates.find((c) => c.label === s.open!.label) ?? null : best;
  const lastReason = s.open?.reason ?? s.journal[0]?.reason ?? null;
  const waiting = (() => {
    const { candidates, sample } = bot.scan;
    if (!s.running || s.open || best || !candidates.length) return null;
    if (sample < settings.window) return { title: "Collecting ticks", detail: `${sample} of ${settings.window} needed before scoring` };
    if (bot.scan.blocked) return { title: "Holding back", detail: bot.scan.blocked };
    const near = candidates.find((c) => c.winRate >= settings.minWinRate);
    if (!near) {
      return { title: "No trade yet", detail: `nothing wins ${settings.minWinRate}% of the time right now (your minimum)` };
    }
    const odds = `${near.label} wins ${near.winRate.toFixed(1)}%, needs ${near.breakEven.toFixed(1)}% to profit`;
    const title = `Watching ${near.label}${where}`;
    if (near.confidence < settings.minConfidence) {
      return { title, detail: `${odds} · edge not proven yet (${Math.max(0, near.confidence).toFixed(1)} of ${settings.minConfidence} σ)` };
    }
    if (near.confirmRate < near.breakEven || near.confirmRate < settings.minWinRate) {
      return { title, detail: `${odds} · recent ticks don't confirm it` };
    }
    return { title, detail: odds };
  })();
  const assistantContext = [
    real
      ? autoMarket
        ? `Market: auto, watching all ${REAL_SYMBOLS.length} volatility indices live and trading the strongest (now ${realName}). Simulated balance only.`
        : `Market: ${realName} (${settings.symbol}), live Deriv ticks, simulated balance only.`
      : `Market: ${MARKET_NAME}, simulated.`,
    `Turbo: ${settings.turbo ? `on, trading every tick of every market, ${s.positions.length} positions open, recovery paused` : "off"}.`,
    `Stake stacking: ${settings.stackStakes ? `on, up to ${settings.maxStack} units on very strong signals` : "off"}.`,
    `Bot: ${s.running ? "running" : "stopped"}, mode ${settings.mode}, stake $${settings.stake}, martingale ${!settings.martingale ? "off" : settings.autoMartingale ? "auto (sized from balance and stop loss)" : `on (max ${settings.maxMartingaleSteps} steps)`}.`,
    `Balance $${s.balance.toFixed(2)} (started with $${s.startBalance.toFixed(2)}), session P/L $${s.pnl.toFixed(2)}, ${s.trades} trades, win rate ${winRate.toFixed(1)}%, max drawdown $${s.maxDrawdown.toFixed(2)}.`,
    best ? `Best setup now: ${best.label}, win rate ${best.winRate.toFixed(1)}% vs ${best.breakEven.toFixed(1)}% needed.` : "No setup currently qualifies.",
    `Risk: Kelly sizing ${settings.kellySizing ? `on (fraction ${settings.kellyFraction})` : "off"}, drawdown brake ${settings.drawdownBrake > 0 ? `${settings.drawdownBrake}% of start balance${bot.braked ? ", engaged now (half stakes, no recovery)" : ""}` : "off"}, daily loss limit ${settings.dailyLossLimit > 0 ? `$${settings.dailyLossLimit}` : "off"}.`,
    `Filters: randomness ${settings.randomnessFilter ? "on" : "off"}, regime guard ${settings.regimeGuard ? "on" : "off"}; window chi-square ${bot.scan.unevenness.toFixed(1)} (uneven above 14.7), shift ${bot.scan.shift.toFixed(1)} (shifted above 21.7)${bot.scan.blocked ? `; holding back: ${bot.scan.blocked}` : ""}.`,
    lastReason ? `Why the latest trade: ${lastReason}` : "",
  ].filter(Boolean).join("\n");
  const chartTrades = real ? s.journal.filter((t) => t.market === focusMarket) : s.journal;
  const nextUnits = best ? bot.unitsFor(best) : 1;
  const tallies = Object.entries(s.byContract) as [ContractType, { trades: number; wins: number; pnl: number }][];

  const persist = () => saveSession(session.current.id, session.current.startedAt, bot.state, settingsRef.current);
  const newSession = () => {
    persist();
    bot.resetSession();
    session.current = { id: newSessionId(), startedAt: Date.now() };
  };

  const draftValid = Number.isFinite(Number(draft)) && Number(draft) >= MIN_BALANCE && Number(draft) <= MAX_BALANCE;
  const applyBalance = (amount: number) => {
    if (!(amount >= MIN_BALANCE && amount <= MAX_BALANCE)) return;
    const next = settingsForBalance(settings, amount);
    if (bot.state.running) bot.stop("Balance changed");
    bot.settings = next;
    newSession();
    onSettings(next);
    setEditingBalance(false);
    refresh();
  };

  const applyCustomSpeed = () => {
    const value = Number(customSpeed);
    if (customSpeed && Number.isFinite(value) && value > 0) {
      setSpeed(Math.round(Math.min(MAX_SPEED, Math.max(MIN_SPEED, value)) * 100) / 100);
    }
    setCustomSpeed(null);
  };

  const toggleBot = () => {
    if (s.running) bot.stop("Stopped manually");
    else {
      if (s.stopReason && s.stopReason !== "Stopped manually") newSession();
      if (bot.state.trades === 0) session.current.startedAt = Date.now();
      bot.dayPnlBefore = todayPnl(session.current.id);
      if (bot.dailyLimitHit) {
        bot.stop("Daily loss limit reached");
        refresh();
        return;
      }
      bot.start();
      track("bot_start", `${settings.mode} · $${bot.state.balance.toFixed(2)}`);
    }
    persist();
    refresh();
  };

  const updateSetting = (key: NumericKey, raw: string) => {
    const value = Number(raw);
    if (Number.isFinite(value)) onSettings({ ...settings, [key]: value });
  };

  const runComparison = () => {
    const seed = Date.now();
    setBacktest([
      runBacktest("pattern", settings, BACKTEST_TICKS, seed),
      runBacktest("pattern", settings, BACKTEST_TICKS, seed + 1),
    ]);
  };

  const runSurvivalTest = async () => {
    survivalRun.current.cancelled = true;
    const signal = { cancelled: false };
    survivalRun.current = signal;
    setSurvivalDone(0);
    const report = await runSurvival(settings, setSurvivalDone, signal);
    if (signal.cancelled) return;
    setSurvival(report);
    setSurvivalDone(null);
  };

  if (!loaded) {
    return <Loader durationMs={LOAD_MS} window={settings.window} balance={settings.startBalance} />;
  }

  return (
    <div className="test">
      <nav className="nav app-nav">
        <div className="app-nav-side">
          <button className="icon-btn" onClick={onBack} aria-label="Back to overview">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>
          </button>
          <span className="brand">
            <BotAvatar size={26} lastTrade={s.journal[0] ?? null} />
            Double LLS
          </span>
        </div>
        <div className="app-nav-side right">
          <div className="nav-tools">
            <History />
            <span className="nav-tools-sep" />
            <Assistant context={assistantContext} lastTrade={s.journal[0] ?? null} />
          </div>
          <span className="nav-divider" />
          <span className="nav-balance">
            <small>Balance</small>
            {usd(s.balance)}
          </span>
          <AccountButton />
          <button className="btn solid" onClick={onBuy}>Purchase</button>
        </div>
      </nav>

      <div className="toolbar">
        <div className="segmented">
          {MODES.map((m) => (
            <button key={m.id} className={settings.mode === m.id ? "on" : ""} onClick={() => onSettings({ ...settings, mode: m.id })}>
              {m.label}
            </button>
          ))}
        </div>
        <div className="toolbar-right">
          <button
            type="button"
            className={`turbo-btn${settings.turbo ? " on" : ""}`}
            aria-pressed={settings.turbo}
            onClick={() => onSettings({ ...settings, turbo: !settings.turbo })}
            title="Trade every tick"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z" /></svg>
            Turbo
          </button>
          <InfoTip label="What is Turbo?" title="Turbo: trade every tick">
            <span>The bot buys on every tick of every market it watches: one position per index at a time, back in the moment the last one settles, win or lose.</span>
            <span>On Auto with all {REAL_SYMBOLS.length} indices that is about 120–140 trades a minute. It takes the strongest setup each tick, even when none clears your confidence bar.</span>
            <span>Recovery staking is paused in Turbo; stakes stay flat (stacking still applies). Real-data test, $1 stakes: about −1% per trade, so a $1,000 balance was used up within about 12 hours.</span>
          </InfoTip>
          <div className="segmented source-switch">
            <button className={!real ? "on" : ""} onClick={() => setSource("sim")}>Simulated</button>
            <button className={real ? "on" : ""} onClick={() => setSource("real")}><i className={`source-dot ${real ? feedStatus : ""}`} />Real market</button>
          </div>
          {real ? (
            <>
              <select className="symbol-select" value={settings.symbol} onChange={(e) => onSettings({ ...settings, symbol: e.target.value })} aria-label="Real market index">
                <option value={AUTO_SYMBOL}>Auto · all {REAL_SYMBOLS.length} indices</option>
                {REAL_SYMBOLS.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              <span className={`feed-status ${feedStatus}`}>
                {feedStatus === "live" ? (autoMarket ? `Live · ${REAL_SYMBOLS.length} markets` : "Live") : feedStatus === "connecting" ? "Connecting…" : feedStatus === "error" ? "Disconnected" : ""}
              </span>
              <InfoTip label="About the real market" title="Live Deriv ticks, simulated balance">
                <span>Prices stream live from Deriv's public feed. The bot trades them with the simulated balance here; no real money is used.</span>
                <span>On Auto the bot watches all {REAL_SYMBOLS.length} volatility indices at once and trades whichever shows the strongest edge, switching by itself. On real data that is about 4 trades a minute, roughly 9× faster than one index.</span>
              </InfoTip>
            </>
          ) : (
          <>
          <button className="icon-btn" onClick={() => setPaused(!paused)} aria-label={paused ? "Resume" : "Pause"} title={paused ? "Resume" : "Pause"}>
            <svg viewBox="0 0 16 16" aria-hidden="true">{paused ? <path d="M5 3.5v9l7-4.5z" /> : <path d="M5.5 3.5v9M10.5 3.5v9" />}</svg>
          </button>
          <div className="segmented">
            {SPEEDS.map((x) => (
              <button key={x} className={speed === x ? "on" : ""} onClick={() => setSpeed(x)}>{x}×</button>
            ))}
            {customSpeed !== null ? (
              <form
                className="speed-custom"
                onSubmit={(e) => { e.preventDefault(); applyCustomSpeed(); }}
              >
                <input
                  autoFocus
                  type="number"
                  inputMode="decimal"
                  min={MIN_SPEED}
                  max={MAX_SPEED}
                  step="any"
                  value={customSpeed}
                  placeholder="10"
                  aria-label={`Custom speed, ${MIN_SPEED} to ${MAX_SPEED}`}
                  onChange={(e) => setCustomSpeed(e.target.value)}
                  onBlur={applyCustomSpeed}
                  onKeyDown={(e) => e.key === "Escape" && setCustomSpeed(null)}
                />
                <span>×</span>
              </form>
            ) : (
              <button className={SPEEDS.includes(speed) ? "" : "on"} onClick={() => setCustomSpeed(SPEEDS.includes(speed) ? "" : String(speed))}>
                {SPEEDS.includes(speed) ? "Custom" : `${speed}×`}
              </button>
            )}
          </div>
          <InfoTip label="What does speed do?" title="Speed is fast-forward">
            <span>Speed only changes how fast this simulated market plays, so you can watch hours of trading in minutes.</span>
            <span>A live market runs at its own pace. On Deriv's fastest indices that is about 1 tick per second, so the bot makes roughly one trade every 2–4 seconds.</span>
          </InfoTip>
          </>
          )}
        </div>
      </div>

      <div className="workspace">
        <section className="pane">
          <header className="pane-head">
            <span>Market</span>
            <span className="pane-head-note">
              {autoMarket && <span className="auto-tag">Auto</span>}
              <span key={marketName} className="market-name">{marketName}</span>
              {real ? (
                <InfoTip label="Is this market real?" title="Real market">
                  <span>
                    {autoMarket
                      ? `Live ticks from all ${REAL_SYMBOLS.length} Deriv volatility indices. The chart follows the index the bot is trading or about to trade.`
                      : `Live ticks from Deriv's ${realName} (${settings.symbol}).`}{" "}
                    Trades here use the demo balance only.
                  </span>
                </InfoTip>
              ) : (
                <InfoTip label="Is this market real?" title="Simulated market">
                  <span>{MARKET_NAME} is generated in your browser to show how the bot reads digits and trades. It is not a live market.</span>
                  <span>Switch to Real market in the toolbar to watch the bot on live Deriv ticks.</span>
                </InfoTip>
              )}
            </span>
          </header>
          <div className="pane-body market-body">
            {switching && (
              <div className="market-switch" role="status" key={switching}>
                <span className="market-switch-ring" />
                <strong>Loading {switching} market</strong>
                <span>Re-sampling {settings.window} ticks</span>
              </div>
            )}
            {autoMarket && <MarketRadar bot={bot} series={engine.series} />}
            <Quote ticks={ticks} />
            <LiveChart ticks={ticks} trades={chartTrades} frame={frame} height={autoMarket ? 220 : 280} />
            <div className="term-label">Last-digit distribution · n={bot.scan.sample}</div>
            <DigitBars scan={bot.scan} highlight={setupDigits(focus)} />
          </div>
        </section>

        <section className="pane">
          <header className="pane-head">
            <span>Engine</span>
            <span className={`state ${s.running ? "on" : ""}`} aria-live="polite">
              {status}
              {s.running && <span className="state-dots" aria-hidden="true"><i /><i /><i /></span>}
            </span>
          </header>
          <div className="pane-body">
            <div className="account">
              <div className="account-top">
                <span className="side-label">Account · USD</span>
                {!editingBalance && (
                  <button
                    type="button"
                    className="account-edit"
                    onClick={() => { setDraft(String(settings.startBalance)); setEditingBalance(true); }}
                    aria-label="Edit balance"
                    title="Edit balance"
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 2.5l3 3L6 13H3v-3z" /></svg>
                  </button>
                )}
              </div>
              {editingBalance ? (
                <form className="balance-edit" onSubmit={(e) => { e.preventDefault(); applyBalance(Number(draft)); }}>
                  <label className="balance-field">
                    <span>$</span>
                    <input
                      autoFocus
                      type="number"
                      inputMode="decimal"
                      min={MIN_BALANCE}
                      max={MAX_BALANCE}
                      step="any"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      aria-label="Starting balance in USD"
                    />
                  </label>
                  <div className="balance-chips">
                    {BALANCE_PRESETS.map((n) => (
                      <button key={n} type="button" className={Number(draft) === n ? "on" : ""} onClick={() => setDraft(String(n))}>{compactUsd(n)}</button>
                    ))}
                  </div>
                  <p className="balance-hint">
                    {draftValid
                      ? `Starts a new session with ${usd(Number(draft))}. Stake ${usd(settingsForBalance(settings, Number(draft)).stake)}, stop loss ${usd(settingsForBalance(settings, Number(draft)).stopLoss)}.`
                      : `Enter an amount from ${usd(MIN_BALANCE)} to ${usd(MAX_BALANCE)}.`}
                  </p>
                  <div className="balance-actions">
                    <button type="button" className="btn outline" onClick={() => setEditingBalance(false)}>Cancel</button>
                    <button type="submit" className="btn solid" disabled={!draftValid}>Set balance</button>
                  </div>
                </form>
              ) : (
                <span className="account-balance">{usd(s.balance)}</span>
              )}
              <span key={s.trades} className={`account-pnl ${s.pnl > 0 ? "up" : s.pnl < 0 ? "down" : ""}`}>
                {signedUsd(s.pnl)} ({s.pnl >= 0 ? "+" : "−"}{Math.abs((s.pnl / s.startBalance) * 100).toFixed(2)}%) this session
              </span>
              {waiting && (
                <span className="account-scan" title={`Scanning ${bot.scan.candidates.length} setups every tick`}>
                  <i className="scan-pulse" />
                  <span><strong>{waiting.title}</strong> · {waiting.detail}</span>
                </span>
              )}
              <span className="account-meta">
                Next stake {usd(best ? bot.entryStake(best) : Math.max(0.35, settings.stake))}
                {nextUnits > 1 && <b className="stack-badge">×{nextUnits} strong signal</b>}
                {settings.turbo && settings.martingale && " · recovery paused in Turbo"}
                {bot.braked && <b className="brake-badge">Drawdown brake · half stakes</b>}
                {!settings.turbo && settings.martingale && settings.autoMartingale && best && s.recoveryStep === 0 && (() => {
                  const steps = bot.autoRecoverySteps(best.setup);
                  return steps > 0 ? ` · auto recovery up to ${steps} step${steps === 1 ? "" : "s"}` : "";
                })()}
              </span>
              {lastReason && (
                <span className="account-why">
                  <strong>{s.open ? `Why ${s.open.label}` : "Why the last trade"}</strong> · {lastReason}
                </span>
              )}
              {settings.martingale && s.recoveryLoss > 0 && (
                <div className="recovery">
                  <div className="recovery-top">
                    <span>Recovering</span>
                    <span>
                      <b className="down">{usd(s.recoveryLoss)}</b> left of {usd(s.recoveryPeak)}
                    </span>
                  </div>
                  <div className="recovery-bar">
                    <i style={{ width: `${Math.max(4, (1 - s.recoveryLoss / s.recoveryPeak) * 100)}%` }} />
                  </div>
                </div>
              )}
            </div>

            <div className="row">
              <button className={`btn lg grow ${s.running ? "outline danger" : "solid"}`} onClick={toggleBot}>
                {s.running ? "Stop bot" : "Start bot"}
              </button>
              <button className="btn outline lg" onClick={() => { newSession(); refresh(); }} disabled={s.running}>
                Reset
              </button>
            </div>
            {s.stopReason && !s.running && <p className="notice">{s.stopReason}</p>}

            <div className="stats">
              <Stat label="Trades" value={String(s.trades)} />
              <Stat label="Win rate" value={pct(winRate)} />
              <Stat label="Won / lost" value={`${s.wins} / ${s.losses}`} />
              <Stat label="Largest stake" value={usd(s.largestStake)} />
              <Stat label="Peak profit" value={usd(s.peakPnl)} />
              <Stat label="Max drawdown" value={usd(s.maxDrawdown)} />
            </div>

            <div className="term-label">Scanner · strongest setups</div>
            <Scanner scan={bot.scan} rows={6} activeLabel={s.open?.label ?? null} />

            <div className="term-label">Cumulative P/L</div>
            <Sparkline values={[0, ...s.equity]} baseline={0} stroke={s.pnl >= 0 ? POSITIVE : NEGATIVE} height={90} />
          </div>
        </section>
      </div>

      <div className="workspace">
        <section className="pane">
          <header className="pane-head"><span>Trades</span><span className="muted">{s.trades} total</span></header>
          <div className="pane-body">
            <div className="ledger">
              <div>
                <label>Money in</label>
                <strong className="down">−{usd(s.totalStaked)}</strong>
                <span>staked on {s.trades} trades</span>
              </div>
              <div>
                <label>Money out</label>
                <strong className="up">+{usd(s.totalStaked + s.pnl)}</strong>
                <span>paid back by {s.wins} winners</span>
              </div>
              <div className={`ledger-net ${s.pnl >= 0 ? "up" : "down"}`}>
                <label>Net result</label>
                <strong>{signedUsd(s.pnl)}</strong>
                <span>{s.wins} won · {s.losses} lost</span>
              </div>
            </div>

            {s.journal.length === 0 ? (
              <p className="empty">No trades yet. Start the bot and every trade will show here.</p>
            ) : (
              <div className="feed">
                <div className="feed-head">
                  <span>Trade</span><span>Contract</span><span className="r">Stake</span><span className="r">Payout</span><span className="r">Net</span>
                </div>
                <div className="feed-scroll">
                  {s.journal.slice(0, 60).map((t) => (
                    <div key={t.id} className={`feed-row ${t.won ? "win" : "loss"}`} title={t.reason}>
                      <span className="feed-id">#{t.id}<small>tick {t.epoch.toLocaleString()}</small></span>
                      <span className="feed-contract">
                        {t.label}{t.units && <b className="stack-badge">×{t.units}</b>}
                        <small>{t.market ? `${symbolShort(t.market)} · ` : ""}exit digit {t.settleDigit}</small>
                      </span>
                      <span className="r feed-stake">−{usd(t.stake)}</span>
                      <span className={`r feed-payout ${t.won ? "" : "zero"}`}>{t.won ? `+${usd(t.stake + t.pnl)}` : usd(0)}</span>
                      <span className="r"><b className="feed-net">{signedUsd(t.pnl)}</b></span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="pane">
          <header className="pane-head"><span>By contract</span></header>
          <div className="pane-body">
            {tallies.length === 0 ? (
              <p className="empty">Contracts the bot trades will appear here.</p>
            ) : (
              <div className="contract-list">
                {[...tallies].sort((a, b) => b[1].pnl - a[1].pnl).map(([k, v]) => {
                  const rate = (v.wins / v.trades) * 100;
                  return (
                    <div key={k} className="contract-row">
                      <div className="contract-row-top">
                        <strong>{CONTRACT_NAMES[k]}</strong>
                        <span className={v.pnl >= 0 ? "up" : "down"}>{signedUsd(v.pnl)}</span>
                      </div>
                      <div className="contract-row-bar"><i style={{ width: `${rate}%` }} className={v.pnl >= 0 ? "up" : "down"} /></div>
                      <div className="contract-row-meta">
                        <span>{v.trades} trades</span>
                        <span>{pct(rate)} won</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </div>

      <div className="workspace">
        <section className="pane">
          <header className="pane-head">
            <span>Parameters</span>
            <label className="check">
              <input
                type="checkbox"
                checked={settings.martingale}
                onChange={(e) => onSettings({ ...settings, martingale: e.target.checked })}
              />
              Martingale
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={settings.autoMartingale}
                disabled={!settings.martingale}
                onChange={(e) => onSettings({ ...settings, autoMartingale: e.target.checked })}
              />
              Auto
            </label>
          </header>
          <div className="pane-body">
            <div className="profiles">
              {PROFILES.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`profile${profile === p.id ? " on" : ""}`}
                  onClick={() => onSettings({ ...settings, ...p.values })}
                >
                  <strong>{p.label}</strong>
                  <span>{p.note}</span>
                  <em>Real-market test: {p.tested}</em>
                </button>
              ))}
            </div>
            <label className="check strict-check">
              <input type="checkbox" checked={settings.strictStats} onChange={(e) => onSettings({ ...settings, strictStats: e.target.checked })} />
              Strict statistics
              <InfoTip label="What is strict statistics?" title="Strict statistics">
                <span>The bot checks up to 30 setups every tick, so a few always look strong by chance. Strict mode raises the bar to allow for that.</span>
                <span>On real data it cut trades by over 99%: very safe, but the bot may wait an hour or more between trades.</span>
              </InfoTip>
            </label>
            <label className="check strict-check">
              <input type="checkbox" checked={settings.stackStakes} onChange={(e) => onSettings({ ...settings, stackStakes: e.target.checked })} />
              Stack stakes on strong signals
              <InfoTip label="What is stake stacking?" title="Stake stacking">
                <span>When a setup clears your confidence bar by a wide margin, the bot buys more than one stake unit: one extra for every 1 σ above the bar, up to Max stake units.</span>
                <span>It never stacks during recovery, and the stake cap still applies. On real data strong signals were rare, so stacking happened on a small share of trades.</span>
              </InfoTip>
            </label>
            <label className="check strict-check">
              <input type="checkbox" checked={settings.kellySizing} onChange={(e) => onSettings({ ...settings, kellySizing: e.target.checked })} />
              Kelly stake sizing
              <InfoTip label="What is Kelly sizing?" title="Kelly stake sizing">
                <span>Instead of a flat stake, each entry is sized from how big the measured edge is: a bigger edge gets a bigger stake, a thin one gets the minimum.</span>
                <span>The bot only trusts half the measured edge and bets the Kelly fraction you set (0.1 = a tenth of full Kelly). It replaces stacking; recovery staking still applies after a loss.</span>
              </InfoTip>
            </label>
            <label className="check strict-check">
              <input type="checkbox" checked={settings.randomnessFilter} onChange={(e) => onSettings({ ...settings, randomnessFilter: e.target.checked })} />
              Randomness filter
              <InfoTip label="What is the randomness filter?" title="Randomness filter">
                <span>Every tick the bot runs a chi-square test on the scan window. It only trades when the digit mix is measurably uneven (p &lt; 0.10), and sits out while digits look evenly random.</span>
                <span>Expect far fewer trades. Deriv's indices are random by design, so uneven windows are uncommon and do not last.</span>
              </InfoTip>
            </label>
            <label className="check strict-check">
              <input type="checkbox" checked={settings.regimeGuard} onChange={(e) => onSettings({ ...settings, regimeGuard: e.target.checked })} />
              Regime guard
              <InfoTip label="What is the regime guard?" title="Regime guard">
                <span>Compares the newest ticks (the confirm window) with the rest of the scan window. If the digit mix has changed sharply (p &lt; 0.01), the bot skips entries until the two agree again.</span>
              </InfoTip>
            </label>
            {!profile && <p className="profile-custom">Custom settings. Pick a preset above to return to a tested configuration.</p>}
            <div className="params">
              {SETTING_FIELDS.map((f) => {
                const locked =
                  (MANUAL_RECOVERY_KEYS.includes(f.key) && (!settings.martingale || settings.autoMartingale)) ||
                  (f.key === "maxStack" && (!settings.stackStakes || settings.kellySizing)) ||
                  (f.key === "kellyFraction" && !settings.kellySizing);
                return (
                  <label key={f.key} className={locked ? "locked" : undefined}>
                    <span>{f.label}{locked && settings.martingale ? " · auto" : ""}</span>
                    <input type="number" step={f.step} min={f.min} value={settings[f.key]} disabled={locked} onChange={(e) => updateSetting(f.key, e.target.value)} />
                  </label>
                );
              })}
            </div>
          </div>
        </section>

        <section className="pane">
          <header className="pane-head">
            <span>Stress test</span>
            <button className="btn outline sm" onClick={runComparison}>Run {BACKTEST_TICKS.toLocaleString()} ticks</button>
          </header>
          <div className="pane-body">
            {!backtest ? (
              <p className="empty">Runs two fresh sessions on {MARKET_NAME} with your current settings, session limits off.</p>
            ) : (
              <>
                <div className="charts">
                  {backtest.map((r, i) => (
                    <figure key={i}>
                      <Sparkline values={[0, ...r.equity]} baseline={0} stroke={r.pnl >= 0 ? POSITIVE : NEGATIVE} height={90} />
                      <figcaption>Session {i + 1}</figcaption>
                    </figure>
                  ))}
                </div>
                <table className="tbl dense">
                  <thead>
                    <tr><th>Session</th><th className="num">Trades</th><th className="num">Win rate</th><th className="num">Net P/L</th><th className="num">Max DD</th></tr>
                  </thead>
                  <tbody>
                    {backtest.map((r, i) => (
                      <tr key={i}>
                        <td>Session {i + 1}</td>
                        <td className="num">{r.trades.toLocaleString()}</td>
                        <td className="num">{pct(r.winRate)}</td>
                        <td className={`num ${r.pnl >= 0 ? "up" : "down"}`}>{signedUsd(r.pnl)}</td>
                        <td className="num down">−{usd(r.maxDrawdown)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </section>
      </div>

      <div className="workspace single">
        <section className="pane">
          <header className="pane-head">
            <span>
              Survival test
              <InfoTip label="What is the survival test?" title="Survival test">
                <span>
                  Plays {SURVIVAL_SESSIONS} separate sessions of up to {SURVIVAL_TICKS.toLocaleString()} ticks with your exact settings, take profit and
                  stop loss included, on digits that are evenly random like Deriv's real volatility indices.
                </span>
                <span>It shows how often a session ends in profit, at take profit, at stop loss, or with the account too low to trade. Run it after changing any setting.</span>
              </InfoTip>
            </span>
            <button className="btn outline sm" onClick={runSurvivalTest} disabled={survivalDone !== null}>
              {survivalDone !== null ? `Running ${survivalDone} / ${SURVIVAL_SESSIONS}` : `Run ${SURVIVAL_SESSIONS} sessions`}
            </button>
          </header>
          <div className="pane-body">
            {survivalDone !== null && (
              <div className="survival-progress"><i style={{ width: `${(survivalDone / SURVIVAL_SESSIONS) * 100}%` }} /></div>
            )}
            {!survival ? (
              <p className="empty">See how your settings hold up over {SURVIVAL_SESSIONS} sessions on real-like random digits before you trust them with money.</p>
            ) : (
              <>
                <div className="survival-grid">
                  <Stat label="Ended in profit" value={pct(survival.profitable)} />
                  <Stat label="Hit take profit" value={pct(survival.takeProfit)} />
                  <Stat label="Hit stop loss" value={pct(survival.stopLoss)} />
                  <Stat label="Too low to trade" value={pct(survival.blownUp)} />
                  <Stat label="Still running at the end" value={pct(survival.unfinished)} />
                  <Stat label="Median session" value={signedUsd(survival.medianPnl)} tone={survival.medianPnl < 0 ? "down" : "up"} />
                  <Stat label="Average session" value={signedUsd(survival.averagePnl)} tone={survival.averagePnl < 0 ? "down" : "up"} />
                  <Stat label="Bad session (5%)" value={signedUsd(survival.worstPnl)} tone={survival.worstPnl < 0 ? "down" : "up"} />
                  <Stat label="Good session (95%)" value={signedUsd(survival.bestPnl)} tone={survival.bestPnl < 0 ? "down" : "up"} />
                  <Stat label="Worst drawdown" value={usd(survival.worstDrawdown)} />
                </div>
                <p className="survival-note">
                  {survival.sessions} sessions on a {usd(survival.startBalance)} balance, up to {survival.ticksPerSession.toLocaleString()} ticks each,
                  {" "}{survival.averageTrades.toFixed(0)} trades per session on average.
                  {(() => {
                    const other = 100 - survival.takeProfit - survival.stopLoss - survival.blownUp - survival.unfinished;
                    return other > 0.5 ? ` ${pct(other)} stopped on another limit (daily loss limit or loss streak).` : "";
                  })()}
                  {" "}{survival.averagePnl < 0
                    ? "The average session lost money: with evenly random digits the payouts sit just below break-even, so settings that win often usually lose more on the sessions that go wrong."
                    : "The average session made money in this run. With evenly random digits that is luck rather than an edge; run it again and compare."}
                </p>
              </>
            )}
          </div>
        </section>
      </div>
      {summary && (
        <SessionSummary
          result={summary}
          onClose={() => setSummary(null)}
          onRunAgain={() => {
            setSummary(null);
            if (!bot.state.running) toggleBot();
          }}
        />
      )}
    </div>
  );
}
