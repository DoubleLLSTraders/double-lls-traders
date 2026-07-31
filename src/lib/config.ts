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

export interface AccountCredentials {
  token: string;
  accountId: string;
}

export interface AppConfig {
  appId: string;
  restUrl: string;
  /** Account selected by .env. The settings modal can override this at runtime. */
  account: AccountKind;
  accountId: string;
  token: string;
  /** Credentials for both accounts, so the switcher does not need a reload. */
  accounts: Record<AccountKind, AccountCredentials>;
  mode: TradingMode;
  symbol: string;
  risk: RiskLimits;
  /** Blocking problems. Non-empty means we must not connect. */
  errors: string[];
  /** Non-blocking notes worth showing the user. */
  warnings: string[];
}

const DEFAULT_REST_URL = "https://api.derivws.com";
const DEFAULT_SYMBOL = "R_75";

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
    errors.push("VITE_DERIV_APP_ID is empty. Paste your Brick Trader app id into .env.");
  }

  const account: AccountKind = env.VITE_DERIV_ACCOUNT?.trim() === "real" ? "real" : "demo";
  const demoToken = (env.VITE_DERIV_TOKEN_DEMO ?? "").trim();
  // A Deriv personal access token reaches every account on the profile, so the
  // demo token is a valid fallback for the real account when no separate one
  // is configured. Verified with scripts/check-accounts.ts.
  const realToken = (env.VITE_DERIV_TOKEN_REAL ?? "").trim() || demoToken;

  const accounts: Record<AccountKind, AccountCredentials> = {
    demo: { token: demoToken, accountId: (env.VITE_DERIV_DEMO_ACCOUNT_ID ?? "").trim() },
    real: { token: realToken, accountId: (env.VITE_DERIV_REAL_ACCOUNT_ID ?? "").trim() },
  };
  const { token, accountId } = accounts[account];

  if (!demoToken && !realToken) {
    errors.push(
      "VITE_DERIV_TOKEN_DEMO is empty. Create a PAT on home.deriv.com with Trade scope.",
    );
  } else if (!token) {
    errors.push(
      account === "real"
        ? "VITE_DERIV_TOKEN_REAL is empty while VITE_DERIV_ACCOUNT=real."
        : "VITE_DERIV_TOKEN_DEMO is empty. Create a PAT on home.deriv.com with Trade scope.",
    );
  }

  if (!accountId) {
    warnings.push(
      account === "real"
        ? "VITE_DERIV_REAL_ACCOUNT_ID is empty — the app will pick the first real account it finds."
        : "VITE_DERIV_DEMO_ACCOUNT_ID is empty — the app will pick the first demo account it finds.",
    );
  }

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
    restUrl: (env.VITE_DERIV_REST_URL ?? "").trim().replace(/\/$/, "") || DEFAULT_REST_URL,
    account,
    accountId,
    token,
    accounts,
    mode,
    symbol: (env.VITE_DEFAULT_SYMBOL ?? "").trim() || DEFAULT_SYMBOL,
    risk,
    errors,
    warnings,
  };
}

export const config: AppConfig = readConfig();

export const isConfigured = config.errors.length === 0;
