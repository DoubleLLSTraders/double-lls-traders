import { AUTO_LADDER_BUDGET_PERCENT, AUTO_MAX_STEPS, AUTO_STAKE_CAP_PERCENT, CHI_SHIFT, CHI_UNEVEN, RECOVERY_SPLIT, STACK_STEP_SIGMA, WIN_RATE_MARGIN, DEFAULT_SETTINGS, MIN_STAKE, MODES, OVER_PAYOUT, UNDER_PAYOUT, effectiveConfidence, setupCount, type BotSettings, type StrategyMode } from "./bot";
import { AUTO_SYMBOL, REAL_SYMBOLS } from "./market";

/** Deriv Bot runs one symbol, so an auto-market setting falls back to this index there. */
const DBOT_FALLBACK_SYMBOL = "1HZ75V";
const AUTO_SYMBOL_IDS = JSON.stringify(REAL_SYMBOLS.map((x) => x.id));

export type ExportFormat = "dbot-xml" | "javascript" | "python" | "json";

export const BOT_NAME = "Double LLS Trading Bot";
const FILE_BASE = "double-lls-trading-bot";
const JSON_FORMAT_ID = "double-lls-trading-bot";
const LEGACY_FORMAT_IDS = ["nyc-digit-engine"];

export const EXPORTS: { format: ExportFormat; label: string; hint: string; runsOn: string }[] = [
  {
    format: "dbot-xml",
    label: "Deriv Bot file (.xml)",
    hint: "No code. Import at dbot.deriv.com and press Run. Differs strategy with take profit / stop loss.",
    runsOn: "Any browser: Android, iPhone, tablet, Windows, Mac",
  },
  {
    format: "javascript",
    label: "JavaScript bot (.mjs)",
    hint: "Full engine: all contract types, watches every volatility index at once, stacks stakes on strong signals. Needs Node.js 22+.",
    runsOn: "Windows, macOS, Linux, any VPS (24/7)",
  },
  {
    format: "python",
    label: "Python bot (.py)",
    hint: "Full engine: all contract types, watches every volatility index at once, stacks stakes on strong signals. Python 3.10+ and pip install websockets.",
    runsOn: "Windows, macOS, Linux, any VPS, Raspberry Pi",
  },
  {
    format: "json",
    label: "Settings (.json)",
    hint: "Your exact settings. Re-import here or share them.",
    runsOn: "Backup and transfer between devices",
  },
];

/** Settings as shipped. Engines get the strict-stats bar folded into minConfidence; the JSON file keeps the raw values for re-import. */
function exportConfig(s: BotSettings, forEngine = true) {
  return {
    ...(forEngine ? {} : { strictStats: s.strictStats }),
    symbol: s.symbol,
    mode: s.mode,
    stake: Math.max(MIN_STAKE, s.stake),
    takeProfit: s.takeProfit,
    stopLoss: s.stopLoss,
    window: s.window,
    confirmWindow: s.confirmWindow,
    minConfidence: Math.round(effectiveConfidence(s, setupCount(s.mode)) * 1000) / 1000,
    minWinRate: s.minWinRate,
    maxConsecutiveLosses: s.maxConsecutiveLosses,
    cooldownTicks: s.cooldownTicks,
    persistTicks: s.persistTicks,
    lossCooldown: s.lossCooldown,
    stackStakes: s.stackStakes,
    maxStack: s.maxStack,
    turbo: s.turbo,
    martingale: s.martingale,
    autoMartingale: s.autoMartingale,
    maxMartingaleSteps: s.maxMartingaleSteps,
    maxStakePercent: s.maxStakePercent,
    kellySizing: s.kellySizing,
    kellyFraction: s.kellyFraction,
    drawdownBrake: s.drawdownBrake,
    dailyLossLimit: s.dailyLossLimit,
    randomnessFilter: s.randomnessFilter,
    regimeGuard: s.regimeGuard,
  };
}

const PAYOUTS = {
  DIGITMATCH: 8.9286,
  DIGITDIFF: 1.0965,
  DIGITEVEN: 1.95,
  DIGITODD: 1.95,
  DIGITOVER: OVER_PAYOUT,
  DIGITUNDER: UNDER_PAYOUT,
};

const RISK_NOTE =
  "Trading is risky and you can lose your stake. Simulated or past results do not guarantee future profit. Test on a DEMO account first.";

/** Stamped into downloaded files so a running bot can tell its owner when a newer version is out. */
export interface ExportMeta {
  version: string;
  licence: string;
  /** Absolute URL of the site's /api/bot/version endpoint; empty disables the check. */
  updateUrl: string;
}

export const DEFAULT_EXPORT_META: ExportMeta = { version: "1.0.0", licence: "", updateUrl: "" };

function buildJson(s: BotSettings, meta: ExportMeta): string {
  return JSON.stringify(
    { format: JSON_FORMAT_ID, version: 2, name: BOT_NAME, botVersion: meta.version, licence: meta.licence || undefined, settings: { ...exportConfig(s, false), minConfidence: s.minConfidence } },
    null,
    2,
  );
}

function buildJavaScript(s: BotSettings, meta: ExportMeta): string {
  const cfg = JSON.stringify(exportConfig(s), null, 2);
  const payouts = JSON.stringify(PAYOUTS, null, 2);
  return `#!/usr/bin/env node
/*
 * ${BOT_NAME} v${meta.version} - exported from the Double LLS showcase.
 * Scans Matches, Differs, Over/Under and Even/Odd every tick and buys the setup
 * whose win rate is statistically above its payout break-even.
 * ${RISK_NOTE}
 *
 * Run (Node.js 22+, no installs needed):
 *   Windows PowerShell:  $env:DERIV_TOKEN="your_token"; node ${FILE_BASE}.mjs
 *   macOS / Linux:       DERIV_TOKEN=your_token node ${FILE_BASE}.mjs
 *
 * Create a token at https://app.deriv.com/account/api-token with "Trade" scope.
 * The bot refuses REAL accounts unless you also set ALLOW_REAL=1.
 * CONFIG.mode: "auto" | "differs" | "matches" | "overunder" | "evenodd".
 */
const CONFIG = ${cfg};

/* Typical Deriv total payout multiples (stake included), used to score setups. */
const PAYOUTS = ${payouts};

const NAMES = { DIGITMATCH: "Matches", DIGITDIFF: "Differs", DIGITOVER: "Over", DIGITUNDER: "Under", DIGITEVEN: "Even", DIGITODD: "Odd" };
const APP_ID = process.env.DERIV_APP_ID || "1089";
const TOKEN = process.env.DERIV_TOKEN;
const ALLOW_REAL = process.env.ALLOW_REAL === "1";

if (!TOKEN) {
  console.error("Set DERIV_TOKEN to a Deriv API token with Trade scope.");
  process.exit(1);
}

const BOT_VERSION = ${JSON.stringify(meta.version)};
const LICENCE = ${JSON.stringify(meta.licence)};
const UPDATE_URL = ${JSON.stringify(meta.updateUrl)};

/* Tells you when a newer version of the bot is out. Trading never waits on it. */
async function checkForUpdate() {
  if (!UPDATE_URL) return;
  try {
    const query = "?v=" + BOT_VERSION + "&licence=" + encodeURIComponent(LICENCE) + "&format=javascript";
    const res = await fetch(UPDATE_URL + query, { signal: AbortSignal.timeout(5000) });
    const info = await res.json();
    if (info.updateAvailable) {
      console.log("\\n*** Update available: v" + info.latest + " (you have v" + BOT_VERSION + ") ***");
      if (info.notes) console.log("What's new: " + info.notes);
      console.log("Download it from " + info.downloadUrl + "\\n");
    }
  } catch {
    /* offline or site unreachable */
  }
}
checkForUpdate();
setInterval(checkForUpdate, 6 * 60 * 60 * 1000).unref();

function setupsFor(mode) {
  const digits = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const differs = digits.map((d) => ({ contract: "DIGITDIFF", barrier: d }));
  const matches = digits.map((d) => ({ contract: "DIGITMATCH", barrier: d }));
  const overUnder = [0, 1, 2, 3].map((b) => ({ contract: "DIGITOVER", barrier: b }))
    .concat([6, 7, 8, 9].map((b) => ({ contract: "DIGITUNDER", barrier: b })));
  const evenOdd = [{ contract: "DIGITEVEN", barrier: null }, { contract: "DIGITODD", barrier: null }];
  if (mode === "differs") return differs;
  if (mode === "matches") return matches;
  if (mode === "overunder") return overUnder;
  if (mode === "evenodd") return evenOdd;
  return differs.concat(matches, overUnder, evenOdd);
}

function wins(s, d) {
  switch (s.contract) {
    case "DIGITMATCH": return d === s.barrier;
    case "DIGITDIFF": return d !== s.barrier;
    case "DIGITOVER": return d > s.barrier;
    case "DIGITUNDER": return d < s.barrier;
    case "DIGITEVEN": return d % 2 === 0;
    default: return d % 2 === 1;
  }
}

function payout(s) {
  const p = PAYOUTS[s.contract];
  return typeof p === "number" ? p : p[s.barrier];
}

const label = (s) => NAMES[s.contract] + (s.barrier === null ? "" : " " + s.barrier);
const SETUPS = setupsFor(CONFIG.mode);

/* CONFIG.symbol "${AUTO_SYMBOL}" watches every volatility index and trades whichever shows the strongest edge. */
const SYMBOLS = CONFIG.symbol === "${AUTO_SYMBOL}" ? ${AUTO_SYMBOL_IDS} : [CONFIG.symbol];

/* Per index: recent last digits, consecutive ticks each setup has qualified for, and its latest pick. */
const books = new Map(SYMBOLS.map((sym) => [sym, { digits: [], streak: new Map(), pick: null }]));

function counts(digits, n) {
  const c = new Array(10).fill(0);
  for (const d of digits.slice(-n)) c[d]++;
  return c;
}

function share(s, c, n) {
  let w = 0;
  for (let d = 0; d < 10; d++) if (wins(s, d)) w += c[d];
  return w / n;
}

/* Chi-square of the window's digits against an even spread; above ${CHI_UNEVEN} they are measurably uneven (p < 0.10). */
function unevenness(c, n) {
  const e = n / 10;
  return c.reduce((sum, x) => sum + (x - e) ** 2 / e, 0);
}

/* Chi-square between the newest ticks and the rest of the window; above ${CHI_SHIFT} the digit mix has shifted (p < 0.01). */
function shift(all, recent) {
  const older = all.map((x, d) => x - recent[d]);
  if (older.some((x) => x < 0)) return 0;
  const n1 = older.reduce((a, b) => a + b, 0);
  const n2 = recent.reduce((a, b) => a + b, 0);
  if (!n1 || !n2) return 0;
  let chi = 0;
  for (let d = 0; d < 10; d++) {
    const t = older[d] + recent[d];
    if (!t) continue;
    const e1 = (t * n1) / (n1 + n2);
    const e2 = (t * n2) / (n1 + n2);
    chi += (older[d] - e1) ** 2 / e1 + (recent[d] - e2) ** 2 / e2;
  }
  return chi;
}

/* Call on every tick of an index. Normally the best expected value; while recovering, the setup whose win-back stake risks the least. */
function pickSetup(book, recovering) {
  const { digits, streak } = book;
  if (digits.length < CONFIG.window) return null;
  const main = counts(digits, CONFIG.window);
  const confirm = counts(digits, CONFIG.confirmWindow);
  const minRate = (CONFIG.minWinRate || 0) / 100;
  const blocked = (CONFIG.randomnessFilter && unevenness(main, CONFIG.window) < ${CHI_UNEVEN}) || (CONFIG.regimeGuard && shift(main, confirm) > ${CHI_SHIFT});
  let best = null;
  let fallback = null;
  for (const s of SETUPS) {
    const key = label(s);
    const pay = payout(s);
    const be = 1 / pay;
    const p = share(s, main, CONFIG.window);
    const pc = share(s, confirm, CONFIG.confirmWindow);
    const z = (p - be) / Math.sqrt((be * (1 - be)) / CONFIG.window);
    const ev = p * pay - 1;
    const need = CONFIG.mode === "auto" ? minRate : Math.min(minRate, be * ${WIN_RATE_MARGIN});
    const ok = p >= need;
    if (!fallback || (ok && !fallback.ok) || (ok === fallback.ok && z > fallback.z)) fallback = { ...s, score: ev, z, ok, p, pc, be, pay };
    if (z < CONFIG.minConfidence || pc < be || ev <= 0 || p < need || pc < need) {
      streak.delete(key);
      continue;
    }
    streak.set(key, (streak.get(key) || 0) + 1);
    if (blocked || streak.get(key) < (CONFIG.persistTicks || 0)) continue;
    const score = recovering ? -(1 - Math.min(p, pc)) / (pay - 1) : ev;
    if (!best || score > best.score) best = { ...s, score, z, p, pc, be, pay };
  }
  /* Turbo trades every tick: with nothing qualified, the most confident setup that meets the minimum win rate. */
  return best || (CONFIG.turbo ? fallback : null);
}

/* One stake unit, plus one per ${STACK_STEP_SIGMA} sigma the edge clears CONFIG.minConfidence by (up to CONFIG.maxStack). */
function unitsFor(pick) {
  if (!CONFIG.stackStakes || CONFIG.kellySizing || CONFIG.maxStack <= 1 || recoveryLoss > 0 || braked()) return 1;
  return Math.max(1, Math.min(Math.floor(CONFIG.maxStack), 1 + Math.floor((pick.z - CONFIG.minConfidence) / ${STACK_STEP_SIGMA})));
}

let balance = 0;
let startBalance = 0;
let peakPnl = 0;
let recoveryLoss = 0;
let recoveryStep = 0;
const MIN_STAKE = ${MIN_STAKE};
const round2 = (n) => Math.round(n * 100) / 100;

/* Fractional Kelly from half the measured edge over break-even, since short-window win rates overstate it. */
function kellyStake(pick) {
  const p = pick.be + (Math.min(pick.p, pick.pc) - pick.be) / 2;
  return Math.max(0, balance * CONFIG.kellyFraction * (p - (1 - p) / (pick.pay - 1)));
}

/* Down CONFIG.drawdownBrake % of the starting balance from the session peak: stakes halve and recovery pauses. */
const braked = () => CONFIG.drawdownBrake > 0 && peakPnl - pnl >= (startBalance * CONFIG.drawdownBrake) / 100;

/* Losses since 00:00 UTC; at CONFIG.dailyLossLimit the bot stops buying until the next UTC day. */
let dayKey = new Date().toISOString().slice(0, 10);
let dayPnl = 0;
let dayPaused = false;
function dayLimitHit() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) {
    dayKey = today;
    dayPnl = 0;
  }
  return CONFIG.dailyLossLimit > 0 && dayPnl <= -CONFIG.dailyLossLimit;
}

/* A losing streak is paid back over this many wins, so recovery stakes stay small. */
const RECOVERY_SPLIT = ${RECOVERY_SPLIT};

const recoveryStake = (owed, s) => owed / ((payout(s) - 1) * RECOVERY_SPLIT) + CONFIG.stake;

function stakeCap() {
  const percent = CONFIG.autoMartingale ? ${AUTO_STAKE_CAP_PERCENT} : CONFIG.maxStakePercent;
  return percent > 0 ? (balance * percent) / 100 : Infinity;
}

function stakeFor(s) {
  if (!CONFIG.martingale || CONFIG.turbo || recoveryLoss <= 0) return CONFIG.stake;
  return Math.round(Math.max(CONFIG.stake, Math.min(recoveryStake(recoveryLoss, s), stakeCap())) * 100) / 100;
}

/* Auto mode keeps a recovery streak within ${AUTO_LADDER_BUDGET_PERCENT}% of balance and the room left before the stop loss. */
function canRecover(lossSoFar, s) {
  if (braked()) return false;
  if (!CONFIG.autoMartingale) return recoveryStep < CONFIG.maxMartingaleSteps;
  if (recoveryStep >= ${AUTO_MAX_STEPS}) return false;
  const next = Math.min(recoveryStake(lossSoFar, s), stakeCap());
  let budget = (balance * ${AUTO_LADDER_BUDGET_PERCENT}) / 100;
  if (CONFIG.stopLoss > 0) budget = Math.min(budget, CONFIG.stopLoss + pnl);
  return lossSoFar + next <= budget;
}

const ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=" + APP_ID);
let currency = "USD";
/* Open positions by symbol; turbo holds one per index at once, otherwise one in total. */
const positions = new Map();
let tickCount = 0;
let cooldownUntil = 0;
let pnl = 0;
let trades = 0;
let wonCount = 0;
let lossStreak = 0;

const send = (msg) => ws.send(JSON.stringify(msg));

function lastDigit(quote, pipSize) {
  const text = Number(quote).toFixed(pipSize);
  return Number(text[text.length - 1]);
}

function stop(reason) {
  console.log("Stopped: " + reason + " | trades " + trades + " | P/L " + pnl.toFixed(2) + " " + currency);
  ws.close();
}

ws.addEventListener("open", () => {
  send({ authorize: TOKEN });
  setInterval(() => send({ ping: 1 }), 30000);
});

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.error) {
    console.error("Deriv error (" + msg.msg_type + "): " + msg.error.message);
    if (msg.msg_type === "authorize") process.exit(1);
    if (msg.msg_type === "buy") positions.delete(msg.echo_req?.passthrough?.symbol);
    return;
  }

  switch (msg.msg_type) {
    case "authorize": {
      const a = msg.authorize;
      currency = a.currency || "USD";
      balance = Number(a.balance);
      startBalance = balance;
      if (!a.is_virtual && !ALLOW_REAL) {
        console.error("This token is for a REAL account. Set ALLOW_REAL=1 only if you accept real-money risk.");
        process.exit(1);
      }
      console.log("Logged in to " + a.loginid + " (" + (a.is_virtual ? "demo" : "REAL") + "), balance " + a.balance + " " + currency);
      console.log("Mode " + CONFIG.mode + ". Warming up: collecting " + CONFIG.window + " ticks on " + SYMBOLS.join(", ") + "...");
      for (const sym of SYMBOLS) send({ ticks: sym, subscribe: 1 });
      break;
    }
    case "tick": {
      const sym = msg.tick.symbol;
      const book = books.get(sym);
      if (!book) return;
      book.digits.push(lastDigit(msg.tick.quote, msg.tick.pip_size));
      if (book.digits.length > 3000) book.digits.shift();
      tickCount++;
      const s = (book.pick = pickSetup(book, recoveryLoss > 0));
      if (!s || (CONFIG.turbo ? positions.has(sym) : positions.size > 0 || tickCount < cooldownUntil)) return;
      if (!CONFIG.turbo) for (const other of books.values()) if (other.pick && other.pick.z > s.z) return;
      if (dayLimitHit()) {
        if (!dayPaused) console.log("Daily loss limit reached: no new trades until 00:00 UTC.");
        dayPaused = true;
        return;
      }
      dayPaused = false;
      const units = unitsFor(s);
      let base = stakeFor(s);
      if (CONFIG.kellySizing && recoveryLoss <= 0) base = round2(Math.max(MIN_STAKE, Math.min(kellyStake(s), stakeCap())));
      if (braked()) base = round2(Math.max(MIN_STAKE, base / 2));
      const stake = units > 1 ? round2(Math.max(base, Math.min(base * units, stakeCap()))) : base;
      positions.set(sym, { setup: s, stake, symbol: sym, units });
      const parameters = {
        amount: stake,
        basis: "stake",
        contract_type: s.contract,
        currency,
        duration: 1,
        duration_unit: "t",
        symbol: sym,
      };
      if (s.barrier !== null) parameters.barrier = String(s.barrier);
      send({ buy: 1, price: stake, parameters, passthrough: { symbol: sym } });
      break;
    }
    case "buy": {
      const pos = positions.get(msg.echo_req?.passthrough?.symbol);
      if (!pos) return;
      pos.contractId = msg.buy.contract_id;
      send({ proposal_open_contract: 1, contract_id: msg.buy.contract_id, subscribe: 1 });
      break;
    }
    case "proposal_open_contract": {
      const c = msg.proposal_open_contract;
      if (!c || !c.is_sold) return;
      const open = [...positions.values()].find((p) => p.contractId === c.contract_id);
      if (!open) return;
      positions.delete(open.symbol);
      if (msg.subscription) send({ forget: msg.subscription.id });
      const profit = Number(c.profit);
      pnl += profit;
      balance += profit;
      dayLimitHit();
      dayPnl += profit;
      trades++;
      if (profit > 0) {
        wonCount++;
        lossStreak = 0;
        recoveryLoss = Math.max(0, recoveryLoss - (profit - CONFIG.stake * (payout(open.setup) - 1)));
        recoveryStep = 0;
      } else {
        lossStreak++;
        if (CONFIG.martingale && !CONFIG.turbo && canRecover(recoveryLoss + open.stake, open.setup)) {
          recoveryLoss += open.stake;
          recoveryStep++;
        } else {
          recoveryLoss = 0;
          recoveryStep = 0;
        }
      }
      console.log(
        "#" + trades + " " + open.symbol + " " + label(open.setup) + (open.units > 1 ? " x" + open.units : "") + " $" + open.stake.toFixed(2) + " -> " + (profit > 0 ? "WIN " : "LOSS ") + profit.toFixed(2) +
          " | P/L " + pnl.toFixed(2) + " | win rate " + ((wonCount / trades) * 100).toFixed(1) + "%",
      );
      peakPnl = Math.max(peakPnl, pnl);
      cooldownUntil = tickCount + CONFIG.cooldownTicks + 1 + (profit > 0 ? 0 : CONFIG.lossCooldown || 0);
      if (CONFIG.takeProfit > 0 && pnl >= CONFIG.takeProfit) stop("take profit reached");
      else if (CONFIG.stopLoss > 0 && pnl <= -CONFIG.stopLoss) stop("stop loss reached");
      else if (CONFIG.maxConsecutiveLosses > 0 && lossStreak >= CONFIG.maxConsecutiveLosses) stop(lossStreak + " losses in a row");
      break;
    }
  }
});

ws.addEventListener("close", () => process.exit(0));
`;
}

function buildPython(s: BotSettings, meta: ExportMeta): string {
  const cfg = JSON.stringify(exportConfig(s), null, 4);
  const payouts = JSON.stringify(PAYOUTS, null, 4);
  return `"""
${BOT_NAME} v${meta.version} - exported from the Double LLS showcase.
Scans Matches, Differs, Over/Under and Even/Odd every tick and buys the setup
whose win rate is statistically above its payout break-even.
${RISK_NOTE}

Run (Python 3.10+):
    pip install websockets
    Windows PowerShell:  $env:DERIV_TOKEN="your_token"; python ${FILE_BASE}.py
    macOS / Linux:       DERIV_TOKEN=your_token python ${FILE_BASE}.py

Create a token at https://app.deriv.com/account/api-token with "Trade" scope.
The bot refuses REAL accounts unless you also set ALLOW_REAL=1.
CONFIG["mode"]: "auto" | "differs" | "matches" | "overunder" | "evenodd".
"""
import asyncio
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request

import websockets

CONFIG = json.loads(r"""${cfg}""")

# Typical Deriv total payout multiples (stake included), used to score setups.
PAYOUTS = json.loads(r"""${payouts}""")

NAMES = {"DIGITMATCH": "Matches", "DIGITDIFF": "Differs", "DIGITOVER": "Over",
         "DIGITUNDER": "Under", "DIGITEVEN": "Even", "DIGITODD": "Odd"}
APP_ID = os.environ.get("DERIV_APP_ID", "1089")
TOKEN = os.environ.get("DERIV_TOKEN")
ALLOW_REAL = os.environ.get("ALLOW_REAL") == "1"

BOT_VERSION = ${JSON.stringify(meta.version)}
LICENCE = ${JSON.stringify(meta.licence)}
UPDATE_URL = ${JSON.stringify(meta.updateUrl)}


def check_for_update() -> None:
    """Tells you when a newer version of the bot is out. Trading never waits on it."""
    if not UPDATE_URL:
        return
    try:
        query = urllib.parse.urlencode({"v": BOT_VERSION, "licence": LICENCE, "format": "python"})
        with urllib.request.urlopen(f"{UPDATE_URL}?{query}", timeout=5) as res:
            info = json.loads(res.read().decode())
        if info.get("updateAvailable"):
            print(f"\\n*** Update available: v{info['latest']} (you have v{BOT_VERSION}) ***")
            if info.get("notes"):
                print(f"What's new: {info['notes']}")
            print(f"Download it from {info['downloadUrl']}\\n")
    except Exception:
        pass  # offline or site unreachable


def setups_for(mode: str) -> list[tuple[str, int | None]]:
    differs = [("DIGITDIFF", d) for d in range(10)]
    matches = [("DIGITMATCH", d) for d in range(10)]
    over_under = [("DIGITOVER", b) for b in (0, 1, 2, 3)] + [("DIGITUNDER", b) for b in (6, 7, 8, 9)]
    even_odd = [("DIGITEVEN", None), ("DIGITODD", None)]
    return {
        "differs": differs,
        "matches": matches,
        "overunder": over_under,
        "evenodd": even_odd,
    }.get(mode, differs + matches + over_under + even_odd)


def wins(contract: str, barrier: int | None, d: int) -> bool:
    return {
        "DIGITMATCH": lambda: d == barrier,
        "DIGITDIFF": lambda: d != barrier,
        "DIGITOVER": lambda: d > barrier,
        "DIGITUNDER": lambda: d < barrier,
        "DIGITEVEN": lambda: d % 2 == 0,
        "DIGITODD": lambda: d % 2 == 1,
    }[contract]()


def payout(contract: str, barrier: int | None) -> float:
    p = PAYOUTS[contract]
    return p if isinstance(p, (int, float)) else p[str(barrier)]


def label(contract: str, barrier: int | None) -> str:
    return NAMES[contract] + ("" if barrier is None else f" {barrier}")


SETUPS = setups_for(CONFIG["mode"])


def last_digit(quote: float, pip_size: int) -> int:
    return int(f"{quote:.{pip_size}f}"[-1])


def share(contract: str, barrier: int | None, window: list[int]) -> float:
    return sum(1 for d in window if wins(contract, barrier, d)) / len(window)


# CONFIG["symbol"] "${AUTO_SYMBOL}" watches every volatility index and trades whichever shows the strongest edge.
SYMBOLS = ${AUTO_SYMBOL_IDS} if CONFIG["symbol"] == "${AUTO_SYMBOL}" else [CONFIG["symbol"]]


def units_for(z: float, recovering: bool, braked: bool) -> int:
    # One stake unit, plus one per ${STACK_STEP_SIGMA} sigma the edge clears minConfidence by (up to maxStack).
    if not CONFIG.get("stackStakes") or CONFIG.get("kellySizing") or CONFIG.get("maxStack", 1) <= 1 or recovering or braked:
        return 1
    return max(1, min(int(CONFIG["maxStack"]), 1 + math.floor((z - CONFIG["minConfidence"]) / ${STACK_STEP_SIGMA})))


def counts(window: list[int]) -> list[int]:
    c = [0] * 10
    for d in window:
        c[d] += 1
    return c


def unevenness(c: list[int]) -> float:
    # Chi-square of the window's digits against an even spread; above ${CHI_UNEVEN} they are measurably uneven (p < 0.10).
    e = sum(c) / 10
    return sum((x - e) ** 2 / e for x in c) if e else 0.0


def shift(all_counts: list[int], recent: list[int]) -> float:
    # Chi-square between the newest ticks and the rest of the window; above ${CHI_SHIFT} the digit mix has shifted (p < 0.01).
    older = [a - r for a, r in zip(all_counts, recent)]
    n1, n2 = sum(older), sum(recent)
    if min(older) < 0 or not n1 or not n2:
        return 0.0
    chi = 0.0
    for o, r in zip(older, recent):
        t = o + r
        if t:
            e1, e2 = t * n1 / (n1 + n2), t * n2 / (n1 + n2)
            chi += (o - e1) ** 2 / e1 + (r - e2) ** 2 / e2
    return chi


def pick_setup(digits: list[int], streak: dict[str, int], recovering: bool) -> tuple[str, int | None, float, float] | None:
    # Call on every tick of an index. Normally the best expected value; while recovering, the setup whose win-back stake risks the least.
    # Returns (contract, barrier, z, edge win rate for Kelly sizing).
    if len(digits) < CONFIG["window"]:
        return None
    main = digits[-CONFIG["window"]:]
    confirm = digits[-CONFIG["confirmWindow"]:]
    main_counts, confirm_counts = counts(main), counts(confirm)
    blocked = (CONFIG.get("randomnessFilter") and unevenness(main_counts) < ${CHI_UNEVEN}) or (
        CONFIG.get("regimeGuard") and shift(main_counts, confirm_counts) > ${CHI_SHIFT}
    )
    min_rate = CONFIG.get("minWinRate", 0) / 100
    best, best_score = None, -math.inf
    fallback, fallback_rank = None, (False, -math.inf)
    for contract, barrier in SETUPS:
        pay = payout(contract, barrier)
        be = 1 / pay
        p = share(contract, barrier, main)
        pc = share(contract, barrier, confirm)
        z = (p - be) / math.sqrt(be * (1 - be) / len(main))
        ev = p * pay - 1
        edge_p = be + (min(p, pc) - be) / 2
        need = min_rate if CONFIG["mode"] == "auto" else min(min_rate, be * ${WIN_RATE_MARGIN})
        if (p >= need, z) > fallback_rank:
            fallback, fallback_rank = (contract, barrier, z, edge_p), (p >= need, z)
        key = label(contract, barrier)
        if z < CONFIG["minConfidence"] or pc < be or ev <= 0 or p < need or pc < need:
            streak.pop(key, None)
            continue
        streak[key] = streak.get(key, 0) + 1
        if blocked or streak[key] < CONFIG.get("persistTicks", 0):
            continue
        score = -(1 - min(p, pc)) / (pay - 1) if recovering else ev
        if score > best_score:
            best, best_score = (contract, barrier, z, edge_p), score
    # Turbo trades every tick: with nothing qualified, the most confident setup that meets the minimum win rate.
    return best or (fallback if CONFIG.get("turbo") else None)


async def main() -> None:
    if not TOKEN:
        sys.exit("Set DERIV_TOKEN to a Deriv API token with Trade scope.")
    asyncio.get_running_loop().run_in_executor(None, check_for_update)

    url = f"wss://ws.derivws.com/websockets/v3?app_id={APP_ID}"
    async with websockets.connect(url) as ws:
        async def send(msg: dict) -> None:
            await ws.send(json.dumps(msg))

        # Per index: recent last digits, consecutive ticks each setup has qualified for, and its latest pick.
        books = {sym: {"digits": [], "streak": {}, "pick": None} for sym in SYMBOLS}
        currency = "USD"
        positions: dict[str, dict] = {}  # open positions by symbol; turbo holds one per index at once
        tick_count = cooldown_until = trades = won = loss_streak = 0
        pnl = balance = recovery_loss = start_balance = peak_pnl = day_pnl = 0.0
        recovery_step = 0
        day_key = time.strftime("%Y-%m-%d", time.gmtime())
        day_paused = False

        def braked() -> bool:
            # Down drawdownBrake % of the starting balance from the session peak: stakes halve and recovery pauses.
            limit = CONFIG.get("drawdownBrake", 0)
            return limit > 0 and peak_pnl - pnl >= start_balance * limit / 100

        def kelly_stake(edge_p: float, contract: str, barrier: int | None) -> float:
            # Fractional Kelly on half the measured edge over break-even, since short-window win rates overstate it.
            b = payout(contract, barrier) - 1
            return max(0.0, balance * CONFIG.get("kellyFraction", 0.1) * (edge_p - (1 - edge_p) / b))

        def roll_day() -> None:
            # Losses since 00:00 UTC; at dailyLossLimit the bot stops buying until the next UTC day.
            nonlocal day_key, day_pnl
            today = time.strftime("%Y-%m-%d", time.gmtime())
            if today != day_key:
                day_key, day_pnl = today, 0.0

        def recovery_stake(owed: float, contract: str, barrier: int | None) -> float:
            # A losing streak is paid back over RECOVERY_SPLIT wins, so recovery stakes stay small.
            return owed / ((payout(contract, barrier) - 1) * ${RECOVERY_SPLIT}) + CONFIG["stake"]

        def stake_for(contract: str, barrier: int | None) -> float:
            if not CONFIG["martingale"] or CONFIG.get("turbo") or recovery_loss <= 0:
                return CONFIG["stake"]
            return round(max(CONFIG["stake"], min(recovery_stake(recovery_loss, contract, barrier), stake_cap())), 2)

        def stake_cap() -> float:
            percent = ${AUTO_STAKE_CAP_PERCENT} if CONFIG.get("autoMartingale") else CONFIG["maxStakePercent"]
            return balance * percent / 100 if percent > 0 else math.inf

        def can_recover(loss_so_far: float, contract: str, barrier: int | None) -> bool:
            # Auto mode keeps a recovery streak within ${AUTO_LADDER_BUDGET_PERCENT}% of balance and the room left before the stop loss.
            if braked():
                return False
            if not CONFIG.get("autoMartingale"):
                return recovery_step < CONFIG["maxMartingaleSteps"]
            if recovery_step >= ${AUTO_MAX_STEPS}:
                return False
            nxt = min(recovery_stake(loss_so_far, contract, barrier), stake_cap())
            budget = balance * ${AUTO_LADDER_BUDGET_PERCENT} / 100
            if CONFIG["stopLoss"] > 0:
                budget = min(budget, CONFIG["stopLoss"] + pnl)
            return loss_so_far + nxt <= budget

        await send({"authorize": TOKEN})
        async for raw in ws:
            msg = json.loads(raw)
            kind = msg.get("msg_type")
            if "error" in msg:
                print(f"Deriv error ({kind}): {msg['error']['message']}")
                if kind == "authorize":
                    return
                if kind == "buy":
                    positions.pop((msg.get("echo_req", {}).get("passthrough") or {}).get("symbol"), None)
                continue

            if kind == "authorize":
                a = msg["authorize"]
                currency = a.get("currency") or "USD"
                balance = start_balance = float(a["balance"])
                if not a.get("is_virtual") and not ALLOW_REAL:
                    sys.exit("This token is for a REAL account. Set ALLOW_REAL=1 only if you accept real-money risk.")
                print(f"Logged in to {a['loginid']} ({'demo' if a.get('is_virtual') else 'REAL'}), balance {a['balance']} {currency}")
                print(f"Mode {CONFIG['mode']}. Warming up: collecting {CONFIG['window']} ticks on {', '.join(SYMBOLS)}...")
                for sym in SYMBOLS:
                    await send({"ticks": sym, "subscribe": 1})

            elif kind == "tick":
                sym = msg["tick"]["symbol"]
                book = books.get(sym)
                if book is None:
                    continue
                book["digits"].append(last_digit(msg["tick"]["quote"], msg["tick"]["pip_size"]))
                del book["digits"][:-3000]
                tick_count += 1
                setup = book["pick"] = pick_setup(book["digits"], book["streak"], recovery_loss > 0)
                if setup is None:
                    continue
                if CONFIG.get("turbo"):
                    if sym in positions:
                        continue
                elif positions or tick_count < cooldown_until or any(b["pick"] and b["pick"][2] > setup[2] for b in books.values()):
                    continue
                roll_day()
                if CONFIG.get("dailyLossLimit", 0) > 0 and day_pnl <= -CONFIG["dailyLossLimit"]:
                    if not day_paused:
                        print("Daily loss limit reached: no new trades until 00:00 UTC.")
                    day_paused = True
                    continue
                day_paused = False
                contract, barrier, z, edge_p = setup
                units = units_for(z, recovery_loss > 0, braked())
                stake = stake_for(contract, barrier)
                if CONFIG.get("kellySizing") and recovery_loss <= 0:
                    stake = round(max(${MIN_STAKE}, min(kelly_stake(edge_p, contract, barrier), stake_cap())), 2)
                if braked():
                    stake = round(max(${MIN_STAKE}, stake / 2), 2)
                if units > 1:
                    stake = round(max(stake, min(stake * units, stake_cap())), 2)
                positions[sym] = {"contract": contract, "barrier": barrier, "stake": stake, "symbol": sym, "units": units}
                parameters = {
                    "amount": stake,
                    "basis": "stake",
                    "contract_type": contract,
                    "currency": currency,
                    "duration": 1,
                    "duration_unit": "t",
                    "symbol": sym,
                }
                if barrier is not None:
                    parameters["barrier"] = str(barrier)
                await send({"buy": 1, "price": stake, "parameters": parameters, "passthrough": {"symbol": sym}})

            elif kind == "buy":
                pos = positions.get((msg.get("echo_req", {}).get("passthrough") or {}).get("symbol"))
                if pos is None:
                    continue
                pos["contract_id"] = msg["buy"]["contract_id"]
                await send({"proposal_open_contract": 1, "contract_id": pos["contract_id"], "subscribe": 1})

            elif kind == "proposal_open_contract":
                c = msg.get("proposal_open_contract") or {}
                if not c.get("is_sold"):
                    continue
                open_trade = next((p for p in positions.values() if p.get("contract_id") == c.get("contract_id")), None)
                if open_trade is None:
                    continue
                positions.pop(open_trade["symbol"], None)
                if msg.get("subscription"):
                    await send({"forget": msg["subscription"]["id"]})
                profit = float(c["profit"])
                pnl += profit
                balance += profit
                roll_day()
                day_pnl += profit
                trades += 1
                if profit > 0:
                    won += 1
                    loss_streak = 0
                    normal_win = CONFIG["stake"] * (payout(open_trade["contract"], open_trade["barrier"]) - 1)
                    recovery_loss, recovery_step = max(0.0, recovery_loss - (profit - normal_win)), 0
                else:
                    loss_streak += 1
                    if CONFIG["martingale"] and not CONFIG.get("turbo") and can_recover(recovery_loss + open_trade["stake"], open_trade["contract"], open_trade["barrier"]):
                        recovery_loss += open_trade["stake"]
                        recovery_step += 1
                    else:
                        recovery_loss, recovery_step = 0.0, 0
                result = "WIN " if profit > 0 else "LOSS "
                name = f"{open_trade['symbol']} {label(open_trade['contract'], open_trade['barrier'])}"
                if open_trade["units"] > 1:
                    name += f" x{open_trade['units']}"
                print(f"#{trades} {name} \${open_trade['stake']:.2f} -> {result}{profit:.2f} | P/L {pnl:.2f} | win rate {won / trades * 100:.1f}%")
                open_trade = None
                peak_pnl = max(peak_pnl, pnl)
                cooldown_until = tick_count + CONFIG["cooldownTicks"] + 1 + (0 if profit > 0 else CONFIG.get("lossCooldown", 0))

                reason = None
                if CONFIG["takeProfit"] > 0 and pnl >= CONFIG["takeProfit"]:
                    reason = "take profit reached"
                elif CONFIG["stopLoss"] > 0 and pnl <= -CONFIG["stopLoss"]:
                    reason = "stop loss reached"
                elif CONFIG["maxConsecutiveLosses"] > 0 and loss_streak >= CONFIG["maxConsecutiveLosses"]:
                    reason = f"{loss_streak} losses in a row"
                if reason:
                    print(f"Stopped: {reason} | trades {trades} | P/L {pnl:.2f} {currency}")
                    return


if __name__ == "__main__":
    asyncio.run(main())
`;
}

const xmlEscape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const numberBlock = (n: number) => `<block type="math_number"><field name="NUM">${n}</field></block>`;
const getPrediction = `<block type="variables_get"><field name="VAR" id="nyc_prediction">prediction</field></block>`;

function buildDbotXml(s: BotSettings, meta: ExportMeta): string {
  const c = exportConfig(s);
  const takeProfit = c.takeProfit > 0 ? c.takeProfit : 1_000_000;
  const stopLoss = c.stopLoss > 0 ? c.stopLoss : 1_000_000;
  return `<xml xmlns="http://www.w3.org/1999/xhtml" collection="false" is_dbot="true">
  <!-- ${xmlEscape(BOT_NAME)} v${xmlEscape(meta.version)} (Lite, Differs only) - exported from the Double LLS showcase. ${xmlEscape(RISK_NOTE)} -->
  <variables>
    <variable id="nyc_prediction">prediction</variable>
  </variables>
  <block type="trade_definition" x="0" y="0">
    <statement name="TRADE_OPTIONS">
      <block type="trade_definition_market" deletable="false" movable="false">
        <field name="MARKET_LIST">synthetic_index</field>
        <field name="SUBMARKET_LIST">random_index</field>
        <field name="SYMBOL_LIST">${xmlEscape(c.symbol === AUTO_SYMBOL ? DBOT_FALLBACK_SYMBOL : c.symbol)}</field>
        <next>
          <block type="trade_definition_tradetype" deletable="false" movable="false">
            <field name="TRADETYPECAT_LIST">digits</field>
            <field name="TRADETYPE_LIST">matchesdiffers</field>
            <next>
              <block type="trade_definition_contracttype" deletable="false" movable="false">
                <field name="TYPE_LIST">DIGITDIFF</field>
                <next>
                  <block type="trade_definition_candleinterval" deletable="false" movable="false">
                    <field name="CANDLEINTERVAL_LIST">60</field>
                    <next>
                      <block type="trade_definition_restartbuysell" deletable="false" movable="false">
                        <field name="TIME_MACHINE_ENABLED">FALSE</field>
                        <next>
                          <block type="trade_definition_restartonerror" deletable="false" movable="false">
                            <field name="RESTARTONERROR">TRUE</field>
                          </block>
                        </next>
                      </block>
                    </next>
                  </block>
                </next>
              </block>
            </next>
          </block>
        </next>
      </block>
    </statement>
    <statement name="INITIALIZATION">
      <block type="variables_set">
        <field name="VAR" id="nyc_prediction">prediction</field>
        <value name="VALUE">${numberBlock(0)}</value>
      </block>
    </statement>
    <statement name="SUBMARKET">
      <block type="trade_definition_tradeoptions">
        <mutation has_first_barrier="false" has_second_barrier="false" has_prediction="true"></mutation>
        <field name="DURATIONTYPE_LIST">t</field>
        <field name="CURRENCY_LIST">USD</field>
        <value name="DURATION">
          <shadow type="math_number_positive"><field name="NUM">1</field></shadow>
        </value>
        <value name="AMOUNT">
          <shadow type="math_number_positive"><field name="NUM">${c.stake}</field></shadow>
        </value>
        <value name="PREDICTION">
          <shadow type="math_number_positive"><field name="NUM">0</field></shadow>
          ${getPrediction}
        </value>
      </block>
    </statement>
  </block>
  <block type="before_purchase" x="0" y="640">
    <statement name="BEFOREPURCHASE_STACK">
      <block type="purchase">
        <field name="PURCHASE_LIST">DIGITDIFF</field>
      </block>
    </statement>
  </block>
  <block type="during_purchase" x="720" y="0">
    <statement name="DURING_PURCHASE_STACK">
      <block type="controls_if">
        <value name="IF0"><block type="check_sell"></block></value>
      </block>
    </statement>
  </block>
  <block type="after_purchase" x="720" y="240">
    <statement name="AFTERPURCHASE_STACK">
      <block type="controls_if">
        <mutation else="1"></mutation>
        <value name="IF0">
          <block type="logic_operation">
            <field name="OP">OR</field>
            <value name="A">
              <block type="logic_compare">
                <field name="OP">GTE</field>
                <value name="A"><block type="total_profit"></block></value>
                <value name="B">${numberBlock(takeProfit)}</value>
              </block>
            </value>
            <value name="B">
              <block type="logic_compare">
                <field name="OP">LTE</field>
                <value name="A"><block type="total_profit"></block></value>
                <value name="B">${numberBlock(-stopLoss)}</value>
              </block>
            </value>
          </block>
        </value>
        <statement name="ELSE">
          <block type="variables_set">
            <field name="VAR" id="nyc_prediction">prediction</field>
            <value name="VALUE"><block type="last_digit"></block></value>
            <next>
              <block type="trade_again"></block>
            </next>
          </block>
        </statement>
      </block>
    </statement>
  </block>
</xml>
`;
}

const BUILDERS: Record<ExportFormat, { build: (s: BotSettings, meta: ExportMeta) => string; file: string; mime: string }> = {
  javascript: { build: buildJavaScript, file: `${FILE_BASE}.mjs`, mime: "text/javascript" },
  python: { build: buildPython, file: `${FILE_BASE}.py`, mime: "text/x-python" },
  "dbot-xml": { build: buildDbotXml, file: `${FILE_BASE}-lite.xml`, mime: "application/xml" },
  json: { build: buildJson, file: `${FILE_BASE}.json`, mime: "application/json" },
};

export function buildExport(format: ExportFormat, settings: BotSettings, meta: ExportMeta = DEFAULT_EXPORT_META): { file: string; text: string } {
  const b = BUILDERS[format];
  return { file: b.file, text: b.build(settings, meta) };
}

export function downloadBot(format: ExportFormat, settings: BotSettings, meta: ExportMeta = DEFAULT_EXPORT_META) {
  const { file, text } = buildExport(format, settings, meta);
  const url = URL.createObjectURL(new Blob([text], { type: BUILDERS[format].mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = file;
  a.click();
  URL.revokeObjectURL(url);
}

const MODE_IDS = new Set<string>(MODES.map((m) => m.id));

export function parseBotJson(text: string): BotSettings {
  const data = JSON.parse(text) as { format?: string; settings?: Record<string, unknown> };
  const knownFormat = data.format === JSON_FORMAT_ID || LEGACY_FORMAT_IDS.includes(data.format ?? "");
  if (!knownFormat || !data.settings) {
    throw new Error(`This is not a ${BOT_NAME} settings file.`);
  }
  const merged: BotSettings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof BotSettings)[]) {
    const value = data.settings[key];
    if (key === "symbol") {
      if (typeof value === "string" && value) merged.symbol = value;
    } else if (key === "mode") {
      if (typeof value === "string" && MODE_IDS.has(value)) merged.mode = value as StrategyMode;
    } else if (key === "martingale") {
      if (typeof value === "boolean") merged.martingale = value;
    } else if (key === "autoMartingale") {
      if (typeof value === "boolean") merged.autoMartingale = value;
    } else if (key === "strictStats" || key === "stackStakes" || key === "turbo" || key === "kellySizing" || key === "randomnessFilter" || key === "regimeGuard") {
      if (typeof value === "boolean") merged[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      merged[key] = value;
    }
  }
  return merged;
}
