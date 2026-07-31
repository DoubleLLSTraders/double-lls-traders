import { DIGITS } from "../lib/analysis/digits";
import type { DigitStats } from "../lib/analysis/digits";

const EXPECTED_PERCENT = 10;

interface DigitBarsProps {
  stats: DigitStats;
  selectedDigit: number | null;
  onSelectDigit: (digit: number) => void;
}

export function DigitBars({ stats, selectedDigit, onSelectDigit }: DigitBarsProps) {
  const { counts, percentages, sampleSize, gaps } = stats;

  // Standard deviation of the observed share of one digit under a fair 10%
  // process. Anything inside two of these is ordinary sampling noise.
  const sigma = sampleSize > 0 ? Math.sqrt((0.1 * 0.9) / sampleSize) * 100 : 0;
  const peak = Math.max(EXPECTED_PERCENT, ...percentages);

  return (
    <section className="panel">
      <h2 className="panel__title">
        Digit frequency
        <span className="panel__hint">
          {sampleSize} ticks · noise band ±{(2 * sigma).toFixed(1)}%
        </span>
      </h2>

      <div className="bars">
        {DIGITS.map((digit) => {
          const percent = percentages[digit];
          const deviation = percent - EXPECTED_PERCENT;
          const isNotable = sigma > 0 && Math.abs(deviation) > 2 * sigma;
          const tone = deviation >= 0 ? "hot" : "cold";

          return (
            <button
              type="button"
              key={digit}
              className={`bar ${selectedDigit === digit ? "bar--selected" : ""}`}
              onClick={() => onSelectDigit(digit)}
              title={`Digit ${digit}: ${counts[digit]} of ${sampleSize} ticks. Last seen ${
                gaps[digit] === null ? "never in window" : `${gaps[digit]} ticks ago`
              }.`}
            >
              <span className="bar__percent">{percent.toFixed(1)}</span>
              <span className="bar__track">
                <span
                  className={`bar__fill ${isNotable ? `bar__fill--${tone}` : ""}`}
                  style={{ height: `${(percent / peak) * 100}%` }}
                />
                <span
                  className="bar__expected"
                  style={{ bottom: `${(EXPECTED_PERCENT / peak) * 100}%` }}
                />
              </span>
              <span className="bar__label">{digit}</span>
              <span className="bar__gap">{gaps[digit] === null ? "–" : gaps[digit]}</span>
            </button>
          );
        })}
      </div>

      <p className="panel__footnote">
        Bottom row is how many ticks ago each digit last appeared. The dashed line is the expected
        10%.
      </p>
    </section>
  );
}
