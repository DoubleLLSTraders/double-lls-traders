interface SparklineProps {
  values: number[];
  height?: number;
  stroke?: string;
  /** Draw a dashed line at this value (e.g. 0 for P/L). */
  baseline?: number;
  /** Horizontal grid lines. */
  grid?: number;
}

const WIDTH = 600;
const MAX_POINTS = 600;

export function Sparkline({ values, height = 140, stroke = "#e6e6e6", baseline, grid = 4 }: SparklineProps) {
  const step = Math.max(1, Math.ceil(values.length / MAX_POINTS));
  const sampled = values.filter((_, i) => i % step === 0 || i === values.length - 1);
  const gridLines = Array.from({ length: grid }, (_, i) => ((i + 1) * height) / (grid + 1));

  const frame = (
    <>
      {gridLines.map((gy) => (
        <line key={gy} x1={0} x2={WIDTH} y1={gy} y2={gy} className="spark-grid" />
      ))}
    </>
  );

  if (sampled.length < 2) {
    return (
      <svg className="spark" viewBox={`0 0 ${WIDTH} ${height}`} preserveAspectRatio="none">
        {frame}
      </svg>
    );
  }

  const all = baseline === undefined ? sampled : [...sampled, baseline];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const y = (v: number) => height - 8 - ((v - min) / span) * (height - 16);
  const x = (i: number) => (i / (sampled.length - 1)) * WIDTH;
  const points = sampled.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

  return (
    <svg className="spark" viewBox={`0 0 ${WIDTH} ${height}`} preserveAspectRatio="none">
      {frame}
      {baseline !== undefined && (
        <line x1={0} x2={WIDTH} y1={y(baseline)} y2={y(baseline)} className="spark-base" />
      )}
      <polyline points={points} fill="none" stroke={stroke} strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
