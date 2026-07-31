export type AccountKind = "demo" | "real";
export type TradingMode = "paper" | "live";

export interface RiskLimits {
  baseStake: number;
  maxStake: number;
  dailyLossLimit: number;
  dailyProfitTarget: number;
  maxConsecutiveLosses: number;
  maxTradesPerDay: number;
}

export interface AppConfig {
  appId: string;
  wsUrl: string;
  account: AccountKind;
  token: string;
  mode: TradingMode;
  symbol: string;
  risk: RiskLimits;
  /** Blocking problems. Non-empty means we must not connect. */
  errors: string[];
  /** Non-blocking notes worth showing the user. */
  warnings: string[];
}

const DEFAULT_WS_URL = "wss://ws.derivws.com/websockets/v3";
const DEFAULT_SYMBOL = "R_100";

function num(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(parsed) ? parsed : fallback;
}

function readConfig(): AppConfig {
  const env = import.meta.env;
  const errors: string[] = [];
  const warnings: string[] = [];

  const appId = (env.VITE_DERIV_APP_ID ?? "").trim();
  if (!appId) {
    errors.push("VITE_DERIV_APP_ID is empty. Register an app on the Deriv developer portal and paste the app_id into .env.");
  }

  const account: AccountKind = env.VITE_DERIV_ACCOUNT?.trim() === "real" ? "real" : "demo";
  const demoToken = (env.VITE_DERIV_TOKEN_DEMO ?? "").trim();
  const realToken = (env.VITE_DERIV_TOKEN_REAL ?? "").trim();
  const token = account === "real" ? realToken : demoToken;

  if (!token) {
    errors.push(
      account === "real"
        ? "VITE_DERIV_TOKEN_REAL is empty while VITE_DERIV_ACCOUNT=real."
        : "VITE_DERIV_TOKEN_DEMO is empty. Create a token with Read + Trade scopes on your virtual account.",
    );
  }

  // `live` only takes effect once execution is wired up, but surface the
  // combination early — trading real money is never meant to happen silently.
  const mode: TradingMode = env.VITE_TRADING_MODE?.trim() === "live" ? "live" : "paper";
  if (mode === "live" && account === "real") {
    warnings.push("Live mode on a REAL account: orders placed will use real money.");
  }

  const risk: RiskLimits = {
    baseStake: num(env.VITE_BASE_STAKE, 0.35),
    maxStake: num(env.VITE_MAX_STAKE, 2),
    dailyLossLimit: num(env.VITE_DAILY_LOSS_LIMIT, 5),
    dailyProfitTarget: num(env.VITE_DAILY_PROFIT_TARGET, 5),
    maxConsecutiveLosses: num(env.VITE_MAX_CONSECUTIVE_LOSSES, 5),
    maxTradesPerDay: num(env.VITE_MAX_TRADES_PER_DAY, 100),
  };

  if (risk.baseStake > risk.maxStake) {
    errors.push("VITE_BASE_STAKE is larger than VITE_MAX_STAKE.");
  }
  if (risk.dailyLossLimit <= 0) {
    errors.push("VITE_DAILY_LOSS_LIMIT must be greater than 0.");
  }

  return {
    appId,
    wsUrl: (env.VITE_DERIV_WS_URL ?? "").trim() || DEFAULT_WS_URL,
    account,
    token,
    mode,
    symbol: (env.VITE_DEFAULT_SYMBOL ?? "").trim() || DEFAULT_SYMBOL,
    risk,
    errors,
    warnings,
  };
}

export const config: AppConfig = readConfig();

export const isConfigured = config.errors.length === 0;
