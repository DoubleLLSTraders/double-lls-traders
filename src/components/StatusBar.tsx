import type { ConnectionState } from "../lib/deriv/types";
import type { AppConfig } from "../lib/config";

const STATE_LABELS: Record<ConnectionState, string> = {
  idle: "Idle",
  connecting: "Connecting",
  authorizing: "Authorising",
  ready: "Live",
  reconnecting: "Reconnecting",
  error: "Error",
  closed: "Disconnected",
};

interface StatusBarProps {
  state: ConnectionState;
  symbol: string;
  loginId: string | null;
  isVirtual: boolean;
  balance: number | null;
  currency: string;
  mode: AppConfig["mode"];
  onReconnect: () => void;
}

export function StatusBar({
  state,
  symbol,
  loginId,
  isVirtual,
  balance,
  currency,
  mode,
  onReconnect,
}: StatusBarProps) {
  const showReconnect = state === "error" || state === "closed";

  return (
    <header className="status-bar">
      <div className="status-bar__group">
        <span className={`status-dot status-dot--${state}`} aria-hidden="true" />
        <span className="status-bar__state">{STATE_LABELS[state]}</span>
        <span className="status-bar__symbol">{symbol}</span>
      </div>

      <div className="status-bar__group">
        <span className={`badge ${isVirtual ? "badge--demo" : "badge--real"}`}>
          {isVirtual ? "DEMO" : "REAL"}
        </span>
        <span className={`badge ${mode === "paper" ? "badge--paper" : "badge--live"}`}>
          {mode === "paper" ? "PAPER" : "LIVE"}
        </span>
        {loginId ? <span className="status-bar__login">{loginId}</span> : null}
        {balance !== null ? (
          <span className="status-bar__balance">
            {balance.toFixed(2)} {currency}
          </span>
        ) : null}
        {showReconnect ? (
          <button type="button" className="button button--small" onClick={onReconnect}>
            Reconnect
          </button>
        ) : null}
      </div>
    </header>
  );
}
