import { useCallback, useEffect, useState } from "react";
import type { ConnectionState } from "../lib/deriv/types";
import {
  runPlatformHealthChecks,
  type HealthLevel,
  type PlatformHealthReport,
} from "../lib/platformStatus";
import { APP_NAME } from "../lib/brand";
import { GITHUB_PAGES_URL } from "../lib/platform";

interface SystemStatusPanelProps {
  feedState: ConnectionState;
  feedError: string | null;
  email: string | null;
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

export function SystemStatusPanel({ feedState, feedError, email }: SystemStatusPanelProps) {
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
    void refresh();
  }, [refresh]);

  const overall = report?.overall ?? "unknown";

  return (
    <div className="system-status">
      <header className="system-status__head">
        <div>
          <h3>{APP_NAME} status</h3>
          <p>Live health on this browser · history stored locally</p>
        </div>
        <button type="button" className="system-status__refresh" disabled={busy} onClick={() => void refresh()}>
          {busy ? "Checking…" : "Refresh"}
        </button>
      </header>

      <div className={`system-status__banner system-status__banner--${overall}`}>
        <div className="system-status__banner-top">
          <span className="system-status__icon" aria-hidden="true">
            {overall === "operational" ? "✓" : overall === "degraded" ? "!" : "×"}
          </span>
          <strong>{report?.headline ?? "Running system checks…"}</strong>
        </div>
        <p>{report?.subline ?? "Verifying Deriv, Firebase, and access control."}</p>
      </div>

      {error ? <p className="modal__error">{error}</p> : null}

      <div className="system-status__range">
        <span>Last {90} checks on this device</span>
        {report ? <span>Updated {formatChecked(report.checkedAt)}</span> : null}
      </div>

      <ul className="system-status__list">
        {(report?.components ?? []).map((component) => (
          <li key={component.id} className="system-status__item">
            <div className="system-status__item-head">
              <div>
                <strong>{component.name}</strong>
                <small>{component.detail}</small>
              </div>
              <span className={`system-status__uptime system-status__uptime--${component.level}`}>
                {component.uptimePct.toFixed(2)}% uptime
              </span>
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
        <a className="system-status__history" href={GITHUB_PAGES_URL} target="_blank" rel="noreferrer">
          Hosted desk →
        </a>
      </footer>
    </div>
  );
}
