import type { Candidate, Scan } from "./bot";
import type { Tick } from "./market";

export const money = (n: number) => `${n < 0 ? "−" : n > 0 ? "+" : ""}${Math.abs(n).toFixed(2)}`;
export const pct = (n: number) => `${n.toFixed(1)}%`;
export const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
export const signedUsd = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${usd(Math.abs(n))}`;

export const POSITIVE = "#4cc38a";
export const NEGATIVE = "#e5484d";

export function Quote({ ticks }: { ticks: Tick[] }) {
  const last = ticks[ticks.length - 1];
  const first = ticks[0];
  if (!last || !first) return null;
  const change = last.quote - first.quote;
  const changePct = (change / first.quote) * 100;
  const pip = last.pip ?? 2;
  return (
    <div className="quote">
      <span className="price">
        {last.quote.toFixed(pip).slice(0, -1)}
        <span className="last-digit">{last.digit}</span>
      </span>
      <span className={`chg ${change < 0 ? "down" : "up"}`}>
        {change >= 0 ? "+" : "−"}
        {Math.abs(change).toFixed(pip)} ({changePct >= 0 ? "+" : "−"}
        {Math.abs(changePct).toFixed(2)}%)
      </span>
    </div>
  );
}

export function DigitBars({ scan, highlight = [] }: { scan: Scan; highlight?: number[] }) {
  const max = Math.max(14, ...scan.percents);
  return (
    <div className="digits">
      {scan.percents.map((p, d) => (
        <div key={d} className={`digit ${highlight.includes(d) ? "on" : ""}`}>
          <div className="bar-wrap">
            <div className="bar" style={{ height: `${(p / max) * 100}%` }} />
            <div className="fair-line" style={{ bottom: `${(10 / max) * 100}%` }} />
          </div>
          <span className="d">{d}</span>
          <span className="p">{p.toFixed(1)}</span>
        </div>
      ))}
    </div>
  );
}

/** Digits a setup is betting on (or against), for highlighting the bars. */
export function setupDigits(c: Candidate | null): number[] {
  if (!c) return [];
  const { contract, barrier } = c.setup;
  const all = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  switch (contract) {
    case "DIGITMATCH":
    case "DIGITDIFF":
      return [barrier!];
    case "DIGITOVER":
      return all.filter((d) => d > barrier!);
    case "DIGITUNDER":
      return all.filter((d) => d < barrier!);
    case "DIGITEVEN":
      return all.filter((d) => d % 2 === 0);
    case "DIGITODD":
      return all.filter((d) => d % 2 === 1);
  }
}

export function Scanner({ scan, rows = 6, activeLabel }: { scan: Scan; rows?: number; activeLabel?: string | null }) {
  return (
    <table className="scanner">
      <thead>
        <tr>
          <th>Setup</th>
          <th className="num">Win</th>
          <th className="num">Needed</th>
          <th className="conf-h">Confidence</th>
        </tr>
      </thead>
      <tbody>
        {scan.candidates.slice(0, rows).map((c) => {
          const width = Math.max(0, Math.min(100, (c.confidence / 4) * 100));
          const active = c.label === activeLabel;
          return (
            <tr key={c.label} className={`${c.ready ? "ready" : ""} ${active ? "active" : ""}`}>
              <td>
                <span className="setup-dot" />
                {c.label}
              </td>
              <td className="num">{pct(c.winRate)}</td>
              <td className="num muted">{pct(c.breakEven)}</td>
              <td>
                <div className="conf">
                  <div className="conf-fill" style={{ width: `${width}%` }} />
                  <span className="conf-mark" />
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${tone ?? ""}`}>{value}</span>
    </div>
  );
}
