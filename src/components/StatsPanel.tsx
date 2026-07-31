import type { DigitStats } from "../lib/analysis/digits";

interface StatsPanelProps {
  stats: DigitStats;
  selectedDigit: number | null;
}

function uniformityVerdict(stats: DigitStats): string {
  if (stats.sampleSize < 100) {
    return "Not enough ticks yet to say anything about the distribution.";
  }
  if (stats.uniformity.significant) {
    return `The spread is wider than a fair 10% generator usually produces (p = ${stats.uniformity.pValue.toFixed(
      4,
    )}). Worth a second look, though it will still be noise most of the time.`;
  }
  return `The spread is what a fair 10% generator normally produces (p = ${stats.uniformity.pValue.toFixed(
    2,
  )}). No edge visible here.`;
}

export function StatsPanel({ stats, selectedDigit }: StatsPanelProps) {
  const { currentStreak, evenCount, oddCount, sampleSize, percentages, gaps } = stats;
  const evenPercent = sampleSize === 0 ? 0 : (evenCount / sampleSize) * 100;

  return (
    <section className="panel">
      <h2 className="panel__title">Statistics</h2>

      <dl className="stats-grid">
        <div className="stat">
          <dt>Current streak</dt>
          <dd>
            {currentStreak.digit === null
              ? "–"
              : `${currentStreak.digit} × ${currentStreak.length}`}
          </dd>
        </div>
        <div className="stat">
          <dt>Even / Odd</dt>
          <dd>
            {evenPercent.toFixed(1)}% / {(100 - evenPercent).toFixed(1)}%
          </dd>
        </div>
        <div className="stat">
          <dt>Hottest</dt>
          <dd>{stats.hottest.join("  ")}</dd>
        </div>
        <div className="stat">
          <dt>Coldest</dt>
          <dd>{stats.coldest.join("  ")}</dd>
        </div>
        <div className="stat">
          <dt>Sample</dt>
          <dd>
            {sampleSize} ticks · {evenCount}/{oddCount}
          </dd>
        </div>
        <div className="stat">
          <dt>Chi-square</dt>
          <dd>
            {stats.uniformity.statistic.toFixed(2)} (df {stats.uniformity.degreesOfFreedom})
          </dd>
        </div>
      </dl>

      <p className={`verdict ${stats.uniformity.significant ? "verdict--flag" : ""}`}>
        {uniformityVerdict(stats)}
      </p>

      {selectedDigit !== null ? (
        <div className="selected-digit">
          <h3 className="selected-digit__title">Digit {selectedDigit}</h3>
          <p>
            Appeared {percentages[selectedDigit].toFixed(1)}% of the last {sampleSize} ticks, last
            seen{" "}
            {gaps[selectedDigit] === null
              ? "not at all in this window"
              : `${gaps[selectedDigit]} ticks ago`}
            .
          </p>
          <p className="selected-digit__reality">
            The true probability of the next tick ending in {selectedDigit} is 10%, regardless of
            the numbers above. A gap does not make it "due".
          </p>
        </div>
      ) : null}
    </section>
  );
}
