/** Admin-assigned AI Operator pocket — app-level accounting, not a Deriv sub-account. */

const STORAGE_KEY = "brick-trader-ai-bankroll";
const LOG_LIMIT = 80;

export type AiOperatorStatus =
  | "idle"
  | "scanning"
  | "hunting"
  | "paused"
  | "stopped";

export interface AiBankrollState {
  allocated: number;
  reservePercent: number;
  /** Cumulative PnL attributed to Operator-tagged trades. */
  aiPnl: number;
  /** Cap per contract while Operator owns the bot (normal confidence). */
  maxStakePerTrade: number;
  /** Higher stake cap when Matches confirms are full (never for Differs). */
  confidentMaxStake: number;
  /**
   * @deprecated Kept for UI; Operator never enables martingale on Differs —
   * wins pay ~9% so doubling after a loss cannot recover.
   */
  martingaleWhenConfident: boolean;
  /**
   * Absolute profit aim (currency units). Operator hard-stops when aiPnl ≥ this.
   * Default mission: start ~50, aim +500. 0 = use takeProfitPercent instead.
   */
  aimProfit: number;
  /** Stop when pocket PnL reaches +this % of allocation. 0 = off. Used if aimProfit is 0. */
  takeProfitPercent: number;
  /** Stop when pocket PnL reaches -this % of allocation (still above reserve). 0 = off. */
  stopLossPercent: number;
  /** Minutes between market rescans while armed. */
  scanIntervalMinutes: number;
  /** Bumped when safe defaults change so old localStorage gets migrated. */
  settingsRevision: number;
  status: AiOperatorStatus;
  lastStopReason: string | null;
  startedAt: number | null;
  /** Epoch seconds when the current fresh run began (for trade filtering). */
  runStartedAt: number | null;
  /** Operator currently owns start/stop of the bot. */
  armed: boolean;
  cooldownUntil: number | null;
  log: string[];
}

export interface AiPocketMath {
  allocated: number;
  aiPnl: number;
  remaining: number;
  reserveFloor: number;
  usable: number;
  /** Absolute profit target the Operator is hunting. */
  aimProfit: number;
  takeProfitAt: number | null;
  stopLossAt: number | null;
  /** 0–100 progress toward aim (capped). */
  aimProgressPercent: number;
}

const SAFE_REVISION = 4;

const DEFAULTS: AiBankrollState = {
  allocated: 50,
  reservePercent: 20,
  aiPnl: 0,
  maxStakePerTrade: 0.35,
  confidentMaxStake: 0.7,
  martingaleWhenConfident: false,
  aimProfit: 500,
  takeProfitPercent: 0,
  stopLossPercent: 15,
  scanIntervalMinutes: 5,
  settingsRevision: SAFE_REVISION,
  status: "idle",
  lastStopReason: null,
  startedAt: null,
  runStartedAt: null,
  armed: false,
  cooldownUntil: null,
  log: [],
};

let cache: AiBankrollState | null = null;
const listeners = new Set<() => void>();

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function read(): AiBankrollState {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cache = { ...DEFAULTS };
      return cache;
    }
    const parsed = JSON.parse(raw) as Partial<AiBankrollState>;
    let next: AiBankrollState = {
      ...DEFAULTS,
      ...parsed,
      log: Array.isArray(parsed.log) ? parsed.log.slice(0, LOG_LIMIT) : [],
    };
    // Migrate aggressive Differs/martingale settings that burned pockets.
    if ((parsed.settingsRevision ?? 0) < SAFE_REVISION) {
      next = {
        ...next,
        maxStakePerTrade: Math.min(next.maxStakePerTrade, DEFAULTS.maxStakePerTrade),
        confidentMaxStake: Math.min(next.confidentMaxStake, DEFAULTS.confidentMaxStake),
        martingaleWhenConfident: false,
        reservePercent: Math.max(next.reservePercent, DEFAULTS.reservePercent),
        stopLossPercent:
          next.stopLossPercent === 0
            ? DEFAULTS.stopLossPercent
            : Math.min(next.stopLossPercent, DEFAULTS.stopLossPercent),
        settingsRevision: SAFE_REVISION,
        armed: false,
        status: "stopped",
        lastStopReason:
          "Safety v4 · Matches-only · min stake · long pauses (digit EV is negative)",
      };
    }
    cache = next;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function write(next: AiBankrollState): void {
  cache = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
  for (const listener of listeners) listener();
}

export function getAiBankroll(): AiBankrollState {
  return read();
}

export function subscribeAiBankroll(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function patchAiBankroll(patch: Partial<AiBankrollState>): AiBankrollState {
  const current = read();
  const next: AiBankrollState = {
    ...current,
    ...patch,
    allocated: patch.allocated !== undefined ? Math.max(1, patch.allocated) : current.allocated,
    reservePercent:
      patch.reservePercent !== undefined
        ? clamp(patch.reservePercent, 1, 50)
        : current.reservePercent,
    maxStakePerTrade:
      patch.maxStakePerTrade !== undefined
        ? Math.max(0.35, patch.maxStakePerTrade)
        : current.maxStakePerTrade,
    confidentMaxStake:
      patch.confidentMaxStake !== undefined
        ? Math.max(0.35, patch.confidentMaxStake)
        : current.confidentMaxStake,
    aimProfit:
      patch.aimProfit !== undefined ? Math.max(0, patch.aimProfit) : current.aimProfit,
  };
  write(next);
  return next;
}

export function pushAiLog(message: string): void {
  const stamp = new Date().toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const current = read();
  write({
    ...current,
    log: [`${stamp} · ${message}`, ...current.log].slice(0, LOG_LIMIT),
  });
}

export function applyAiTradePnl(pnl: number): AiBankrollState {
  const current = read();
  if (!current.armed && current.status === "idle") {
    // Still attribute if we just stopped mid-settle — only skip when never armed this run.
  }
  const next = {
    ...current,
    aiPnl: Number((current.aiPnl + pnl).toFixed(2)),
  };
  write(next);
  return next;
}

export function resetAiPnl(): AiBankrollState {
  return patchAiBankroll({ aiPnl: 0, lastStopReason: null });
}

/**
 * Clean restart: stop ownership, PnL → 0, fresh demo pocket (default $50),
 * clear policy log, stamp a new run for the AI trade list.
 */
export function restartAiFresh(budget = 50): AiBankrollState {
  const current = read();
  const next: AiBankrollState = {
    ...current,
    allocated: Math.max(1, budget),
    aiPnl: 0,
    armed: false,
    status: "idle",
    lastStopReason: null,
    startedAt: null,
    cooldownUntil: null,
    runStartedAt: Math.floor(Date.now() / 1000),
    log: [],
  };
  write(next);
  pushAiLog(
    `Restart · fresh ${next.allocated.toFixed(0)} demo pocket · PnL 0 · aim +${next.aimProfit.toFixed(0)}`,
  );
  return getAiBankroll();
}

/** Pocket math used for sizing and survival stops. */
export function pocketMath(state: AiBankrollState = read()): AiPocketMath {
  const remaining = Number((state.allocated + state.aiPnl).toFixed(2));
  const reserveFloor = Number(
    Math.max(0.35, (state.allocated * state.reservePercent) / 100).toFixed(2),
  );
  const usable = Number(Math.max(0, remaining - reserveFloor).toFixed(2));
  const aimProfit = Math.max(0, state.aimProfit);
  const takeProfitAt =
    aimProfit > 0
      ? Number(aimProfit.toFixed(2))
      : state.takeProfitPercent > 0
        ? Number(((state.allocated * state.takeProfitPercent) / 100).toFixed(2))
        : null;
  const stopLossAt =
    state.stopLossPercent > 0
      ? Number((-(state.allocated * state.stopLossPercent) / 100).toFixed(2))
      : null;
  const aimProgressPercent =
    takeProfitAt && takeProfitAt > 0
      ? Math.min(100, Math.max(0, (state.aiPnl / takeProfitAt) * 100))
      : 0;
  return {
    allocated: state.allocated,
    aiPnl: state.aiPnl,
    remaining,
    reserveFloor,
    usable,
    aimProfit,
    takeProfitAt,
    stopLossAt,
    aimProgressPercent,
  };
}

export type AiConfidenceTier = "low" | "medium" | "high" | "full";

/**
 * Stake one contract inside the usable pocket.
 * Differs pays ~1.09x — one loss needs ~11 wins at the same stake to break even,
 * so Differs stakes stay tiny. Matches pays ~8.3x — modest size only when full confirm.
 */
export function stakeFromPocket(
  state: AiBankrollState = read(),
  contracts = 1,
  tier: AiConfidenceTier = "low",
  side: "DIGITMATCH" | "DIGITDIFF" = "DIGITMATCH",
  consecutiveLosses = 0,
): number {
  const { usable } = pocketMath(state);
  const legs = Math.max(1, contracts);
  const differs = side === "DIGITDIFF";

  const fraction = differs
    ? tier === "full"
      ? 0.02
      : 0.012
    : tier === "full"
      ? 0.06
      : tier === "high"
        ? 0.04
        : tier === "medium"
          ? 0.025
          : 0.015;

  // Hard wall: Differs never uses the confident max — that path burned pockets.
  const maxCap = differs
    ? Math.min(state.maxStakePerTrade, 0.75)
    : tier === "full" || tier === "high"
      ? Math.max(state.maxStakePerTrade, state.confidentMaxStake)
      : state.maxStakePerTrade;

  const lossCut =
    consecutiveLosses >= 2 ? 0.35 : consecutiveLosses === 1 ? 0.55 : 1;

  const byUsable = ((usable * fraction) / legs) * lossCut;
  const byLegCap = usable / legs;
  const capped = Math.min(maxCap, byUsable, byLegCap);
  return Number(Math.max(0.35, Math.floor(capped * 100) / 100).toFixed(2));
}

export function survivalStopReason(state: AiBankrollState = read()): string | null {
  const math = pocketMath(state);
  if (math.remaining <= math.reserveFloor) {
    return `Bankroll floor · remaining ${math.remaining.toFixed(2)} ≤ reserve ${math.reserveFloor.toFixed(2)}`;
  }
  if (math.takeProfitAt !== null && state.aiPnl >= math.takeProfitAt) {
    return `Aim hit · +${state.aiPnl.toFixed(2)} reached +${math.takeProfitAt.toFixed(2)} target`;
  }
  if (math.stopLossAt !== null && state.aiPnl <= math.stopLossAt) {
    return `Stop-loss · pocket ${state.aiPnl.toFixed(2)} hit ${math.stopLossAt.toFixed(2)}`;
  }
  if (math.usable < 0.35) {
    return `Usable pocket ${math.usable.toFixed(2)} below min stake`;
  }
  return null;
}

export const AI_TRADE_NOTE = "ai-operator";

export function confidenceTierFromScore(score: number): AiConfidenceTier {
  if (score >= 5) return "full";
  if (score >= 4) return "high";
  if (score >= 3) return "medium";
  return "low";
}
