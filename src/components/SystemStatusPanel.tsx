import { useCallback, useEffect, useState } from "react";
import type { ConnectionState } from "../lib/deriv/types";
import {
  runPlatformHealthChecks,
  startStatusRecorder,
  type HealthLevel,
  type PlatformHealthReport,
} from "../lib/platformStatus";
import { APP_NAME } from "../lib/brand";
import { GITHUB_PAGES_URL, GITHUB_REPO_URL } from "../lib/platform";

interface SystemStatusPanelProps {
  feedState: ConnectionState;
  feedError: string | null;
  email: string | null;
  active: boolean;
}

function barClass(level: HealthLevel): string {
  if (level === "operational") return "status-bar is-up";
  if (level === "degraded") return "status-bar is-warn";
  if (level === "down") return "status-bar is-down";
  return "status-bar is-unknown";
}

function formatChecked(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(ms);
}

export function SystemStatusPanel({ feedState, feedError, email, active }: SystemStatusPanelProps) {
  const [report, setReport] = useState<PlatformHealthReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await runPlatformHealthChecks({ feedState, feedError, email });
      setReport(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [email, feedError, feedState]);

  useEffect(() => {
    if (!active) return;
    void refresh();
  }, [active, refresh]);

  useEffect(() => {
    if (!active) return;
    return startStatusRecorder(() => ({ feedState, feedError, email }), 5 * 60_000);
  }, [active, email, feedError, feedState]);

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(id);
  }, [active, refresh]);

  useEffect(() => {
    if (!active) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [active, refresh]);

  useEffect(() => {
    if (!active) return;
    const id = window.setTimeout(() => void refresh(), 1_500);
    return () => window.clearTimeout(id);
  }, [active, feedError, feedState, refresh]);

  const overall = report?.overall ?? "unknown";

  return (
    <div className="system-status">
      <header className="system-status__head">
        <div>
          <h3>{APP_NAME} status</h3>
          <p>Live probes every 15s · instant on feed change · history from real checks</p>
        </div>
        <button type="button" className="system-status__refresh" disabled={busy} onClick={() => void refresh()}>
          {busy ? "Probing…" : "Refresh"}
        </button>
      </header>

      <div className={`system-status__banner system-status__banner--${overall}`}>
        <div className="system-status__banner-top">
          <span className="system-status__icon" aria-hidden="true">
            {overall === "operational" ? "✓" : overall === "degraded" ? "!" : "×"}
          </span>
          <strong>{report?.headline ?? "Running live probes…"}</strong>
        </div>
        <p>{report?.subline ?? "Contacting GitHub Status, repository API, Pages, Deriv, and Firestore."}</p>
      </div>

      {error ? <p className="modal__error">{error}</p> : null}

      <div className="system-status__range">
        <span>90 probe slots · grey = no data yet</span>
        {report ? <span>Updated {formatChecked(report.checkedAt)}</span> : null}
      </div>

      <ul className="system-status__list">
        {(report?.components ?? []).map((component) => (
          <li key={component.id} className="system-status__item">
            <div className="system-status__item-head">
              <div>
                <strong>{component.name}</strong>
                <small>{component.detail}</small>
                <code className="system-status__endpoint">{component.endpoint}</code>
              </div>
              <div className="system-status__metrics">
                <span className={`system-status__uptime system-status__uptime--${component.level}`}>
                  {component.probeCount > 0
                    ? `${component.uptimePct.toFixed(2)}% uptime`
                    : "First probe"}
                </span>
                {component.latencyMs !== null ? (
                  <span className="system-status__latency">{component.latencyMs}ms</span>
                ) : null}
              </div>
            </div>
            <div className="system-status__bars" aria-hidden="true">
              {component.bars.map((level, index) => (
                <span key={`${component.id}-${index}`} className={barClass(level)} />
              ))}
            </div>
          </li>
        ))}
      </ul>

      <footer className="system-status__foot">
        <a className="system-status__history" href={GITHUB_REPO_URL} target="_blank" rel="noreferrer">
          GitHub repo →
        </a>
        <a className="system-status__history" href={GITHUB_PAGES_URL} target="_blank" rel="noreferrer">
          Hosted desk →
        </a>
      </footer>
    </div>
  );
}
