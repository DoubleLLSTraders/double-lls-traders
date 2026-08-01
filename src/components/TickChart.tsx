import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTheme } from "../hooks/useTheme";
import type { Tick } from "../lib/deriv/types";
import { marketLabel } from "./MarketSelect";

interface TickChartProps {
  ticks: Tick[];
  symbol: string;
  maxPoints?: number;
  /** True while the live stream is swapping markets (ticks stay until replace). */
  syncing?: boolean;
  /** Settled trades to mark on the chart (epoch → win/loss). */
  tradeMarkers?: Array<{ epoch: number; won: boolean; pnl?: number }>;
}

const WINDOW_OPTIONS = [50, 100, 150, 200] as const;

interface ChartPoint {
  x: number;
  y: number;
  epoch: number;
  quote: number;
  digit: number;
  index: number;
}

interface HoverState {
  point: ChartPoint;
  /** Change vs previous tick in the window. */
  stepAbs: number | null;
  stepPct: number | null;
}

function formatTime(epoch: number): string {
  return new Date(epoch * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatChange(abs: number, pct: number, pip: number): string {
  const sign = abs >= 0 ? "+" : "-";
  return `${sign}${Math.abs(abs).toFixed(pip)} (${Math.abs(pct).toFixed(2)}%)`;
}

export function TickChart({
  ticks,
  symbol,
  maxPoints = 100,
  syncing = false,
  tradeMarkers = [],
}: TickChartProps) {
  const { theme } = useTheme();
  const gradId = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [windowSize, setWindowSize] = useState(maxPoints);
  const [frameSize, setFrameSize] = useState({ width: 1200, height: 420 });
  const [hover, setHover] = useState<HoverState | null>(null);
  const series = ticks.slice(-windowSize);

  useEffect(() => {
    const node = frameRef.current;
    if (!node) return;

    const sync = () => {
      const { width, height } = node.getBoundingClientRect();
      const w = Math.round(width);
      const h = Math.round(height);
      if (w <= 0 || h <= 0) return;
      setFrameSize((prev) =>
        prev.width === w && prev.height === h ? prev : { width: w, height: h },
      );
    };

    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const chart = useMemo(() => {
    const width = Math.max(320, frameSize.width);
    const height = Math.max(240, frameSize.height);
    const pad = {
      top: 20,
      right: 78,
      bottom: 34,
      left: 12,
    };

    if (series.length < 2) {
      return {
        width,
        height,
        pad,
        path: "",
        area: "",
        min: 0,
        max: 0,
        span: 1,
        latestY: height / 2,
        latestX: width - pad.right,
        yTicks: [] as number[],
        xLabels: [] as Array<{ x: number; label: string }>,
        markers: [] as Array<{ x: number; y: number; won: boolean }>,
        points: [] as ChartPoint[],
        plotBottom: height - pad.bottom,
        plotRight: width - pad.right,
        plotTop: pad.top,
        plotLeft: pad.left,
      };
    }

    const quotes = series.map((tick) => tick.quote);
    const rawMin = Math.min(...quotes);
    const rawMax = Math.max(...quotes);
    const padY = (rawMax - rawMin || rawMax * 0.001) * 0.08;
    const min = rawMin - padY;
    const max = rawMax + padY;
    const span = max - min || 1;
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const plotBottom = height - pad.bottom;
    const plotRight = width - pad.right;

    const points: ChartPoint[] = series.map((tick, index) => {
      const x = pad.left + (index / (series.length - 1)) * plotW;
      const y = pad.top + (1 - (tick.quote - min) / span) * plotH;
      return {
        x,
        y,
        epoch: tick.epoch,
        quote: tick.quote,
        digit: tick.digit,
        index,
      };
    });

    const path = points
      .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
      .join(" ");
    const last = points[points.length - 1];
    const area = `${path} L ${last.x} ${plotBottom} L ${points[0].x} ${plotBottom} Z`;

    const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => min + span * (1 - t));
    const labelCount = Math.min(6, series.length);
    const xLabels = Array.from({ length: labelCount }, (_, index) => {
      const at = Math.round((index / Math.max(labelCount - 1, 1)) * (series.length - 1));
      return { x: points[at].x, label: formatTime(series[at].epoch) };
    });

    const firstEpoch = series[0].epoch;
    const lastEpoch = series[series.length - 1].epoch;
    const markers = tradeMarkers
      .filter((marker) => marker.epoch >= firstEpoch && marker.epoch <= lastEpoch)
      .map((marker) => {
        let best = points[0];
        let bestDist = Math.abs(points[0].epoch - marker.epoch);
        for (const point of points) {
          const dist = Math.abs(point.epoch - marker.epoch);
          if (dist < bestDist) {
            best = point;
            bestDist = dist;
          }
        }
        return { x: best.x, y: best.y, won: marker.won };
      });

    return {
      width,
      height,
      pad,
      path,
      area,
      min,
      max,
      span,
      latestY: last.y,
      latestX: last.x,
      yTicks,
      xLabels,
      markers,
      points,
      plotBottom,
      plotRight,
      plotTop: pad.top,
      plotLeft: pad.left,
    };
  }, [series, tradeMarkers, frameSize]);

  const latest = series[series.length - 1];
  const first = series[0];
  const previous = series[series.length - 2];
  const rising = latest && previous ? latest.quote >= previous.quote : true;
  const changeUp = latest && first ? latest.quote >= first.quote : true;
  const change =
    latest && first
      ? {
          abs: latest.quote - first.quote,
          pct: ((latest.quote - first.quote) / first.quote) * 100,
        }
      : null;
  const pip = latest?.pipSize ?? 2;
  const name = marketLabel(symbol);

  const lineColor =
    theme === "light"
      ? changeUp
        ? "var(--chart-line-up)"
        : "var(--chart-line-down)"
      : rising
        ? "var(--chart-line-up)"
        : "var(--chart-line-down)";
  const badgeColor = theme === "light" ? "var(--chart-badge)" : lineColor;
  const badgeText = "var(--chart-badge-text)";

  const display = hover?.point ?? (latest
    ? {
        quote: latest.quote,
        epoch: latest.epoch,
        digit: latest.digit,
      }
    : null);

  function nearestPoint(clientX: number, clientY: number): HoverState | null {
    const svg = svgRef.current;
    if (!svg || chart.points.length === 0) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = ((clientX - rect.left) / rect.width) * chart.width;
    const y = ((clientY - rect.top) / rect.height) * chart.height;

    if (
      x < chart.plotLeft - 8 ||
      x > chart.plotRight + 8 ||
      y < chart.plotTop - 8 ||
      y > chart.plotBottom + 8
    ) {
      return null;
    }

    let best = chart.points[0];
    let bestDist = Math.abs(best.x - x);
    for (const point of chart.points) {
      const dist = Math.abs(point.x - x);
      if (dist < bestDist) {
        best = point;
        bestDist = dist;
      }
    }

    const prev = best.index > 0 ? chart.points[best.index - 1] : null;
    const stepAbs = prev ? best.quote - prev.quote : null;
    const stepPct =
      prev && prev.quote !== 0 ? ((best.quote - prev.quote) / prev.quote) * 100 : null;

    return { point: best, stepAbs, stepPct };
  }

  function onPointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    setHover(nearestPoint(event.clientX, event.clientY));
  }

  function onPointerLeave() {
    setHover(null);
  }

  const tipLeft = hover
    ? Math.min(
        Math.max(hover.point.x + 14, chart.plotLeft + 4),
        chart.plotRight - 168,
      )
    : 0;
  const tipTop = hover
    ? Math.min(
        Math.max(hover.point.y - 70, chart.plotTop + 4),
        chart.plotBottom - 78,
      )
    : 0;

  return (
    <section className="block tick-chart tick-chart--pro">
      <div className="tick-chart__header">
        <div>
          <h2>
            {name}
            {syncing ? (
              <em className="tick-chart__sync" aria-live="polite">
                {" "}
                · syncing live…
              </em>
            ) : null}
          </h2>
          <div className="tick-chart__price-line">
            {display ? (
              <>
                <strong className={changeUp ? "is-up" : "is-down"}>
                  {display.quote.toFixed(pip)}
                </strong>
                {hover ? (
                  <span className="tick-chart__hover-meta">
                    {formatTime(display.epoch)} · digit {display.digit}
                    {hover.stepAbs !== null && hover.stepPct !== null
                      ? ` · ${formatChange(hover.stepAbs, hover.stepPct, pip)}`
                      : ""}
                  </span>
                ) : change ? (
                  <span className={changeUp ? "is-up" : "is-down"}>
                    {formatChange(change.abs, change.pct, pip)}
                  </span>
                ) : null}
              </>
            ) : (
              <strong>—</strong>
            )}
          </div>
        </div>
        <div className="tick-chart__windows" role="group" aria-label="Tick window">
          {WINDOW_OPTIONS.map((size) => (
            <button
              key={size}
              type="button"
              className={windowSize === size ? "is-active" : ""}
              onClick={() => setWindowSize(size)}
            >
              {size === 50 ? "1T" : `${size}`}
            </button>
          ))}
        </div>
      </div>

      <div className="tick-chart__stage">
        <div className="tick-chart__frame" ref={frameRef}>
          {series.length < 2 ? (
            <p className="empty">Waiting for ticks to draw the chart…</p>
          ) : (
            <svg
              ref={svgRef}
              className="tick-chart__svg"
              viewBox={`0 0 ${chart.width} ${chart.height}`}
              role="img"
              aria-label={`${name} tick chart — hover for price and time`}
              onPointerMove={onPointerMove}
              onPointerLeave={onPointerLeave}
              onPointerDown={onPointerMove}
            >
              <defs>
                <linearGradient id={`fill-${gradId}`} x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor={lineColor}
                    stopOpacity={theme === "light" ? 0.14 : 0.3}
                  />
                  <stop
                    offset="55%"
                    stopColor={lineColor}
                    stopOpacity={theme === "light" ? 0.04 : 0.08}
                  />
                  <stop offset="100%" stopColor={lineColor} stopOpacity="0" />
                </linearGradient>
              </defs>

              {/* Invisible hit area so hover works on empty chart space */}
              <rect
                x={chart.plotLeft}
                y={chart.plotTop}
                width={chart.plotRight - chart.plotLeft}
                height={chart.plotBottom - chart.plotTop}
                fill="transparent"
                className="tick-chart__hit"
              />

              {chart.yTicks.map((value, index) => {
                const y =
                  chart.pad.top +
                  (index / Math.max(chart.yTicks.length - 1, 1)) *
                    (chart.height - chart.pad.top - chart.pad.bottom);
                return (
                  <g key={`y-${index}`}>
                    <line
                      x1={chart.pad.left}
                      y1={y}
                      x2={chart.plotRight}
                      y2={y}
                      className="tick-chart__grid"
                    />
                    <text
                      x={chart.plotRight + 10}
                      y={y + 3}
                      className="tick-chart__axis"
                    >
                      {value.toFixed(pip)}
                    </text>
                  </g>
                );
              })}

              {chart.xLabels.map((item, index) => (
                <g key={`x-${index}-${item.label}`}>
                  <line
                    x1={item.x}
                    y1={chart.pad.top}
                    x2={item.x}
                    y2={chart.plotBottom}
                    className="tick-chart__grid tick-chart__grid--v"
                  />
                  <text
                    x={item.x}
                    y={chart.height - 10}
                    textAnchor="middle"
                    className="tick-chart__axis"
                  >
                    {item.label}
                  </text>
                </g>
              ))}

              <line
                x1={chart.pad.left}
                y1={chart.latestY}
                x2={chart.plotRight}
                y2={chart.latestY}
                className="tick-chart__crosshair"
                stroke={lineColor}
              />

              <path d={chart.area} fill={`url(#fill-${gradId})`} />
              <path
                d={chart.path}
                fill="none"
                stroke={lineColor}
                strokeWidth={theme === "light" ? 1.8 : 2.2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />

              <circle cx={chart.latestX} cy={chart.latestY} r="4.5" fill={lineColor} />
              <circle
                cx={chart.latestX}
                cy={chart.latestY}
                r="8"
                fill="none"
                stroke={lineColor}
                strokeOpacity="0.28"
                strokeWidth="2"
              />

              {chart.markers.map((marker, index) => (
                <g key={`m-${index}-${marker.x}`}>
                  <circle
                    cx={marker.x}
                    cy={marker.y}
                    r="7"
                    className={
                      marker.won ? "tick-chart__mark--win" : "tick-chart__mark--loss"
                    }
                  />
                  <text
                    x={marker.x}
                    y={marker.y + 3.5}
                    textAnchor="middle"
                    className="tick-chart__mark-label"
                  >
                    {marker.won ? "W" : "L"}
                  </text>
                </g>
              ))}

              {hover ? (
                <g className="tick-chart__hover" pointerEvents="none">
                  <line
                    x1={hover.point.x}
                    y1={chart.plotTop}
                    x2={hover.point.x}
                    y2={chart.plotBottom}
                    className="tick-chart__hover-cross"
                  />
                  <line
                    x1={chart.plotLeft}
                    y1={hover.point.y}
                    x2={chart.plotRight}
                    y2={hover.point.y}
                    className="tick-chart__hover-cross"
                  />
                  <circle
                    cx={hover.point.x}
                    cy={hover.point.y}
                    r="6"
                    className="tick-chart__hover-dot"
                    fill={lineColor}
                  />
                  <circle
                    cx={hover.point.x}
                    cy={hover.point.y}
                    r="11"
                    fill="none"
                    stroke={lineColor}
                    strokeOpacity="0.35"
                    strokeWidth="2"
                  />

                  {/* Price badge on Y axis */}
                  <rect
                    x={chart.plotRight + 4}
                    y={hover.point.y - 11}
                    width="70"
                    height="22"
                    rx="3"
                    className="tick-chart__hover-badge"
                  />
                  <text
                    x={chart.plotRight + 39}
                    y={hover.point.y + 4}
                    textAnchor="middle"
                    className="tick-chart__hover-badge-text"
                  >
                    {hover.point.quote.toFixed(pip)}
                  </text>

                  {/* Time badge on X axis */}
                  <rect
                    x={hover.point.x - 34}
                    y={chart.plotBottom + 4}
                    width="68"
                    height="18"
                    rx="3"
                    className="tick-chart__hover-badge"
                  />
                  <text
                    x={hover.point.x}
                    y={chart.plotBottom + 16}
                    textAnchor="middle"
                    className="tick-chart__hover-badge-text"
                  >
                    {formatTime(hover.point.epoch)}
                  </text>

                  {/* Floating tooltip */}
                  <g transform={`translate(${tipLeft}, ${tipTop})`}>
                    <rect
                      width="160"
                      height="72"
                      rx="6"
                      className="tick-chart__tip"
                    />
                    <text x="12" y="20" className="tick-chart__tip-label">
                      {formatTime(hover.point.epoch)}
                    </text>
                    <text x="12" y="40" className="tick-chart__tip-price">
                      {hover.point.quote.toFixed(pip)}
                    </text>
                    <text x="12" y="58" className="tick-chart__tip-label">
                      Digit {hover.point.digit}
                      {hover.stepAbs !== null && hover.stepPct !== null
                        ? ` · ${hover.stepAbs >= 0 ? "+" : ""}${hover.stepAbs.toFixed(pip)}`
                        : ""}
                    </text>
                  </g>
                </g>
              ) : (
                <>
                  <rect
                    x={chart.plotRight + 6}
                    y={chart.latestY - 11}
                    width="66"
                    height="22"
                    rx="3"
                    fill={badgeColor}
                  />
                  <text
                    x={chart.plotRight + 39}
                    y={chart.latestY + 4}
                    textAnchor="middle"
                    className="tick-chart__price-tag"
                    fill={badgeText}
                  >
                    {latest.quote.toFixed(pip)}
                  </text>
                </>
              )}
            </svg>
          )}

          <div className="tick-chart__zoom">
            <button
              type="button"
              aria-label="Show fewer ticks"
              disabled={windowSize <= WINDOW_OPTIONS[0]}
              onClick={() =>
                setWindowSize((current) => {
                  const idx = WINDOW_OPTIONS.findIndex((size) => size >= current);
                  return WINDOW_OPTIONS[
                    Math.max(0, (idx === -1 ? WINDOW_OPTIONS.length : idx) - 1)
                  ];
                })
              }
            >
              +
            </button>
            <button
              type="button"
              className="tick-chart__zoom-reset"
              aria-label="Reset window"
              onClick={() => setWindowSize(maxPoints)}
            >
              <span aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Show more ticks"
              disabled={windowSize >= WINDOW_OPTIONS[WINDOW_OPTIONS.length - 1]}
              onClick={() =>
                setWindowSize((current) => {
                  const idx = WINDOW_OPTIONS.findIndex((size) => size > current);
                  return idx === -1
                    ? WINDOW_OPTIONS[WINDOW_OPTIONS.length - 1]
                    : WINDOW_OPTIONS[idx];
                })
              }
            >
              −
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
