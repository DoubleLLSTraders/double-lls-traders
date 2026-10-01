import { useEffect, useState } from "react";
import { BotAvatar } from "./BotAvatar";
import { submitReview } from "./siteClient";
import { signedUsd, usd } from "./ui";

const REVIEWED_KEY = "double-lls:reviewed:v1";
const COUNT_MS = 900;

export interface SessionResult {
  pnl: number;
  startBalance: number;
  balance: number;
  trades: number;
  wins: number;
  losses: number;
  maxDrawdown: number;
  durationMs: number;
  reason: string | null;
}

interface SessionSummaryProps {
  result: SessionResult;
  onClose: () => void;
  onRunAgain: () => void;
}

function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function CountUp({ value }: { value: number }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / COUNT_MS);
      setShown(value * (1 - (1 - t) ** 3));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{signedUsd(shown)}</>;
}

/** Shown when the bot stops: did the session make or lose money, and the numbers behind it. */
export function SessionSummary({ result, onClose, onRunAgain }: SessionSummaryProps) {
  const profit = result.pnl >= 0;
  const pct = result.startBalance > 0 ? (result.pnl / result.startBalance) * 100 : 0;
  const winRate = result.trades ? (result.wins / result.trades) * 100 : 0;
  const [reviewed, setReviewed] = useState(() => localStorage.getItem(REVIEWED_KEY) === "1");
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [sent, setSent] = useState(false);
  const askReview = profit && result.pnl > 0 && !reviewed;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const send = () => {
    void submitReview({ rating, text: text.trim(), name: name.trim(), streak: 0 }).catch(() => {});
    localStorage.setItem(REVIEWED_KEY, "1");
    setSent(true);
    setReviewed(true);
  };

  return (
    <div className="sum-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`sum-pop ${profit ? "is-up" : "is-down"}`} role="dialog" aria-modal="true" aria-label="Session summary">
        <button className="sum-close" onClick={onClose} aria-label="Close">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>

        <div className="sum-head">
          <BotAvatar size={64} mood={profit ? "win" : undefined} />
          <div>
            <span className={`sum-status ${profit ? "up" : "down"}`}>
              {profit ? (
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>
              ) : (
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 4v5M8 11.5v.5" /></svg>
              )}
              {profit ? "Session complete · In profit" : "Session complete · In loss"}
            </span>
            <span className="sum-reason">{result.reason ?? "Stopped"}</span>
          </div>
        </div>

        <div className="sum-result">
          <label>Session P/L</label>
          <strong className={profit ? "up" : "down"}><CountUp value={result.pnl} /></strong>
          <span className={profit ? "up" : "down"}>{pct >= 0 ? "+" : "−"}{Math.abs(pct).toFixed(2)}% on {usd(result.startBalance)}</span>
        </div>

        <dl className="sum-stats">
          <div><dt>Balance</dt><dd>{usd(result.startBalance)} → {usd(result.balance)}</dd></div>
          <div><dt>Trades</dt><dd>{result.trades}</dd></div>
          <div><dt>Win rate</dt><dd>{winRate.toFixed(1)}%</dd></div>
          <div><dt>Won / lost</dt><dd><span className="up">{result.wins}</span> / <span className="down">{result.losses}</span></dd></div>
          <div><dt>Max drawdown</dt><dd>{usd(result.maxDrawdown)}</dd></div>
          <div><dt>Time</dt><dd>{duration(result.durationMs)}</dd></div>
        </dl>

        {askReview && (
          <div className="sum-review">
            <span>How was the bot?</span>
            <div className="sum-stars" onMouseLeave={() => setHover(0)} role="radiogroup" aria-label="Rating">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  role="radio"
                  aria-checked={rating === n}
                  aria-label={`${n} star${n > 1 ? "s" : ""}`}
                  className={n <= (hover || rating) ? "on" : ""}
                  onMouseEnter={() => setHover(n)}
                  onClick={() => setRating(n)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" /></svg>
                </button>
              ))}
            </div>
            {rating > 0 && (
              <>
                <textarea rows={2} maxLength={500} placeholder="Leave a short review (optional)" value={text} onChange={(e) => setText(e.target.value)} />
                <input maxLength={60} placeholder="Your name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
                <button className="btn outline sm" onClick={send}>Send review</button>
              </>
            )}
          </div>
        )}
        {sent && <p className="sum-thanks">Thanks for the review.</p>}

        <div className="sum-actions">
          <button className="btn outline" onClick={onClose}>Close</button>
          <button className="btn solid" onClick={onRunAgain}>Run again</button>
        </div>
      </div>
    </div>
  );
}
