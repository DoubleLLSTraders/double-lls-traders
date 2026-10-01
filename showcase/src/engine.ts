import { useCallback, useEffect, useRef, useState } from "react";
import { DigitBot, type BotSettings } from "./bot";
import { AUTO_SYMBOL, DemoMarket, REAL_SYMBOLS, type Regime, type Tick } from "./market";

export { AUTO_SYMBOL, REAL_SYMBOLS };

export const SPEEDS = [1, 5, 20, 100];
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 200;
/** At 1× the market prints one tick every BASE_TICK_MS. */
const BASE_TICK_MS = 250;
const MIN_FRAME_MS = 100;
export const CHART_TICKS = 120;

export interface Engine {
  market: DemoMarket;
  bot: DigitBot;
  /** Chart ticks of the market in view (the bot's focus market on the real feed). */
  ticks: Tick[];
  /** Recent ticks per live market. */
  series: Map<string, Tick[]>;
}

function createEngine(regime: Regime, settings: BotSettings, autoStart: boolean): Engine {
  const market = new DemoMarket(regime, Date.now(), settings.mode);
  const bot = new DigitBot(settings);
  const ticks: Tick[] = [];
  for (let i = 0; i < settings.window; i++) {
    const t = market.next();
    ticks.push(t);
    bot.onTick(t, false);
  }
  if (autoStart) bot.start();
  return { market, bot, ticks: ticks.slice(-CHART_TICKS), series: new Map() };
}

/** Plays the market forward without trading so the chart and digit sample reflect a newly chosen market at once. */
function warmUp(engine: Engine, ticks: number) {
  const { bot, market } = engine;
  const wasRunning = bot.state.running;
  bot.state.running = false;
  for (let i = 0; i < ticks; i++) {
    const t = market.next();
    engine.ticks.push(t);
    bot.onTick(t, i === ticks - 1);
  }
  bot.state.running = wasRunning;
  if (engine.ticks.length > CHART_TICKS) engine.ticks.splice(0, engine.ticks.length - CHART_TICKS);
}

interface SimulationOptions {
  initialRegime?: Regime;
  /** Start the bot immediately (used for the live preview on the landing page). */
  autoStart?: boolean;
  initialSource?: Source;
}

export type Source = "sim" | "real";
export type FeedStatus = "idle" | "connecting" | "live" | "error";

const DERIV_WS = "wss://api.derivws.com/trading/v1/options/ws/public";
const REAL_HISTORY = 1000;

const lastDigit = (quote: number, pip: number) => {
  const s = quote.toFixed(pip);
  return Number(s[s.length - 1]);
};

/**
 * Streams live Deriv ticks into the engine: one index, or every index at once when `symbol` is AUTO_SYMBOL.
 * Epochs are renumbered across all markets so cooldowns count ticks, not seconds.
 */
function useRealFeed(engine: Engine, symbol: string, enabled: boolean, autoStart: boolean, onFrame: () => void) {
  const [status, setStatus] = useState<FeedStatus>("idle");

  useEffect(() => {
    if (!enabled) {
      setStatus("idle");
      return;
    }
    setStatus("connecting");
    const symbols = symbol === AUTO_SYMBOL ? REAL_SYMBOLS.map((x) => x.id) : [symbol];
    const pips = new Map<string, number>();
    let seq = (engine.ticks[engine.ticks.length - 1]?.epoch ?? 0) + 1;
    let pending = symbols.length;
    let closed = false;
    let raf = 0;
    const { bot } = engine;
    bot.clearMarkets();
    engine.series.clear();
    engine.ticks = [];
    const ws = new WebSocket(DERIV_WS);

    const frame = () => {
      engine.ticks = engine.series.get(bot.focus) ?? engine.ticks;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; onFrame(); });
    };

    const push = (market: string, quote: number, last: boolean) => {
      const pip = pips.get(market) ?? 2;
      const t: Tick = { epoch: seq++, quote, digit: lastDigit(quote, pip), pip, market };
      let series = engine.series.get(market);
      if (!series) engine.series.set(market, (series = []));
      series.push(t);
      if (series.length > CHART_TICKS) series.splice(0, series.length - CHART_TICKS);
      bot.onTick(t, last);
    };

    ws.onopen = () => {
      symbols.forEach((sym) => ws.send(JSON.stringify({ ticks_history: sym, end: "latest", count: REAL_HISTORY, style: "ticks" })));
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.error) {
        setStatus("error");
        return;
      }
      if (msg.msg_type === "history") {
        const sym: string = msg.echo_req.ticks_history;
        pips.set(sym, msg.pip_size ?? 2);
        const wasRunning = bot.state.running;
        bot.state.running = false;
        const prices: number[] = msg.history.prices;
        prices.forEach((q, i) => push(sym, q, i === prices.length - 1));
        bot.state.running = wasRunning;
        ws.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
        if (--pending === 0) setStatus("live");
        frame();
      } else if (msg.msg_type === "tick" && msg.tick) {
        const sym: string = msg.tick.symbol;
        pips.set(sym, msg.tick.pip_size ?? pips.get(sym) ?? 2);
        push(sym, msg.tick.quote, true);
        if (autoStart && !bot.state.running) {
          bot.resetSession();
          bot.start();
        }
        frame();
      }
    };
    ws.onerror = () => !closed && setStatus("error");
    ws.onclose = () => !closed && setStatus("error");

    return () => {
      closed = true;
      cancelAnimationFrame(raf);
      ws.close();
    };
  }, [engine, symbol, enabled, autoStart, onFrame]);

  return status;
}

/** Runs our demo market (or the live Deriv feed) with the bot on it, and re-renders each frame. */
export function useSimulation(settings: BotSettings, { initialRegime = "pattern", autoStart = false, initialSource = "sim" }: SimulationOptions = {}) {
  const [regime, setRegime] = useState<Regime>(initialRegime);
  const [speed, setSpeed] = useState(1);
  const [paused, setPaused] = useState(false);
  const [frame, setFrame] = useState(0);
  const [source, setSourceState] = useState<Source>(initialSource);

  const engineRef = useRef<Engine | null>(null);
  if (!engineRef.current) engineRef.current = createEngine(initialRegime, settings, autoStart);
  const engine = engineRef.current;

  const refresh = useCallback(() => setFrame((f) => f + 1), []);
  const feedStatus = useRealFeed(engine, settings.symbol, source === "real", autoStart, refresh);

  const setSource = useCallback(
    (next: Source) => {
      if (next === source) return;
      if (engine.bot.state.running) engine.bot.stop(next === "real" ? "Switched to the real market" : "Switched to the simulated market");
      if (next === "sim") {
        engine.bot.clearMarkets();
        engine.series.clear();
        engine.ticks = [];
        warmUp(engine, settings.window);
      }
      setSourceState(next);
      refresh();
    },
    [engine, source, settings.window, refresh],
  );

  useEffect(() => {
    engine.market.regime = regime;
  }, [engine, regime]);

  useEffect(() => {
    engine.bot.settings = settings;
    if (engine.market.setFocus(settings.mode) && source === "sim") warmUp(engine, settings.window);
  }, [engine, settings, source]);

  useEffect(() => {
    if (paused || source === "real") return;
    const perFrame = Math.max(1, Math.round((speed * Math.max(MIN_FRAME_MS, BASE_TICK_MS / speed)) / BASE_TICK_MS));
    const frameMs = (perFrame * BASE_TICK_MS) / speed;
    const id = setInterval(() => {
      for (let i = 0; i < perFrame; i++) {
        const t = engine.market.next();
        engine.ticks.push(t);
        engine.bot.onTick(t, i === perFrame - 1);
        if (autoStart && !engine.bot.state.running) {
          engine.bot.resetSession();
          engine.bot.start();
        }
      }
      if (engine.ticks.length > CHART_TICKS) engine.ticks.splice(0, engine.ticks.length - CHART_TICKS);
      setFrame((f) => f + 1);
    }, frameMs);
    return () => clearInterval(id);
  }, [engine, speed, paused, autoStart, source]);

  return { engine, frame, regime, setRegime, speed, setSpeed, paused, setPaused, refresh, source, setSource, feedStatus };
}
