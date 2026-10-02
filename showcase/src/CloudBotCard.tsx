import { useCallback, useEffect, useState } from "react";
import { getCloudBot, removeCloudBot, saveCloudBot, type CloudBotView } from "./account";
import { MODES } from "./bot";
import { symbolName, symbolShort } from "./market";
import { loadSettings } from "./sessionStore";
import { useLicence } from "./siteClient";

const POLL_MS = 30_000;
/** No status write for this long means the worker is not running the bot. */
const STALE_MS = 3 * 60_000;
const TOKEN_URL = "https://home.deriv.com/";

const money = (n: number, currency = "USD") => `${n < 0 ? "−" : n > 0 ? "+" : ""}${Math.abs(n).toFixed(2)} ${currency}`;
const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

export function CloudBotCard({ onBuy }: { onBuy: () => void }) {
  const licence = useLicence();
  const [view, setView] = useState<CloudBotView | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [allowReal, setAllowReal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const v = await getCloudBot();
      setView(v);
      setUnavailable(null);
      if (v.allowReal !== undefined) setAllowReal(v.allowReal);
    } catch (err) {
      setUnavailable(err instanceof Error ? err.message : "The cloud bot is unavailable.");
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => document.visibilityState === "visible" && void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const act = async (fn: () => Promise<CloudBotView>) => {
    setBusy(true);
    setError(null);
    try {
      setView(await fn());
      setToken("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const settings = loadSettings();
  const modeLabel = MODES.find((m) => m.id === settings.mode)?.label ?? settings.mode;
  const status = view?.status ?? null;
  const running = !!view?.enabled;
  const stale = running && (!status?.heartbeat || Date.now() - status.heartbeat > STALE_MS);
  const winRate = status?.trades ? (status.wins / status.trades) * 100 : 0;
  const currency = status?.currency ?? "USD";
  const start = () => act(() => saveCloudBot({ enabled: true, derivToken: token.trim() || undefined, settings, allowReal }));

  if (unavailable) return null;

  return (
    <div className="co-card cloud-card">
      <header className="pane-head">
        <span>Cloud bot · runs 24/7</span>
        {running && status && (
          <span className={`cloud-state ${stale ? "stale" : status.state}`}>
            <i />{stale ? "Waiting for the server" : status.state === "running" ? "Running" : status.state === "starting" ? "Starting" : status.state === "error" ? "Needs attention" : "Stopped"}
          </span>
        )}
      </header>
      <div className="pane-body">
        {unavailable ? (
          <p className="muted">{unavailable}</p>
        ) : !licence ? (
          <div className="cloud-locked">
            <p className="muted">Your bot can trade on Google's servers around the clock, even with this page closed. It comes with every licence.</p>
            <button className="btn solid" onClick={onBuy}>Buy the bot</button>
          </div>
        ) : !view ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            {running && status && (
              <>
                <p className="cloud-message">
                  {status.message}
                  {status.loginid && <span className="muted"> · {status.loginid} ({status.isVirtual ? "demo" : "real money"})</span>}
                  {status.heartbeat > 0 && <span className="muted"> · updated {ago(status.heartbeat)}</span>}
                </p>
                <div className="acct-stats cloud-stats">
                  <div><small>Balance</small><b>{status.balance.toFixed(2)} {currency}</b></div>
                  <div><small>Session P/L</small><b className={status.pnl < 0 ? "neg" : "pos"}>{money(status.pnl, currency)}</b></div>
                  <div><small>Today</small><b className={status.dayPnl < 0 ? "neg" : "pos"}>{money(status.dayPnl, currency)}</b></div>
                  <div><small>Trades · win rate</small><b>{status.trades} · {status.trades ? `${winRate.toFixed(1)}%` : "–"}</b></div>
                </div>
              </>
            )}

            {view.recent && view.recent.length > 0 && (
              <ul className="acct-sessions cloud-trades">
                {view.recent.slice(0, 8).map((t) => (
                  <li key={`${t.id}-${t.at}`} title={t.reason}>
                    <span>{new Date(t.at).toLocaleTimeString(undefined, { timeStyle: "short" })}</span>
                    <span className="muted">{t.label} · {symbolShort(t.market)} · digit {t.digit} · stake {t.stake.toFixed(2)}</span>
                    <b className={t.won ? "pos" : "neg"}>{money(t.pnl, currency)}</b>
                  </li>
                ))}
              </ul>
            )}

            <div className="cloud-form">
              <p className="muted cloud-uses">
                Runs your saved test-drive settings: {modeLabel}, {symbolName(settings.symbol)}, stake ${settings.stake}, take profit {settings.takeProfit ? `$${settings.takeProfit}` : "off"}, stop loss {settings.stopLoss ? `$${settings.stopLoss}` : "off"}
                {settings.dailyLossLimit > 0 && `, daily loss limit $${settings.dailyLossLimit}`}.
              </p>
              <label className="co-field">
                <span>
                  Deriv personal access token{view.hasToken ? " (saved; paste a new one to replace it)" : ""} ·{" "}
                  <a href={TOKEN_URL} target="_blank" rel="noreferrer">create one on home.deriv.com with Trade scope</a>
                </span>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={view.hasToken ? "••••••••••••" : "Paste your token"}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </label>
              <label className="check cloud-real">
                <input type="checkbox" checked={allowReal} onChange={(e) => setAllowReal(e.target.checked)} />
                <span>Allow real money. Leave this off to trade a Deriv demo account only. Real trading can lose your whole stake.</span>
              </label>
              {error && <span className="co-err">{error}</span>}
              <div className="cloud-actions">
                {running ? (
                  <>
                    <button className="btn outline danger" disabled={busy} onClick={() => act(() => saveCloudBot({ enabled: false, allowReal }))}>Stop cloud bot</button>
                    <button className="btn outline" disabled={busy} onClick={start}>Restart with current settings</button>
                  </>
                ) : (
                  <button className="btn solid" disabled={busy || (!token.trim() && !view.hasToken)} onClick={start}>
                    {busy ? "Starting…" : "Start 24/7"}
                  </button>
                )}
                {view.configured && !running && (
                  <button className="btn ghost danger" disabled={busy} onClick={() => confirm("Remove the cloud bot and its saved token?") && act(removeCloudBot)}>
                    Remove saved token
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
