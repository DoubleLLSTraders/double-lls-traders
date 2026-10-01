import { useMemo } from "react";
import { AccountButton } from "./AccountButton";
import { CONTRACT_NAMES, DEFAULT_SETTINGS, DEMO_BALANCE, OVER_PAYOUT, type ContractType } from "./bot";
import { runBacktest } from "./backtest";
import { useSimulation } from "./engine";
import { BotAvatar } from "./BotAvatar";
import { BotCompanion } from "./BotCompanion";
import { EngineScene } from "./EngineScene";
import { BOT_NAME } from "./exports";
import { LiveChart } from "./LiveChart";
import { MARKET_NAME, REAL_SYMBOLS, symbolName, symbolShort } from "./market";
import { Sparkline } from "./Sparkline";
import { Quote, Scanner, pct, signedUsd, usd } from "./ui";

const PREVIEW_TICKS = 30_000;
const SEED = 7;

const CONTRACTS: { name: string; rule: string; pays: string }[] = [
  { name: "Matches", rule: "Last digit equals your pick", pays: "8.93×" },
  { name: "Differs", rule: "Last digit is anything but your pick", pays: "1.10×" },
  { name: "Over", rule: "Last digit lands above the barrier", pays: `${OVER_PAYOUT[0].toFixed(2)}–${OVER_PAYOUT[3].toFixed(2)}×` },
  { name: "Under", rule: "Last digit lands below the barrier", pays: `${OVER_PAYOUT[0].toFixed(2)}–${OVER_PAYOUT[3].toFixed(2)}×` },
  { name: "Even", rule: "Last digit is 0, 2, 4, 6 or 8", pays: "1.95×" },
  { name: "Odd", rule: "Last digit is 1, 3, 5, 7 or 9", pays: "1.95×" },
];

const STEPS = [
  {
    title: "Scan everything",
    body: "Every tick, the engine scores all 30 setups across six contract types against the last 300 digits.",
  },
  {
    title: "Prove the edge",
    body: "A setup only qualifies when its win rate sits two standard errors above what that contract needs to break even.",
  },
  {
    title: "Take the best one",
    body: "It buys the qualifying setup with the highest expected value, with optional recovery staking, and stops on your profit or loss limits.",
  },
];

interface LandingProps {
  onTest: () => void;
  onBuy: () => void;
}

export function Landing({ onTest, onBuy }: LandingProps) {
  const { engine, frame, feedStatus } = useSimulation(DEFAULT_SETTINGS, { autoStart: true, initialSource: "real" });
  const results = useMemo(
    () => [
      { label: "Session 1", note: `${MARKET_NAME}, fresh start`, r: runBacktest("pattern", DEFAULT_SETTINGS, PREVIEW_TICKS, SEED) },
      { label: "Session 2", note: `${MARKET_NAME}, different day`, r: runBacktest("pattern", DEFAULT_SETTINGS, PREVIEW_TICKS, SEED + 1) },
    ],
    [],
  );
  const { bot, ticks } = engine;
  const open = bot.state.open;
  const mix = Object.entries(results[0].r.byContract) as [ContractType, { trades: number }][];
  const liveMarket = REAL_SYMBOLS.some((s) => s.id === bot.focus) ? bot.focus : null;
  const statusLabel = feedStatus === "live" ? "LIVE" : feedStatus === "error" ? "FEED OFFLINE" : "CONNECTING";

  return (
    <div className="landing">
      <BotCompanion lastTrade={bot.state.journal[0] ?? null} onOpen={onTest} />
      <section className="hero-wrap">
        <div className="hero-photo" />
        <div className="hero-shade" />
        <div className="hero-grain" />
        <nav className="nav overlay">
          <a className="nav-brand" href="#top" aria-label="Double LLS Trading Bot home">
            <BotAvatar size={30} />
            <span className="wordmark">DOUBLE LLS<span>TRADING BOT</span></span>
          </a>
          <div className="nav-links">
            <a href="#live">Live market</a>
            <a href="#contracts">Contracts</a>
            <a href="#how">How it works</a>
            <a href="#results">Results</a>
            <a href="#/licence">My licence</a>
            <a href="#/docs">API</a>
          </div>
          <div className="nav-cta">
            <AccountButton />
            <button className="btn pill" onClick={onBuy}>Purchase <span className="pill-arrow">›</span></button>
          </div>
        </nav>
        <header className="hero">
          <h1>One bot.<br />Every digit contract.</h1>
          <p className="subtitle">
            Matches, Differs, Over/Under and Even/Odd, scanned on every tick and traded only when the
            numbers are on your side.
          </p>
          <div className="hero-actions">
            <button className="btn solid lg" onClick={onTest}>Test the bot before purchase</button>
            <a className="btn glass lg" href="#live">Watch it live</a>
          </div>
        </header>
      </section>

      <section className="section meet">
        <div className="meet-copy">
          <span className="eyebrow">Meet the engine</span>
          <h2>It watches every tick so you do not have to.</h2>
          <p>
            Thirty setups scored at once, a trade only when one proves its edge, and a live record of every
            result. Move your cursor — it is watching that too.
          </p>
          <button className="btn solid lg" onClick={onTest}>Test the bot before purchase</button>
        </div>
        <EngineScene bot={bot} />
      </section>

      <section id="live" className="section">
        <div className="section-head">
          <h2>Watch it read the market.</h2>
          <p>{BOT_NAME} running right now on real Deriv volatility indices, streaming live ticks.</p>
        </div>
        <div className="showcase">
          <div className="showcase-chart">
            <div className="showcase-top">
              <div className="market-id">
                <span className="sym">{liveMarket ? symbolShort(liveMarket) : "LIVE"}</span>
                <span>{liveMarket ? symbolName(liveMarket) : "Volatility indices"}</span>
              </div>
              <span className="term-status"><i /> {statusLabel}</span>
            </div>
            <Quote ticks={ticks} />
            <LiveChart ticks={ticks} trades={bot.state.journal} frame={frame} height={300} />
          </div>
          <aside className="showcase-side">
            <div className="side-label">Scanner · top setups</div>
            <Scanner scan={bot.scan} rows={7} activeLabel={open?.label ?? null} />
            <div className="now">
              <span className="side-label">Now</span>
              <strong>{open ? `Trading ${open.label}` : bot.scan.best ? `Entering ${bot.scan.best.label}` : "Waiting for an edge"}</strong>
            </div>
          </aside>
        </div>
      </section>

      <section id="contracts" className="section">
        <div className="section-head">
          <h2>Six contracts. One engine.</h2>
          <p>The bot is not tied to one trick. It compares every contract on the same scale and goes where the edge is.</p>
        </div>
        <div className="contract-grid">
          {CONTRACTS.map((c) => (
            <div key={c.name} className="contract">
              <h3>{c.name}</h3>
              <p>{c.rule}</p>
              <span className="pays">Pays {c.pays}</span>
            </div>
          ))}
        </div>
      </section>

      <section id="how" className="section">
        <div className="section-head">
          <span className="eyebrow">Method</span>
          <h2>Three rules, every tick.</h2>
        </div>
        <div className="how">
          {STEPS.map((s, i) => (
            <div key={s.title}>
              <span className="how-n">0{i + 1}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="results" className="section">
        <div className="section-head">
          <span className="eyebrow">Results</span>
          <h2>Two sessions. Same engine.</h2>
          <p>
            {PREVIEW_TICKS.toLocaleString()} simulated ticks each on a {usd(DEMO_BALANCE)} starting balance,
            {" "}{usd(DEFAULT_SETTINGS.stake)} stake, running non-stop.
          </p>
        </div>
        <div className="result-grid">
          {results.map(({ label, note, r }) => (
            <div key={label} className="result">
              <div className="result-top">
                <div>
                  <h3>{label}</h3>
                  <p>{note}</p>
                </div>
                <span className={`result-pnl ${r.pnl >= 0 ? "up" : "down"}`}>{signedUsd(r.pnl)}</span>
              </div>
              <Sparkline values={[0, ...r.equity]} baseline={0} stroke={r.pnl >= 0 ? "#4cc38a" : "#e5484d"} height={110} grid={0} />
              <div className="result-stats">
                <div><span>{r.trades.toLocaleString()}</span><label>Trades</label></div>
                <div><span>{pct(r.winRate)}</span><label>Win rate</label></div>
                <div><span>{usd(r.maxDrawdown)}</span><label>Max drawdown</label></div>
              </div>
            </div>
          ))}
        </div>
        <div className="mix">
          <span className="side-label">{MARKET_NAME} · trades by contract</span>
          <div className="mix-bar">
            {mix.map(([k, v]) => (
              <div key={k} style={{ flex: v.trades }} title={`${CONTRACT_NAMES[k]}: ${v.trades}`}>
                <span>{CONTRACT_NAMES[k]}</span>
              </div>
            ))}
          </div>
        </div>
        <p className="footnote">
          Results come from our simulated {MARKET_NAME}. Live markets behave differently, and past results
          do not guarantee future earnings.
        </p>
      </section>

      <section className="cta-band">
        <div className="hero-photo dim" />
        <div className="cta-inner">
          <h2>Test it free.<br />Buy when you are sure.</h2>
          <div className="hero-actions">
            <button className="btn solid lg" onClick={onTest}>Test the bot before purchase</button>
            <button className="btn glass lg" onClick={onBuy}>Purchase</button>
          </div>
        </div>
      </section>

      <footer className="site-foot">
        <span className="wordmark small">DOUBLE LLS<span>TRADING BOT</span></span>
        <p>Simulated results. Not financial advice. Trading carries risk; only trade money you can afford to lose.</p>
        <a className="foot-link" href="#/licence">Already bought? Get your files and updates</a>
        <nav className="foot-links">
          <a href="#/docs">API docs</a>
          <a href="#/terms">Terms</a>
          <a href="#/privacy">Privacy</a>
        </nav>
      </footer>
    </div>
  );
}
