/** Real wait timing for Apex gate — tied to candle clock + confluence distance. */

export function msUntilNextCandle(
  granularitySec: number,
  nowMs = Date.now(),
  lastBarEpochSec?: number | null,
): number {
  const g = Math.max(1, granularitySec) * 1000;
  if (lastBarEpochSec != null && Number.isFinite(lastBarEpochSec)) {
    const barStart = lastBarEpochSec * 1000;
    const barEnd = barStart + g;
    const left = barEnd - nowMs;
    if (left > 0) return left;
  }
  // Fallback: wall-clock bucket
  const rem = g - (nowMs % g);
  return rem === 0 ? g : rem;
}

export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

/**
 * Estimate when Apex may re-qualify.
 * Anchored to the next candle close (real), then extra bars from how far confluence is.
 */
export function estimateApexWaitMs(args: {
  granularitySec: number;
  nowMs?: number;
  lastBarEpochSec?: number | null;
  tradeable: boolean;
  confluence: number;
  powerLabel: string;
  bias: string;
}): {
  nextCandleMs: number;
  estimateMs: number;
  extraBars: number;
  label: string;
} {
  const now = args.nowMs ?? Date.now();
  const nextCandleMs = msUntilNextCandle(
    args.granularitySec,
    now,
    args.lastBarEpochSec,
  );

  if (args.tradeable) {
    return {
      nextCandleMs,
      estimateMs: 0,
      extraBars: 0,
      label: "Ready now",
    };
  }

  // Distance from a typical clear → extra closed candles to watch (estimate only).
  const gap = Math.max(0, 48 - args.confluence);
  let extraBars = 0;
  if (args.bias === "neutral" || args.confluence < 38) extraBars = 2;
  else if (gap > 12) extraBars = 2;
  else if (gap > 5) extraBars = 1;
  else extraBars = 0; // Almost — next candle recheck is the real clock

  if (args.powerLabel === "Almost") extraBars = Math.min(extraBars, 0);
  if (args.powerLabel === "Building") extraBars = Math.max(extraBars, 1);

  const estimateMs = nextCandleMs + extraBars * args.granularitySec * 1000;
  const label =
    extraBars === 0
      ? `Recheck ${formatDuration(nextCandleMs)}`
      : `~${extraBars + 1} bars · ${formatDuration(estimateMs)}`;

  return { nextCandleMs, estimateMs, extraBars, label };
}
