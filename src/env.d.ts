/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DERIV_APP_ID?: string;
  readonly VITE_DERIV_REST_URL?: string;
  readonly VITE_DERIV_TOKEN_DEMO?: string;
  readonly VITE_DERIV_TOKEN_REAL?: string;
  readonly VITE_DERIV_DEMO_ACCOUNT_ID?: string;
  readonly VITE_DERIV_REAL_ACCOUNT_ID?: string;
  readonly VITE_DERIV_ACCOUNT?: string;
  readonly VITE_TRADING_MODE?: string;
  readonly VITE_DEFAULT_SYMBOL?: string;
  readonly VITE_BASE_STAKE?: string;
  readonly VITE_MAX_STAKE?: string;
  readonly VITE_DAILY_LOSS_LIMIT?: string;
  readonly VITE_DAILY_PROFIT_TARGET?: string;
  readonly VITE_MAX_CONSECUTIVE_LOSSES?: string;
  readonly VITE_MAX_TRADES_PER_DAY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
