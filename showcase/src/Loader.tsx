import { useEffect, useState } from "react";
import { DEMO_BALANCE } from "./bot";
import { BotAvatar } from "./BotAvatar";
import { MARKET_NAME } from "./market";
import { usd } from "./ui";

interface LoaderProps {
  durationMs: number;
  window: number;
  balance?: number;
}

const RING_R = 74;
const RING_C = 2 * Math.PI * RING_R;

export function Loader({ durationMs, window: sample, balance = DEMO_BALANCE }: LoaderProps) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      setProgress(1 - Math.pow(1 - t, 2.2));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [durationMs]);

  const steps = [
    `Connecting to ${MARKET_NAME}`,
    `Sampling ${sample} ticks`,
    "Scoring 30 setups across 6 contracts",
    `Opening ${usd(balance)} account`,
  ];
  const active = Math.min(steps.length - 1, Math.floor(progress * steps.length));

  return (
    <div className="loader">
      <div className="loader-bg" />
      <div className="loader-core">
        <div className="loader-ring">
          <svg viewBox="0 0 160 160" aria-hidden="true">
            <circle className="loader-track" cx="80" cy="80" r={RING_R} />
            <circle
              className="loader-progress"
              cx="80"
              cy="80"
              r={RING_R}
              strokeDasharray={RING_C}
              strokeDashoffset={RING_C * (1 - progress)}
            />
          </svg>
          <BotAvatar size={112} />
        </div>

        <span className="loader-pct">{Math.round(progress * 100)}%</span>
        <span className="wordmark">DOUBLE LLS<span>TRADING BOT</span></span>

        <ul className="loader-steps">
          {steps.map((s, i) => (
            <li key={s} className={i < active || progress >= 1 ? "done" : i === active ? "active" : ""}>
              <i />
              {s}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
