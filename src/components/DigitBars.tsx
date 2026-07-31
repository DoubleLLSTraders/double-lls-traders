import { DIGITS } from "../lib/analysis/digits";
import type { DigitStats } from "../lib/analysis/digits";

type Tone = "high" | "second" | "low" | "neutral";

interface DigitBarsProps {
  stats: DigitStats;
  selectedDigit: number | null;
  onSelectDigit: (digit: number) => void;
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

export function DigitBars({ stats, selectedDigit, onSelectDigit }: DigitBarsProps) {
  const { counts, percentages, sampleSize, gaps } = stats;
  const tones = toneByRank(counts, sampleSize);

  return (
    <section className="panel digit-map">
      <div className="panel__head">
        <h2>Digits</h2>
        <span>{sampleSize} ticks</span>
      </div>

      <div className="digit-grid">
        {DIGITS.map((digit) => (
          <button
            type="button"
            key={digit}
            className={`digit-tile ${selectedDigit === digit ? "digit-tile--selected" : ""}`}
            onClick={() => onSelectDigit(digit)}
            title={`Digit ${digit}: ${counts[digit]} · gap ${
              gaps[digit] === null ? "—" : gaps[digit]
            }`}
          >
            <span className="digit-tile__box">{digit}</span>
            <span className={`digit-tile__percent digit-tile__percent--${tones[digit]}`}>
              {percentages[digit].toFixed(1)}%
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
