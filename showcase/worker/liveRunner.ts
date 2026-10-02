import { DigitBot, type BotSettings, type OpenTrade } from "../src/bot";
import { AUTO_SYMBOL, REAL_SYMBOLS, type Tick } from "../src/market";
import { CLOUD_RECENT_TRADES, type CloudStatus, type CloudTrade } from "../server/cloudBots";

export const DEFAULT_REST_URL = "https://api.derivws.com";
const HISTORY_TICKS = 1000;
const PING_MS = 30_000;
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const DAILY_STOP = "Daily loss limit reached";

export interface RunnerOptions {
  settings: BotSettings;
  token: string;
  allowReal: boolean;
  appId: string;
  restUrl?: string;
  /** Called whenever status or recent trades change. */
  onChange: () => void;
  log: (message: string) => void;
}

const utcDay = () => new Date().toISOString().slice(0, 10);

interface DerivAccount {
  account_id: string;
  balance: string;
  currency: string;
  status: string;
  account_type: string;
}

/** A refusal Deriv will repeat on every retry (bad token, wrong account), as opposed to a network blip. */
class AccountError extends Error {}

async function derivRest<T>(url: string, token: string, appId: string, method = "GET"): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Deriv-App-ID": appId, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const fallback =
      res.status === 401 || res.status === 403
        ? "the token is wrong, expired or missing Trade scope"
        : `HTTP ${res.status}`;
    const detail = body.message ?? body.error?.message ?? body.error ?? body.errors?.[0]?.message ?? fallback;
    const text = typeof detail === "string" ? detail : fallback;
    throw res.status >= 400 && res.status < 500 && res.status !== 429 ? new AccountError(text) : new Error(text);
  }
  return body as T;
}

function lastDigit(value: string | number, pip: number): number {
  const s = typeof value === "number" ? value.toFixed(pip) : value;
  return Number(s[s.length - 1]);
}

/**
 * Runs one account's bot on its own Deriv connection: DigitBot decides, real contracts are bought,
 * and each contract's actual profit settles the bot. Reconnects by itself until stopped.
 */
export class LiveRunner {
  status: CloudStatus;
  recent: CloudTrade[] = [];
  private bot: DigitBot | null = null;
  private ws: WebSocket | null = null;
  private stopped = false;
  private seq = 0;
  private reqId = 0;
  private retryMs = RECONNECT_MIN_MS;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pips = new Map<string, number>();
  private sent = new Set<OpenTrade>();
  private buying = new Map<number, OpenTrade>();
  private contracts = new Map<number, OpenTrade>();
  private day = utcDay();
  private readonly symbols: string[];

  constructor(private opts: RunnerOptions) {
    this.symbols = opts.settings.symbol === AUTO_SYMBOL ? REAL_SYMBOLS.map((s) => s.id) : [opts.settings.symbol];
    this.status = {
      state: "starting",
      message: "Connecting to Deriv",
      loginid: "",
      isVirtual: true,
      currency: "USD",
      startBalance: 0,
      balance: 0,
      pnl: 0,
      dayPnl: 0,
      trades: 0,
      wins: 0,
      maxDrawdown: 0,
      open: null,
      startedAt: Date.now(),
      heartbeat: 0,
    };
  }

  start() {
    this.connect();
  }

  stop(message: string) {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.closeSocket();
    this.bot?.stop(message);
    this.update("stopped", message);
  }

  private update(state = this.status.state, message = this.status.message) {
    const b = this.bot;
    if (b) {
      const s = b.state;
      Object.assign(this.status, {
        startBalance: s.startBalance,
        balance: s.balance,
        pnl: s.pnl,
        dayPnl: Math.round((b.dayPnlBefore + s.pnl) * 100) / 100,
        trades: s.trades,
        wins: s.wins,
        maxDrawdown: s.maxDrawdown,
        open: s.open?.label ?? null,
      });
    }
    this.status.state = state;
    this.status.message = message;
    this.opts.onChange();
  }

  private send(msg: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private closeSocket() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
  }

  private retry(message: string) {
    if (this.stopped) return;
    this.update("starting", message);
    this.retryTimer = setTimeout(() => void this.connect(), this.retryMs);
    this.retryMs = Math.min(RECONNECT_MAX_MS, this.retryMs * 2);
  }

  /** Picks the demo account, or the real one when real money is allowed. */
  private async account(rest: string): Promise<DerivAccount> {
    const { token, appId, allowReal } = this.opts;
    const { data = [] } = await derivRest<{ data?: DerivAccount[] }>(`${rest}/trading/v1/options/accounts`, token, appId);
    if (!data.length) throw new AccountError("This token cannot see any Deriv Options accounts.");
    const demo = data.find((a) => a.account_type === "demo");
    const real = data.find((a) => a.account_type !== "demo");
    if (allowReal) {
      if (real) return real;
      throw new AccountError("“Allow real money” is ticked but this token has no real Options account.");
    }
    if (demo) return demo;
    throw new AccountError("This token only has a real-money account. Tick “Allow real money” on the website to use it.");
  }

  /** Each (re)connect mints a fresh one-time socket address, since those expire within moments. */
  private async connect() {
    if (this.stopped) return;
    const { token, appId } = this.opts;
    const rest = (this.opts.restUrl || DEFAULT_REST_URL).replace(/\/$/, "");
    let account: DerivAccount;
    let url: string;
    try {
      account = await this.account(rest);
      const otp = await derivRest<{ data?: { url?: string } }>(
        `${rest}/trading/v1/options/accounts/${encodeURIComponent(account.account_id)}/otp`,
        token,
        appId,
        "POST",
      );
      if (!otp.data?.url) throw new Error("Deriv did not return a socket address");
      url = otp.data.url;
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (err instanceof AccountError) return this.fail(`Deriv refused the token: ${text}`);
      this.opts.log(`connect failed: ${text}`);
      return this.retry("Deriv unreachable, retrying");
    }
    if (this.stopped) return;

    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.pingTimer = setInterval(() => this.send({ ping: 1 }), PING_MS);
      this.onAuthorized(account);
    };
    ws.onmessage = (e) => {
      try {
        this.onMessage(JSON.parse(String(e.data)));
      } catch (err) {
        this.opts.log(`message error: ${err instanceof Error ? err.message : err}`);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws || this.stopped) return;
      this.closeSocket();
      this.retry("Connection lost, reconnecting");
    };
    ws.onerror = () => this.opts.log("socket error");
  }

  private fail(message: string) {
    this.opts.log(message);
    this.stop(message);
    this.status.state = "error";
    this.opts.onChange();
  }

  private onMessage(msg: any) {
    if (msg.error) {
      const text = `${msg.error.message ?? "Deriv error"}`;
      if (msg.msg_type === "buy") {
        const open = this.buying.get(msg.req_id);
        this.buying.delete(msg.req_id);
        if (open) this.bot?.cancelLive(open);
        this.opts.log(`buy refused: ${text}`);
        if (/insufficient|balance/i.test(text)) this.bot?.stop("Deriv balance too low for the stake");
        this.update();
        return;
      }
      this.opts.log(`${msg.msg_type}: ${text}`);
      return;
    }

    switch (msg.msg_type) {
      case "history":
        return this.onHistory(msg);
      case "tick":
        return this.onTick(msg.tick.symbol, Number(msg.tick.quote), msg.tick.pip_size);
      case "buy":
        return this.onBought(msg);
      case "proposal_open_contract":
        return this.onContract(msg);
    }
  }

  private onAuthorized(a: DerivAccount) {
    this.retryMs = RECONNECT_MIN_MS;
    const isVirtual = a.account_type === "demo";
    Object.assign(this.status, { loginid: a.account_id, isVirtual, currency: a.currency || "USD" });
    if (!this.bot) {
      this.bot = new DigitBot({ ...this.opts.settings, startBalance: Number(a.balance) });
      this.bot.live = true;
      this.bot.start();
    }
    this.resumeAfterReconnect();
    this.bot.clearMarkets();
    for (const sym of this.symbols) {
      this.send({ ticks_history: sym, end: "latest", count: HISTORY_TICKS, style: "ticks", subscribe: 1 });
    }
    this.update("starting", `Warming up on ${this.symbols.length} market${this.symbols.length === 1 ? "" : "s"}`);
  }

  /** Contracts bought before a reconnect are followed again; buys that never got an answer are dropped. */
  private resumeAfterReconnect() {
    const bot = this.bot!;
    for (const open of this.buying.values()) bot.cancelLive(open);
    this.buying.clear();
    for (const id of this.contracts.keys()) this.send({ proposal_open_contract: 1, contract_id: id, subscribe: 1 });
  }

  private onHistory(msg: any) {
    const bot = this.bot;
    if (!bot) return;
    const sym: string = msg.echo_req.ticks_history;
    const pip = msg.pip_size ?? 2;
    this.pips.set(sym, pip);
    const prices: number[] = msg.history?.prices ?? [];
    const wasRunning = bot.state.running;
    bot.state.running = false;
    prices.forEach((q, i) => bot.onTick(this.tick(sym, Number(q), pip), i === prices.length - 1));
    bot.state.running = wasRunning;
    if (bot.state.running) this.update("running", "Scanning live ticks");
  }

  private tick(market: string, quote: number, pip: number): Tick {
    return { epoch: ++this.seq, quote, digit: lastDigit(quote, pip), pip, market };
  }

  private onTick(sym: string, quote: number, pipSize: number | undefined) {
    const bot = this.bot;
    if (!bot) return;
    const pip = pipSize ?? this.pips.get(sym) ?? 2;
    this.pips.set(sym, pip);
    this.rollDay(bot);
    bot.onTick(this.tick(sym, quote, pip));
    for (const open of bot.state.positions) if (!this.sent.has(open)) this.buy(open);
    if (!bot.state.running && this.status.state === "running") this.ended();
  }

  /** A new UTC day starts the daily loss count again and wakes a bot the daily limit stopped. */
  private rollDay(bot: DigitBot) {
    const today = utcDay();
    if (today === this.day) return;
    this.day = today;
    bot.dayPnlBefore = -bot.state.pnl;
    if (!bot.state.running && bot.state.stopReason === DAILY_STOP) {
      bot.start();
      this.update("running", "New day, trading again");
    }
  }

  private buy(open: OpenTrade) {
    this.sent.add(open);
    const id = ++this.reqId;
    this.buying.set(id, open);
    const parameters: Record<string, unknown> = {
      amount: open.stake,
      basis: "stake",
      contract_type: open.setup.contract,
      currency: this.status.currency,
      duration: 1,
      duration_unit: "t",
      symbol: open.market,
    };
    if (open.setup.barrier !== null) parameters.barrier = String(open.setup.barrier);
    this.send({ buy: 1, price: open.stake, parameters, req_id: id });
    this.update("running", `Bought ${open.label}`);
  }

  private onBought(msg: any) {
    const open = this.buying.get(msg.req_id);
    this.buying.delete(msg.req_id);
    if (!open) return;
    this.contracts.set(msg.buy.contract_id, open);
    this.send({ proposal_open_contract: 1, contract_id: msg.buy.contract_id, subscribe: 1 });
  }

  private onContract(msg: any) {
    const c = msg.proposal_open_contract;
    if (!c?.is_sold) return;
    const open = this.contracts.get(c.contract_id);
    if (msg.subscription?.id) this.send({ forget: msg.subscription.id });
    if (!open || !this.bot) return;
    this.contracts.delete(c.contract_id);
    this.sent.delete(open);
    const pip = this.pips.get(open.market) ?? 2;
    const exit = c.exit_tick_display_value ?? c.exit_tick ?? c.current_spot_display_value ?? "0";
    this.bot.settleLive(open, Number(c.profit), lastDigit(exit, pip), this.seq);
    const t = this.bot.state.journal[0];
    if (t) {
      this.recent.unshift({
        id: t.id,
        at: Date.now(),
        market: open.market,
        label: t.label,
        stake: t.stake,
        pnl: t.pnl,
        won: t.won,
        digit: t.settleDigit,
        reason: t.reason ?? "",
      });
      this.recent.length = Math.min(this.recent.length, CLOUD_RECENT_TRADES);
    }
    if (this.bot.state.running) this.update("running", `${t?.won ? "Won" : "Lost"} ${t?.label ?? ""}`.trim());
    else this.ended();
  }

  /** The session stopped itself. Only a daily-limit stop keeps the connection, to resume the next UTC day. */
  private ended() {
    const s = this.bot!.state;
    const reason = s.stopReason ?? "Stopped";
    if (reason === DAILY_STOP) return this.update("stopped", `${reason}, resumes at 00:00 UTC`);
    if (this.contracts.size || this.buying.size) return this.update("stopped", reason);
    this.stopped = true;
    this.closeSocket();
    this.update("stopped", reason);
  }
}
