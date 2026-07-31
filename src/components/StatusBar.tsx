import { useEffect, useState } from "react";
import type { ConnectionState } from "../lib/deriv/types";
import type { AppConfig } from "../lib/config";
import { useKesRate } from "../hooks/useFxRate";
import { storageKey } from "../lib/platform";

const STATE_LABELS: Record<ConnectionState, string> = {
  idle: "Idle",
  connecting: "Connecting",
  authorizing: "Signing in",
  ready: "Connected",
  reconnecting: "Reconnecting",
  error: "Error",
  closed: "Offline",
};

const DISPLAY_KEY = storageKey("balance-currency");

type DisplayCurrency = "account" | "KES";

function readDisplayCurrency(): DisplayCurrency {
  try {
    const stored = localStorage.getItem(DISPLAY_KEY);
    if (stored === "KES" || stored === "account") return stored;
  } catch {
    /* ignore */
  }
  return "account";
}

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
  const { rate } = useKesRate(currency);
  const [display, setDisplay] = useState<DisplayCurrency>(readDisplayCurrency);

  useEffect(() => {
    try {
      localStorage.setItem(DISPLAY_KEY, display);
    } catch {
      /* ignore */
    }
  }, [display]);

  const showKes = display === "KES" && rate !== null && currency.toUpperCase() !== "KES";
  const amount = showKes && balance !== null ? balance * rate : balance;
  const label = showKes ? "KES" : currency;
  const canToggle = rate !== null && currency.toUpperCase() !== "KES";

  const toggleDisplay = () => {
    if (!canToggle) return;
    setDisplay((prev) => (prev === "KES" ? "account" : "KES"));
  };

  const rateHint =
    rate !== null
      ? `1 ${currency} ≈ ${rate.toLocaleString(undefined, {
          maximumFractionDigits: 2,
        })} KES · click to switch`
      : "Loading KES rate…";

  return (
    <div className="status">
      <div className="status__line">
        <span className={`status-dot status-dot--${state}`} aria-hidden="true" />
        <span className="status__state">{STATE_LABELS[state]}</span>
        <span className="status__symbol">{symbol}</span>
      </div>
      <div className="status__tags">
        <span
          className={`badge badge--circle ${isVirtual ? "badge--demo" : "badge--real"}`}
          title={isVirtual ? "Demo" : "Real"}
        >
          {isVirtual ? "D" : "R"}
        </span>
        <span
          className={`badge badge--circle ${mode === "paper" ? "badge--paper" : "badge--live"}`}
          title={mode === "paper" ? "Paper" : "Live"}
        >
          {mode === "paper" ? "P" : "L"}
        </span>
      </div>
      {loginId ? <div className="status__login">{loginId}</div> : null}
      {amount !== null ? (
        <button
          type="button"
          className="status__balance"
          onClick={toggleDisplay}
          disabled={!canToggle}
          title={rateHint}
          aria-label={`Balance in ${label}. ${rateHint}`}
        >
          {amount.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}
          <small>{label}</small>
        </button>
      ) : null}
      {showReconnect ? (
        <button type="button" className="button" onClick={onReconnect}>
          Reconnect
        </button>
      ) : null}
    </div>
  );
}
