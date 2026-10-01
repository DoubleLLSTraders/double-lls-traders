import { useEffect, useRef } from "react";
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Trade } from "./bot";
import type { Tick } from "./market";

/** Ticks are one second apart, so anchor them to a fixed clock for the time axis. */
const EPOCH_BASE = 1_790_000_000;
const time = (epoch: number) => (EPOCH_BASE + epoch) as UTCTimestamp;

interface LiveChartProps {
  ticks: Tick[];
  trades?: Trade[];
  height?: number;
  /** Changes every frame so the chart redraws. */
  frame: number;
}

export function LiveChart({ ticks, trades = [], height = 320, frame }: LiveChartProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const pipRef = useRef(2);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const chart = createChart(box, {
      height,
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#6f6f6f",
        fontFamily: '"IBM Plex Mono", Consolas, monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: "rgba(255,255,255,0.04)", style: LineStyle.Solid },
      },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.18, bottom: 0.12 } },
      timeScale: { borderVisible: false, visible: false, rightOffset: 4, fixLeftEdge: true },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: "rgba(255,255,255,0.15)", labelVisible: false, style: LineStyle.Dashed },
        horzLine: { color: "rgba(255,255,255,0.15)", labelBackgroundColor: "#1c1c1c", style: LineStyle.Dashed },
      },
      handleScroll: false,
      handleScale: false,
    });
    const series = chart.addAreaSeries({
      lineColor: "#f2f0ec",
      lineWidth: 2,
      topColor: "rgba(242,240,236,0.16)",
      bottomColor: "rgba(242,240,236,0)",
      priceLineColor: "rgba(242,240,236,0.35)",
      priceLineStyle: LineStyle.Dotted,
      lastValueVisible: true,
      crosshairMarkerRadius: 3,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    chartRef.current = chart;
    seriesRef.current = series;
    pipRef.current = 2;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [height]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series || ticks.length === 0) return;
    const pip = ticks[ticks.length - 1].pip ?? 2;
    if (pip !== pipRef.current) {
      pipRef.current = pip;
      series.applyOptions({ priceFormat: { type: "price", precision: pip, minMove: 10 ** -pip } });
    }
    series.setData(ticks.map((t) => ({ time: time(t.epoch), value: t.quote })));

    const first = ticks[0].epoch;
    const markers: SeriesMarker<UTCTimestamp>[] = trades
      .filter((t) => t.epoch >= first)
      .map((t): SeriesMarker<UTCTimestamp> => ({
        time: time(t.epoch),
        position: t.won ? "aboveBar" : "belowBar",
        shape: "circle",
        color: t.won ? "#4cc38a" : "#e5484d",
        size: 0.6,
      }))
      .reverse();
    series.setMarkers(markers);
    chartRef.current?.timeScale().fitContent();
  }, [ticks, trades, frame]);

  return (
    <div className="live-chart-wrap">
      <div ref={boxRef} className="live-chart" style={{ height }} />
    </div>
  );
}
