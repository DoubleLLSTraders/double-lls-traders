import type { DigitStats } from "../lib/analysis/digits";

interface StatsPanelProps {
  stats: DigitStats;
  selectedDigit: number | null;
}

function uniformityVerdict(stats: DigitStats): string {
  if (stats.sampleSize < 100) {
    return "Need 100+ ticks for a meaningful uniformity check.";
  }
  if (stats.uniformity.significant) {
    return `Distribution differs from 10% (p=${stats.uniformity.pValue.toFixed(4)}). Not proof of edge.`;
  }
  return `Within random range (p=${stats.uniformity.pValue.toFixed(2)}). No clear edge.`;
}

export function StatsPanel({ stats, selectedDigit }: StatsPanelProps) {
  const { currentStreak, evenCount, sampleSize, percentages, gaps } = stats;
  const evenPercent = sampleSize === 0 ? 0 : (evenCount / sampleSize) * 100;

  return (
    <section className="panel stats-panel">
      <div className="panel__head">
        <h2>Stats</h2>
        <span>χ² {stats.uniformity.statistic.toFixed(2)}</span>
      </div>

      <div className="stat-chips">
        <div className="stat-chip">
          <span>Streak</span>
          <strong>
            {currentStreak.digit === null
              ? "—"
              : `${currentStreak.digit}×${currentStreak.length}`}
          </strong>
        </div>
        <div className="stat-chip">
          <span>Even / Odd</span>
          <strong>
            {evenPercent.toFixed(0)}/{(100 - evenPercent).toFixed(0)}
          </strong>
        </div>
        <div className="stat-chip">
          <span>Hot</span>
          <strong>{stats.hottest.join(" ")}</strong>
        </div>
        <div className="stat-chip">
          <span>Cold</span>
          <strong>{stats.coldest.join(" ")}</strong>
        </div>
      </div>

      <p className={`verdict ${stats.uniformity.significant ? "verdict--flag" : ""}`}>
        {uniformityVerdict(stats)}
      </p>

      {selectedDigit !== null ? (
        <p className="selected-note">
          Digit <strong>{selectedDigit}</strong> · {percentages[selectedDigit].toFixed(1)}% ·{" "}
          {gaps[selectedDigit] === null ? "outside window" : `${gaps[selectedDigit]} ticks ago`}
        </p>
      ) : null}
    </section>
  );
}
