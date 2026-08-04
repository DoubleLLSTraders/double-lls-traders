import { memo } from "react";
import type { Tick } from "../lib/deriv/types";

interface DigitStripProps {
  /** Prefer ticks (stable epoch keys). Falls back to digits-only. */
  ticks?: Tick[];
  digits?: number[];
  count?: number;
}

function DigitStripInner({ ticks, digits, count = 40 }: DigitStripProps) {
  const recentTicks = ticks?.slice(-count) ?? null;
  const recentDigits =
    recentTicks?.map((tick) => tick.digit) ?? digits?.slice(-count) ?? [];

  return (
    <section
      className="ticker"
      aria-label={`Last ${count} digits, newest on the right`}
    >
      <div className="ticker__label">Stream</div>
      <div className="ticker__track">
        {recentDigits.length === 0 ? (
          <span className="empty">Waiting for ticks…</span>
        ) : (
          recentDigits.map((digit, index) => {
            const isLatest = index === recentDigits.length - 1;
            const epoch = recentTicks?.[index]?.epoch;
            return (
              <span
                key={epoch ?? `d-${index}-${digit}`}
                className={`ticker__chip ${isLatest ? "is-live" : ""} ${
                  digit % 2 === 0 ? "is-even" : "is-odd"
                }`}
              >
                {digit}
              </span>
            );
          })
        )}
      </div>
    </section>
  );
}

export const DigitStrip = memo(DigitStripInner);
