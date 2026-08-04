import { storageKey } from "../../lib/platform";

export type AtlasStakeMode = "percent" | "fixed";
/** classic = wait for setup / manual bank stops bot. sprint = bank small profits fast, keep hunting to session target. */
export type AtlasBotMode = "classic" | "sprint";

export interface AtlasRiskConfig {
  /** Max fraction of equity risked per trade (when stakeMode = percent). */
  riskPerTradePct: number;
  /** Fixed cash stake / risk per trade (when stakeMode = fixed). */
  stakeAmount: number;
  stakeMode: AtlasStakeMode;
  /** Demo leverage for margin display (notional / leverage = margin). */
  leverage: number;
  dailyLossLimitPct: number;
  maxOpenTrades: number;
  maxConsecutiveLosses: number;
  maxDailyTrades: number;
  paused: boolean;
  paperMode: boolean;
  botMode: AtlasBotMode;
  /** Sprint: auto-bank when live P/L reaches this cash. */
  minBankCash: number;
  /** Sprint: stop bot when booked day P/L hits this. */
  sessionTargetCash: number;
  /** Sprint: seconds to wait underwater before cutting and moving on. */
  lossPatienceSec: number;
}

export interface AtlasRiskState {
  equity: number;
  dayPnl: number;
  openTrades: number;
  consecutiveLosses: number;
  dayTrades: number;
  /** Margin already locked in open paper trades. */
  usedMargin?: number;
}

export interface AtlasRiskVerdict {
  ok: boolean;
  reasons: string[];
  positionNotional: number;
  riskCash: number;
  marginRequired: number;
  freeMargin: number;
}

/** How margin is reserved before a fire. */
export type AtlasMarginMode = "cfd" | "stake";

const RISK_KEY = storageKey("atlas-risk-config");

export const DEFAULT_ATLAS_RISK: AtlasRiskConfig = {
  riskPerTradePct: 1,
  stakeAmount: 100,
  stakeMode: "fixed",
  leverage: 50,
  dailyLossLimitPct: 3,
  maxOpenTrades: 1,
  maxConsecutiveLosses: 4,
  maxDailyTrades: 200,
  paused: false,
  paperMode: true,
  botMode: "classic",
  minBankCash: 0.05,
  sessionTargetCash: 5,
  lossPatienceSec: 90,
};

export function loadAtlasRisk(): AtlasRiskConfig {
  try {
    const raw = localStorage.getItem(RISK_KEY);
    if (!raw) return { ...DEFAULT_ATLAS_RISK };
    const merged = { ...DEFAULT_ATLAS_RISK, ...JSON.parse(raw) } as AtlasRiskConfig;
    merged.maxOpenTrades = 1;
    // Old default (20) blocked demo sessions too early — lift saved configs.
    if (!Number.isFinite(merged.maxDailyTrades) || merged.maxDailyTrades < 50) {
      merged.maxDailyTrades = 200;
    }
    merged.minBankCash = Math.max(0.01, Number(merged.minBankCash) || 0.05);
    merged.sessionTargetCash = Math.max(
      0.5,
      Number(merged.sessionTargetCash) || 5,
    );
    merged.lossPatienceSec = Math.max(
      15,
      Math.min(600, Number(merged.lossPatienceSec) || 90),
    );
    if (merged.botMode !== "sprint") merged.botMode = "classic";
    return merged;
  } catch {
    return { ...DEFAULT_ATLAS_RISK };
  }
}

export function saveAtlasRisk(config: AtlasRiskConfig): void {
  try {
    localStorage.setItem(RISK_KEY, JSON.stringify(config));
  } catch {
    /* ignore */
  }
}

/** Cash at risk if stop is hit. */
export function resolveRiskCash(
  config: AtlasRiskConfig,
  equity: number,
): number {
  if (config.stakeMode === "fixed") {
    return Math.max(1, Math.min(config.stakeAmount, equity * 0.95));
  }
  return Math.max(1, (config.riskPerTradePct / 100) * equity);
}

/**
 * Hard gates before any automated order. Auto-trade must not fire unless ok.
 * @param marginMode `stake` = Deriv Multipliers (cost ≈ stake). `cfd` = paper display (notional / leverage).
 */
export function evaluateRisk(
  config: AtlasRiskConfig,
  state: AtlasRiskState,
  stopDistance: number,
  price: number,
  marginMode: AtlasMarginMode = "cfd",
): AtlasRiskVerdict {
  const reasons: string[] = [];
  if (config.paused) reasons.push("Trading paused by risk switch");
  if (state.openTrades >= config.maxOpenTrades) {
    reasons.push(`Max open trades (${config.maxOpenTrades}) reached`);
  }
  if (state.consecutiveLosses >= config.maxConsecutiveLosses) {
    reasons.push(`Max consecutive losses (${config.maxConsecutiveLosses}) hit`);
  }
  if (state.dayTrades >= config.maxDailyTrades) {
    reasons.push(`Max daily trades (${config.maxDailyTrades}) reached`);
  }
  const dayLossLimit = (config.dailyLossLimitPct / 100) * state.equity;
  if (state.dayPnl <= -dayLossLimit) {
    reasons.push(`Daily loss limit ${config.dailyLossLimitPct}% breached`);
  }
  if (!(stopDistance > 0) || !(price > 0) || !(state.equity > 0)) {
    reasons.push("Invalid price, stop, or equity");
  }

  const riskCash = resolveRiskCash(config, state.equity);
  const units = stopDistance > 0 ? riskCash / stopDistance : 0;
  const positionNotional = units * price;
  const lev = Math.max(1, config.leverage);
  // Live Multipliers: you pay ~stake, not CFD notional/leverage margin.
  const marginRequired =
    marginMode === "stake" ? riskCash : positionNotional / lev;
  const used = state.usedMargin ?? 0;
  const freeMargin = Math.max(0, state.equity - used);

  if (marginRequired > freeMargin + 1e-9) {
    reasons.push(
      marginMode === "stake"
        ? `Not enough Deriv balance (need stake ${marginRequired.toFixed(2)}, have ${freeMargin.toFixed(2)})`
        : `Not enough free margin (need ${marginRequired.toFixed(2)}, free ${freeMargin.toFixed(2)})`,
    );
  }
  if (riskCash > state.equity) {
    reasons.push(
      marginMode === "stake"
        ? "Stake larger than Deriv balance"
        : "Stake larger than demo balance",
    );
  }

  return {
    ok: reasons.length === 0,
    reasons,
    positionNotional,
    riskCash,
    marginRequired,
    freeMargin,
  };
}
