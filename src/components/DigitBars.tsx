import { useEffect, useMemo, useState } from "react";
import { DIGITS } from "../lib/analysis/digits";
import type { DigitStats } from "../lib/analysis/digits";
import {
  readMarketPulse,
  type PulseRequirements,
} from "../lib/analysis/marketPulse";
import type { MarketSignal } from "../lib/analysis/signal";

type Tone = "high" | "second" | "low" | "neutral";

interface DigitBarsProps {
  stats: DigitStats;
  selectedDigit: number | null;
  onSelectDigit: (digit: number) => void;
  /** Most recent live digit — pulses on the matching tile. */
  latestDigit?: number | null;
  /** Live analyzer signal — sharpens the market mood readout. */
  signal?: MarketSignal | null;
  /** Bot gate floors shown as “Good needs …”. */
  requirements?: PulseRequirements;
}

function toneByRank(counts: number[], sampleSize: number): Tone[] {
  const tones = new Array<Tone>(10).fill("neutral");
  if (sampleSize === 0) return tones;

  const ranked = [...DIGITS].sort((a, b) =>
    counts[b] !== counts[a] ? counts[b] - counts[a] : a - b,
  );
  tones[ranked[0]] = "high";
  tones[ranked[1]] = "second";
  tones[ranked[ranked.length - 1]] = "low";
  return tones;
}

function rankLabel(rank: number): string {
  if (rank === 1) return "hottest";
  if (rank === 2) return "2nd hottest";
  if (rank === 10) return "coldest";
  if (rank === 9) return "2nd coldest";
  return `#${rank} of 10`;
}

const RING = 2 * Math.PI * 22; // r=22 in 52 viewBox

export function DigitBars({
  stats,
  selectedDigit,
  onSelectDigit,
  latestDigit = null,
  signal = null,
  requirements,
}: DigitBarsProps) {
  const { counts, percentages, sampleSize, gaps, hottest, coldest } = stats;
  const tones = toneByRank(counts, sampleSize);
  const maxPct = Math.max(...percentages, 10);
  const [pulseDigit, setPulseDigit] = useState<number | null>(null);
  const [hoverDigit, setHoverDigit] = useState<number | null>(null);
  const pulse = useMemo(
    () => readMarketPulse(stats, signal, requirements),
    [stats, signal, requirements],
  );

  useEffect(() => {
    if (latestDigit === null || latestDigit === undefined) return;
    setPulseDigit(latestDigit);
    const timer = window.setTimeout(() => setPulseDigit(null), 700);
    return () => window.clearTimeout(timer);
  }, [latestDigit, sampleSize]);

  const ranked = [...DIGITS].sort((a, b) =>
    counts[b] !== counts[a] ? counts[b] - counts[a] : a - b,
  );
  const rankOf = (digit: number) => (ranked as readonly number[]).indexOf(digit) + 1;

  return (
    <section className="panel digit-map">
      <div className="panel__head">
        <h2>Digits</h2>
        <span className="digit-map__live">
          <i className={sampleSize > 0 ? "is-on" : ""} aria-hidden="true" />
          {sampleSize.toLocaleString()} ticks
        </span>
      </div>

      <div className="digit-grid" role="list">
        {DIGITS.map((digit) => {
          const pct = percentages[digit] ?? 0;
          const count = counts[digit] ?? 0;
          const gap = gaps[digit];
          const vsFair = pct - 10;
          const fill = Math.min(1, pct / Math.max(maxPct, 0.001));
          const dash = `${(fill * RING).toFixed(2)} ${RING.toFixed(2)}`;
          const selected = selectedDigit === digit;
          const live = latestDigit === digit;
          const pulsing = pulseDigit === digit;
          const hovering = hoverDigit === digit;
          const tone = tones[digit];
          const rank = rankOf(digit);

          return (
            <button
              type="button"
              key={digit}
              role="listitem"
              className={[
                "digit-tile",
                selected ? "digit-tile--selected" : "",
                live ? "digit-tile--live" : "",
                pulsing ? "digit-tile--pulse" : "",
                hovering ? "digit-tile--hover" : "",
                `digit-tile--${tone}`,
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => onSelectDigit(digit)}
              onPointerEnter={() => setHoverDigit(digit)}
              onPointerLeave={() => setHoverDigit((d) => (d === digit ? null : d))}
              aria-pressed={selected}
              aria-label={`Digit ${digit}, ${pct.toFixed(1)} percent, ${count} of ${sampleSize}`}
            >
              <span className="digit-tile__ring-wrap">
                <svg className="digit-tile__ring" viewBox="0 0 52 52" aria-hidden="true">
                  <circle className="digit-tile__ring-track" cx="26" cy="26" r="22" />
                  <circle
                    className={`digit-tile__ring-fill digit-tile__ring-fill--${tone}`}
                    cx="26"
                    cy="26"
                    r="22"
                    strokeDasharray={dash}
                    transform="rotate(-90 26 26)"
                  />
                </svg>
                <span className="digit-tile__box">{digit}</span>
              </span>

              <span className={`digit-tile__percent digit-tile__percent--${tone}`}>
                {pct.toFixed(1)}%
              </span>

              {hovering ? (
                <span className="digit-tile__tip" role="tooltip">
                  <strong>Digit {digit}</strong>
                  <em>
                    {count.toLocaleString()} / {sampleSize.toLocaleString()} ·{" "}
                    {pct.toFixed(2)}%
                  </em>
                  <em>
                    {vsFair >= 0 ? "+" : ""}
                    {vsFair.toFixed(1)} vs 10% · {rankLabel(rank)}
                  </em>
                  <em>
                    Gap {gap === null ? "absent" : `${gap} tick${gap === 1 ? "" : "s"}`}
                    {hottest[0] === digit
                      ? " · hot"
                      : coldest[0] === digit
                        ? " · cold"
                        : ""}
                  </em>
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div
        className={`digit-map__pulse digit-map__pulse--${pulse.mood}`}
        title={`${pulse.detail} · ${pulse.need}`}
      >
        <div className="digit-map__pulse-main">
          <span className="digit-map__pulse-dot" aria-hidden="true" />
          <strong>{pulse.label}</strong>
          <em>{pulse.detail}</em>
        </div>
        <div className="digit-map__legend">
          <span className="is-high">Hot</span>
          <span className="is-low">Cold</span>
          <span>Fair 10%</span>
          <span className="digit-map__legend-need">{pulse.need}</span>
          {latestDigit !== null && latestDigit !== undefined ? (
            <span className="digit-map__legend-live">Live · {latestDigit}</span>
          ) : null}
        </div>
      </div>
    </section>
  );
}
