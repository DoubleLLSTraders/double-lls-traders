import { createHash, randomBytes } from "node:crypto";
import { runBacktest } from "../src/backtest";
import { DEFAULT_SETTINGS, DigitBot, MODES, PROFILES, scanMarket, type BotSettings, type BotState, type Candidate } from "../src/bot";
import { buildExport, parseBotJson, type ExportFormat } from "../src/exports";
import { AUTO_SYMBOL, REAL_SYMBOLS, type Tick } from "../src/market";
import { accountFromRequest } from "./accounts";
import type { Kv } from "./kv";

/** Bump when the API terms change; keys record the version their owner accepted. */
export const API_TERMS_VERSION = "2026-10-02";
const API_VERSION = "1.0.0";
const DERIV_WS = "wss://api.derivws.com/trading/v1/options/ws/public";
const DERIV_TIMEOUT_MS = 9000;
/** Deriv returns at most this many ticks per history request. */
const MAX_HISTORY = 5000;
const SCAN_HISTORY = 1000;
const BODY_LIMIT = 64_000;
const KEY_RATE_MAX = 120;
const RATE_WINDOW_MS = 60_000;
const MAX_KEYS_PER_ACCOUNT = 5;
const MAX_RUNNING_PER_KEY = 3;
const MAX_SESSIONS_PER_KEY = 50;
const SESSION_MAX_MS = 24 * 3_600_000;
const STOPPED_RETENTION_MS = 30 * 86_400_000;
const IDLE_KEY_RETENTION_MS = 365 * 86_400_000;
const EQUITY_KEEP = 2000;
const EXPORT_FORMATS: ExportFormat[] = ["javascript", "python", "json", "dbot-xml"];

const KEY_PREFIX = "api:key:";
const SESSION_PREFIX = "api:ses:";
const sessionKey = (keyId: string, id: string) => `${SESSION_PREFIX}${keyId}:${id}`;

interface ApiKey {
  id: string;
  /** sha256 of the key; the key itself is shown once and never stored. */
  hash: string;
  prefix: string;
  email: string;
  name: string;
  createdAt: number;
  lastUsed: number;
  requests: number;
  termsVersion: string;
  acceptedAt: number;
  /** Customer account that owns the key. */
  accountId?: string;
}

/**
 * A paper-trading bot on the live feed. It does not need a running process: each advance fetches the real
 * Deriv ticks since `cursor` and replays them through the bot in time order, so results match a live run.
 */
interface ApiSession {
  id: string;
  keyId: string;
  createdAt: number;
  updatedAt: number;
  status: "running" | "stopped";
  settings: BotSettings;
  state: BotState;
  /** Last processed Deriv tick time (unix seconds) per market. */
  cursor: Record<string, number>;
  /** Tick counter fed to the bot as its epoch, so cooldowns count ticks. */
  seq: number;
  /** Bumped on every write; a stale advance never overwrites a newer one. */
  rev: number;
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Api-Key, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS, ...headers } });

const marketsOf = (s: BotSettings) => (s.symbol === AUTO_SYMBOL ? REAL_SYMBOLS.map((m) => m.id) : [s.symbol]);
const tickSeconds = (symbol: string) => (symbol.startsWith("1HZ") ? 1 : 2);
const digitOf = (quote: number, pip: number) => {
  const s = quote.toFixed(pip);
  return Number(s[s.length - 1]);
};

/** Validates any partial settings object the same way an imported settings file is checked. */
function cleanSettings(input: unknown): BotSettings {
  const patch = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const s = parseBotJson(JSON.stringify({ format: "double-lls-trading-bot", settings: { ...DEFAULT_SETTINGS, ...patch } }));
  if (s.symbol !== AUTO_SYMBOL && !REAL_SYMBOLS.some((x) => x.id === s.symbol)) {
    throw new ApiError(400, `Unknown symbol "${s.symbol}". Use "auto" or one of /api/v1/markets.`);
  }
  s.stake = Math.min(Math.max(s.stake, 0.35), 50_000);
  s.window = Math.min(Math.max(Math.round(s.window), 50), SCAN_HISTORY);
  s.confirmWindow = Math.min(Math.max(Math.round(s.confirmWindow), 10), s.window);
  s.persistTicks = Math.min(Math.max(Math.round(s.persistTicks), 0), 50);
  s.startBalance = Math.min(Math.max(s.startBalance, 1), 1_000_000);
  s.maxStack = Math.min(Math.max(Math.round(s.maxStack), 1), 10);
  return s;
}

interface Series {
  symbol: string;
  pip: number;
  times: number[];
  prices: number[];
}

interface HistoryRequest {
  symbol: string;
  count: number;
  start?: number;
  end?: number;
}

/** Fetches tick histories for several symbols over one connection to Deriv's public feed. */
async function fetchHistories(requests: HistoryRequest[]): Promise<Map<string, Series>> {
  const out = new Map<string, Series>();
  if (!requests.length) return out;
  await new Promise<void>((ok, fail) => {
    const ws = new WebSocket(DERIV_WS);
    const done = (err?: Error) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      if (err && !out.size) fail(err);
      else ok();
    };
    const timer = setTimeout(() => done(new ApiError(503, "The Deriv market feed did not answer in time. Try again.")), DERIV_TIMEOUT_MS);
    ws.onopen = () =>
      requests.forEach((r, i) =>
        ws.send(JSON.stringify({ ticks_history: r.symbol, end: r.end ?? "latest", ...(r.start && { start: r.start }), count: r.count, style: "ticks", req_id: i + 1 })),
      );
    let answered = 0;
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.msg_type !== "history" && !msg.error) return;
      const r = requests[(msg.req_id ?? 0) - 1];
      if (r && msg.history) out.set(r.symbol, { symbol: r.symbol, pip: msg.pip_size ?? 2, times: msg.history.times ?? [], prices: msg.history.prices ?? [] });
      if (++answered === requests.length) done();
    };
    ws.onerror = () => done(new ApiError(503, "The Deriv market feed is unavailable right now. Try again shortly."));
  });
  return out;
}

const seriesTicks = (s: Series): (Tick & { time: number })[] =>
  s.prices.map((q, i) => ({ epoch: 0, time: s.times[i], quote: q, digit: digitOf(q, s.pip), pip: s.pip, market: s.symbol }));

/** Restores a session's bot: state as saved, digit history re-read from the ticks up to its cursor. */
function rehydrate(session: ApiSession, warm: Map<string, (Tick & { time: number })[]>): DigitBot {
  const bot = new DigitBot(session.settings);
  bot.state = structuredClone(session.state);
  const { positions, open, running } = bot.state;
  bot.state.positions = [];
  bot.state.open = null;
  bot.state.running = false;
  const exactFrom = session.settings.persistTicks + 1;
  for (const ticks of warm.values()) {
    const tail = ticks.slice(-session.settings.window);
    tail.forEach((t, i) => bot.onTick(t, i >= tail.length - exactFrom));
  }
  bot.state.positions = positions;
  bot.state.open = open;
  bot.state.running = running;
  return bot;
}

function snapshot(session: ApiSession, bot: DigitBot) {
  const st = bot.state;
  session.state = { ...st, equity: st.equity.slice(-EQUITY_KEEP), journal: st.journal.slice(0, 100) };
  session.updatedAt = Date.now();
}

/** Replays real ticks since the session's cursor (up to one Deriv page per market) and saves the result. */
async function advanceSession(kv: Kv, session: ApiSession): Promise<ApiSession> {
  if (session.status !== "running") return session;
  const nowSec = Math.floor(Date.now() / 1000);
  const limitSec = Math.floor((session.createdAt + SESSION_MAX_MS) / 1000);
  const warmTicks = session.settings.window + session.settings.persistTicks + 5;
  const requests = marketsOf(session.settings).map((symbol) => {
    const step = tickSeconds(symbol);
    const from = session.cursor[symbol] ?? nowSec;
    const start = from - warmTicks * step;
    return { symbol, start, end: Math.min(nowSec, limitSec, start + (MAX_HISTORY - 1) * step), count: MAX_HISTORY };
  });
  const histories = await fetchHistories(requests);

  const warm = new Map<string, (Tick & { time: number })[]>();
  const fresh: (Tick & { time: number })[] = [];
  for (const [symbol, s] of histories) {
    const cut = session.cursor[symbol] ?? nowSec;
    const ticks = seriesTicks(s);
    warm.set(symbol, ticks.filter((t) => t.time <= cut));
    fresh.push(...ticks.filter((t) => t.time > cut));
  }
  const order = new Map(REAL_SYMBOLS.map((m, i) => [m.id, i]));
  fresh.sort((a, b) => a.time - b.time || (order.get(a.market!) ?? 0) - (order.get(b.market!) ?? 0));

  const next: ApiSession = structuredClone(session);
  const bot = rehydrate(next, warm);
  for (const t of fresh) {
    bot.onTick({ ...t, epoch: ++next.seq });
    next.cursor[t.market!] = t.time;
    if (!bot.state.running) break;
  }
  if (bot.state.running && nowSec >= limitSec) bot.stop("24-hour session limit reached");
  snapshot(next, bot);
  if (!bot.state.running) next.status = "stopped";
  next.rev = session.rev + 1;

  const key = sessionKey(session.keyId, session.id);
  const saved = await kv.update<ApiSession | null>(key, () => null, (cur) => (cur && cur.rev === session.rev ? next : cur));
  return saved ?? next;
}

/** Brings every running session up to date and applies retention. Run on a schedule (every minute). */
export async function advanceAllSessions(kv: Kv) {
  const now = Date.now();
  const sessions = await kv.list<ApiSession>(SESSION_PREFIX);
  await Promise.all(
    sessions.map(async (s) => {
      if (s.status === "stopped" && now - s.updatedAt > STOPPED_RETENTION_MS) return kv.delete(sessionKey(s.keyId, s.id));
      if (s.status === "running") await advanceSession(kv, s).catch((err) => console.error("[public-api] advance failed", s.id, err));
    }),
  );
  for (const k of await kv.list<ApiKey>(KEY_PREFIX)) {
    if (now - Math.max(k.lastUsed, k.createdAt) > IDLE_KEY_RETENTION_MS) await deleteKeyData(kv, k);
  }
}

async function deleteKeyData(kv: Kv, key: ApiKey) {
  for (const s of await kv.list<ApiSession>(`${SESSION_PREFIX}${key.id}:`)) await kv.delete(sessionKey(key.id, s.id));
  await kv.delete(KEY_PREFIX + key.hash);
}

const keysOfAccount = async (kv: Kv, accountId: string) => (await kv.list<ApiKey>(KEY_PREFIX)).filter((k) => k.accountId === accountId);

/** Deletes every API key an account owns, with their sessions. */
export async function deleteAccountApiData(kv: Kv, accountId: string) {
  for (const k of await keysOfAccount(kv, accountId)) await deleteKeyData(kv, k);
}

const keyView = (k: ApiKey) => ({
  id: k.id,
  prefix: k.prefix,
  name: k.name,
  createdAt: new Date(k.createdAt).toISOString(),
  lastUsed: new Date(k.lastUsed).toISOString(),
  requests: k.requests,
});

const candidateView = (c: Candidate) => ({
  setup: c.label,
  contract: c.setup.contract,
  barrier: c.setup.barrier,
  winRate: round(c.winRate),
  breakEven: round(c.breakEven),
  confirmRate: round(c.confirmRate),
  confidence: round(c.confidence),
  expectedValue: round(c.ev, 4),
  qualified: c.ready,
});

const sampled = (eq: number[]) => (eq.length > 200 ? eq.filter((_, i) => i % Math.ceil(eq.length / 200) === 0) : eq);

function sessionView(s: ApiSession, detail = false) {
  const st = s.state;
  return {
    id: s.id,
    status: s.status,
    stopReason: st.stopReason,
    createdAt: new Date(s.createdAt).toISOString(),
    updatedAt: new Date(s.updatedAt).toISOString(),
    symbol: s.settings.symbol,
    mode: s.settings.mode,
    turbo: s.settings.turbo,
    startBalance: st.startBalance,
    balance: st.balance,
    pnl: st.pnl,
    trades: st.trades,
    wins: st.wins,
    losses: st.losses,
    winRate: st.trades ? round((st.wins / st.trades) * 100) : 0,
    maxDrawdown: st.maxDrawdown,
    largestStake: st.largestStake,
    openPositions: st.positions.length,
    ticksProcessed: s.seq,
    ...(detail && {
      settings: s.settings,
      recentTrades: st.journal.slice(0, 50).map((t) => ({
        id: t.id, market: t.market ?? null, setup: t.label, stake: t.stake, units: t.units ?? 1, exitDigit: t.settleDigit, won: t.won, pnl: t.pnl,
      })),
      equity: sampled(st.equity),
    }),
  };
}

const TOOLS: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [
  { name: "get_markets", description: "List the Deriv volatility indices, strategy modes and contract types the bot trades.", inputSchema: { type: "object", properties: {} } },
  { name: "get_default_settings", description: "Default bot settings and the tested presets (careful, balanced, active). Use these as a starting point for other tools.", inputSchema: { type: "object", properties: {} } },
  {
    name: "scan_markets",
    description: "Score every digit setup on the latest live Deriv ticks and return the strongest per market, plus the overall best qualified setup.",
    inputSchema: { type: "object", properties: { symbol: { type: "string", description: '"auto" for all indices, or a symbol like "1HZ75V".' }, settings: { type: "object", description: "Optional partial bot settings (mode, window, minConfidence, ...)." } } },
  },
  {
    name: "backtest",
    description: "Run the bot on a simulated market, or on the last 1,000 real ticks of each index, and return trades, win rate, P/L and drawdown.",
    inputSchema: {
      type: "object",
      properties: {
        settings: { type: "object" },
        market: { type: "string", enum: ["sim-pattern", "sim-fair", "real-recent"] },
        ticks: { type: "number", description: "Simulated ticks, up to 100000 (default 30000)." },
        seed: { type: "number" },
      },
    },
  },
  {
    name: "start_session",
    description: "Start a paper-trading bot on the live Deriv feed with demo money. It keeps trading every real tick (up to 24h) until stopped or a limit is hit; results are kept on the server.",
    inputSchema: { type: "object", properties: { settings: { type: "object", description: "Partial bot settings; unspecified fields use defaults." } } },
  },
  { name: "list_sessions", description: "List this key's paper-trading sessions, brought up to date with the live market.", inputSchema: { type: "object", properties: {} } },
  { name: "get_session", description: "Full state of one session: balance, P/L, win rate, recent trades and equity curve.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "stop_session", description: "Stop a running paper-trading session.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "delete_session", description: "Delete a session and its stored results.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  {
    name: "export_bot",
    description: "Generate a runnable bot file (JavaScript, Python, Deriv Bot XML or settings JSON) for the given settings, to run on the user's own Deriv account.",
    inputSchema: { type: "object", properties: { format: { type: "string", enum: EXPORT_FORMATS }, settings: { type: "object" } }, required: ["format"] },
  },
  { name: "get_account", description: "This API key's details and usage.", inputSchema: { type: "object", properties: {} } },
];

type Handler = (req: Request, ip: string) => Promise<Response | null>;

/**
 * Public developer API (/api/v1/*) and MCP endpoint (/api/mcp): API keys, live market scans, backtests,
 * paper-trading sessions and bot exports, stored in the shared Kv.
 */
export function createPublicApi(env: Record<string, string | undefined>, kv: Kv): Handler {
  const hits = new Map<string, number[]>();
  const recent = (map: Map<string, number[]>, k: string, windowMs: number) => {
    const now = Date.now();
    const list = (map.get(k) ?? []).filter((t) => now - t < windowMs);
    map.set(k, list);
    return list;
  };
  const origin = (req: Request) => (env.SITE_URL || new URL(req.url).origin).replace(/\/+$/, "");

  const readJson = async (req: Request): Promise<Record<string, unknown>> => {
    if (req.method !== "POST") return {};
    const text = await req.text();
    if (text.length > BODY_LIMIT) throw new ApiError(413, "Request too large.");
    if (!text) return {};
    const body = JSON.parse(text);
    return body && typeof body === "object" ? body : {};
  };

  const ownSession = async (key: ApiKey, id: unknown) => {
    const s = await kv.get<ApiSession>(sessionKey(key.id, str(id, 40)));
    if (!s) throw new ApiError(404, "Session not found.");
    return s;
  };
  const listOwn = (key: ApiKey) => kv.list<ApiSession>(`${SESSION_PREFIX}${key.id}:`);

  /** Every capability, shared by the REST routes and the MCP tools. */
  const ops: Record<string, (key: ApiKey, args: Record<string, unknown>) => Promise<unknown> | unknown> = {
    get_markets: () => ({
      symbols: [{ id: AUTO_SYMBOL, name: "All volatility indices (bot picks the strongest)" }, ...REAL_SYMBOLS.map(({ id, name }) => ({ id, name }))],
      modes: MODES,
      contracts: ["DIGITMATCH", "DIGITDIFF", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD"],
      notes: "Contracts are 1-tick digit options. The bot scores setups on the last digit of each tick.",
    }),
    get_default_settings: () => ({ settings: DEFAULT_SETTINGS, presets: PROFILES }),
    scan_markets: async (_key, args) => {
      const settings = cleanSettings({ ...(args.settings as object), ...(args.symbol ? { symbol: args.symbol } : {}) });
      const histories = await fetchHistories(marketsOf(settings).map((symbol) => ({ symbol, count: SCAN_HISTORY })));
      let best: { market: string; candidate: Candidate } | null = null;
      const markets = [...histories.values()].map((s) => {
        const digits = s.prices.map((q) => digitOf(q, s.pip));
        const scan = scanMarket(digits, settings);
        if (scan.best && (!best || scan.best.confidence > best.candidate.confidence)) best = { market: s.symbol, candidate: scan.best };
        return { market: s.symbol, sample: scan.sample, lastDigits: digits.slice(-10), top: scan.candidates.slice(0, 5).map(candidateView) };
      });
      const b = best as { market: string; candidate: Candidate } | null;
      return { at: new Date().toISOString(), best: b ? { market: b.market, ...candidateView(b.candidate) } : null, markets };
    },
    backtest: async (_key, args) => {
      const settings = cleanSettings(args.settings);
      const market = str(args.market, 20) || "sim-pattern";
      if (market === "real-recent") {
        const histories = await fetchHistories(marketsOf(settings).map((symbol) => ({ symbol, count: SCAN_HISTORY })));
        const order = new Map(REAL_SYMBOLS.map((m, i) => [m.id, i]));
        const ticks = [...histories.values()].flatMap(seriesTicks).sort((a, b) => a.time - b.time || (order.get(a.market!) ?? 0) - (order.get(b.market!) ?? 0));
        const bot = new DigitBot({ ...settings, takeProfit: 0, stopLoss: 0, maxConsecutiveLosses: 0 });
        bot.start();
        ticks.forEach((t, i) => bot.onTick({ ...t, epoch: i + 1 }));
        const st = bot.state;
        return { market, ticks: ticks.length, trades: st.trades, winRate: st.trades ? round((st.wins / st.trades) * 100) : 0, pnl: st.pnl, maxDrawdown: st.maxDrawdown, totalStaked: st.totalStaked, equity: sampled(st.equity) };
      }
      if (market !== "sim-pattern" && market !== "sim-fair") throw new ApiError(400, 'market must be "sim-pattern", "sim-fair" or "real-recent".');
      const ticks = Math.min(Math.max(Math.round(Number(args.ticks) || 30_000), 1000), 100_000);
      const r = runBacktest(market === "sim-pattern" ? "pattern" : "fair", settings, ticks, Number(args.seed) || Date.now());
      return { market, ticks, trades: r.trades, winRate: round(r.winRate), pnl: round(r.pnl), maxDrawdown: round(r.maxDrawdown), byContract: r.byContract, equity: sampled(r.equity) };
    },
    start_session: async (key, args) => {
      const own = await listOwn(key);
      if (own.filter((s) => s.status === "running").length >= MAX_RUNNING_PER_KEY) {
        throw new ApiError(429, `At most ${MAX_RUNNING_PER_KEY} sessions can run at once. Stop one first.`);
      }
      const stopped = own.filter((s) => s.status === "stopped").sort((a, b) => a.updatedAt - b.updatedAt);
      let count = own.length;
      while (count >= MAX_SESSIONS_PER_KEY && stopped.length) {
        await kv.delete(sessionKey(key.id, stopped.shift()!.id));
        count -= 1;
      }
      if (count >= MAX_SESSIONS_PER_KEY) throw new ApiError(429, `At most ${MAX_SESSIONS_PER_KEY} sessions can be stored. Delete some first.`);

      const settings = cleanSettings(args.settings);
      const histories = await fetchHistories(marketsOf(settings).map((symbol) => ({ symbol, count: settings.window + settings.persistTicks + 5 })));
      const now = Date.now();
      const session: ApiSession = {
        id: `ses_${randomBytes(8).toString("hex")}`,
        keyId: key.id,
        createdAt: now,
        updatedAt: now,
        status: "running",
        settings,
        state: new DigitBot(settings).state,
        cursor: Object.fromEntries([...histories.values()].map((s) => [s.symbol, s.times[s.times.length - 1] ?? Math.floor(now / 1000)])),
        seq: 0,
        rev: 0,
      };
      session.state.running = true;
      await kv.set(sessionKey(key.id, session.id), session);
      return sessionView(session, true);
    },
    list_sessions: async (key) => {
      const own = await listOwn(key);
      const fresh = await Promise.all(own.map((s) => advanceSession(kv, s).catch(() => s)));
      return { sessions: fresh.sort((a, b) => b.createdAt - a.createdAt).map((s) => sessionView(s)) };
    },
    get_session: async (key, args) => sessionView(await advanceSession(kv, await ownSession(key, args.id)), true),
    stop_session: async (key, args) => {
      const current = await advanceSession(kv, await ownSession(key, args.id)).catch(async () => ownSession(key, args.id));
      const saved = await kv.update<ApiSession | null>(sessionKey(key.id, current.id), () => null, (s) => {
        if (!s || s.status === "stopped") return s;
        s.status = "stopped";
        s.state.running = false;
        s.state.stopReason = "Stopped via API";
        s.state.positions = [];
        s.state.open = null;
        s.updatedAt = Date.now();
        s.rev += 1;
      });
      return sessionView(saved ?? current, true);
    },
    delete_session: async (key, args) => {
      const s = await ownSession(key, args.id);
      await kv.delete(sessionKey(key.id, s.id));
      return { deleted: s.id };
    },
    export_bot: (_key, args) => {
      const format = str(args.format, 20) as ExportFormat;
      if (!EXPORT_FORMATS.includes(format)) throw new ApiError(400, `format must be one of ${EXPORT_FORMATS.join(", ")}.`);
      return buildExport(format, cleanSettings(args.settings));
    },
    get_account: async (key) => {
      const own = await listOwn(key);
      return {
        id: key.id,
        prefix: key.prefix,
        email: key.email,
        name: key.name,
        createdAt: new Date(key.createdAt).toISOString(),
        lastUsed: new Date(key.lastUsed).toISOString(),
        requests: key.requests,
        termsVersion: key.termsVersion,
        runningSessions: own.filter((s) => s.status === "running").length,
        storedSessions: own.length,
        limits: { requestsPerMinute: KEY_RATE_MAX, runningSessions: MAX_RUNNING_PER_KEY, storedSessions: MAX_SESSIONS_PER_KEY, sessionHours: SESSION_MAX_MS / 3_600_000 },
      };
    },
  };

  const authenticate = async (req: Request): Promise<ApiKey> => {
    const auth = req.headers.get("authorization") ?? "";
    const raw = auth.startsWith("Bearer ") ? auth.slice(7).trim() : str(req.headers.get("x-api-key"), 200);
    if (!raw) throw new ApiError(401, "Missing API key. Send Authorization: Bearer <key>.");
    const hash = sha(raw);
    if (recent(hits, hash, RATE_WINDOW_MS).push(Date.now()) > KEY_RATE_MAX) throw new ApiError(429, `Rate limit: ${KEY_RATE_MAX} requests per minute.`);
    const key = await kv.update<ApiKey | null>(KEY_PREFIX + hash, () => null, (k) => {
      if (!k) return k;
      k.lastUsed = Date.now();
      k.requests += 1;
    });
    if (!key) throw new ApiError(401, "Invalid or deleted API key.");
    return key;
  };

  /** Keys are managed with the customer's account sign-in, never with an API key. */
  const manageKeys = async (req: Request, sub: string, body: Record<string, unknown>) => {
    const account = await accountFromRequest(kv, req);
    if (!account) throw new ApiError(401, "Sign in to your account to manage API keys. Create keys on the account page.");
    const own = await keysOfAccount(kv, account.user.id);
    if (sub === "/keys" && req.method === "GET") {
      return { status: 200, body: { keys: own.sort((a, b) => b.createdAt - a.createdAt).map(keyView) } };
    }
    if (sub === "/keys" && req.method === "POST") {
      if (own.length >= MAX_KEYS_PER_ACCOUNT) throw new ApiError(429, `An account can have ${MAX_KEYS_PER_ACCOUNT} keys. Revoke one first.`);
      const raw = `lls_${randomBytes(24).toString("base64url")}`;
      const now = Date.now();
      const key: ApiKey = {
        id: `key_${randomBytes(6).toString("hex")}`,
        hash: sha(raw),
        prefix: raw.slice(0, 10),
        email: account.user.email,
        name: str(body.name, 80),
        createdAt: now,
        lastUsed: now,
        requests: 0,
        termsVersion: API_TERMS_VERSION,
        acceptedAt: now,
        accountId: account.user.id,
      };
      await kv.set(KEY_PREFIX + key.hash, key);
      return { status: 201, body: { key: raw, ...keyView(key), note: "Store this key now. It is shown once and only a hash is kept." } };
    }
    const m = sub.match(/^\/keys\/(key_[a-f0-9]+)$/);
    if (m && req.method === "DELETE") {
      const key = own.find((k) => k.id === m[1]);
      if (!key) throw new ApiError(404, "Key not found.");
      await deleteKeyData(kv, key);
      return { status: 200, body: { deleted: key.id } };
    }
    throw new ApiError(404, "Not found.");
  };

  const openapi = (req: Request) => {
    const op = (summary: string, body?: Record<string, unknown>, params?: unknown[]) => ({
      summary,
      ...(params && { parameters: params }),
      ...(body && { requestBody: { required: false, content: { "application/json": { schema: body } } } }),
      responses: { 200: { description: "OK" }, 401: { description: "Missing or invalid key" }, 429: { description: "Rate limited" } },
    });
    const tool = (n: string) => TOOLS.find((t) => t.name === n)!;
    const idParam = [{ name: "id", in: "path", required: true, schema: { type: "string" } }];
    return {
      openapi: "3.1.0",
      info: {
        title: "Double LLS Trading Bot API",
        version: API_VERSION,
        description: `Scan live Deriv digit markets, backtest, run paper-trading bots and export runnable bots. Terms: ${origin(req)}/#/terms · Privacy: ${origin(req)}/#/privacy`,
      },
      servers: [{ url: `${origin(req)}/api/v1` }],
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
      security: [{ bearer: [] }],
      paths: {
        "/keys": {
          get: op("List your account's API keys. Authenticate with your account sign-in token, not an API key."),
          post: op("Create an API key for your account (max 5). Authenticate with your account sign-in token. Easiest from the account page.", { type: "object", properties: { name: { type: "string" } } }),
        },
        "/keys/{id}": { delete: op("Revoke one of your account's keys and delete its sessions.", undefined, idParam) },
        "/me": { get: op(tool("get_account").description), delete: op("Delete this key and every session stored for it.") },
        "/markets": { get: op(tool("get_markets").description) },
        "/settings/defaults": { get: op(tool("get_default_settings").description) },
        "/scan": { post: op(tool("scan_markets").description, tool("scan_markets").inputSchema) },
        "/backtest": { post: op(tool("backtest").description, tool("backtest").inputSchema) },
        "/sessions": { get: op(tool("list_sessions").description), post: op(tool("start_session").description, tool("start_session").inputSchema) },
        "/sessions/{id}": { get: op(tool("get_session").description, undefined, idParam), delete: op(tool("delete_session").description, undefined, idParam) },
        "/sessions/{id}/stop": { post: op(tool("stop_session").description, undefined, idParam) },
        "/export": { post: op(tool("export_bot").description, tool("export_bot").inputSchema) },
      },
    };
  };

  /** Minimal stateless MCP server (Streamable HTTP, JSON responses) exposing TOOLS. */
  const mcp = async (req: Request) => {
    if (req.method !== "POST") return json(405, { error: "MCP clients POST JSON-RPC here." }, { Allow: "POST" });
    const text = await req.text();
    if (text.length > BODY_LIMIT) throw new ApiError(413, "Request too large.");
    const parsed = JSON.parse(text || "null");
    const messages: Record<string, any>[] = Array.isArray(parsed) ? parsed : [parsed]; // eslint-disable-line @typescript-eslint/no-explicit-any
    let key: ApiKey | null = null;
    const replies: unknown[] = [];
    for (const m of messages) {
      if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") {
        replies.push({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
        continue;
      }
      if (m.id === undefined) continue;
      const reply = (result: unknown) => replies.push({ jsonrpc: "2.0", id: m.id, result });
      const fail = (code: number, message: string) => replies.push({ jsonrpc: "2.0", id: m.id, error: { code, message } });
      try {
        key ??= await authenticate(req);
        if (m.method === "initialize") {
          reply({
            protocolVersion: typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "double-lls-trading-bot", version: API_VERSION },
            instructions:
              "Tools for the Double LLS digit trading bot on Deriv volatility indices. Typical flow: get_default_settings, scan_markets, backtest, then start_session to paper-trade live and get_session to follow it, or export_bot to give the user a runnable bot for their own Deriv account. Sessions use demo money only.",
          });
        } else if (m.method === "ping") reply({});
        else if (m.method === "tools/list") reply({ tools: TOOLS });
        else if (m.method === "tools/call") {
          const name = str(m.params?.name, 40);
          const op = ops[name];
          if (!op) fail(-32602, `Unknown tool: ${name}`);
          else {
            try {
              const out = await op(key, (m.params?.arguments ?? {}) as Record<string, unknown>);
              reply({ content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out });
            } catch (err) {
              reply({ content: [{ type: "text", text: err instanceof Error ? err.message : "Tool failed." }], isError: true });
            }
          }
        } else fail(-32601, `Method not found: ${m.method}`);
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 429)) {
          return json(err.status, { jsonrpc: "2.0", id: m.id, error: { code: -32001, message: err.message } }, err.status === 401 ? { "WWW-Authenticate": 'Bearer realm="double-lls"' } : {});
        }
        fail(-32603, err instanceof Error ? err.message : "Internal error");
      }
    }
    if (!replies.length) return new Response(null, { status: 202, headers: CORS });
    return json(200, Array.isArray(parsed) ? replies : replies[0]);
  };

  const routes: [string, RegExp, string][] = [
    ["GET", /^\/me$/, "get_account"],
    ["GET", /^\/markets$/, "get_markets"],
    ["GET", /^\/settings\/defaults$/, "get_default_settings"],
    ["POST", /^\/scan$/, "scan_markets"],
    ["POST", /^\/backtest$/, "backtest"],
    ["GET", /^\/sessions$/, "list_sessions"],
    ["POST", /^\/sessions$/, "start_session"],
    ["GET", /^\/sessions\/([\w-]+)$/, "get_session"],
    ["DELETE", /^\/sessions\/([\w-]+)$/, "delete_session"],
    ["POST", /^\/sessions\/([\w-]+)\/stop$/, "stop_session"],
    ["POST", /^\/export$/, "export_bot"],
  ];

  return async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;
    if (!path.startsWith("/api/v1/") && path !== "/api/mcp") return null;
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    try {
      if (path === "/api/mcp") return await mcp(req);
      const sub = path.slice("/api/v1".length);
      if (sub === "/openapi.json" && req.method === "GET") return json(200, openapi(req));
      const body = await readJson(req);
      if (sub === "/keys" || sub.startsWith("/keys/")) {
        const r = await manageKeys(req, sub, body);
        return json(r.status, r.body);
      }
      const key = await authenticate(req);
      if (sub === "/me" && req.method === "DELETE") {
        await deleteKeyData(kv, key);
        return json(200, { deleted: true, note: "Your key, its sessions and its usage data were deleted." });
      }
      for (const [method, re, op] of routes) {
        const m = sub.match(re);
        if (!m || req.method !== method) continue;
        const args = { ...Object.fromEntries(url.searchParams), ...body, ...(m[1] ? { id: m[1] } : {}) };
        return json(op === "start_session" ? 201 : 200, await ops[op](key, args));
      }
      return json(404, { error: "Not found. See /api/v1/openapi.json." });
    } catch (err) {
      const status = err instanceof ApiError ? err.status : err instanceof SyntaxError ? 400 : 500;
      return json(status, { error: err instanceof Error ? err.message : "Request failed." });
    }
  };
}
