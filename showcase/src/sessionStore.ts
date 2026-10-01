import { DEFAULT_SETTINGS, PROFILES, type BotSettings, type BotState, type ContractTally, type ContractType, type StrategyMode } from "./bot";

const HISTORY_KEY = "double-lls:history:v1";
const SETTINGS_KEY = "double-lls:settings:v1";
const MAX_SESSIONS = 100;
const EQUITY_POINTS = 60;
const RECENT_TRADES = 100;
export const HISTORY_EVENT = "double-lls:history";
export const SETTINGS_EVENT = "double-lls:settings";
/** Fired when settings saved on another device replace the ones on this device. */
export const SETTINGS_REPLACED_EVENT = "double-lls:settings-replaced";

export interface SessionTrade {
  /** Trade number within the session; missing on records saved before it was tracked. */
  id?: number;
  /** Last digit the contract settled on. */
  digit?: number;
  label: string;
  stake: number;
  pnl: number;
  won: boolean;
}

export interface SessionRecord {
  id: string;
  startedAt: number;
  updatedAt: number;
  running: boolean;
  stopReason: string | null;
  mode: StrategyMode;
  stake: number;
  startBalance: number;
  endBalance: number;
  pnl: number;
  trades: number;
  wins: number;
  totalStaked: number;
  maxDrawdown: number;
  largestStake: number;
  byContract: Partial<Record<ContractType, ContractTally>>;
  equity: number[];
  recent: SessionTrade[];
}

export const newSessionId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function downsample(values: number[], points: number): number[] {
  if (values.length <= points) return values.slice();
  const out: number[] = [];
  for (let i = 0; i < points; i++) out.push(values[Math.round((i * (values.length - 1)) / (points - 1))]);
  return out;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: history is best-effort */
  }
}

export function loadHistory(): SessionRecord[] {
  const list = read<SessionRecord[]>(HISTORY_KEY, []);
  return Array.isArray(list) ? list : [];
}

export function saveSession(id: string, startedAt: number, state: BotState, settings: BotSettings) {
  if (state.trades === 0) return;
  const record: SessionRecord = {
    id,
    startedAt,
    updatedAt: Date.now(),
    running: state.running,
    stopReason: state.stopReason,
    mode: settings.mode,
    stake: settings.stake,
    startBalance: state.startBalance,
    endBalance: state.balance,
    pnl: state.pnl,
    trades: state.trades,
    wins: state.wins,
    totalStaked: state.totalStaked,
    maxDrawdown: state.maxDrawdown,
    largestStake: state.largestStake,
    byContract: state.byContract,
    equity: downsample(state.equity, EQUITY_POINTS),
    recent: state.journal.slice(0, RECENT_TRADES).map((t) => ({ id: t.id, digit: t.settleDigit, label: t.label, stake: t.stake, pnl: t.pnl, won: t.won })),
  };
  const list = loadHistory().filter((r) => r.id !== id);
  list.unshift(record);
  write(HISTORY_KEY, list.slice(0, MAX_SESSIONS));
  window.dispatchEvent(new Event(HISTORY_EVENT));
}

/** Combined P/L of sessions started today (local time), leaving out `excludeId`. */
export function todayPnl(excludeId: string): number {
  const midnight = new Date().setHours(0, 0, 0, 0);
  return loadHistory()
    .filter((r) => r.id !== excludeId && r.startedAt >= midnight)
    .reduce((sum, r) => sum + r.pnl, 0);
}

export function clearHistory() {
  write(HISTORY_KEY, []);
  window.dispatchEvent(new Event(HISTORY_EVENT));
}

/** Merges sessions from another device: the newer copy of each session wins. */
export function mergeHistory(incoming: SessionRecord[]) {
  const byId = new Map(loadHistory().map((r) => [r.id, r]));
  for (const r of incoming) {
    const have = byId.get(r.id);
    if (!have || r.updatedAt > have.updatedAt) byId.set(r.id, r);
  }
  const list = [...byId.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_SESSIONS);
  write(HISTORY_KEY, list);
  window.dispatchEvent(new Event(HISTORY_EVENT));
}

export function loadSettings(): BotSettings {
  const saved = read<Partial<BotSettings>>(SETTINGS_KEY, {});
  const merged = { ...DEFAULT_SETTINGS, ...saved };
  if (Object.keys(saved).length === 0) return merged;
  if (saved.persistTicks === undefined) Object.assign(merged, PROFILES.find((p) => p.id === "balanced")!.values);
  if (saved.stackStakes === undefined) merged.symbol = DEFAULT_SETTINGS.symbol;
  return merged;
}

export function saveSettings(settings: BotSettings) {
  write(SETTINGS_KEY, settings);
  window.dispatchEvent(new Event(SETTINGS_EVENT));
}

export function replaceSettings(settings: Partial<BotSettings>) {
  write(SETTINGS_KEY, { ...DEFAULT_SETTINGS, ...settings });
  window.dispatchEvent(new Event(SETTINGS_REPLACED_EVENT));
}
